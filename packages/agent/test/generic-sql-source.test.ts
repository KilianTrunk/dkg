import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  genericSqlSourceHandler,
  registerGenericSqlConnector,
  selectGenericSqlAssetGroupsForChangedPartitions,
  unregisterGenericSqlConnector,
  type GenericSqlClient,
  type GenericSqlMappingSpec,
  type GenericSqlSourceDefinition,
} from '../src/generic-sql-source.js';

const TEST_DIALECT = 'neutral-memory-sql';
const cleanupPaths: string[] = [];

afterEach(async () => {
  unregisterGenericSqlConnector(TEST_DIALECT);
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('generic SQL source handler', () => {
  it('queries a real SQLite database and maps typed literals and joins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'generic-sql-source-'));
    cleanupPaths.push(dir);
    const databasePath = join(dir, 'fixture.sqlite');
    await seedSqliteDatabase(databasePath);

    const result = await genericSqlSourceHandler.prepare(sqliteSource(databasePath));
    const quads = result.assets.flatMap((asset) => asset.quads);

    expect(result.fingerprintMetadata).toMatchObject({
      kind: 'generic-sql-partitions',
      mappingId: 'neutral.orders.v1',
      partitions: [
        {
          key: 'A100',
          rowCounts: {
            orders: 1,
            lines: 2,
          },
        },
      ],
    });
    expect(result.assets.map((asset) => asset.rootEntity).sort()).toEqual([
      'urn:neutral:line:L1',
      'urn:neutral:line:L2',
      'urn:neutral:order:A100',
    ]);
    expect(quads).toEqual(expect.arrayContaining([
      quad('urn:neutral:order:A100', 'https://example.test/quantity', '"12.5"^^<http://www.w3.org/2001/XMLSchema#decimal>'),
      quad('urn:neutral:order:A100', 'https://example.test/status', '"READY"'),
      quad('urn:neutral:line:L1', 'https://example.test/eventTime', '"2026-05-22T10:30:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'),
      quad('urn:neutral:order:A100', 'https://example.test/hasLine', 'urn:neutral:line:L1'),
    ]));
  });

  it('fails clearly when a required SQL column is missing', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        if (dataset === 'orders') {
          return [{ order_id: 'A100' }];
        }
        return [];
      },
    }));

    await expect(genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      datasets: {
        ...mapping.datasets,
        orders: {
          query: 'select order_id from customer_order',
          requiredColumns: ['order_id', 'quantity'],
        },
      },
    }))).rejects.toThrow('dataset orders is missing required columns: quantity');
  });

  it('renders mapping templates without regular expression replacement', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        return rowsByDataset()[dataset] ?? [];
      },
    }));

    const result = await genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      entities: [
        {
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:order:{order_id}',
          properties: {
            'https://example.test/composite': 'order-{order_id}-{status}',
            'https://example.test/emptyBraces': 'literal-{}',
            'https://example.test/unclosedBrace': 'literal-{status',
          },
        },
      ],
      relations: [],
    }));

    const quads = result.assets.flatMap((asset) => asset.quads);
    expect(quads).toEqual(expect.arrayContaining([
      quad('urn:neutral:order:A100', 'https://example.test/composite', '"order-A100-ready"'),
      quad('urn:neutral:order:A100', 'https://example.test/emptyBraces', '"literal-{}"'),
      quad('urn:neutral:order:A100', 'https://example.test/unclosedBrace', '"literal-{status"'),
    ]));
  });

  it('selects only asset groups for changed partitions', async () => {
    let rows = rowsByDataset();
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        return rows[dataset] ?? [];
      },
    }));

    const prior = await genericSqlSourceHandler.prepare(memorySource());
    rows = rowsByDataset({
      orders: [
        { order_id: 'A100', sku: 'W-1', quantity: '12.5', status: 'ready' },
        { order_id: 'B200', sku: 'W-2', quantity: '9', status: 'ready' },
      ],
    });
    const current = await genericSqlSourceHandler.prepare(memorySource());
    const groups = selectGenericSqlAssetGroupsForChangedPartitions(
      current.assets,
      current.fingerprintMetadata,
      prior.fingerprintMetadata,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.roots).toEqual(['urn:neutral:order:B200']);
  });

  it('rejects rows missing the configured partition key', async () => {
    registerGenericSqlConnector(TEST_DIALECT, async (): Promise<GenericSqlClient> => ({
      async query(_sql, _parameters, dataset) {
        if (dataset === 'orders') {
          return [
            { order_id: '', sku: 'W-missing-key', quantity: '1', status: 'ready' },
          ];
        }
        return [];
      },
    }));

    await expect(genericSqlSourceHandler.prepare(memorySource({
      ...mapping,
      entities: [
        {
          name: 'order',
          from: 'orders',
          id: 'urn:neutral:sku:{sku}',
          properties: {
            'https://example.test/status': '{status}',
          },
        },
      ],
      relations: [],
      fingerprint: {
        mapperVersion: 1,
        partitionBy: {
          field: 'order_id',
          datasets: ['orders'],
        },
      },
    }))).rejects.toThrow('dataset orders row 1 is missing partition key order_id');
  });

  it('preflights missing SQL Server environment before loading optional driver', async () => {
    await expect(genericSqlSourceHandler.prepare({
      ...memorySource(),
      connection: {
        dialect: 'mssql',
        serverEnv: 'GENERIC_SQL_TEST_SERVER_NOT_SET',
        databaseEnv: 'GENERIC_SQL_TEST_DATABASE_NOT_SET',
        userEnv: 'GENERIC_SQL_TEST_USER_NOT_SET',
        passwordEnv: 'GENERIC_SQL_TEST_PASSWORD_NOT_SET',
      },
    })).rejects.toThrow('requires environment variable GENERIC_SQL_TEST_SERVER_NOT_SET');
  });
});

function sqliteSource(databasePath: string): GenericSqlSourceDefinition {
  return {
    ...memorySource(),
    connection: {
      dialect: 'sqlite',
      databasePath,
    },
    parameters: {
      orderId: 'A100',
    },
  };
}

function memorySource(customMapping: GenericSqlMappingSpec = mapping): GenericSqlSourceDefinition {
  return {
    id: 'neutral-orders',
    kind: 'generic-sql',
    dataset: 'neutral',
    connection: {
      dialect: TEST_DIALECT,
    },
    mapping: customMapping,
  };
}

const mapping: GenericSqlMappingSpec = {
  id: 'neutral.orders.v1',
  version: '1',
  datasets: {
    orders: {
      query: 'select order_id, sku, quantity, status from customer_order where order_id = @orderId',
      requiredColumns: ['order_id', 'sku', 'quantity', 'status'],
    },
    lines: {
      query: 'select line_id, order_id, line_quantity, event_date, event_time from shipment_line where order_id = @orderId',
      requiredColumns: ['line_id', 'order_id', 'line_quantity', 'event_date', 'event_time'],
    },
  },
  entities: [
    {
      name: 'order',
      from: 'orders',
      id: 'urn:neutral:order:{order_id}',
      type: 'https://example.test/Order',
      properties: {
        'https://example.test/sku': '{sku}',
        'https://example.test/quantity': {
          value: '{quantity}',
          datatype: 'xsd:decimal',
        },
        'https://example.test/status': {
          transform: 'upper',
          args: ['{status}'],
        },
      },
    },
    {
      name: 'line',
      from: 'lines',
      id: 'urn:neutral:line:{line_id}',
      type: 'https://example.test/ShipmentLine',
      properties: {
        'https://example.test/lineQuantity': {
          value: '{line_quantity}',
          datatype: 'xsd:integer',
        },
        'https://example.test/eventTime': {
          transform: 'combineDateTime',
          args: ['{event_date}', '{event_time}', 'Z'],
          datatype: 'xsd:dateTime',
        },
      },
    },
  ],
  relations: [
    {
      from: 'order',
      to: 'line',
      predicate: 'https://example.test/hasLine',
      join: {
        left: 'orders.order_id',
        right: 'lines.order_id',
      },
    },
  ],
  fingerprint: {
    mapperVersion: 1,
    partitionBy: {
      field: 'order_id',
      datasets: ['orders', 'lines'],
    },
  },
};

function rowsByDataset(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  return {
    orders: [
      { order_id: 'A100', sku: 'W-1', quantity: '12.5', status: 'ready' },
      { order_id: 'B200', sku: 'W-2', quantity: '8', status: 'ready' },
    ],
    lines: [
      { line_id: 'L1', order_id: 'A100', line_quantity: '7', event_date: '2026-05-22', event_time: '10:30' },
      { line_id: 'L2', order_id: 'A100', line_quantity: '5', event_date: '2026-05-22', event_time: '10:45' },
    ],
    ...overrides,
  };
}

async function seedSqliteDatabase(databasePath: string): Promise<void> {
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as any;
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE customer_order (
        order_id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        quantity TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE shipment_line (
        line_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        line_quantity TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT NOT NULL
      );
    `);
    database.prepare('INSERT INTO customer_order VALUES (?, ?, ?, ?)').run('A100', 'W-1', '12.5', 'ready');
    database.prepare('INSERT INTO customer_order VALUES (?, ?, ?, ?)').run('B200', 'W-2', '8', 'ready');
    const insertLine = database.prepare('INSERT INTO shipment_line VALUES (?, ?, ?, ?, ?)');
    insertLine.run('L1', 'A100', '7', '2026-05-22', '10:30');
    insertLine.run('L2', 'A100', '5', '2026-05-22', '10:45');
  } finally {
    database.close();
  }
}

function quad(subject: string, predicate: string, object: string) {
  return { subject, predicate, object, graph: '' };
}

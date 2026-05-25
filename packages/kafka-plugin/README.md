# @origintrail-official/kafka-plugin

DKG daemon route plugin for publishing Kafka stream registrations as public `dkg-streams:KafkaStream` Knowledge Assets. Default mount: `/api/kafka/streams`.

## API

- `POST /register` validates a registration, enqueues `agent.publishAsync`,
  and returns `202 { captureID }`.
- `GET /register/:captureID` polls publisher state and eventual UAL.
- `GET /` lists KafkaStream KAs with `limit`/`offset`.
- `GET /:ual` fetches one KafkaStream KA.

The context graph is server-owned: pass `contextGraphId` to the factory or set `config.kafka.contextGraphId`. Extension schemas must be Zod objects with scalar fields so discovery can round-trip registrations.

## Usage

```ts
import kafkaPlugin, { createKafkaPlugin } from '@origintrail-official/kafka-plugin';

export default kafkaPlugin;
export const customKafkaPlugin = createKafkaPlugin({ contextGraphId: 'kafka-streams-demo' });
```

## Extensions

```ts
import { z } from 'zod';
import { createKafkaPlugin } from '@origintrail-official/kafka-plugin';

export default createKafkaPlugin({
  extension: {
    schema: z.object({ externalRef: z.string() }),
    augment: ({ externalRef }) => ({
      '@context': { vendor: 'https://vendor.example/ontology#' },
      'vendor:externalRef': externalRef,
    }),
  },
});
```

Core fields and `dkg-streams:KafkaStream` remain invariant.

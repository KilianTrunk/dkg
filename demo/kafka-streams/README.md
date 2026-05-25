# Kafka-Streams Two-Node Demo

Registers a KafkaStream KA on node1, waits for finalization, then verifies node2 can read the same UAL. Prerequisites: two-node devnet, node1 publisher enabled, both nodes loading `@origintrail-official/kafka-plugin`, and matching config:

```jsonc
{ "kafka": { "contextGraphId": "kafka-streams-demo" }, "routePlugins": ["/abs/path/to/packages/kafka-plugin/dist/index.js"] }
```

```sh
DKG_HOME=.devnet/node1 NODE2_DKG_HOME=.devnet/node2 \
  node demo/kafka-streams/run.mjs --no-pause
```

Tests: `node --test demo/kafka-streams/test/*.mjs`.

# @origintrail-official/kafka-plugin
DKG daemon route plugin for publishing Kafka stream registrations as public `dkg-streams:KafkaStream` Knowledge Assets. Default mount: `/api/kafka/streams`.

Routes: `POST /register`, `GET /register/:captureID`, `GET /`, and `GET /:ual`.

## Usage

```ts
import { createKafkaPlugin } from '@origintrail-official/kafka-plugin';

export default createKafkaPlugin({
  contextGraphId: 'kafka-streams-demo',
});
```

The context graph is server-owned via the factory or `config.kafka.contextGraphId`. Extensions use Zod object schemas and scalar fields; core fields and `dkg-streams:KafkaStream` stay invariant.

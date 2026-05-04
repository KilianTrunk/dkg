# Architecture

This repository contains the DKG V10 node monorepo: the CLI daemon, agent runtime,
publisher, storage, chain adapters, dashboard UI, and local tooling used to write,
share, publish, and query knowledge assets.

The local publish/async/get benchmark lives inside the CLI package. It is a
developer/operator workflow, not a daemon subsystem: the benchmark runner connects
to an already running DKG daemon, writes unique benchmark payloads to shared
memory, exercises synchronous and asynchronous publish paths, queries the
published marker, and reports timings plus failures.

## Top-Level Components

```mermaid
classDiagram
  direction TB

  class CliPackage {
    <<package>>
    +daemon()
    +benchmark_publish_async_get()
    +ApiClient()
  }

  class PublishGetBenchmark {
    <<tooling>>
    +parseBenchmarkArgs()
    +createBenchmarkClient()
    +runPublishAsyncGetBenchmark()
    +formatResult()
  }

  class DkgDaemonApi {
    <<http api>>
    +status()
    +shared_memory_write()
    +shared_memory_publish()
    +publisher_enqueue()
    +publisher_job()
    +query()
  }

  class DkgAgentRuntime {
    <<runtime>>
    +working_memory()
    +shared_working_memory()
    +query()
  }

  class PublisherRuntime {
    <<runtime>>
    +publishFromSharedMemory()
    +enqueue()
    +processNext()
    +finalize()
  }

  class StorageAdapters {
    <<persistence>>
    +local_triple_store()
    +context_graph_store()
    +operation_journal()
  }

  class ChainAdapters {
    <<integration>>
    +evm_commitments()
    +knowledge_collection_roots()
    +publisher_authorization()
  }

  class NodeUi {
    <<frontend>>
    +dashboard()
    +context_graph_views()
  }

  CliPackage --> DkgDaemonApi : starts and exposes
  CliPackage --> PublishGetBenchmark : provides script
  PublishGetBenchmark --> DkgDaemonApi : measures via ApiClient
  DkgDaemonApi --> DkgAgentRuntime : delegates memory and query work
  DkgDaemonApi --> PublisherRuntime : delegates publish work
  DkgAgentRuntime --> StorageAdapters : reads and writes triples
  PublisherRuntime --> StorageAdapters : reads SWM staging data
  PublisherRuntime --> ChainAdapters : anchors VM commitments
  NodeUi --> DkgDaemonApi : consumes local API
```

## Publish/Async/Get Benchmark Flow

The benchmark command is exposed from `packages/cli` as
`benchmark:publish-async-get`. Configuration is read from CLI flags and matching
environment variables. `DKG_API_PORT` and loopback `DKG_API_URL` targets load the
normal local auth token; non-loopback API URLs require an explicit auth token.

Each warmup and measured iteration gets distinct root entity and marker values so
warmup writes cannot collide with measured payloads. Warmups are recorded but
excluded from summary statistics.

```mermaid
sequenceDiagram
  autonumber
  participant Operator
  participant Script as Benchmark Script
  participant Config as Config Parser
  participant Client as ApiClient
  participant Daemon as DKG Daemon API
  participant Agent as Agent Runtime
  participant Publisher as Publisher Runtime
  participant Store as WM SWM VM Stores
  participant Chain as Chain Adapter

  Operator->>Script: pnpm benchmark:publish-async-get
  Script->>Config: parse flags and environment
  Config-->>Script: benchmark config without secrets in output
  Script->>Client: create client and resolve auth
  Client->>Daemon: GET status
  Daemon-->>Client: daemon available

  loop warmups and measured iterations
    Script->>Script: create unique sync payload
    Script->>Client: sharedMemoryWrite(sync quads)
    Client->>Daemon: POST shared memory write
    Daemon->>Agent: write benchmark triples
    Agent->>Store: persist SWM payload
    Store-->>Agent: share operation recorded
    Agent-->>Daemon: write accepted
    Daemon-->>Client: share operation id

    Script->>Client: publishFromSharedMemory(sync root)
    Client->>Daemon: POST shared memory publish
    Daemon->>Publisher: publish synchronously
    Publisher->>Store: read staged triples
    Publisher->>Chain: anchor knowledge collection
    Chain-->>Publisher: commitment finalized
    Publisher-->>Daemon: kc id
    Daemon-->>Client: publish result

    Script->>Client: query marker for sync payload
    Client->>Daemon: POST query
    Daemon->>Agent: execute SPARQL in selected view
    Agent->>Store: read matching triples
    Store-->>Agent: query result
    Agent-->>Daemon: result bindings
    Daemon-->>Client: query result
    Script->>Script: validate returned marker

    Script->>Script: create unique async payload
    Script->>Client: sharedMemoryWrite(async quads)
    Client->>Daemon: POST shared memory write
    Daemon->>Agent: write benchmark triples
    Agent->>Store: persist SWM payload
    Store-->>Agent: share operation recorded
    Agent-->>Daemon: write accepted
    Daemon-->>Client: share operation id

    Script->>Client: publisherEnqueue(share operation id)
    Client->>Daemon: POST publisher enqueue
    Daemon->>Publisher: enqueue job
    Publisher-->>Daemon: job id
    Daemon-->>Client: enqueue result

    loop until success status or timeout
      Script->>Client: publisherJob(job id)
      Client->>Daemon: GET publisher job
      Daemon->>Publisher: read job state
      Publisher->>Store: resolve queued SWM payload
      Publisher->>Chain: finalize when ready
      Publisher-->>Daemon: current status
      Daemon-->>Client: job status
    end

    Script->>Script: record operation timing or failure context
  end

  Script->>Script: aggregate min max mean median p50 p95
  Script-->>Operator: JSON or NDJSON benchmark result
```

## Codex Architecture Documentation Workflow

The repository architecture documentation is maintained as a docs-only step after
implementation, tests, and code review have passed. That keeps architecture
updates tied to actual code changes while preserving the code and test diff from
documentation-only mutations.

```mermaid
sequenceDiagram
  autonumber
  participant Planner as Codex Workflow
  participant Engineer as Implementation Agent
  participant Tests as Validation and Review
  participant Docs as Mermaid Docs Agent
  participant Arch as ARCHITECTURE.md

  Planner->>Engineer: assign focused implementation subtask
  Engineer->>Engineer: update scoped source files and tests
  Engineer->>Tests: run focused validation and code review
  Tests-->>Planner: implementation accepted
  Planner->>Docs: provide changed files and architecture context
  Docs->>Docs: decide whether architecture changed
  alt architecture update needed
    Docs->>Arch: create or update Mermaid diagrams and prose
    Arch-->>Docs: docs-only architecture diff
  else no architecture update needed
    Docs-->>Planner: leave working tree unchanged
  end
  Docs-->>Planner: report documentation outcome
```

# Benchmarking

This repository uses two separate tools for two separate jobs:

- Vitest is for unit and correctness tests.
- ESBench is for repeatable local benchmarks, HTML reports, and baseline comparisons.

The initial ESBench suite lives in `bench/publish-async-get.bench.ts`. It uses
the same publish/get runner contract as the CLI benchmark and a deterministic
in-memory DKG client from `bench/support/layered-dkg-client.ts`. That client
models the important layers explicitly:

- working memory, where benchmark triples are first written
- shared working memory, where payloads are staged for publishing
- verified memory, where sync or async publish finalizes readable content
- publisher jobs, where async enqueue is separated from runtime finalization

The ESBench suite measures `syncPublish SWM to VM`,
`asyncPublish enqueue runtime SWM to VM`, `get VM marker validation`, and the
full `runPublishAsyncGetBenchmark` runner path. Add new suites under
`bench/**/*.bench.ts` as performance-sensitive paths become obvious.

## Local Usage

Run correctness tests:

```bash
pnpm test
```

Run benchmarks and write the raw result to `bench/results/latest.json`:

```bash
pnpm bench
```

The root ESBench config is `esbench.config.mjs`. It was verified against ESBench `0.8.1`, whose CLI runs suites with `esbench --config <file>` and generates reports from saved result files with `esbench report <patterns...> --config <file>`.

## HTML Reports

Generate a benchmark run plus an interactive HTML report:

```bash
pnpm bench:html
```

This writes:

- `bench/results/latest.json`
- `bench/results/latest.html`

Open the HTML file in a browser to inspect charts and per-suite comparisons.

## Baseline Workflow

Record a local baseline before changing performance-sensitive code:

```bash
pnpm bench:baseline
```

This writes:

- `bench/results/baseline.json`
- `bench/results/baseline.html`

Keep baseline files local unless a PR explicitly needs to share benchmark artifacts. They are generated outputs and are ignored by git.

## Branch Comparison Workflow

Use the same machine, Node version, and terminal session shape for both runs.

```bash
git checkout main
pnpm install --frozen-lockfile
pnpm bench:baseline

git checkout <feature-branch>
pnpm install --frozen-lockfile
pnpm bench:compare
```

`pnpm bench:compare` reads `bench/results/baseline.json`, writes the current run to `bench/results/compare.json`, and writes an HTML report to `bench/results/compare.html`. ESBench includes the previous-run diff in the text and HTML reports.

## Node Version And CI Noise

Pin Node before comparing numbers. This repo has `.nvmrc` set to Node `22`; use that version for local comparisons:

```bash
nvm use
node --version
```

Microbenchmarks are sensitive to CPU scaling, thermal throttling, background processes, dependency versions, and VM/container scheduling. Treat CI benchmark numbers as smoke signals, not hard gates, unless the runner is pinned and quiet. For regression review, prefer repeated local runs on the same machine with the same Node and pnpm versions.

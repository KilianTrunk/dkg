import { defineConfig, htmlReporter, rawReporter, textReporter } from 'esbench/host';

const resultFile = process.env.ESBENCH_RESULT ?? 'bench/results/latest.json';
const htmlFile = process.env.ESBENCH_HTML_FILE ?? 'bench/results/latest.html';
const diffFile = process.env.ESBENCH_DIFF ?? null;
const reporters = [
  textReporter(),
  rawReporter(resultFile),
];

if (process.env.ESBENCH_HTML === '1') {
  reporters.push(htmlReporter(htmlFile));
}

export default defineConfig({
  cleanTempDir: true,
  diff: diffFile,
  logLevel: process.env.ESBENCH_LOG_LEVEL ?? 'info',
  tempDir: '.esbench-tmp',
  tags: {
    node: process.version,
  },
  toolchains: [
    {
      include: ['bench/**/*.bench.ts'],
    },
  ],
  reporters,
});

import { defineConfig } from 'vitest/config';

process.env.LOG_LEVEL ??= 'warn';

// Real env > repo .env > .env.example (loadEnvFile never overrides existing vars).
for (const file of ['../../.env', '../../.env.example']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}

// TEST_RESULTS_DIR set (CI): also JUnit XML for the test report servers (docs/test-reports.md).
const results = process.env.TEST_RESULTS_DIR;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    reporters: results ? ['default', 'junit'] : ['default'],
    outputFile: results ? { junit: `${results}/api.xml` } : undefined,
  },
});

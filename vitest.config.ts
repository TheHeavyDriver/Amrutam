import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // esbuild does not emit decorator metadata, which NestJS DI requires.
    // SWC does, so it handles all TypeScript transforms for tests.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
    clearMocks: true,
    // Integration suites share one migrated PostgreSQL database and seeded
    // inventory. File-level parallelism would make slot allocation racy.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', '**/*.spec.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});

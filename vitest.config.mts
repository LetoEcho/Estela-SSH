import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/main/**/*.spec.ts', 'src/shared/**/*.spec.ts', 'src/renderer/**/*.spec.ts', 'test/**/*.spec.ts'],
    environment: 'node',
  },
});

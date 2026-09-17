import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// `aetherflow` 与子路径别名指向源码，让 examples/ 可以直接 `import ... from "aetherflow"`
// 运行（npm run example examples/01-hello-agent.ts），同时仍被 tsc / vitest 覆盖。
const r = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "aetherflow/core": r("./src/core/index.ts"),
      "aetherflow/models": r("./src/models/index.ts"),
      "aetherflow/tools": r("./src/tools/index.ts"),
      "aetherflow/agent": r("./src/agent/index.ts"),
      "aetherflow/memory": r("./src/memory/index.ts"),
      "aetherflow/observability": r("./src/observability/index.ts"),
      "aetherflow/evals": r("./src/evals/index.ts"),
      aetherflow: r("./src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});

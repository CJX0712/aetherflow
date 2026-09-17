import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "models/index": "src/models/index.ts",
    "tools/index": "src/tools/index.ts",
    "tools/mcp": "src/tools/mcp.ts",
    "memory/index": "src/memory/index.ts",
    "observability/index": "src/observability/index.ts",
    "evals/index": "src/evals/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  target: "node22",
  platform: "node",
  dts: true,
  clean: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
  minify: false,
  external: ["@modelcontextprotocol/sdk"],
});

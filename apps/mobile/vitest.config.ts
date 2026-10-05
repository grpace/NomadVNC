import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// fileURLToPath (not URL.pathname) so checkouts under paths with spaces or
// other percent-encoded characters still resolve.
const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      // Resolve workspace packages to source for tests.
      "@nomadvnc/domain": source("../../packages/domain/src/index.ts"),
      "@nomadvnc/platform-contracts": source("../../packages/platform-contracts/src/index.ts"),
      "@nomadvnc/viewer-shell": source("../../packages/viewer-shell/src/index.ts"),
    },
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the "@/..." path alias (mirrors tsconfig paths) so unit tests can
// import from src the same way app code does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    // Vitest owns unit tests; Playwright owns tests/e2e.
    include: ["tests/unit/**/*.test.ts"]
  }
});

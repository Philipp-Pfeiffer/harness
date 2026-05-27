import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    alias: {
      "@/": fileURLToPath(new URL("./src", import.meta.url)) + "/",
    },
  },
});
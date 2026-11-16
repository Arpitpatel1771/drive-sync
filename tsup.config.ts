import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  external: ["react", "react-dom"],
  onSuccess: async () => {
    mkdirSync("dist", { recursive: true });
    copyFileSync("src/styles.css", "dist/styles.css");
  },
});

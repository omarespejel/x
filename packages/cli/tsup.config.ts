import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  platform: "node",
  target: "es2020",
  clean: true,
});

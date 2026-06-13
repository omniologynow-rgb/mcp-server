import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  // Preserve the shebang so the bundled file is directly executable via the bin entry.
  banner: {
    js: "#!/usr/bin/env node",
  },
});

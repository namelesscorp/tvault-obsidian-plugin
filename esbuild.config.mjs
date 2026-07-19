import esbuild from "esbuild";
import process from "process";
import { existsSync, readFileSync } from "fs";
import { builtinModules } from "module";

const production = process.argv[2] === "production";

// The pinned tvault-core release and per-binary SHA-256 checksums are baked into
// main.js at build time, so the plugin can download and verify the CLI at
// runtime with a trust anchor it ships with.
const readJson = (file, fallback) =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;

const cli = readJson("cli.json", { repo: "namelesscorp/tvault-core", version: "" });
const checksums = readJson("cli-checksums.json", {});

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  define: {
    TVAULT_CLI_REPO: JSON.stringify(cli.repo),
    TVAULT_CLI_VERSION: JSON.stringify(cli.version),
    TVAULT_CLI_CHECKSUMS: JSON.stringify(checksums),
  },
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

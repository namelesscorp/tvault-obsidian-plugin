// Entry point: esbuild bundles from here into main.js. All implementation lives
// in src/; this file only re-exports the plugin class as the default export
// that Obsidian loads.
export { default } from "./src/plugin";

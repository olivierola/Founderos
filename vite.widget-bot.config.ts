// Standalone IIFE build of the public widget's animated bot avatar
// (bot-avatars) → committed to public/widget-bot.js, lazy-loaded by
// public/widget.js. Run with `npm run build:widget-bot`.
//
// React is swapped for preact/compat, like the voice glow: this file is served
// on customers' sites, so a few kB of Preact instead of ~140 kB of React.
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react$/, replacement: "preact/compat" },
    ],
  },
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/widget-bot/entry.ts"),
      name: "FounderOSWidgetBot",
      formats: ["iife"],
      fileName: () => "widget-bot.js",
    },
    outDir: "public",
    emptyOutDir: false,
    minify: true,
    rollupOptions: { output: { entryFileNames: "widget-bot.js", inlineDynamicImports: true } },
  },
});

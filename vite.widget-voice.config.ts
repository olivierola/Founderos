// Standalone IIFE build of the public widget's voice glow (voice-glow) →
// committed to public/widget-voice.js, lazy-loaded by public/widget.js the
// first time a visitor dictates or the agent starts thinking. Run with
// `npm run build:widget-voice`.
//
// React is swapped for preact/compat: voice-glow only uses hooks, forwardRef,
// useId and the JSX runtime, and this file lands on customers' sites — a few
// kB of Preact instead of ~140 kB of React.
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
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/widget-voice/entry.ts"),
      name: "FounderOSWidgetVoice",
      formats: ["iife"],
      fileName: () => "widget-voice.js",
    },
    outDir: "public",
    emptyOutDir: false, // keep widget.js and the other public/ assets
    minify: true,
    rollupOptions: {
      output: { entryFileNames: "widget-voice.js", inlineDynamicImports: true },
    },
  },
});

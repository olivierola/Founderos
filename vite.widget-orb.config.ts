// Standalone IIFE build of the public widget's thinking orbs (thinking-orbs
// engine, no React) → committed to public/widget-orb.js, lazy-loaded by
// public/widget.js. Run with `npm run build:widget-orb`.
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/widget-orb/entry.ts"),
      name: "FounderOSWidgetOrbBundle",
      formats: ["iife"],
      fileName: () => "widget-orb.js",
    },
    outDir: "public",
    emptyOutDir: false, // keep widget.js and the other public/ assets
    minify: true,
    rollupOptions: {
      output: { entryFileNames: "widget-orb.js", inlineDynamicImports: true },
    },
  },
});

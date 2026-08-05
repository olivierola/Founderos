// Standalone IIFE build of the onboarding co-pilot (page-agent) → committed to
// public/onboarding-agent.js, loaded by the widget on the host page. Run with
// `npm run build:onboarding-agent`. Self-contained (page-agent's dist already
// inlines its Panel CSS and deps); nothing external, no hashed filename.
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  publicDir: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/onboarding-agent/entry.ts"),
      name: "FounderOSOnboardingAgentBundle",
      formats: ["iife"],
      fileName: () => "onboarding-agent.js",
    },
    outDir: "public",
    emptyOutDir: false, // keep widget.js and the other public/ assets
    minify: true,
    rollupOptions: {
      output: {
        entryFileNames: "onboarding-agent.js",
        inlineDynamicImports: true,
        // Shim Node globals a few deps (e.g. chalk) touch, for the browser.
        banner: "window.process=window.process||{env:{},platform:'browser',cwd:function(){return'/'}};",
      },
      onwarn(message, handler) {
        if (message.code === "EVAL") return; // page-agent's DOM engine
        handler(message);
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Pre-bundle the Spline runtime (used by the 3D agent orb, lazy-loaded) so
  // the dev optimizer doesn't 504 on first import.
  optimizeDeps: {
    include: ["@splinetool/react-spline", "@splinetool/runtime"],
    // Only the app: without this, the dependency scan also crawls the HTML of
    // the reference clones at the root (opencode/, agent-desktop/) and fails on
    // their imports.
    entries: ["index.html"],
  },
  // The PDF renderer runs in a module worker (features/pdf/pdf.worker.ts).
  worker: { format: "es" },
  server: {
    port: 5173,
    // Reference clones and local data: nothing the dev server should watch.
    watch: { ignored: ["**/opencode/**", "**/agent-desktop/**", "**/backend/.data/**"] },
  },
});

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
  },
  server: { port: 5173 },
});

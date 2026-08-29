import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain Vite (not electron-vite) — builds the browser bundle served by
// src/web/server, reusing the same renderer components as the Electron app.
export default defineConfig({
  root: "src/web/client",
  build: {
    outDir: "../../../out/web",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/web/client/index.html",
    },
  },
  plugins: [react()],
});

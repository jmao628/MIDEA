import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built app is served by the same local `http.server` that serves the
// scraped JSON (repo root), at /newsagg/web/dashboard/. In dev, Vite proxies
// /data to that server so the poller can read the JSON.
export default defineConfig({
  base: "/newsagg/web/dashboard/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../web/dashboard",
    // Do NOT empty the output dir first. This dir is served live by the local
    // server; emptying it at build start means any interrupted/failed build
    // leaves the site 404ing until the next full build. Overwriting in place
    // keeps the site up throughout. Old hashed assets linger (harmless; a few
    // KB) — index.html always points at the current bundle.
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/data": "http://localhost:8000",
    },
  },
});

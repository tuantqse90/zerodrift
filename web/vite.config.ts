import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Same-origin proxy for Perpl: the upstream rejects foreign browser Origins on
// both REST (no CORS) and WS (close 1002), so the app talks to /perpl/* and we
// rewrite the Origin header here (Caddy does the same in production).
const perplProxy: ProxyOptions = {
  target: "https://app.perpl.xyz",
  changeOrigin: true,
  ws: true,
  rewrite: (path) => path.replace(/^\/perpl/, ""),
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("Origin", "https://app.perpl.xyz"));
    proxy.on("proxyReqWs", (proxyReq) => proxyReq.setHeader("Origin", "https://app.perpl.xyz"));
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/perpl": perplProxy } },
  preview: { proxy: { "/perpl": perplProxy } },
});

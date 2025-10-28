import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { createProxyServer } from "http-proxy";
import type { Server as HttpProxy } from "http-proxy";

const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8080";

function enhanceProxyLogging(proxy: HttpProxy) {
  proxy.on("proxyReq", (proxyReq, req) => {
    const uid = process.env.VITE_DEBUG_USER_ID ?? "12345";
    proxyReq.setHeader("X-User-Id", uid);
    proxyReq.setHeader("X-Debug-User-Id", uid);
    console.log("[proxy req]", req?.url);
  });
  proxy.on("proxyRes", (res, req) => {
    console.log("[proxy res]", req?.url, res?.statusCode);
  });
  proxy.on("error", (err, req) => {
    console.error("[proxy error]", req?.url, err?.message);
  });
}

function createApiProxyOptions(): ProxyOptions {
  return {
    target: API_PROXY_TARGET,
    changeOrigin: true,
    ws: false,
    secure: false,
    configure(proxy) {
      enhanceProxyLogging(proxy as HttpProxy);
    },
  } satisfies ProxyOptions;
}

function previewProxyPlugin(): Plugin {
  return {
    name: "ogma-preview-proxy",
    apply: "serve",
    configurePreviewServer(server) {
      const proxy = createProxyServer({
        target: API_PROXY_TARGET,
        changeOrigin: true,
        ws: false,
        secure: false,
      });
      enhanceProxyLogging(proxy);

      server.middlewares.use("/api", (req, res) => {
        proxy.web(req, res, undefined, (err) => {
          console.error("[proxy error]", req?.url, err?.message);
          if (!res.headersSent) {
            res.statusCode = 502;
          }
          res.end("Proxy error");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), previewProxyPlugin()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "0.0.0.0",
    port: 5190,
    strictPort: true,
    proxy: {
      "/api": createApiProxyOptions(),
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5194,
    strictPort: true,
  },
});

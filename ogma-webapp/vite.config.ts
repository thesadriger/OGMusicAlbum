import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import httpProxy from "http-proxy";
import type { IncomingMessage, ServerResponse } from "http";

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8080";

function enhanceProxyLogging(proxy: httpProxy) {
  proxy.on(
    "proxyReq",
    (
      proxyReq: any,
      req: IncomingMessage & { url?: string | null | undefined }
    ) => {
      const uid = process.env.VITE_DEBUG_USER_ID ?? "12345";
      proxyReq.setHeader("X-User-Id", uid);
      proxyReq.setHeader("X-Debug-User-Id", uid);
      console.log("[proxy req]", req?.url);
    }
  );

  proxy.on(
    "proxyRes",
    (
      res: { statusCode?: number },
      req: IncomingMessage & { url?: string | null | undefined }
    ) => {
      console.log("[proxy res]", req?.url, res?.statusCode);
    }
  );

  proxy.on(
    "error",
    (
      err: Error & { message?: string },
      req: IncomingMessage & { url?: string | null | undefined }
    ) => {
      console.error("[proxy error]", req?.url, err?.message);
    }
  );
}

function createApiProxyOptions(): ProxyOptions {
  return {
    target: API_PROXY_TARGET,
    changeOrigin: true,
    ws: false,
    secure: false,
    configure(proxy) {
      // vite тут даёт нам не совсем тот тип, TS думает "unknown"
      enhanceProxyLogging(proxy as unknown as httpProxy);
    },
  } satisfies ProxyOptions;
}

function previewProxyPlugin(): Plugin {
  return {
    name: "ogma-preview-proxy",
    apply: "serve",
    configurePreviewServer(server) {
      const proxy = httpProxy.createProxyServer({
        target: API_PROXY_TARGET,
        changeOrigin: true,
        ws: false,
        secure: false,
      });
      enhanceProxyLogging(proxy);

      server.middlewares.use(
        "/api",
        (req: IncomingMessage, res: ServerResponse) => {
          proxy.web(req, res, undefined, (err: Error & { message?: string }) => {
            console.error("[proxy error]", req?.url, err?.message);
            if (!res.headersSent) {
              res.statusCode = 502;
            }
            res.end("Proxy error");
          });
        }
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), previewProxyPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
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
//home/ogma/ogma/ogma-webapp/vite.config.ts
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let httpProxy: any = null;
try {
  httpProxy = require("http-proxy");
} catch {
  httpProxy = null;
}
import type { IncomingMessage, ServerResponse } from "http";

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8080";

function enhanceProxyLogging(proxy: any) {
  if (!proxy) return;
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
      enhanceProxyLogging(proxy as any);
    },
  } satisfies ProxyOptions;
}

function previewProxyPlugin(): Plugin {
  return {
    name: "ogma-preview-proxy",
    apply: "serve",
    configurePreviewServer(server) {
      if (!httpProxy) return;
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
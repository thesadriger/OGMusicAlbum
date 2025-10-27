import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "0.0.0.0",
    port: 5190,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: false,
        secure: false,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, req) => {
            // proxyReq.setHeader("X-Debug-User-Id", process.env.VITE_DEBUG_USER_ID ?? "12345");
            const uid = process.env.VITE_DEBUG_USER_ID ?? "12345";
            proxyReq.setHeader("X-User-Id", uid);        // <-- важно
            proxyReq.setHeader("X-Debug-User-Id", uid);  // опционально, для лога/совместимости
            console.log("[proxy req]", req?.url);
          });
          proxy.on("proxyRes", (res, req) => {
            console.log("[proxy res]", req?.url, res?.statusCode);
          });
          proxy.on("error", (err, req) => {
            // никаких err.code, только message
            console.error("[proxy error]", req?.url, (err as any)?.message);
          });
        },
      },
    },
  },
});

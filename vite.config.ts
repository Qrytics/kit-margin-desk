import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;
const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss", host, port: parseInt(process.env.FRONTEND_PORT!) || 8002, clientPort: 443 };

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react", "@shopify/polaris"] },
} as never);

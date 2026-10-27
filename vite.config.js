import { defineConfig, loadEnv } from "vite";

// Proxy /stac to Montandon so the token stays server-side and CORS isn't an issue.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "./",
    // Only a yes/no flag reaches the bundle, never the token itself.
    define: { __HAS_ENV_TOKEN__: JSON.stringify(mode === "development" && !!env.MONTANDON_TOKEN) },
    server: {
      proxy: {
        "/stac": {
          target: "https://montandon-eoapi.ifrc.org",
          changeOrigin: true,
          headers: { Authorization: `Bearer ${env.MONTANDON_TOKEN}` },
        },
      },
    },
  };
});

import { defineConfig, loadEnv } from "vite";

// Proxy /stac to Montandon so the token stays server-side and CORS isn't an issue.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
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

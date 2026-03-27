import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid(), cloudflare()],
  server: {
    allowedHosts: true,
  },
});

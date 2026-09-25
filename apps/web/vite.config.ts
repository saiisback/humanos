import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  // The deployment and local example env files live at the repository root.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
});

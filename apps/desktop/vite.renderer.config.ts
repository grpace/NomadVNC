import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { getMetaCsp } from "./src/main/csp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Bake the matching CSP `<meta>` into `index.html` (covers `file://` production loads). */
function cspMetaPlugin(isPackaged: boolean): Plugin {
  const metaCsp = getMetaCsp(isPackaged);
  return {
    name: "nomadvnc-csp-meta",
    transformIndexHtml(html: string): string {
      if (html.includes("http-equiv=\"Content-Security-Policy\"")) {
        return html;
      }
      return html.replace(
        /<head([^>]*)>/i,
        `<head$1>\n    <meta http-equiv="Content-Security-Policy" content="${metaCsp}" />`,
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [
    react(),
    cspMetaPlugin(command === "build"),
  ],
  server:
    command === "serve"
      ? {
          port: 5173,
          strictPort: true,
          host: "127.0.0.1",
        }
      : undefined,
  build: {
    // Electron 41 ships a current Chromium. Vite's default browser target
    // asks esbuild to downlevel destructuring, and that transform fails
    // the package build.
    target: "chrome130",
    outDir: path.resolve(__dirname, "dist-electron/renderer"),
    emptyOutDir: true,
  },
}));

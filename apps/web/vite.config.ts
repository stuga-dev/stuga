/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { thirdPartyLicenses } from "../../packaging/shared/third-party-licenses.mjs";

/**
 * The node this dev server proxies to. Only VITE_-prefixed variables reach
 * client code, so nothing else in the environment can leak into the bundle.
 */
const NODE = process.env.STUGA_NODE ?? "http://127.0.0.1:8787";

/** The app's pages under /auth, where a sign-in through the identity provider lands; the node leaves them to the app too. */
const SPA_AUTH_PAGES = new Set(["/auth/complete", "/auth/first-visit"]);

/**
 * dist/third-party-licenses.txt: every npm package whose code the build put into the bundle, with its
 * license. The node serves it like the rest of dist, and the bundle's first line points to it.
 */
function licenseList(): Plugin {
  return {
    name: "stuga-third-party-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((out) => (out.type === "chunk" ? Object.keys(out.modules) : []));
      const heading = `Third-party software in the Stuga web app

The web app is part of Stuga, AGPL-3.0-only: https://github.com/stuga-dev/stuga. Its bundle includes the
npm packages below, each under its own license.`;
      this.emitFile({ type: "asset", fileName: "third-party-licenses.txt", source: thirdPartyLicenses(modules, heading) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), licenseList()],
  resolve: {
    alias: [{ find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: fileURLToPath(new URL("./src/editor/elk-unavailable.ts", import.meta.url)) }],
  },
  server: {
    port: 3001,
    proxy: {
      // During `vite dev` the SPA is served from here and everything else is
      // forwarded to the node, so the app sees one origin exactly as it does
      // when the node serves the built bundle itself.
      "/api": { target: NODE, changeOrigin: true },
      "/ws": { target: NODE.replace(/^http/, "ws"), ws: true },
      "/auth": {
        target: NODE,
        changeOrigin: true,
        bypass: (req) =>
          req.method === "GET" && SPA_AUTH_PAGES.has((req.url ?? "").split("?")[0]!) ? "/index.html" : undefined,
      },
      "/mcp": { target: NODE, changeOrigin: true },
      "/oauth": { target: NODE, changeOrigin: true },
      "/.well-known": { target: NODE, changeOrigin: true },
      // Without this the SPA fallback answers /ready with index.html and a 200.
      "/ready": { target: NODE, changeOrigin: true },
    },
  },
  test: {
    setupFiles: ["./src/test/dom-setup.ts"],
  },
  build: {
    // No maps in a build: the node serves all of dist unauthenticated, and a .map (hidden or not) carries the full source.
    sourcemap: mode === "development",
    outDir: "dist",
    rolldownOptions: {
      // After minification, which drops comments.
      output: { postBanner: "/*! Stuga, AGPL-3.0-only. Third-party licenses: /third-party-licenses.txt */" },
    },
  },
}));

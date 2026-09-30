import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import sourceTestExclusions from "./source-test-exclusions.json";

const nodeTestFiles = [
  "scripts/build-creative-previews.test.mjs",
  "scripts/build-personal-visual-pack.test.mjs",
  "scripts/creative-pack-rights.test.mjs",
  "scripts/font-em-metrics.test.mjs",
  "scripts/font-source-acquisition.test.mjs",
  "scripts/open-source-preflight.test.mjs",
  "scripts/lib/cargo-artifact-path.test.mjs",
  "scripts/lib/cargo-lock-preflight.test.mjs",
  "scripts/lib/desktop-stage-target-policy.test.mjs",
  "scripts/lib/native-shared-inputs.test.mjs",
  "scripts/lib/owned-process-runner.test.mjs",
  "scripts/lib/tauri-candidate-artifact-root.test.mjs",
  "scripts/material-color-runtime-pair.test.mjs",
  "src/shared/visualAssetRights.test.mjs",
];

const lanOrigin = process.env.EDITKIN_PNY_ORIGIN;
if (lanOrigin) {
  const endpoint = new URL(lanOrigin);
  const host = endpoint.hostname;
  if (endpoint.protocol !== "http:" || !(/^(?:127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host))
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("EDITKIN_PNY_ORIGIN must be an HTTP loopback or private LAN address");
  }
}

export default defineConfig(({ command }) => ({
  // Electron/Tauri load the production UI from a file:// URL. Absolute
  // `/assets/*` URLs resolve from the filesystem root and leave a blank
  // window, so every production asset must remain relative to index.html.
  base: "./",
  // Release builds embed only the UI-critical web surface. Large OCIO LUTs
  // and static render faces stay in Tauri/Electron resources and are loaded
  // through bounded desktop commands instead of being duplicated in the EXE.
  publicDir: command === "build" ? ".web-public" : "public",
  plugins: [react(), {
    // Crawlers require absolute og:url / og:image and the deployment origin is
    // not known to the repository, so only the Pages workflow supplies it.
    // Desktop builds leave EDITKIN_SITE_URL unset and get no absolute URLs.
    name: "editkin-site-url",
    transformIndexHtml() {
      const raw = process.env.EDITKIN_SITE_URL;
      if (!raw) return [];
      const site = new URL(raw.endsWith("/") ? raw : `${raw}/`);
      if (site.protocol !== "https:") throw new Error(`EDITKIN_SITE_URL must be https: ${raw}`);
      return [
        { tag: "meta", attrs: { property: "og:url", content: site.href }, injectTo: "head" },
        { tag: "meta", attrs: { property: "og:image", content: new URL("og-image.png", site).href }, injectTo: "head" },
        { tag: "meta", attrs: { name: "twitter:image", content: new URL("og-image.png", site).href }, injectTo: "head" },
        { tag: "link", attrs: { rel: "canonical", href: site.href }, injectTo: "head" },
      ];
    },
  }],
  test: {
    // Retained fail-before experiments are replayed explicitly against their
    // captured source; they are not current product regression entry points.
    exclude: [
      ...configDefaults.exclude,
      ".rd/**",
      ...nodeTestFiles,
      ...(process.platform === "win32" ? [] : ["scripts/electron-update-ipc.test.ts"]),
      ...(process.env.EDITKIN_FULL_TESTS === "1" ? [] : sourceTestExclusions.entries.map(row => row.file)),
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom/client", "react/jsx-runtime"],
        },
      },
    },
  },
  server: {
    strictPort: true,
    // The LAN endpoint is supplied by the operator at launch; never commit it.
    ...(lanOrigin ? { proxy: {
      "/__local_llm/pny": {
        target: lanOrigin,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/__local_llm\/pny/, ""),
      },
    } } : {}),
  },
}));

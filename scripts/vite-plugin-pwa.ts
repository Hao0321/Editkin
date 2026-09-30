import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`);

// Icons reuse files already approved by the public-source binary policy
// (only src-tauri/icons may hold PNGs), so no new binary enters the tree.
const ICONS = [
  { fileName: "icons/icon-256.png", source: "src-tauri/icons/128x128@2x.png", sizes: "256x256" },
  { fileName: "icons/icon-512.png", source: "src-tauri/icons/icon.png", sizes: "512x512" },
];

const manifest = {
  name: "Editkin",
  short_name: "Editkin",
  description: "本機優先的自動剪輯工作台。網頁版為桌面版介面的瀏覽器試玩版。",
  lang: "zh-Hant",
  // Relative to the manifest URL, so the app works under any Pages sub-path.
  start_url: "./",
  scope: "./",
  display: "standalone",
  background_color: "#0a0b0f",
  theme_color: "#0a0b0f",
  icons: ICONS.map(({ fileName, sizes }) => ({ src: fileName, sizes, type: "image/png", purpose: "any" })),
};

/**
 * Turns the browser build into an installable, offline-capable PWA.
 * Disabled by default: desktop builds (Tauri/Electron, file://) must not ship
 * a manifest or service worker, so the Pages workflow opts in explicitly.
 */
export function editkinPwa({ enabled }: { enabled: boolean }): Plugin {
  return {
    name: "editkin-pwa",
    apply: "build",
    transformIndexHtml() {
      if (!enabled) return [];
      return [
        { tag: "link", attrs: { rel: "manifest", href: "./manifest.webmanifest" }, injectTo: "head" },
        { tag: "script", attrs: { type: "module", src: "./pwa-register.js" }, injectTo: "head" },
      ];
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (!enabled) return;
        const assets: Record<string, string | Buffer> = {
          "manifest.webmanifest": `${JSON.stringify(manifest, null, 2)}\n`,
          "pwa-register.js": read("scripts/pwa/register.js"),
          ...Object.fromEntries(ICONS.map(({ fileName, source }) => [fileName, read(source)])),
        };
        for (const [fileName, source] of Object.entries(assets)) this.emitFile({ type: "asset", fileName, source });
        // Fonts, demo media and benchmarks come from the public directory and
        // are deliberately not precached (see service-worker.js).
        const precache = [...new Set([...Object.keys(bundle), ...Object.keys(assets), "index.html"])]
          .filter((file) => !file.endsWith(".map"))
          .sort();
        const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 16);
        const worker = read("scripts/pwa/service-worker.js").toString("utf8")
          .replace('"__EDITKIN_VERSION__"', JSON.stringify(version))
          .replace('"__EDITKIN_PRECACHE__"', JSON.stringify(precache));
        this.emitFile({ type: "asset", fileName: "sw.js", source: worker });
      },
    },
  };
}

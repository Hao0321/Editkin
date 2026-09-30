import { describe, expect, it } from "vitest";
import { editkinPwa } from "./vite-plugin-pwa";

function run(enabled: boolean, files: string[]) {
  const plugin = editkinPwa({ enabled });
  const emitted = new Map<string, string | Uint8Array>();
  const bundle = Object.fromEntries(files.map((file) => [file, {}]));
  const handler = (plugin.generateBundle as { handler: (this: unknown, options: unknown, bundle: unknown) => void }).handler;
  handler.call({ emitFile: (file: { fileName: string; source: string | Uint8Array }) => emitted.set(file.fileName, file.source) }, {}, bundle);
  const html = (plugin.transformIndexHtml as () => unknown[])();
  return { emitted, html };
}

describe("editkinPwa", () => {
  it("leaves desktop builds untouched unless explicitly enabled", () => {
    const { emitted, html } = run(false, ["index.html", "assets/index-abc.js"]);
    expect(emitted.size).toBe(0);
    expect(html).toEqual([]);
  });

  it("emits a relocatable manifest and a worker that precaches the shell but not fonts, maps or media", () => {
    const { emitted, html } = run(true, ["index.html", "assets/index-abc.js", "assets/index-abc.js.map", "assets/App-1.css"]);
    const manifest = JSON.parse(String(emitted.get("manifest.webmanifest")));
    expect(manifest).toMatchObject({ start_url: "./", scope: "./", display: "standalone", lang: "zh-Hant" });
    expect(manifest.icons.map((icon: { src: string }) => icon.src).every((src: string) => emitted.has(src))).toBe(true);
    const worker = String(emitted.get("sw.js"));
    expect(worker).not.toContain("__EDITKIN_");
    const precache: string[] = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(worker)![1]);
    expect(precache).toEqual(expect.arrayContaining(["index.html", "assets/index-abc.js", "assets/App-1.css", "manifest.webmanifest", "pwa-register.js", "icons/icon-512.png"]));
    expect(precache.some((file) => file.endsWith(".map") || file.includes("fonts/") || file.endsWith(".mp4"))).toBe(false);
    expect(html).toHaveLength(2);
  });

  it("changes the cache version whenever the shell file set changes", () => {
    const version = (files: string[]) => /const VERSION = "([0-9a-f]+)"/.exec(String(run(true, files).emitted.get("sw.js")))![1];
    expect(version(["index.html", "assets/a-1.js"])).toBe(version(["index.html", "assets/a-1.js"]));
    expect(version(["index.html", "assets/a-1.js"])).not.toBe(version(["index.html", "assets/a-2.js"]));
  });
});

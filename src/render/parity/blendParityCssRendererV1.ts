import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PNG } from "pngjs";
import { activeMediaLayers } from "../../application/previewMedia";
import { Preview } from "../../ui/Preview";
import { PARITY_CANVAS_V1, parityFixtureProjectV1, type ParityFixtureV1 } from "./blendParityFixturesV1";
import { sampleParityPixelsV1, type ParityRendererV1 } from "./blendParityHarnessV1";

const APP_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** Default Chromium-family browsers on Windows (headless use only; a fresh profile under the work directory). */
export function findParityBrowserV1(): string | undefined {
  const candidates = [
    process.env.EDITKIN_PARITY_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

/** Minimal Chrome DevTools Protocol client over the browser WebSocket (flattened sessions). */
export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: { method?: string; params?: unknown; sessionId?: string }) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
  }
  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => rejectOpen(Error("CDP socket error")), { once: true });
    });
    return new CdpClient(socket);
  }
  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId += 1;
    return new Promise<T>((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: value => resolveSend(value as T), reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); rejectWait(Error(`CDP timeout waiting for ${method}`)); }, timeoutMs);
      const listener = (message: { method?: string; sessionId?: string }) => {
        if (message.method === method && message.sessionId === sessionId) { clearTimeout(timer); this.listeners.delete(listener); resolveWait(); }
      };
      this.listeners.add(listener);
    });
  }
  close(): void { this.socket.close(); }
}

const OVERRIDES = `
html, body { margin: 0; padding: 0; background: #000; }
#parity-root .preview-viewport { position: fixed; left: 0; top: 0; width: ${PARITY_CANVAS_V1.width}px; height: ${PARITY_CANVAS_V1.height}px; }
#parity-root .preview-stage { border-radius: 0; box-shadow: none; }
#parity-root .preview-play, #parity-root .playback-controls, #parity-root [data-testid="playback-controls"] { display: none !important; }
`;

/**
 * The CSS compatible preview, headlessly: the real `Preview` component (server-rendered with the layers
 * `activeMediaLayers` selects), the app's own stylesheets, drawn by headless Chromium and captured over CDP at device
 * scale 1 with an sRGB colour profile. Only measurement chrome changes: the stage is pinned to the canvas size, its
 * rounded corner/shadow are removed and the playback controls are hidden. ACES 2 layers draw through WebGL/OCIO
 * effects, which a static render does not run; those fixtures are declined here.
 */
export function createParityCssRendererV1(options: { browserPath?: string; timeoutMs?: number } = {}): ParityRendererV1 {
  const browserPath = options.browserPath ?? findParityBrowserV1();
  let browser: ChildProcess | undefined;
  let client: CdpClient | undefined;
  let sessionId: string | undefined;
  let profile: string | undefined;
  let sequence = 0;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function start(workDirectory: string): Promise<void> {
    if (client) return;
    profile = join(workDirectory, "css", `chrome-profile-${process.pid}`);
    await mkdir(profile, { recursive: true });
    browser = spawn(browserPath!, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--force-color-profile=srgb",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync",
      "--disable-component-update", "--disable-default-apps", "--mute-audio", "--hide-scrollbars", "--allow-file-access-from-files", "about:blank"],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
      let text = "";
      const timer = setTimeout(() => rejectEndpoint(Error("headless browser did not report a DevTools endpoint")), timeoutMs);
      browser!.stderr!.on("data", chunk => {
        text += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
        if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
      });
      browser!.once("exit", code => { clearTimeout(timer); rejectEndpoint(Error(`headless browser exited (${code})`)); });
    });
    client = await CdpClient.connect(endpoint);
    const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 256, height: 128, deviceScaleFactor: 1, mobile: false }, sessionId);
  }

  return {
    id: "css",
    route: "css:compatible-preview(Preview SSR, headless Chromium)",
    async available() {
      if (!browserPath) return { ok: false, reason: "no Chromium-family browser found for headless rendering" };
      if (typeof WebSocket !== "function") return { ok: false, reason: "this Node has no WebSocket client (needs Node 22)" };
      return { ok: true };
    },
    async render(fixture: ParityFixtureV1, context) {
      if (fixture.colour !== "rec709") return { kind: "declined", reason: "ACES 2 preview draws through WebGL/OCIO; not evaluated by the static CSS harness" };
      await start(context.workDirectory);
      const project = parityFixtureProjectV1(fixture, image => pathToFileURL(context.imagePaths[image]).href);
      const layers = activeMediaLayers(project, 0, {}, "video");
      const markup = renderToStaticMarkup(createElement(Preview, {
        layers, audioLayers: [], projectWidth: project.width, projectHeight: project.height, playhead: 0, projectDuration: PARITY_CANVAS_V1.duration,
        projectFps: project.fps, captions: [], captionStyle: project.captionStyle, project, playing: false,
        onPlayingChange: () => undefined, onPlayheadChange: () => undefined,
      }));
      const css = ["src/styles.css", "src/ui/captionPreview.css"].map(path => `<link rel="stylesheet" href="${pathToFileURL(join(APP_ROOT, path)).href}">`).join("");
      const html = `<!doctype html><html><head><meta charset="utf-8">${css}<style>${OVERRIDES}</style></head><body><div id="parity-root">${markup}</div></body></html>`;
      const directory = join(context.workDirectory, "css");
      await mkdir(directory, { recursive: true });
      const page = join(directory, `page-${sequence += 1}.html`);
      await writeFile(page, html, "utf8");
      const loaded = client!.waitFor("Page.loadEventFired", sessionId!, timeoutMs);
      await client!.send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
      await loaded;
      const settle = await client!.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression: `(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
          await new Promise(done => setTimeout(done, 150)); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          const stage = document.querySelector("#parity-root .preview-stage"); if (!stage) return "no-stage";
          const rect = stage.getBoundingClientRect(); const blocked = document.querySelector("#parity-root [role=alert], #parity-root .empty-preview");
          return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, blocked: blocked ? blocked.textContent : null }); })()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      const value = settle.result.value;
      if (!value || value === "no-stage") throw Error("CSS preview stage not rendered");
      const rect = JSON.parse(value) as { x: number; y: number; width: number; height: number; blocked: string | null };
      if (rect.blocked) return { kind: "declined", reason: `CSS preview refused this layer: ${rect.blocked.trim().slice(0, 160)}` };
      if (Math.round(rect.width) !== PARITY_CANVAS_V1.width || Math.round(rect.height) !== PARITY_CANVAS_V1.height) throw Error(`CSS stage ${rect.width}x${rect.height}`);
      const shot = await client!.send<{ data: string }>("Page.captureScreenshot", {
        format: "png", clip: { x: rect.x, y: rect.y, width: PARITY_CANVAS_V1.width, height: PARITY_CANVAS_V1.height, scale: 1 },
      }, sessionId);
      const png = PNG.sync.read(Buffer.from(shot.data, "base64"));
      return { kind: "measured", samples: sampleParityPixelsV1(png.data, png.width, 4) };
    },
    async dispose() {
      client?.close();
      client = undefined;
      if (browser && browser.exitCode === null) {
        await new Promise<void>(done => { browser!.once("exit", () => done()); browser!.kill(); setTimeout(done, 5_000); });
      }
      browser = undefined;
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    },
  };
}

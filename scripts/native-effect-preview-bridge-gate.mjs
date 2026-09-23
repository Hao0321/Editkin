import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baseline = process.argv.includes("--baseline");
const executableArgument = process.argv.find((argument, index) => index > 1 && !argument.startsWith("--"));
const executable = resolve(root, executableArgument ?? "src-tauri/target/release/editkin.exe");
const reportRoot = resolve(root, "../../.rd/benchmarks/editkin-native-effect-preview-bridge");
const stateRoot = resolve(reportRoot, baseline ? "baseline-state" : "current-state");
await rm(stateRoot, { recursive: true, force: true });
await mkdir(stateRoot, { recursive: true });

let journeyProject;
if (!baseline) {
  const pluginDirectory = resolve(stateRoot, "data/plugins/native-effect-preview-bridge");
  await mkdir(resolve(pluginDirectory, "bin"), { recursive: true });
  const librarySource = resolve(root, "native/effect-test-plugin/target/release/editkin_effect_test_plugin.dll");
  const libraryPath = resolve(pluginDirectory, "bin/editkin_effect_test_plugin.dll");
  await copyFile(librarySource, libraryPath);
  const librarySha256 = createHash("sha256").update(await readFile(libraryPath)).digest("hex");
  const manifest = {
    schema: "editkin.plugin/v1", id: "editkin.diagnostic.preview-bridge", name: "Preview Bridge Native Gain", version: "1.0.0",
    minimumHostVersion: "0.15.0", publisher: { name: "Editkin Gate" }, license: { spdx: "MIT", commercialUse: true }, permissions: ["render.effect"],
    capabilities: [{
      id: "gain-invert", name: "Gain Invert", description: "Delivered bridge diagnostic", kind: "effect", automation: "manual",
      semanticRoles: ["diagnostic"], formats: ["any"], requires: [], avoidWhen: [],
      parameters: [
        { id: "gain", name: "Gain", type: "number", default: 0.8, min: 0, max: 2 },
        { id: "invert", name: "Invert", type: "number", default: 0.25, min: 0, max: 1 },
        { id: "fault", name: "Fault", type: "number", default: 0, min: 0, max: 3 },
      ],
      runtime: { type: "native_effect", abiVersion: 2, entrySymbol: "editkin_effect_plugin_v2", libraries: { "win32-x64": { path: "bin/editkin_effect_test_plugin.dll", sha256: librarySha256 } }, supportedFormats: ["rgba32_float"], maxTemporalRadius: 0, timeoutMs: 100 },
    }],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  await writeFile(resolve(pluginDirectory, "editkin-plugin.json"), manifestText, "utf8");
  const neutralColor = { brightness: 0, contrast: 1, saturation: 1, hue: 0, exposure: 0, temperature: 0, tint: 0, pivot: 0.5, shadows: 0, highlights: 0, blacks: 0, whites: 0 };
  journeyProject = {
    schemaVersion: 8, revision: 0, id: "native-effect-preview-bridge", name: "Native Effect Preview Bridge", width: 64, height: 36, fps: 30, editorialProfile: "auto",
    colorManagement: { mode: "rec709", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" },
    assets: [{ id: "source", name: "source", kind: "video", uri: resolve(root, "public/demo-source.mp4"), duration: 0.4, width: 960, height: 540, color: { interpretation: "rec709" } }],
    compositions: [],
    tracks: [{ id: "video-main", name: "主畫面", kind: "video", locked: false, muted: false, clips: [{
      id: "clip-native-preview", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 0.4, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: neutralColor, keyframes: [], layer: { enabled: true, blendMode: "normal", role: "content" }, expressions: {},
      creative: { effectPresetIds: [], nativeEffectInstances: [{ id: "native-preview-1", pluginId: manifest.id, capabilityId: "gain-invert", pluginVersion: manifest.version, manifestSha256, enabled: true, parameters: { gain: 0.8, invert: 0.25, fault: 0 } }] },
    }] }],
    captions: [],
    captionStyle: { presetId: "hao-bold", fontFamily: "Noto Sans TC", fontSize: 36, color: "#FFFFFF", outlineColor: "#000000", outlineWidth: 3, alignment: 2, marginV: 36, bold: true, italic: false, shadow: 1, backgroundColor: "#00000000", letterSpacing: 0, translationFontFamily: "Noto Sans TC", translationFontSize: 36, translationColor: "#DCE8FF", translationBold: true, translationItalic: false },
    motionTracks: [], motionGraphics: [], director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: new Date().toISOString() }, updatedAt: new Date().toISOString(),
  };
}

const port = await new Promise((resolvePromise, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePromise(selected));
  });
});
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    EDITKIN_INTEGRATION_SMOKE: "1",
    EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
    WEBVIEW2_USER_DATA_FOLDER: resolve(stateRoot, "webview2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function stop() {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), delay(3_000)]);
  if (child.exitCode === null && process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

async function findPage() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${basename(executable)} exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const pages = (await response.json()).filter((item) => item.type === "page" && item.webSocketDebuggerUrl);
        const page = pages.find((item) => /^https?:\/\/tauri\.localhost\//.test(item.url ?? "")) ?? pages.find((item) => item.url !== "about:blank");
        if (page) return page;
      }
    } catch { /* WebView2 is still starting. */ }
    await delay(150);
  }
  throw new Error("Editkin WebView2 debug target did not start");
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP socket open timeout")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    return await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP Runtime.evaluate timeout")), 10_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text ?? "CDP exception"));
        else resolvePromise(JSON.parse(message.result.result.value));
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally {
    socket.close();
  }
}

let observation;
let journey;
try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = await findPage();
    observation = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({desktop:typeof window.haoDesktop,bridge:typeof window.haoDesktop?.renderNativeEffectPreview,isDesktop:window.haoDesktop?.isDesktop===true,heading:document.querySelector('.brand-copy strong')?.textContent||''})");
    if (observation.desktop === "object" && observation.isDesktop && observation.heading === "Editkin") break;
    await delay(150);
  }
  if (!observation?.isDesktop || observation.heading !== "Editkin") throw new Error(`Editkin did not become interactive: ${JSON.stringify(observation)}`);
  const expectedBridge = baseline ? "undefined" : "function";
  if (observation.bridge !== expectedBridge) throw new Error(`renderNativeEffectPreview bridge was ${observation.bridge}; expected ${expectedBridge}`);
  if (!baseline) {
    const page = await findPage();
    const first = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.renderNativeEffectPreview(${JSON.stringify(journeyProject)},'clip-native-preview').then(value=>JSON.stringify(value))`);
    const second = await evaluate(page.webSocketDebuggerUrl, `window.haoDesktop.renderNativeEffectPreview(${JSON.stringify(journeyProject)},'clip-native-preview').then(value=>JSON.stringify(value))`);
    if (first.status !== "GREEN" || first.cacheHit || !second.cacheHit || first.cacheKey !== second.cacheKey || first.previewUrl !== second.previewUrl) {
      throw new Error(`delivered preview bridge cache journey failed: ${JSON.stringify({ first, second })}`);
    }
    const bytes = await readFile(first.path);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!bytes.length || actualSha256 !== first.sha256 || !/^https?:\/\/asset\.localhost\//.test(first.previewUrl)) {
      throw new Error(`delivered preview artifact failed integrity/protocol checks: ${JSON.stringify({ bytes: bytes.length, actualSha256, receiptSha256: first.sha256, previewUrl: first.previewUrl })}`);
    }
    journey = { firstCacheHit: first.cacheHit, secondCacheHit: second.cacheHit, cacheKey: first.cacheKey, bytes: bytes.length, sha256: first.sha256, previewUrlProtocol: new URL(first.previewUrl).protocol, mode: first.mode, audioSourceRetained: first.audioSourceRetained };
  }
  const report = {
    schemaVersion: 1,
    status: baseline ? "BLOCK" : "GREEN",
    expectedBridge,
    observation,
    journey,
    executable,
    executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
  };
  await mkdir(reportRoot, { recursive: true });
  await writeFile(resolve(reportRoot, baseline ? "baseline-report.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await stop();
}

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
if (typeof WebSocket === "undefined" && process.platform === "win32") {
  const bundledNode = join(appRoot, "vendor/node/win32-x64/node.exe");
  if (!existsSync(bundledNode)) throw new Error(`Bundled Node.js with WebSocket support is missing: ${bundledNode}`);
  const relaunched = spawnSync(bundledNode, [import.meta.filename, ...process.argv.slice(2)], { windowsHide: true, stdio: "inherit" });
  process.exit(relaunched.status ?? 1);
}
const executable = resolve(process.argv[2] ?? "src-tauri/target/release/editkin.exe");
const packRoot = join(repoRoot, ".rd/model-packs/editkin-auto-roto-sam21-tiny-windows-cuda-1.0.3");
const reportRoot = join(appRoot, ".rd/benchmarks/editkin-auto-roto-tauri-model-lifecycle");
const reportPath = join(reportRoot, "report.json");
const stateParent = join(repoRoot, ".rd/tmp");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); });
});
await mkdir(stateParent, { recursive: true });
await mkdir(reportRoot, { recursive: true });
const stateRoot = await mkdtemp(join(stateParent, "editkin-auto-roto-lifecycle-"));
const child = spawn(executable, [], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot, WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-32_000); });

async function pageTarget() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Editkin exited during startup: ${child.exitCode} ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const pages = (await response.json()).filter((item) => item.type === "page");
        const page = pages.find((item) => /^https?:\/\/tauri\.localhost\//.test(item.url ?? "")) ?? pages.find((item) => item.url && item.url !== "about:blank");
        if (page) return page;
      }
    } catch { /* still starting */ }
    await delay(200);
  }
  throw new Error("Editkin WebView2 did not become available");
}

let socket; let nextId = 0; const pending = new Map();
async function connect(url) {
  if (socket?.readyState === WebSocket.OPEN) return socket;
  socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  return socket;
}

async function evaluate(url, expression, timeoutMs = 30_000) {
  const channel = await connect(url); const id = ++nextId;
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP evaluation timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve: resolveResult, reject, timer });
    channel.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return JSON.parse(result.result.value);
}

function invokeExpression(method, args = {}) {
  return `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(method)},${JSON.stringify(args)}).then(value=>JSON.stringify(value))`;
}

async function stop() {
  socket?.close();
  socket = undefined;
  if (child.exitCode === null && child.pid && process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else if (child.exitCode === null) {
    child.kill();
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(5_000),
    ]);
  }
}

async function removeStateRoot() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(stateRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 11) throw error;
      await delay(250 * (attempt + 1));
    }
  }
}

const started = performance.now();
try {
  const page = await pageTarget();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ready = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({desktop:typeof window.haoDesktop,root:Boolean(document.querySelector('#root')?.childNodes.length)})");
    if (ready.desktop === "object" && ready.root) break;
    if (attempt === 299) throw new Error("Editkin UI did not become interactive");
    await delay(200);
  }
  await evaluate(page.webSocketDebuggerUrl, `(()=>{window.__editkinLifecycleTrace=[];const note=(type,value='')=>window.__editkinLifecycleTrace.push({type,value:String(value)});window.addEventListener('error',event=>note('error',event.error?.stack||event.message));window.addEventListener('unhandledrejection',event=>note('unhandledrejection',event.reason?.stack||event.reason));const root=document.querySelector('#root');if(root)new MutationObserver(()=>{if(!root.childNodes.length)note('root-empty')}).observe(root,{childList:true});return JSON.stringify(true)})()`);
  const missing = await evaluate(page.webSocketDebuggerUrl, invokeExpression("inspect_auto_roto_video_model"));
  const installStarted = performance.now();
  const installed = await evaluate(page.webSocketDebuggerUrl, invokeExpression("install_auto_roto_video_model", { sourceRoot: packRoot }), 1_200_000);
  const installSeconds = (performance.now() - installStarted) / 1000;
  const verified = await evaluate(page.webSocketDebuggerUrl, invokeExpression("inspect_auto_roto_video_model"), 120_000);
  const installedRoot = installed.root;
  const markerPath = join(installedRoot, "source/UPSTREAM_COMMIT");
  const originalMarker = await readFile(markerPath);
  await writeFile(markerPath, Buffer.concat([originalMarker, Buffer.from("tamper")]));
  const corrupt = await evaluate(page.webSocketDebuggerUrl, invokeExpression("inspect_auto_roto_video_model"), 120_000);
  const repairStarted = performance.now();
  const repaired = await evaluate(page.webSocketDebuggerUrl, invokeExpression("repair_auto_roto_video_model", { sourceRoot: packRoot }), 1_200_000);
  const repairSeconds = (performance.now() - repairStarted) / 1000;
  const reverified = await evaluate(page.webSocketDebuggerUrl, invokeExpression("inspect_auto_roto_video_model"), 120_000);
  const trace = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify(window.__editkinLifecycleTrace||[])");
  const checks = {
    freshInstallMissing: missing.status === "missing" && missing.nativeFallback === true,
    installVerified: installed.status === "installed" && installed.active?.status === "verified" && installed.copied?.files >= 5_000 && installed.copied?.bytes >= 4_000_000_000,
    activeIdentity: verified.status === "verified" && verified.pack?.identity?.manifestSha256 === installed.active?.identity?.manifestSha256 && verified.pack?.identity?.publisherKeyId === "editkin-auto-roto-production-2026",
    corruptionDetected: corrupt.status === "corrupt" && corrupt.nativeFallback === true,
    repairedAndReverified: repaired.status === "installed" && reverified.status === "verified" && reverified.pack?.identity?.manifestSha256 === verified.pack?.identity?.manifestSha256,
    uiStable: trace.length === 0,
  };
  const status = Object.values(checks).every(Boolean) ? "GREEN_TAURI_MODEL_LIFECYCLE" : "FAIL";
  const report = {
    schema: "editkin.auto-roto-tauri-model-lifecycle-gate/v1", status, checks,
    timing: { installSeconds, repairSeconds, totalSeconds: (performance.now() - started) / 1000 },
    delivery: { executable, executableBytes: (await stat(executable)).size, executableSha256: sha256(await readFile(executable)) },
    pack: { source: packRoot, manifestSha256: verified.pack?.identity?.manifestSha256, copied: installed.copied }, trace,
    claimBoundary: "Proves a fresh delivered Windows Editkin app reports native fallback, installs a separately signed closed-world pack, detects an on-disk mutation, repairs it, and keeps the UI alive. Public Authenticode/download transport and macOS remain separate scopes.",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`AUTO_ROTO_TAURI_LIFECYCLE status=${status} install=${installSeconds.toFixed(1)}s repair=${repairSeconds.toFixed(1)}s report=${reportPath}\n`);
  if (status === "FAIL") process.exitCode = 1;
} finally {
  await stop();
  await removeStateRoot();
}

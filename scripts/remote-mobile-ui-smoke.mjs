import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assessRemoteMobileUi } from "./lib/remote-mobile-ui.mjs";

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const allocatePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("無法配置測試連接埠")));
  });
});

function browserExecutable() {
  const candidates = [
    process.env.EDITKIN_CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("找不到可供手機 UI 幾何測試使用的 Chrome／Edge");
  return executable;
}

function cdpCommand(webSocketDebuggerUrl, method, params = {}, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else resolvePromise(message.result ?? {});
    });
    socket.addEventListener("error", reject);
  });
}

async function evaluate(webSocketDebuggerUrl, expression, timeoutMs = 5_000) {
  const result = await cdpCommand(webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.result?.description ?? JSON.stringify(result.exceptionDetails));
  const value = result.result?.value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function debugTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((item) => item.type === "page");
        if (page) return page;
      }
    } catch { /* browser is still starting */ }
    await delay(100);
  }
  throw new Error("Chrome DevTools target did not start");
}

const matrix = [
  { id: "android-narrow", width: 360, height: 800, columns: 2 },
  { id: "iphone-compact", width: 390, height: 844, columns: 2 },
  { id: "phone-large", width: 430, height: 932, columns: 2 },
  { id: "short-landscape", width: 844, height: 390, columns: 4 },
];
const root = await mkdtemp(join(tmpdir(), "editkin-remote-mobile-ui-"));
const queuePath = join(root, "commands");
const snapshotPath = join(root, "snapshot.json");
const devicesPath = join(root, "devices.json");
const trustedDevicesPath = join(root, "trusted-devices.json");
const profilePath = join(root, "chrome-profile");
const token = "mobile-ui-0123456789abcdef0123456789";
const remotePort = await allocatePort();
const debugPort = await allocatePort();
await writeFile(snapshotPath, `${JSON.stringify({ projectName: "手機 UI 驗收", resolution: "1920×1080", fps: 30, trackCount: 4, playheadLabel: "00:01.25", status: "ready" })}\n`);

const remote = spawn(process.execPath, [resolve("desktop-dist/remote.mjs")], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    EDITKIN_REMOTE_TOKEN: token,
    EDITKIN_REMOTE_HEALTH_PROBE_ID: "3".repeat(32),
    EDITKIN_REMOTE_PORT: String(remotePort),
    EDITKIN_REMOTE_QUEUE: queuePath,
    EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
    EDITKIN_REMOTE_DEVICES: devicesPath,
    EDITKIN_REMOTE_TRUSTED_DEVICES: trustedDevicesPath,
  },
});
const ready = new Promise((resolveReady, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("Editkin Remote 啟動逾時")), 5_000);
  remote.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes('"status":"READY"')) { clearTimeout(timer); resolveReady(); }
  });
  remote.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Editkin Remote 提前結束：${code}`)); });
});

let chrome;
try {
  await ready;
  chrome = spawn(browserExecutable(), [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--force-prefers-reduced-motion",
    "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  const page = await debugTarget(debugPort);
  await cdpCommand(page.webSocketDebuggerUrl, "Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__editkinRuntimeErrors=[];addEventListener('error',event=>window.__editkinRuntimeErrors.push(String(event.error||event.message)));addEventListener('unhandledrejection',event=>window.__editkinRuntimeErrors.push(String(event.reason)));",
  });
  await cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
  await cdpCommand(page.webSocketDebuggerUrl, "Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  const navigationStarted = performance.now();
  await cdpCommand(page.webSocketDebuggerUrl, "Page.navigate", { url: `http://127.0.0.1:${remotePort}/#token=${token}` });
  let paired = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      paired = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({paired:document.querySelector('#online')?.textContent?.includes('已連線'),hash:location.hash})");
      if (paired.paired && paired.hash === "") break;
    } catch { /* page is navigating */ }
    await delay(50);
  }
  const pairingReadyMs = performance.now() - navigationStarted;
  const measurements = [];
  for (const viewport of matrix) {
    await cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await delay(80);
    const measurement = await evaluate(page.webSocketDebuggerUrl, `(()=>{scrollTo(0,0);const visible=node=>{const style=getComputedStyle(node);const box=node.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0};const controls=[...document.querySelectorAll('button,input,textarea')].filter(visible).map(node=>{const box=node.getBoundingClientRect();return{tag:node.tagName,name:node.getAttribute('aria-label')||node.textContent.trim()||node.getAttribute('placeholder')||'',width:box.width,height:box.height,fontSize:parseFloat(getComputedStyle(node).fontSize),top:box.top,bottom:box.bottom}});const finalControl=document.querySelector('#caption');finalControl.scrollIntoView({block:'center'});const finalBox=finalControl.getBoundingClientRect();const quickColumns=getComputedStyle(document.querySelector('.quick')).gridTemplateColumns.split(' ').filter(Boolean).length;return JSON.stringify({viewport:{width:innerWidth,height:innerHeight},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},controls,quickColumns,firstScreenActions:controls.filter(item=>item.top<innerHeight&&item.bottom>0).length,finalActionReachable:finalBox.top>=0&&finalBox.bottom<=innerHeight,runtimeErrors:window.__editkinRuntimeErrors||[],hash:location.hash,connected:document.querySelector('#online')?.textContent?.includes('已連線')===true})})()`);
    measurements.push({ ...viewport, ...measurement });
  }
  await cdpCommand(page.webSocketDebuggerUrl, "Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedMotion = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({matches:matchMedia('(prefers-reduced-motion: reduce)').matches})");
  await cdpCommand(page.webSocketDebuggerUrl, "Page.reload", { ignoreCache: true });
  let reconnectedWithoutQr = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const state = await evaluate(page.webSocketDebuggerUrl, "JSON.stringify({connected:document.querySelector('#online')?.textContent?.includes('永久綁定')===true,hash:location.hash})");
      if (state.connected && state.hash === "") { reconnectedWithoutQr = true; break; }
    } catch { /* page is reloading */ }
    await delay(50);
  }
  await cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
  const commandStarted = performance.now();
  await evaluate(page.webSocketDebuggerUrl, "JSON.stringify((()=>{scrollTo(0,0);document.querySelector('[data-command=\"復原\"]')?.click();return true})())");
  let queueFiles = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { queueFiles = (await readdir(queuePath)).filter((name) => name.endsWith(".json")); } catch { /* queue not created yet */ }
    if (queueFiles.length === 1) break;
    await delay(25);
  }
  const commandRoundTripMs = performance.now() - commandStarted;
  const queued = queueFiles[0] ? JSON.parse(await readFile(join(queuePath, queueFiles[0]), "utf8")) : null;
  const evidenceBase = {
    schemaVersion: 2,
    browser: browserExecutable(),
    pairingReadyMs: Number(pairingReadyMs.toFixed(2)),
    commandRoundTripMs: Number(commandRoundTripMs.toFixed(2)),
    tokenRemovedFromUrl: paired.hash === "",
    reconnectedWithoutQr,
    reducedMotion: reducedMotion.matches,
    atomicQueueFiles: queueFiles.length,
    queuedInstruction: queued?.instruction ?? null,
    matrix: measurements,
  };
  const assessment = assessRemoteMobileUi(evidenceBase);
  const green = paired.paired && assessment.status === "GREEN";
  const evidence = { ...evidenceBase, status: green ? "GREEN" : "BLOCK", failures: assessment.failures };
  const evidencePath = resolve("../../.rd/benchmarks/editkin-remote-mobile-ui-windows.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
  if (!green) process.exitCode = 1;
} finally {
  chrome?.kill();
  remote.kill();
  if (chrome) await Promise.race([new Promise((resolveExit) => chrome.once("exit", resolveExit)), delay(2_000)]);
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => undefined);
}

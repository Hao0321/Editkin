import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executable = resolve(process.argv[2] ?? "src-tauri/target/release/editkin.exe");
const evaluatorPath = fileURLToPath(import.meta.url);
const stateParent = resolve("../../.rd/tmp");
const artifactRoot = resolve("../../.rd/artifacts");
const benchmarkRoot = resolve("../../.rd/benchmarks");
await mkdir(stateParent, { recursive: true });
await mkdir(artifactRoot, { recursive: true });
await mkdir(benchmarkRoot, { recursive: true });
const stateRoot = await mkdtemp(resolve(stateParent, "editkin-library-ui-"));
const port = await new Promise((resolvePromise, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : undefined;
    server.close(() => selected ? resolvePromise(selected) : reject(new Error("Could not allocate CDP port")));
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
child.stdout?.on("data", (chunk) => process.stderr.write(`[editkin-stdout] ${chunk}`));
child.stderr?.on("data", (chunk) => process.stderr.write(`[editkin-stderr] ${chunk}`));

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
let socket;
let activeWebSocketUrl;
let nextId = 0;
const pending = new Map();

async function target() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Editkin exited before CDP became ready (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((item) => item.type === "page" && item.url && item.url !== "about:blank");
        if (page) return page;
      }
    } catch { /* WebView2 is starting. */ }
    await delay(200);
  }
  throw new Error("Editkin CDP target did not start within 60 seconds");
}

async function connect(url) {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
    socket.addEventListener("error", (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else request.resolve(message.result ?? {});
  });
  activeWebSocketUrl = url;
}

async function command(method, params = {}, timeoutMs = 10_000) {
  const id = ++nextId;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, timeoutMs = 10_000) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime.evaluate failed");
      const value = result.result?.value;
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/context was destroyed|connection closed|not opened|closed/i.test(message) || attempt === 5) throw error;
      await delay(400);
      const refreshed = await target();
      if (refreshed.webSocketDebuggerUrl !== activeWebSocketUrl || socket?.readyState !== WebSocket.OPEN) await connect(refreshed.webSocketDebuggerUrl);
    }
  }
  throw new Error("Runtime.evaluate retry exhausted");
}

async function stop() {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await delay(1_000);
  if (child.exitCode === null && process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await delay(1_000);
  }
}

async function removeStateRoot() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(stateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      return;
    } catch (error) {
      if (attempt === 7 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await delay(500 * (attempt + 1));
    }
  }
}

try {
  const page = await target();
  await connect(page.webSocketDebuggerUrl);
  const ready = await evaluate(`(async()=>{const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));for(let i=0;i<240;i+=1){if(window.haoDesktop?.isDesktop&&document.querySelector('.brand-copy strong')?.textContent==='Editkin'&&!document.body.innerText.includes('正在載入'))return JSON.stringify(true);await wait(200)}return JSON.stringify(false)})()`, 55_000);
  if (!ready) throw new Error("Editkin did not become interactive");
  await evaluate(`(async()=>{const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));document.querySelector('[data-testid="guide-skip"]')?.click();await wait(100);document.querySelector('[data-testid="explore-editor-button"]')?.click();for(let i=0;i<120&&!document.querySelector('[data-testid="asset-library-tab"]');i+=1)await wait(100);document.querySelector('[data-testid="asset-library-tab"]')?.click();for(let i=0;i<240&&!document.querySelector('.creative-preview.ready img,.creative-preview.ready video');i+=1)await wait(100);return JSON.stringify(true)})()`, 35_000);
  const before = await evaluate(`(()=>{const scroll=document.querySelector('[data-testid="creative-library-scroll"]');const box=scroll?.getBoundingClientRect();const media=[...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')];return JSON.stringify({cards:document.querySelectorAll('.creative-asset-card').length,loaded:media.filter(node=>node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0).length,failed:document.querySelectorAll('.preview-loading.failed').length,scrollTop:scroll?.scrollTop??-1,scrollHeight:scroll?.scrollHeight??0,clientHeight:scroll?.clientHeight??0,box:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,visibleText:document.querySelector('.media-bin')?.innerText??''})})()`);
  if (!before.box) throw new Error("Creative library scroll viewport is missing");
  const x = before.box.x + before.box.width / 2;
  const y = before.box.y + Math.min(before.box.height / 2, 180);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await command("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 420 });
  await evaluate(`(async()=>{const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const scroll=document.querySelector('[data-testid="creative-library-scroll"]');const visibleReady=()=>{const viewport=scroll?.getBoundingClientRect();if(!viewport)return false;return [...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')].some(node=>{const box=node.getBoundingClientRect();const decoded=node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0;return decoded&&box.bottom>viewport.top&&box.top<viewport.bottom})};for(let i=0;i<120&&!visibleReady();i+=1)await wait(100);return JSON.stringify(visibleReady())})()`, 15_000);
  const after = await evaluate(`(()=>{const scroll=document.querySelector('[data-testid="creative-library-scroll"]');const viewport=scroll?.getBoundingClientRect();const media=[...document.querySelectorAll('.creative-preview.ready img,.creative-preview.ready video')];const visibleLoaded=viewport?media.filter(node=>{const box=node.getBoundingClientRect();const decoded=node.tagName==='IMG'?node.complete&&node.naturalWidth>0:node.readyState>=2&&node.videoWidth>0;return decoded&&box.bottom>viewport.top&&box.top<viewport.bottom}).length:0;return JSON.stringify({scrollTop:scroll?.scrollTop??-1,visibleLoaded})})()`);
  const full = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 15_000);
  const panel = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: Math.max(0, before.box.x - 6), y: Math.max(0, before.box.y - 130), width: before.box.width + 12, height: before.box.height + 136, scale: 1 } }, 15_000);
  const fullPath = resolve(artifactRoot, "editkin-creative-library-ui-full.png");
  const panelPath = resolve(artifactRoot, "editkin-creative-library-ui-panel.png");
  await writeFile(fullPath, Buffer.from(full.data, "base64"));
  await writeFile(panelPath, Buffer.from(panel.data, "base64"));
  const importTiming = await evaluate(`(async()=>{
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const samples=[],visibility=[];
    for(let sample=0;sample<11;sample+=1){
      for(let retry=0;retry<200&&!([...document.querySelectorAll('.library-add')].some(button=>!button.disabled));retry+=1)await wait(20);
      const button=[...document.querySelectorAll('.library-add')].find(candidate=>!candidate.disabled&&candidate.getBoundingClientRect().height>0);
      if(!button)return JSON.stringify({error:'no-enabled-library-add',samples});
      const before=document.querySelector('.timeline-clip.selected:not(.caption)')?.dataset.testid??'',start=performance.now();
      button.click();
      let selected;
      for(let retry=0;retry<250;retry+=1){
        const current=document.querySelector('.timeline-clip.selected:not(.caption)');
        if(current?.dataset.testid&&current.dataset.testid!==before){selected=current;break;}
        await wait(20);
      }
      if(!selected)return JSON.stringify({error:'new-clip-not-selected',samples,before,visibility});
      const viewport=document.querySelector('[data-testid="timeline-scroll"]')?.getBoundingClientRect(),box=selected.getBoundingClientRect();
      const inViewport=Boolean(viewport&&box.right>viewport.left+180&&box.left<viewport.right-16);
      visibility.push({sample,id:selected.dataset.testid,inViewport,left:box.left,right:box.right,viewportRight:viewport?.right??0});
      samples.push(performance.now()-start);
    }
    return JSON.stringify({samples,warmup:samples[0],measured:samples.slice(1),visibility});
  })()`, 75_000);
  const measured = importTiming.measured ?? [];
  const sortedImport = [...measured].sort((left, right) => left - right);
  const importP95 = sortedImport.length ? sortedImport[Math.ceil(sortedImport.length * 0.95) - 1] : Number.POSITIVE_INFINITY;
  const importMax = sortedImport.at(-1) ?? Number.POSITIVE_INFINITY;
  const importGreen = !importTiming.error && measured.length === 10 && importP95 <= 1_200 && importMax <= 3_000 && importTiming.visibility?.every(item=>item.inViewport);
  const report = {
    schemaVersion: 1,
    evaluation: "editkin-creative-library-desktop-v1",
    measuredAt: new Date().toISOString(),
    evaluator: { path: evaluatorPath, sha256: createHash("sha256").update(await readFile(evaluatorPath)).digest("hex") },
    executable: {
      path: executable,
      bytes: (await stat(executable)).size,
      sha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    },
    status: before.cards > 0 && before.loaded > 0 && before.failed === 0 && before.scrollHeight > before.clientHeight * 4 && after.scrollTop > before.scrollTop && after.visibleLoaded > 0 && importGreen ? "GREEN" : "BLOCK",
    cards: before.cards,
    loadedMediaPreviews: before.loaded,
    failedPreviews: before.failed,
    scroll: { before: before.scrollTop, after: after.scrollTop, scrollHeight: before.scrollHeight, clientHeight: before.clientHeight, visibleLoadedAfterScroll: after.visibleLoaded },
    timelineImport: { warmupMs: importTiming.warmup, samplesMs: measured, visibility: importTiming.visibility, p95Ms: importP95, maxMs: importMax, threshold: { samples: 10, p95Ms: 1_200, maxMs: 3_000 }, error: importTiming.error ?? null, status: importGreen ? "GREEN" : "BLOCK" },
    simpleLabels: ["專案", "素材", "模板", "工具"].every((label) => before.visibleText.includes(label)),
    screenshots: { fullPath, panelPath },
  };
  report.receiptPath = resolve(benchmarkRoot, "editkin-creative-library-desktop-20260904.json");
  await writeFile(report.receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "GREEN" || !report.simpleLabels) process.exitCode = 1;
} finally {
  await stop();
  await removeStateRoot();
}

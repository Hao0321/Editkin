// Packaged desktop acceptance for an existing project. The input file is read-only.
// Usage: node scripts/review-existing-project-desktop.mjs <portable-preview.exe> <existing-project.editkin.json>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
const sourceProject = resolve(process.argv[3] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
assert(/\.editkin\.json$/i.test(sourceProject));
const originalBytes = await readFile(sourceProject);
const original = JSON.parse(originalBytes.toString("utf8"));
const clips = original.tracks.flatMap((track) => track.clips);
assert(clips.length >= 2 && original.assets.length >= 2, "Expected a real multi-clip project");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const originalHash = digest(originalBytes);
const outputRoot = resolve("../artifacts/autopilot-desk");
await mkdir(outputRoot, { recursive: true });
const stateRoot = await mkdtemp(join(outputRoot, "existing-project-review-"));
const projectPath = join(stateRoot, "review.editkin.json");
const outputPath = join(stateRoot, "review.mp4");
await writeFile(projectPath, originalBytes, { flag: "wx" });
const savedOriginPath = join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json");
const savedOrigin = new URL(JSON.parse(await readFile(savedOriginPath, "utf8")).origin);
assert.equal(savedOrigin.protocol, "http:");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(savedOrigin.hostname),
  "The saved model origin is not a private LAN address");
await mkdir(join(stateRoot, "data/local-story"), { recursive: true });
await writeFile(join(stateRoot, "data/local-story/origin.json"), JSON.stringify({ origin: savedOrigin.origin }));
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});
const child = spawn(executable, [], {
  cwd: dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
    WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.stdout.resume(); child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
const report = { status: "BLOCK", stateRoot, sourceProjectSha256: originalHash,
  input: { assets: original.assets.length, clips: clips.length, duration: Math.max(...clips.map((clip) => clip.timelineStart + clip.duration)) },
  checks: {} };
let page;
const evaluate = (expression, timeout = 10_000) => harness.evaluate(page.webSocketDebuggerUrl, expression, timeout);
const inspect = () => evaluate(`(()=>{const media=document.querySelector('.media-bin')?.textContent||'';
  const timeline=document.querySelector('.timeline-toolbar')?.textContent||'';return JSON.stringify({
  ready:!!document.querySelector('[data-testid="new-project-button"]'),
  name:document.querySelector('.project-heading strong')?.textContent||'',
  assets:document.querySelectorAll('.asset-row').length,
  clips:document.querySelectorAll('.timeline-clip').length,
  assetCount:Number(media.match(/專案\\s*(\\d+)/)?.[1]||0),
  clipCount:Number(timeline.match(/(\\d+)\\s*個片段/)?.[1]||0),
  audioGap:document.querySelector('[data-testid="audio-gap-notice"]')?.textContent?.trim()||'',
  audioGapTitle:document.querySelector('[data-testid="audio-gap-notice"]')?.getAttribute('title')||'',
  playheadLabel:document.querySelector('.project-heading small')?.textContent?.trim()||'',
  menuOpen:!!document.querySelector('.project-menu')?.open,
  renderBusy:!!document.querySelector('[data-testid="render-button"]')?.disabled,
  renderLabel:document.querySelector('[data-testid="render-button"]')?.textContent?.trim()||'',
  status:document.querySelector('[data-testid="operation-status-message"]')?.textContent?.trim()||'',
  saveState:document.querySelector('[data-testid="save-state"]')?.textContent?.trim()||'',
  previewVideoReady:(document.querySelector('[data-testid="preview-video"]')?.readyState||0)>=2,
  previewImageVisible:!!document.querySelector('.preview-stage img'),
  documentWidth:document.documentElement.scrollWidth,
  viewportWidth:innerWidth
})})()`);
const inspectAgent = () => evaluate(`(async()=>{try{const status=await window.haoDesktop.statusOpenCodeAgent(0);return JSON.stringify({
  connected:status.connected,projectMatched:status.projectPath===${JSON.stringify(projectPath)},
  error:document.querySelector('.opencode-dock-error')?.textContent?.trim()||'',
  model:document.querySelector('.opencode-dock-compose-model select')?.value||''
})}catch{return JSON.stringify({connected:false,projectMatched:false,error:'',model:''})}})()`, 10_000);
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (predicate(last)) return last;
    await delay(500);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
async function click(selector) {
  const box = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node?.scrollIntoView({block:'nearest'});const r=node?.getBoundingClientRect();const x=r?r.left+r.width/2:0,y=r?r.top+r.height/2:0;const hit=document.elementFromPoint(x,y);return JSON.stringify({x,y,ready:!!r&&r.width>0&&r.height>0&&!node.disabled&&(node===hit||node.contains(hit))})})()`);
  assert(box.ready, `Control unavailable: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"])
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, 10_000);
}
async function projectMenu() {
  await evaluate("(()=>{const menu=document.querySelector('.project-menu');menu.open=true;menu.querySelector('.project-menu-group').open=true;return JSON.stringify(true)})()");
}
async function screenshot(name) {
  const shot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, 15_000);
  await writeFile(join(stateRoot, name), Buffer.from(shot.data, "base64"), { flag: "wx" });
}
async function runTool(command, args, timeoutMs = 90_000) {
  const process = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
  process.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1_000_000); });
  const code = await new Promise((done, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
    process.once("exit", (exitCode) => { clearTimeout(timer); done(exitCode); });
  });
  assert.equal(code, 0, `${command} failed: ${stderr.slice(-1000)}`);
  return stdout;
}
try {
  page = await harness.target();
  await waitFor((state) => state.ready, 40_000, "Editor ready");
  await evaluate(`(()=>{const api=window.haoDesktop;api.openProject=()=>api.reloadProjectFromPath(${JSON.stringify(projectPath)});window.confirm=()=>true;return JSON.stringify(true)})()`);
  await projectMenu();
  await click('[data-testid="open-project-button"]');
  report.checks.opened = await waitFor((state) => state.assetCount === original.assets.length && state.clipCount === clips.length,
    45_000, "Existing project open");
  assert.equal(report.checks.opened.name, original.name);
  assert(!report.checks.opened.menuOpen, "Project menu obscures the opened project");
  assert(report.checks.opened.audioGapTitle.includes("00:08.00–00:48.00"),
    `Long soundless section is not visible before export: ${report.checks.opened.audioGapTitle}`);
  await click('[data-testid="audio-gap-notice"]');
  report.checks.audioGapJump = await waitFor((state) => state.playheadLabel.includes("00:08.00")
    && state.status.includes("沒有可發聲片段"), 10_000, "Sound gap navigation");
  const agentDeadline = Date.now() + 65_000;
  while (Date.now() < agentDeadline) {
    report.checks.agentAfterOpen = await inspectAgent();
    if (report.checks.agentAfterOpen.connected && report.checks.agentAfterOpen.projectMatched
      && !report.checks.agentAfterOpen.error && report.checks.agentAfterOpen.model) break;
    await delay(750);
  }
  assert(report.checks.agentAfterOpen?.connected && report.checks.agentAfterOpen.projectMatched
    && !report.checks.agentAfterOpen.error && report.checks.agentAfterOpen.model,
  `Agent did not automatically bind the opened project: ${JSON.stringify(report.checks.agentAfterOpen)}`);
  await screenshot("opened.png");
  await evaluate(`(()=>{const api=window.haoDesktop,save=api.saveProject.bind(api);api.saveProject=(project,path)=>save(project,path||${JSON.stringify(projectPath)},false);return JSON.stringify(true)})()`);
  await projectMenu();
  await click('[data-testid="save-project-button"]');
  report.checks.saved = await waitFor((state) => state.saveState.includes("專案檔已儲存"), 30_000, "Existing project save");
  assert(!report.checks.saved.menuOpen, "Project menu obscures the saved project");
  const saved = JSON.parse(await readFile(projectPath, "utf8"));
  assert.equal(saved.tracks.flatMap((track) => track.clips).length, clips.length, "Saving lost timeline clips");
  assert.equal(saved.assets.length, original.assets.length, "Saving lost media assets");
  await projectMenu();
  await click('[data-testid="new-project-button"]');
  await waitFor((state) => state.clipCount === 0, 15_000, "Clear before reopen");
  await projectMenu();
  await click('[data-testid="open-project-button"]');
  report.checks.reopened = await waitFor((state) => state.assetCount === original.assets.length && state.clipCount === clips.length,
    45_000, "Existing project reopen");
  assert.equal(report.checks.reopened.name, original.name);
  assert(!report.checks.reopened.menuOpen, "Project menu obscures the reopened project");
  const reboundDeadline = Date.now() + 65_000;
  while (Date.now() < reboundDeadline) {
    report.checks.agentAfterReopen = await inspectAgent();
    if (report.checks.agentAfterReopen.connected && report.checks.agentAfterReopen.projectMatched
      && !report.checks.agentAfterReopen.error && report.checks.agentAfterReopen.model) break;
    await delay(750);
  }
  assert(report.checks.agentAfterReopen?.connected && report.checks.agentAfterReopen.projectMatched
    && !report.checks.agentAfterReopen.error && report.checks.agentAfterReopen.model,
  `Agent did not automatically rebind the reopened project: ${JSON.stringify(report.checks.agentAfterReopen)}`);
  await screenshot("reopened.png");
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, 10_000);
  await evaluate("(()=>{const diagnostic=document.getElementById('editkin-integration-performance');if(diagnostic)diagnostic.hidden=true;return JSON.stringify(true)})()");
  await delay(250);
  report.checks.compactLayout = await inspect();
  const gapBounds = await evaluate(`(()=>{const r=document.querySelector('[data-testid="audio-gap-notice"]')?.getBoundingClientRect();
    return JSON.stringify(r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width})})()`);
  assert.equal(report.checks.compactLayout.documentWidth, 1280, "Compact editor has horizontal overflow");
  assert(gapBounds?.width > 50 && gapBounds.left >= 0 && gapBounds.right <= 1280 && gapBounds.bottom <= 720,
    `Sound gap notice is outside the compact viewport: ${JSON.stringify(gapBounds)}`);
  await screenshot("compact-1280x720.png");
  await evaluate(`(()=>{const api=window.haoDesktop;window.__reviewRenderCalls=0;api.renderProject=(project)=>{window.__reviewRenderCalls+=1;return window.__TAURI_INTERNALS__.invoke('render_project_smoke',{project,outputPath:${JSON.stringify(outputPath)}})};return JSON.stringify(true)})()`);
  await click('[data-testid="render-button"]');
  report.checks.renderStarted = await waitFor((state) => state.renderBusy && state.renderLabel.includes("輸出中"), 20_000, "Existing project render start");
  report.checks.renderFinished = await waitFor((state) => !state.renderBusy, 600_000, "Existing project render finish");
  assert(report.checks.renderFinished.status.includes("影片輸出完成"), `Export failed: ${report.checks.renderFinished.status}`);
  report.checks.renderCalls = await evaluate("JSON.stringify(window.__reviewRenderCalls)");
  assert.equal(report.checks.renderCalls, 1, "Export was submitted more than once");
  const rendered = await stat(outputPath);
  assert(rendered.size > 10_000, "Exported MP4 is empty");
  const probe = JSON.parse(await runTool("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath]));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert(video && Number(video.nb_read_frames) >= report.input.duration * Number(original.fps) - 2,
    "Exported video is missing or truncated");
  assert(Math.abs(Number(probe.format.duration) - report.input.duration) < 0.25,
    "Exported duration differs from the project timeline");
  report.checks.output = { bytes: rendered.size, duration: Number(probe.format.duration),
    frames: Number(video.nb_read_frames), audioPresent: Boolean(audio) };
  await runTool("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-i", outputPath,
    "-map", "0:v:0", "-f", "null", "-"], 180_000);
  report.checks.sourceProjectUnchanged = digest(await readFile(sourceProject)) === originalHash;
  assert(report.checks.sourceProjectUnchanged, "The input project changed");
  report.status = "PASS";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (page) try { await screenshot("failure.png"); } catch { /* Keep the original failure. */ }
} finally {
  harness.closeCdp();
  await harness.stopOwnedApplication();
  await writeFile(join(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, stateRoot, checks: report.checks, error: report.error }) + "\n");
}
if (report.status !== "PASS") process.exitCode = 1;

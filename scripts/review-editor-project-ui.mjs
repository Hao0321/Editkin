// Usage: node scripts/review-editor-project-ui.mjs <portable-preview.exe>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
const outputRoot = resolve("../artifacts/autopilot-desk");
await mkdir(outputRoot, { recursive: true });
const stateRoot = await mkdtemp(resolve(outputRoot, "editor-project-review-"));
const audioPath = resolve(stateRoot, "voice.wav");
const videoPath = resolve("public/editkin-demo-preview.mp4");
const projectPath = resolve(stateRoot, "roundtrip.editkin.json");
const outputPath = resolve(stateRoot, "roundtrip.mp4");
assert((await stat(videoPath)).isFile(), "Bundled test video is missing");
const ffmpeg = spawn("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", audioPath],
  { windowsHide: true, stdio: "ignore" });
const ffmpegExit = await new Promise((done, reject) => {
  ffmpeg.once("error", reject);
  ffmpeg.once("exit", (code) => done(code));
});
assert.equal(ffmpegExit, 0, "Could not create isolated voice fixture");
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
    WEBVIEW2_USER_DATA_FOLDER: resolve(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.stdout.resume();
child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
let page;
const report = { status: "BLOCK", stateRoot, appPid: child.pid, checks: {} };
const evaluate = (expression, timeout = 10_000) => harness.evaluate(page.webSocketDebuggerUrl, expression, timeout);
const inspect = () => evaluate(`(()=>{
  const starts=(kind)=>[...document.querySelectorAll('.track-lane.'+kind+' .timeline-clip')].map(node=>Number(node.dataset.timelineStart));
  return JSON.stringify({ready:!!document.querySelector('[data-testid="new-project-button"]'),
    name:document.querySelector('.project-heading strong')?.textContent||'',
    assets:[...document.querySelectorAll('.asset-row .asset-copy strong')].map(node=>node.textContent||''),
    videoStarts:starts('video'),audioStarts:starts('audio'),
    demoPresent:!!document.querySelector('[data-testid="timeline-clip-clip-demo"]'),
    libraryPromotion:!!document.querySelector('[data-testid="asset-preview-entry"]'),
    saveState:document.querySelector('[data-testid="save-state"]')?.textContent?.trim()||'',
    previewReady:(document.querySelector('[data-testid="preview-video"]')?.readyState||0)>=2,
    starterSlate:!!document.querySelector('[data-testid="starter-preview-slate"]'),
    renderBusy:document.querySelector('[data-testid="render-button"]')?.disabled||false,
    renderLabel:document.querySelector('[data-testid="render-button"]')?.textContent?.trim()||'',
    status:document.querySelector('[data-testid="operation-status-message"]')?.textContent?.trim()||'',
    agentView:document.querySelector('[data-testid="editor-agent-dock"]')?.getAttribute('data-view')||''});
})()`);
async function runTool(command, args, timeoutMs = 60_000) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1_000_000); });
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); done(code); });
  });
  assert.equal(result, 0, `${command} failed: ${stderr.slice(-1000)}`);
  return { stdout, stderr };
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (predicate(last)) return last;
    await delay(400);
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
async function drop(path) {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tauri://drag-drop',payload:{paths:[${JSON.stringify(path)}],position:{x:320,y:240}}}).then(()=>JSON.stringify(true))`);
}
async function screenshot(name) {
  const image = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, 15_000);
  await writeFile(resolve(stateRoot, name), Buffer.from(image.data, "base64"), { flag: "wx" });
}
try {
  page = await harness.target();
  report.checks.initial = await waitFor((state) => state.ready && state.demoPresent, 25_000, "Starter editor ready");
  assert(!report.checks.initial.libraryPromotion, "Empty optional library is promoted as if it had content");
  await evaluate("(()=>{window.confirm=()=>true;return JSON.stringify(true)})()");
  await drop(audioPath);
  report.checks.starterAudio = await waitFor((state) => state.assets.includes("voice.wav") && state.audioStarts.length === 1,
    30_000, "Voice replaces the starter demo");
  assert(!report.checks.starterAudio.demoPresent && report.checks.starterAudio.videoStarts.length === 0,
    "Voice-first import left the demo picture in the real project");
  assert.deepEqual(report.checks.starterAudio.audioStarts, [0]);
  await projectMenu();
  await click('[data-testid="new-project-button"]');
  report.checks.empty = await waitFor((state) => !state.demoPresent && state.videoStarts.length === 0 && state.audioStarts.length === 0,
    10_000, "New empty project");
  await drop(audioPath);
  report.checks.audioFirst = await waitFor((state) => state.assets.includes("voice.wav") && state.audioStarts.length === 1,
    30_000, "Voice import");
  assert.deepEqual(report.checks.audioFirst.audioStarts, [0]);
  assert.deepEqual(report.checks.audioFirst.videoStarts, []);
  await drop(videoPath);
  report.checks.withVideo = await waitFor((state) => state.assets.includes("editkin-demo-preview.mp4")
    && state.videoStarts.length === 1 && state.previewReady, 30_000, "Picture import and preview");
  assert.deepEqual(report.checks.withVideo.videoStarts, [0]);
  assert.deepEqual(report.checks.withVideo.audioStarts, [0]);
  assert(!report.checks.withVideo.starterSlate);
  await screenshot("imported-picture-and-voice.png");
  await evaluate(`(()=>{const api=window.haoDesktop,save=api.saveProject.bind(api);api.saveProject=(project,path)=>save(project,path||${JSON.stringify(projectPath)},false);return JSON.stringify(true)})()`);
  await projectMenu();
  await click('[data-testid="save-project-button"]');
  report.checks.saved = await waitFor((state) => state.saveState.includes("專案檔已儲存"), 25_000, "Save through editor");
  const stored = JSON.parse(await readFile(projectPath, "utf8"));
  report.checks.disk = { assetNames: stored.assets.map((asset) => asset.name),
    videoStarts: stored.tracks.find((track) => track.kind === "video")?.clips.map((clip) => clip.timelineStart),
    audioStarts: stored.tracks.find((track) => track.kind === "audio")?.clips.map((clip) => clip.timelineStart), revision: stored.revision };
  assert.deepEqual(report.checks.disk.videoStarts, [0]);
  assert.deepEqual(report.checks.disk.audioStarts, [0]);
  assert(!stored.assets.some((asset) => asset.id === "asset-demo"));
  await projectMenu();
  await click('[data-testid="new-project-button"]');
  await waitFor((state) => state.videoStarts.length === 0 && state.audioStarts.length === 0, 10_000, "Clear before reopen");
  await evaluate(`(()=>{const api=window.haoDesktop;api.openProject=()=>api.reloadProjectFromPath(${JSON.stringify(projectPath)});return JSON.stringify(true)})()`);
  await projectMenu();
  await click('[data-testid="open-project-button"]');
  report.checks.reopened = await waitFor((state) => state.assets.length === 2 && state.videoStarts.length === 1
    && state.audioStarts.length === 1 && state.previewReady, 25_000, "Reopen saved picture and voice");
  assert.deepEqual(report.checks.reopened.videoStarts, [0]);
  assert.deepEqual(report.checks.reopened.audioStarts, [0]);
  assert(!report.checks.reopened.demoPresent && !report.checks.reopened.starterSlate);
  await screenshot("reopened-picture-and-voice.png");
  await evaluate(`(()=>{const api=window.haoDesktop;window.__reviewRenderCalls=0;api.renderProject=(project)=>{window.__reviewRenderCalls+=1;return window.__TAURI_INTERNALS__.invoke('render_project_smoke',{project,outputPath:${JSON.stringify(outputPath)}})};return JSON.stringify(true)})()`);
  await click('[data-testid="render-button"]');
  report.checks.renderStarted = await waitFor((state) => state.renderBusy && state.renderLabel.includes("輸出中"), 15_000, "Export busy state");
  report.checks.renderFinished = await waitFor((state) => !state.renderBusy && state.status.includes("影片輸出完成"), 150_000, "Picture and voice export");
  report.checks.renderCalls = await evaluate("JSON.stringify(window.__reviewRenderCalls)");
  assert.equal(report.checks.renderCalls, 1, "One export click submitted more than one render");
  const rendered = await stat(outputPath);
  assert(rendered.size > 10_000, "Rendered MP4 is missing or empty");
  const probe = JSON.parse((await runTool("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath])).stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert(video && audio, "Rendered MP4 must contain picture and sound");
  assert(Number(video.nb_read_frames) >= 300, "Rendered picture is truncated");
  assert(Math.abs(Number(probe.format.duration) - 12) < 0.25, "Rendered duration differs from timeline");
  const decoded = await runTool("ffmpeg", ["-nostdin", "-hide_banner", "-v", "info", "-xerror", "-i", outputPath,
    "-map", "0:v:0", "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], 90_000);
  const peakDb = Number(decoded.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1]);
  assert(Number.isFinite(peakDb) && peakDb > -50, "Rendered audio is silent or not decoded");
  const toneAt = async (seconds) => {
    const measured = await runTool("ffmpeg", ["-nostdin", "-hide_banner", "-v", "info", "-ss", String(seconds), "-t", "1", "-i", outputPath,
      "-vn", "-af", "bandpass=f=440:w=20,volumedetect", "-f", "null", "-"], 30_000);
    return Number(measured.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  };
  const toneAtStartDb = await toneAt(0.5);
  const toneAfterClipDb = await toneAt(4);
  assert(Number.isFinite(toneAtStartDb) && toneAtStartDb > -40, "Imported audio did not begin with picture at zero");
  assert(Number.isFinite(toneAfterClipDb) && toneAfterClipDb < -65, "Imported three-second audio exceeded its timeline clip");
  report.checks.output = { outputPath, bytes: rendered.size, duration: Number(probe.format.duration), frames: Number(video.nb_read_frames), peakDb, toneAtStartDb, toneAfterClipDb };
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false }, 10_000);
  await evaluate("(()=>{document.querySelector('.project-menu')?.removeAttribute('open');const diagnostic=document.getElementById('editkin-integration-performance');if(diagnostic)diagnostic.hidden=true;return JSON.stringify(true)})()");
  await delay(250);
  report.checks.compactLayout = await evaluate(`(()=>{const box=(selector)=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return JSON.stringify({viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},toolbar:box('.toolbar'),media:box('.media-bin'),preview:box('.preview-stage'),timeline:box('.timeline'),agent:box('.agent-dock'),exportButton:box('[data-testid="render-button"]'),composer:box('[data-testid="agent-input"]')})})()`);
  assert.equal(report.checks.compactLayout.document.width, 1366, "Compact editor has horizontal overflow");
  assert(report.checks.compactLayout.preview.height >= 290, "Compact preview is too small after simplifying controls");
  await screenshot("compact-editor-1366x768.png");
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, 10_000);
  await delay(250);
  report.checks.smallLayout = await evaluate(`(()=>{const box=(selector)=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return JSON.stringify({viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},preview:box('.preview-stage'),agent:box('.agent-dock'),exportButton:box('[data-testid="render-button"]'),profile:box('[data-testid="editing-profile-picker"]'),material:box('[data-testid="material-review-open"]'),timelineToolbar:box('.timeline-toolbar'),timelineScroll:box('.timeline-scroll'),ruler:box('.timeline-row.ruler-row'),videoTrack:box('.track-lane.video'),audioTrack:box('.track-lane.audio'),playhead:box('.playhead')})})()`);
  assert.equal(report.checks.smallLayout.document.width, 1280, "Small editor has horizontal overflow");
  assert(report.checks.smallLayout.audioTrack.bottom < report.checks.smallLayout.timelineScroll.bottom,
    "Audio track is clipped below the visible small-window timeline");
  assert(Math.abs(report.checks.smallLayout.playhead.y - report.checks.smallLayout.ruler.y) < 1,
    "Playhead no longer aligns with the compact time ruler");
  await screenshot("small-editor-1280x720.png");
  await click('[data-testid="editing-profile-picker"] > summary');
  report.checks.profilePicker = await evaluate("(()=>{const details=document.querySelector('[data-testid=editing-profile-picker]');return JSON.stringify({open:details?.open,choices:details?.querySelectorAll('.profile-options button').length})})()");
  assert(report.checks.profilePicker.open && report.checks.profilePicker.choices >= 6, "Compact profile control does not open its choices");
  await click('[data-testid="editing-profile-picker"] > summary');
  await click('[data-testid="material-review-open"]');
  report.checks.materialReview = await waitFor((state) => state.agentView === "material", 10_000, "Material evidence panel");
  report.status = "PASS";
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ status: report.status, stateRoot, projectPath, revision: report.checks.disk.revision })}\n`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (page) try { await screenshot("failure.png"); } catch { /* Preserve the original failure. */ }
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  harness.closeCdp();
  await harness.stopOwnedApplication();
}

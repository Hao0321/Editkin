import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

// One diagnostic journey, not a release/parity gate. No dev server, update server,
// installer, private footage, seeded transcript, or backend replacement is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedModel = { fileName: "ggml-small-q5_1.bin", bytes: 190085487, sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb" };
const execFileAsync = promisify(execFile);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function assertPackagedUrl(value) {
  const url = new URL(value);
  assert(["http:", "https:"].includes(url.protocol) && url.hostname === "tauri.localhost" && !url.port, `Not the packaged Tauri UI: ${value}`);
}
function assertRecoveryHealthy(state) {
  assert(!state.saveFailed && !state.saveState?.includes("失敗"), `Application autosave failed: ${JSON.stringify(state)}`);
}
function automaticEditingComplete({ state, recovery }) {
  assertRecoveryHealthy(state);
  const captions = recovery?.found ? recovery.snapshot?.project?.captions : undefined;
  return Boolean(state.hasButton && !state.busy && state.captionCount > 0 && Array.isArray(captions)
    && captions.length >= state.captionCount && captions.every((caption) => typeof caption.text === "string" && caption.text.trim()));
}
function assertPlaybackToggle(before, after, playing) {
  assert.equal(before.pauseOffered, !playing, "Playback must start in the opposite state");
  assert.equal(after.pauseOffered, playing, "One Space event must produce one observed playback toggle");
  if (after.video) assert.equal(after.paused, !playing, "Real video playback must agree with its control");
}
function assertAutoEditConsent(state, selectedFormat = null) {
  assert.equal(state.open, true, "Auto-edit must present its real consent dialog");
  assert.equal(state.selectedFormat, selectedFormat, "Auto-edit format selection must be explicit");
  assert.equal(state.submitDisabled, selectedFormat === null, "Start must be disabled until a format is selected");
}
function assertOutput(probe, project, duration) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  assert(video && audio, "Rendered file must contain both video and audio");
  assert(["h264", "hevc", "av1"].includes(video.codec_name), "Unexpected MP4 video codec");
  assert.equal(video.width, project.width, "Wrong rendered width");
  assert.equal(video.height, project.height, "Wrong rendered height");
  const actualDuration = Number(probe.format?.duration);
  assert(Number.isFinite(actualDuration) && actualDuration > 0 && Math.abs(actualDuration - duration) <= Math.max(0.25, 2 / project.fps), "Missing/truncated rendered duration");
  assert(Number(video.nb_read_frames) >= Math.floor(duration * project.fps) - 2, "Output did not decode the expected frames");
  assert(probe.format?.format_name?.split(",").includes("mp4"), "Output is not an MP4 container");
}
if (process.argv[2] === "--self-test") {
  assertPackagedUrl("http://tauri.localhost/");
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:5173/", "http://tauri.localhost:5173/", "https://tauri.localhost.example/"]) assert.throws(() => assertPackagedUrl(url));
  const project = { width: 640, height: 360, fps: 30 };
  const positive = { streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, nb_read_frames: "90" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "3", format_name: "mov,mp4,m4a,3gp,3g2,mj2" } };
  assertOutput(positive, project, 3);
  for (const alter of [(p) => { p.streams.pop(); }, (p) => { p.streams[0].width = 320; }, (p) => { p.format.duration = "1"; }, (p) => { p.streams[0].nb_read_frames = "1"; }, (p) => { p.format.format_name = "matroska"; }]) {
    const negative = structuredClone(positive); alter(negative); assert.throws(() => assertOutput(negative, project, 3));
  }
  const completed = { state: { hasButton: true, busy: false, captionCount: 1, saveState: "Autosave 安全" }, recovery: { found: true, snapshot: { project: { captions: [{ text: "Actual recognizer output" }] } } } };
  assert(automaticEditingComplete(completed));
  for (const alter of [(p) => { p.state.hasButton = false; }, (p) => { p.state.busy = true; }, (p) => { p.state.captionCount = 0; }, (p) => { p.recovery.found = false; }, (p) => { p.recovery.snapshot.project.captions = []; }, (p) => { p.recovery.snapshot.project.captions[0].text = " "; }]) {
    const pending = structuredClone(completed); alter(pending); assert.equal(automaticEditingComplete(pending), false);
  }
  const saveFailure = structuredClone(completed);
  saveFailure.state.saveState = "未儲存 · Autosave 失敗";
  saveFailure.state.rawError = "assets[1].width: expected number, received null";
  assert.throws(() => automaticEditingComplete(saveFailure), /assets\[1\]\.width/);
  const paused = { video: true, paused: true, pauseOffered: false };
  const playing = { video: true, paused: false, pauseOffered: true };
  assertPlaybackToggle(paused, playing, true);
  assertPlaybackToggle(playing, paused, false);
  assert.throws(() => assertPlaybackToggle(paused, paused, true)); // zero or duplicate toggle
  assert.throws(() => assertPlaybackToggle(playing, playing, false));
  assert.throws(() => assertPlaybackToggle(paused, { ...playing, paused: true }, true));
  const unchosen = { open: true, selectedFormat: null, submitDisabled: true };
  const chosen = { open: true, selectedFormat: "longform", submitDisabled: false };
  assertAutoEditConsent(unchosen);
  assertAutoEditConsent(chosen, "longform");
  assert.throws(() => assertAutoEditConsent({ ...unchosen, open: false }));
  assert.throws(() => assertAutoEditConsent({ ...unchosen, submitDisabled: false }));
  assert.throws(() => assertAutoEditConsent({ ...chosen, selectedFormat: "shorts" }, "longform"));
  assert.throws(() => assertAutoEditConsent({ ...chosen, submitDisabled: true }, "longform"));
  process.stdout.write(json({ status: "GREEN", scope: "evaluator-controls-only", packagedUrlNegatives: 4, outputNegatives: 5, readinessNegatives: 7, playbackNegatives: 3, autoEditConsentNegatives: 4, productJourney: "NOT_RUN" }));
} else if (!process.argv[2] || process.argv[2] === "--help") {
  process.stdout.write("Usage: pinned-node scripts/desktop-first-edit-smoke.mjs <packaged-editkin.exe> [existing-pinned-whisper-model]\n       pinned-node scripts/desktop-first-edit-smoke.mjs --self-test\nRetains an isolated profile, synthetic fixture, editable project, MP4 and report in .rd/tmp. Hard journey budget: 9m30s plus owned-process cleanup.\n");
  if (!process.argv[2]) process.exitCode = 2;
} else {
  const started = Date.now();
  const deadline = started + 570000;
  const parent = resolve(root, "../../.rd/tmp");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(resolve(parent, "desktop-first-edit-"));
  const report = { schemaVersion: 1, status: "BLOCK", scope: "synthetic-first-edit-diagnostic-not-full-product-acceptance", startedAt: new Date(started).toISOString(), workspace, steps: [], unmeasured: ["real-user-footage editorial quality", "native file-picker/save-dialog interaction", "public installer/signature", "full-product readiness"] };
  let harness, page, child, childStdout = "", childStderr = "", watchdog, stopping;
  const mark = (stage) => { report.stage = stage; report.steps.push({ stage, elapsedMs: Date.now() - started }); process.stderr.write(`[first-edit] ${stage}\n`); };
  const remaining = (maximum = 15000) => { const value = Math.min(maximum, deadline - Date.now()); assert(value > 0, "First-edit journey exceeded its 9m30s budget"); return value; };
  async function identity(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) { remaining(); hash.update(chunk); }
    return { path, bytes: (await stat(path)).size, sha256: hash.digest("hex") };
  }
  async function command(name, executable, args, maximum = 60000) {
    let result;
    try { result = await execFileAsync(executable, args, { cwd: workspace, windowsHide: true, timeout: remaining(maximum), maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { await writeFile(resolve(workspace, `${name}.stderr.txt`), error.stderr ?? error.message, { flag: "wx" }); throw error; }
    await writeFile(resolve(workspace, `${name}.stdout.txt`), result.stdout, { flag: "wx" });
    await writeFile(resolve(workspace, `${name}.stderr.txt`), result.stderr, { flag: "wx" });
    return result.stdout;
  }
  const evaluate = (expression, timeout = 10000) => harness.evaluate(page.webSocketDebuggerUrl, expression, remaining(timeout));
  const readUiState = () => evaluate(`(()=>{const b=document.querySelector('[data-testid="semantic-edit-button"]');const s=document.querySelector('[data-testid="save-state"]');return JSON.stringify({hasButton:!!b,busy:!!b?.disabled,captionCount:document.querySelectorAll('.timeline-clip.caption').length,saveState:s?.textContent??'',saveFailed:!!s?.querySelector('.red'),rawError:s?.getAttribute('title')||document.querySelector('[data-testid="agent-status"]')?.textContent||''})})()`);
  async function poll(name, read, accepted, maximum) {
    const end = Math.min(deadline, Date.now() + maximum);
    let last;
    while (Date.now() < end) {
      last = await read();
      assertRecoveryHealthy(last?.state ?? await readUiState());
      if (accepted(last)) return last;
      await delay(Math.min(300, Math.max(1, end - Date.now())));
    }
    throw new Error(`${name} timed out: ${JSON.stringify(last)?.slice(0, 1200)}`);
  }
  async function click(selector) {
    const box = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n?.scrollIntoView({block:'nearest',inline:'nearest'});const r=n?.getBoundingClientRect();return JSON.stringify({x:r? r.left+r.width/2:0,y:r? r.top+r.height/2:0,visible:!!r&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight,disabled:!!n?.disabled})})()`);
    assert(box.visible && !box.disabled, `Control is not visible/enabled: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, remaining());
  }
  async function screenshot(name) {
    const shot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, remaining());
    await writeFile(resolve(workspace, `${name}.png`), Buffer.from(shot.data, "base64"), { flag: "wx" });
  }
  function stopOwnedTree() {
    return stopping ??= (async () => {
      // Kill descendants before the root can exit and make its children unaddressable.
      if (child?.pid && child.exitCode === null) {
        try { await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); }
        catch (error) { if (child.exitCode === null) report.treeStopDiagnostic = error.message; }
      }
      await harness?.stopOwnedApplication();
    })();
  }
  try {
    mark("preflight-owned-fixture-and-pinned-model");
    assert.equal(process.platform, "win32", "This bounded journey currently targets Windows Tauri");
    const executable = await realpath(resolve(process.argv[2]));
    assert.equal(basename(executable).toLowerCase(), "editkin.exe", "Pass the application executable, never an installer");
    report.executable = await identity(executable);
    report.evaluator = await identity(fileURLToPath(import.meta.url));
    const speechPath = resolve(root, "../../.rd/fixtures/editkin-caption-ground-truth.wav");
    const videoPath = resolve(root, "public/demo-source.mp4");
    const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
    const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
    report.fixture = { classification: "SYNTHETIC TEST SPEECH over bundled demo video; NOT the user's footage", speech: await identity(speechPath), video: await identity(videoPath) };
    const modelPath = resolve(process.argv[3] ?? resolve(process.env.APPDATA ?? "", "studio.hao.editkin/models", pinnedModel.fileName));
    const modelIdentity = await identity(modelPath);
    assert.equal(modelIdentity.bytes, pinnedModel.bytes, "Existing Whisper model has the wrong size; no download will be attempted");
    assert.equal(modelIdentity.sha256, pinnedModel.sha256, "Existing Whisper model has the wrong digest; no download will be attempted");
    const profile = resolve(workspace, "profile");
    const modelDirectory = resolve(profile, "data/models");
    await mkdir(modelDirectory, { recursive: true });
    const copiedModel = resolve(modelDirectory, pinnedModel.fileName);
    await copyFile(modelPath, copiedModel, constants.COPYFILE_EXCL);
    report.model = await identity(copiedModel);
    assert.equal(report.model.sha256, pinnedModel.sha256, "Copied Whisper model changed");
    const speechProbe = JSON.parse(await command("probe-speech", ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", speechPath]));
    const fixtureDuration = Number(speechProbe.format.duration);
    assert(fixtureDuration > 1 && fixtureDuration <= 15, "Speech fixture must stay short and bounded");
    const fixturePath = resolve(workspace, "SYNTHETIC-TEST-SPEECH-NOT-USER-FOOTAGE.mp4");
    await command("make-fixture", ffmpeg, ["-nostdin", "-n", "-stream_loop", "-1", "-i", videoPath, "-i", speechPath, "-map", "0:v:0", "-map", "1:a:0", "-t", String(fixtureDuration), "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", fixturePath]);
    report.fixture.combined = await identity(fixturePath);
    const port = await new Promise((done, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => done(address.port)); }); });
    const env = { ...process.env };
    // Do not inherit development-runtime, remote/update, user-pack or smoke-exit overrides.
    for (const key of Object.keys(env)) if (/^(EDITKIN_|HAO_EDITOR_|HAO_FFMPEG_PATH$|HAO_FFPROBE_PATH$|HAO_NATIVE_CORE_PATH$|WEBVIEW2_)/i.test(key)) delete env[key];
    Object.assign(env, { EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: profile, WEBVIEW2_USER_DATA_FOLDER: resolve(profile, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` });
    mark("start-packaged-ui-in-empty-profile");
    child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { childStdout = (childStdout + chunk).slice(-1024 * 1024); });
    child.stderr.on("data", (chunk) => { childStderr = (childStderr + chunk).slice(-1024 * 1024); });
    harness = createTauriCdpHarness({ child, port, startupPollMs: 200, startupInteractiveTimeoutMs: 45000, startupInteractiveAttempts: 225 });
    watchdog = setTimeout(() => { void stopOwnedTree().catch((error) => { report.watchdogCleanupError = error.message; }); }, remaining(570000));
    page = await harness.target();
    assertPackagedUrl(page.url);
    report.url = page.url;
    await poll("Startup controls", () => evaluate(`JSON.stringify({desktop:window.haoDesktop?.isDesktop,toolbar:!!document.querySelector('[data-testid="editor-toolbar"]'),welcome:!!document.querySelector('[data-testid="first-project-start"]')})`), (state) => state.desktop && state.toolbar && state.welcome, 45000);
    report.buildManifest = await evaluate(`window.__TAURI_INTERNALS__.invoke('release_input_manifest').then(v=>JSON.stringify({product:v.product,productVersion:v.productVersion,inputIdentity:v.inputIdentity,outputIdentity:v.outputIdentity}))`);
    await screenshot("01-first-start");
    const guide = await evaluate(`JSON.stringify(!!document.querySelector('[data-testid="guide-skip"]'))`);
    if (guide) await click('[data-testid="guide-skip"]');
    mark("import-synthetic-video-through-desktop-drop-api");
    await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tauri://drag-drop',payload:{paths:[${JSON.stringify(fixturePath)}],position:{x:320,y:240}}}).then(()=>JSON.stringify(true))`);
    await poll("Imported source and prepared proxy in autosave", () => evaluate(`window.haoDesktop.loadRecovery().then(v=>JSON.stringify(v))`), (value) => value.found && value.snapshot.project.assets.some((asset) => asset.uri.toLowerCase() === fixturePath.toLowerCase() && asset.derivatives?.sourceSha256 && asset.derivatives.proxyUri), 90000);
    await poll("Import button readiness", () => evaluate(`JSON.stringify({enabled:!document.querySelector('[data-testid="semantic-edit-button"]')?.disabled,exists:!!document.querySelector('[data-testid="semantic-edit-button"]'),status:document.querySelector('.status-bar')?.innerText})`), (state) => state.exists && state.enabled, 90000);
    mark("observe-real-source-preview-playback");
    const previewState = () => evaluate(`(()=>{const v=document.querySelector('.preview-stage video');const surface=document.querySelector('[data-testid="native-gpu-surface"]');const c=document.querySelector('canvas[data-testid="preview-video"]');const label=document.querySelector('[data-testid="preview-play"],[data-testid="native-preview-play"]')?.textContent?.trim();return JSON.stringify({video:!!v,readyState:v?.readyState,width:v?.videoWidth,time:v?.currentTime,paused:v?.paused,pauseOffered:label==='❚❚'||label==='暫停',nativeSurface:!!surface,canvasStatus:c?.dataset.ocioStatus,canvasWidth:c?.width,playhead:document.querySelector('[data-testid="timeline-playhead"]')?.style.left})})()`);
    const before = await poll("Source video decoder or native surface", previewState, (state) => state.nativeSurface || (state.video && state.readyState >= 2 && state.width > 0 && (!state.canvasStatus || state.canvasStatus === "ready")), 30000);
    const playSelector = before.nativeSurface ? '[data-testid="native-preview-play"]' : '[data-testid="preview-play"]';
    await click(playSelector);
    const progressed = await poll("Actual preview progression", previewState, (state) => before.video ? state.time > before.time + 0.08 : state.playhead !== before.playhead, 10000);
    report.preview = { status: before.video ? "MEASURED_HTML_VIDEO_DECODE_AND_TIME_PROGRESS" : "NATIVE_SURFACE_UI_PROGRESS_ONLY", before, progressed };
    if (!before.video) report.unmeasured.push("native swap-chain decoded pixel progression (only UI playhead progression observed)");
    await click(playSelector);
    await screenshot("02-preview-after-real-playback");
    await screenshot("02-imported-source");
    mark("verify-single-space-key-playback-toggle-in-full-app");
    // The real DOM focus is non-interactive so Space cannot also activate a button.
    // Do not replace handlers, inspect React internals, or open a native Save dialog.
    const keyboardFocus = await evaluate(`(()=>{document.activeElement?.blur();const active=document.activeElement;return JSON.stringify({tag:active?.tagName,interactive:!!active?.closest('input,textarea,select,button,[contenteditable="true"]'),blocked:!!document.querySelector('[data-shortcuts-blocked="true"],[aria-modal="true"]')})})()`);
    assert(!keyboardFocus.interactive && !keyboardFocus.blocked, "Space test requires non-interactive focus and no modal");
    const pressSpace = async () => {
      for (const type of ["keyDown", "keyUp"]) await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type, key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, remaining());
    };
    const keyboardBefore = await poll("Paused before Space", previewState, (state) => !state.pauseOffered && (!state.video || state.paused), 5000);
    await pressSpace();
    const keyboardPlaying = await poll("One Space starts playback", previewState, (state) => state.pauseOffered && (state.video ? !state.paused && state.time > keyboardBefore.time + 0.08 : state.playhead !== keyboardBefore.playhead), 5000);
    assertPlaybackToggle(keyboardBefore, keyboardPlaying, true);
    await pressSpace();
    const keyboardPaused = await poll("One Space pauses playback", previewState, (state) => !state.pauseOffered && (!state.video || state.paused), 5000);
    assertPlaybackToggle(keyboardPlaying, keyboardPaused, false);
    await delay(300);
    const keyboardSettled = await previewState();
    assert(!keyboardSettled.pauseOffered && (!keyboardSettled.video || (keyboardSettled.paused && Math.abs(keyboardSettled.time - keyboardPaused.time) <= 0.05)), "Space pause did not remain stopped");
    report.keyboardPlayback = { scope: "One observed playback transition per real CDP Space keydown in the full app tree; not a Save-dialog or all-shortcuts claim", focus: keyboardFocus, before: keyboardBefore, playing: keyboardPlaying, paused: keyboardPaused, settled: keyboardSettled };
    mark("choose-format-and-start-real-local-auto-edit");
    await click('[data-testid="semantic-edit-button"]');
    const readAutoEditConsent = () => evaluate(`(()=>{const d=document.querySelector('dialog.auto-edit-dialog');return JSON.stringify({open:!!d?.open,selectedFormat:d?.querySelector('input[name="edit-format"]:checked')?.value??null,submitDisabled:d?.querySelector('button[type="submit"]')?.disabled??null})})()`);
    const initialConsent = await poll("Auto-edit consent dialog", readAutoEditConsent, state => state.open, 10000);
    assertAutoEditConsent(initialConsent);
    await click('dialog.auto-edit-dialog input[name="edit-format"][value="longform"]');
    const selectedConsent = await poll("Explicit longform selection", readAutoEditConsent, state => state.selectedFormat === "longform" && state.submitDisabled === false, 5000);
    assertAutoEditConsent(selectedConsent, "longform");
    await click('dialog.auto-edit-dialog button[type="submit"]');
    await poll("Submitted auto-edit dialog closes", readAutoEditConsent, state => !state.open, 5000);
    report.autoEditConsent = { initial: initialConsent, selected: selectedConsent, route: "visible native local rough-cut dialog; not Codex/Claude visual analysis" };
    mark("wait-for-real-local-auto-edit-and-whisper");
    const completed = await poll("Native automatic editing with durable captions", async () => {
      const state = await readUiState();
      assertRecoveryHealthy(state);
      const recovery = await evaluate(`window.haoDesktop.loadRecovery().then(v=>JSON.stringify(v))`);
      return { state, recovery };
    }, automaticEditingComplete, 210000);
    report.automaticEdit = { ui: completed.state, savedAt: completed.recovery.snapshot.savedAt, captionCount: completed.recovery.snapshot.project.captions.length, source: "actual desktop loadRecovery response; no React state inspection" };
    const recovery = completed.recovery;
    const originalProject = recovery.snapshot.project;
    assert(originalProject.tracks.some((track) => track.kind === "video" && track.clips.length), "No editable video timeline");
    await writeFile(resolve(workspace, "automatic-result.editkin.json"), json(originalProject), { flag: "wx" });
    await screenshot("03-automatic-edit-result");
    mark("edit-an-actual-generated-caption-through-ui");
    const caption = originalProject.captions[0];
    // The default simple workspace deliberately hides the inspector. Reveal it
    // through existing visible controls, not by mutating React/localStorage state.
    const inspectorVisible = await evaluate(`JSON.stringify(!!document.querySelector('.inspector'))`);
    if (!inspectorVisible) {
      for (const selector of [".project-menu", ".project-menu-group", '[data-testid="workspace-controls"]']) {
        if (!await evaluate(`JSON.stringify(!!document.querySelector(${JSON.stringify(selector)})?.open)`)) await click(`${selector} > summary`);
      }
      await click('[data-testid="workspace-controls"] .workspace-preset-grid button:nth-child(2)');
      await click(".project-menu > summary");
    }
    await click(`[data-testid="timeline-caption-${caption.id}"]`);
    await poll("Caption editor", () => evaluate(`JSON.stringify({value:document.querySelector('[data-testid="caption-text-input"]')?.value})`), (value) => value.value === caption.text, 10000);
    await click('[data-testid="caption-text-input"]');
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2 }, remaining());
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2 }, remaining());
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: " · 測試" }, remaining());
    const edited = await poll("Manual caption edit persisted", () => evaluate(`window.haoDesktop.loadRecovery().then(v=>JSON.stringify(v))`), (value) => value.found && value.snapshot.project.captions.find((item) => item.id === caption.id)?.text === `${caption.text} · 測試`, 15000);
    const project = edited.snapshot.project;
    await writeFile(resolve(workspace, "editable-result.editkin.json"), json(project), { flag: "wx" });
    report.editable = { captions: project.captions.length, videoClips: project.tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips).length, manuallyEditedCaption: caption.id, persistence: "actual application autosave, read through desktop API", projectPath: resolve(workspace, "editable-result.editkin.json") };
    await screenshot("04-editable-caption");
    mark("render-with-the-apps-real-render-service");
    const outputPath = resolve(workspace, "first-edit-result.mp4");
    report.render = await evaluate(`window.__TAURI_INTERNALS__.invoke('render_project_smoke',{project:${JSON.stringify(project)},outputPath:${JSON.stringify(outputPath)}}).then(v=>JSON.stringify(v))`, 150000);
    report.renderEntry = "Existing integration-only output-path adapter -> same call_service('render_project') as normal export. Native Save dialog skipped; renderer not mocked.";
    const duration = Math.max(...project.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + clip.duration)), ...project.captions.map((item) => item.start + item.duration), ...project.motionGraphics.map((item) => item.timelineStart + item.duration));
    mark("independently-probe-and-decode-retained-mp4");
    const probe = JSON.parse(await command("probe-output", ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath]));
    assertOutput(probe, project, duration);
    await command("decode-output", ffmpeg, ["-nostdin", "-v", "info", "-xerror", "-i", outputPath, "-map", "0:v:0", "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
    const audioDecode = await readFile(resolve(workspace, "decode-output.stderr.txt"), "utf8");
    const maximumDb = Number(audioDecode.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1]);
    assert(Number.isFinite(maximumDb) && maximumDb > -55, "Rendered speech is silent or effectively inaudible");
    report.decodedAudio = { maximumDb, minimumAudiblePeakDb: -55, scope: "audibility smoke, not loudness/mastering acceptance" };
    await command("sample-output", ffmpeg, ["-nostdin", "-n", "-v", "error", "-ss", String(Math.min(duration / 2, project.captions[0].start + project.captions[0].duration / 2)), "-i", outputPath, "-frames:v", "1", resolve(workspace, "05-rendered-output.png")]);
    report.output = { ...await identity(outputPath), duration: Number(probe.format.duration), streams: probe.streams.map(({ codec_type, codec_name, width, height, sample_rate, channels, nb_read_frames }) => ({ codec_type, codec_name, width, height, sample_rate, channels, nb_read_frames })) };
    assert.equal((await identity(fixturePath)).sha256, report.fixture.combined.sha256, "Input video was unexpectedly changed");
    report.status = "GREEN";
    mark("synthetic-first-edit-journey-complete");
  } catch (error) {
    report.failure = { stage: report.stage, message: error.message, stack: error.stack };
    if (page && harness) { try { report.failure.ui = await readUiState(); } catch (probeError) { report.failure.uiProbeError = probeError.message; } }
    if (page && harness) { try { await screenshot("failure"); } catch (captureError) { report.screenshotError = captureError.message; } }
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (harness) {
      harness.closeCdp();
      try { await stopOwnedTree(); }
      catch (error) { report.cleanupError = error.message; report.status = "BLOCK"; process.exitCode = 1; }
    }
    report.elapsedMs = Date.now() - started;
    report.retention = "Owned profile, synthetic fixture, project, render and logs retained; no existing files deleted.";
    await writeFile(resolve(workspace, "app.stdout.txt"), childStdout, { flag: "wx" });
    await writeFile(resolve(workspace, "app.stderr.txt"), childStderr, { flag: "wx" });
    await writeFile(resolve(workspace, "report.json"), json(report), { flag: "wx" });
    process.stdout.write(json(report));
  }
}

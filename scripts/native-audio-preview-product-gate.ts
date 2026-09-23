import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { validateProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.slice(2).find((argument) => argument.toLowerCase().endsWith(".exe"))
  ?? "src-tauri/target/release/editkin.exe");
const evidenceRoot = resolve(root, ".rd/benchmarks/native-audio-preview-product");
const evidencePath = join(evidenceRoot, "report.json");
const fixtureRoot = join(evidenceRoot, "fixtures");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const timelineStartSeconds = 0.333333333333;

interface GateMeasurement {
  platform: string;
  appReady: boolean;
  apiSurface: { start: boolean; status: boolean; stop: boolean };
  processAliveAfterNegativeControls: boolean;
  projectUnchanged: boolean;
  start: Record<string, any>;
  progress: Record<string, any>;
  stop: Record<string, any>;
  statusAfterStop: Record<string, any>;
  invalidStartRejected: boolean;
  noAudioRejected: boolean;
  cacheFilesAfterStop: string[];
}

interface Assessment {
  decision: "GREEN" | "BLOCK";
  failures: string[];
}

export function assessNativeAudioPreviewProduct(measurement: GateMeasurement): Assessment {
  const failures: string[] = [];
  const stage = measurement.start?.stage ?? {};
  const started = measurement.start?.playback ?? {};
  const progress = measurement.progress?.playback ?? {};
  if (measurement.platform !== "win32") failures.push("WINDOWS_PRODUCT_REQUIRED");
  if (!measurement.appReady) failures.push("TAURI_APP_NOT_READY");
  if (!measurement.apiSurface.start || !measurement.apiSurface.status || !measurement.apiSurface.stop) failures.push("DESKTOP_API_MISSING");
  if (measurement.start?.native !== true) failures.push("NATIVE_SESSION_NOT_STARTED");
  if (stage.schema !== "editkin.native-audio-preview-stage/v1" || stage.status !== "GREEN") failures.push("STAGE_RECEIPT_INVALID");
  if (Object.hasOwn(stage, "path")) failures.push("MANAGED_PCM_PATH_EXPOSED");
  if (stage.projectId !== "slice43-native-audio" || stage.projectRevision !== 43 || stage.projectUpdatedAt !== "2026-08-28T00:00:00.000Z") failures.push("PROJECT_BINDING_INVALID");
  if (Math.abs((stage.timelineStartSeconds ?? -1) - timelineStartSeconds) > 1e-9) failures.push("STAGE_TIMELINE_INVALID");
  if (stage.sampleRate !== 48_000 || stage.channels !== 2 || !(stage.bytes > 0) || !(stage.durationSeconds >= 4)) failures.push("STAGE_PCM_INVALID");
  if (stage.clipCount !== 2 || stage.voiceClipCount !== 1 || stage.musicClipCount !== 1) failures.push("EDITGRAPH_AUDIO_ROLES_NOT_STAGED");
  if (stage.mixExecutor !== "ffmpeg-window-staging/v1" || stage.nativeGraphExecution !== false) failures.push("MIX_EXECUTOR_CLAIM_INVALID");
  if (started.schema !== "editkin.native-audio-preview-event/v1" || started.event !== "started" || started.backend !== "WASAPI shared event-driven") failures.push("WASAPI_START_RECEIPT_INVALID");
  if (Math.abs((started.timelineStartSeconds ?? -1) - timelineStartSeconds) > 1e-6) failures.push("NATIVE_START_TOLERANCE_INVALID");
  if (progress.event !== "progress" || progress.backend !== "WASAPI shared event-driven") failures.push("NATIVE_PROGRESS_MISSING");
  if (!(progress.timelineSeconds > timelineStartSeconds) || !(progress.sampleMasterFrame > 0)
    || !(progress.presentedFrame > 0) || !(progress.callbackCount > 0) || !(progress.clockQpc100ns > 0)) failures.push("NATIVE_SAMPLE_MASTER_CLOCK_DID_NOT_ADVANCE");
  if (measurement.stop?.active !== false || measurement.stop?.stopped !== true || measurement.statusAfterStop?.active !== false) failures.push("STOP_DID_NOT_TERMINATE_SESSION");
  if (!measurement.invalidStartRejected) failures.push("INVALID_START_NOT_REJECTED");
  if (!measurement.noAudioRejected) failures.push("NO_AUDIO_NOT_REJECTED_FOR_FALLBACK");
  if (!measurement.processAliveAfterNegativeControls) failures.push("NEGATIVE_CONTROL_CRASHED_PRODUCT");
  if (!measurement.projectUnchanged) failures.push("PROJECT_JSON_MUTATED");
  if (measurement.cacheFilesAfterStop.length !== 0) failures.push("MANAGED_PCM_NOT_CLEANED");
  return { decision: failures.length ? "BLOCK" : "GREEN", failures };
}

function goldenMeasurement(): GateMeasurement {
  const stage = {
    schema: "editkin.native-audio-preview-stage/v1", status: "GREEN", bytes: 1_920_000,
    projectId: "slice43-native-audio", projectRevision: 43, projectUpdatedAt: "2026-08-28T00:00:00.000Z",
    timelineStartSeconds, durationSeconds: 5, sampleRate: 48_000, channels: 2,
    clipCount: 2, voiceClipCount: 1, musicClipCount: 1,
    mixExecutor: "ffmpeg-window-staging/v1", nativeGraphExecution: false,
  };
  const playback = {
    schema: "editkin.native-audio-preview-event/v1", event: "started", backend: "WASAPI shared event-driven",
    timelineStartSeconds, timelineSeconds: timelineStartSeconds,
  };
  return {
    platform: "win32", appReady: true, apiSurface: { start: true, status: true, stop: true },
    processAliveAfterNegativeControls: true, projectUnchanged: true,
    start: { native: true, stage, playback },
    progress: { active: true, stage, playback: { ...playback, event: "progress", timelineSeconds: 0.75, sampleMasterFrame: 20_000, presentedFrame: 3_000, callbackCount: 8, clockQpc100ns: 1 } },
    stop: { active: false, stopped: true }, statusAfterStop: { active: false },
    invalidStartRejected: true, noAudioRejected: true, cacheFilesAfterStop: [],
  };
}

function runEvaluatorSelfTest(): void {
  const golden = goldenMeasurement();
  const controls: Record<string, (candidate: GateMeasurement) => void> = {
    missingApi: (value) => { value.apiSurface.start = false; },
    exposedPath: (value) => { value.start.stage.path = "secret.f32le"; },
    staleProject: (value) => { value.start.stage.projectRevision = 42; },
    falseNativeMixClaim: (value) => { value.start.stage.nativeGraphExecution = true; },
    missingMusicRole: (value) => { value.start.stage.musicClipCount = 0; },
    fakeBackend: (value) => { value.start.playback.backend = "browser"; },
    frozenClock: (value) => { value.progress.playback.sampleMasterFrame = 0; },
    failedStop: (value) => { value.statusAfterStop.active = true; },
    invalidAccepted: (value) => { value.invalidStartRejected = false; },
    noAudioAccepted: (value) => { value.noAudioRejected = false; },
    projectMutation: (value) => { value.projectUnchanged = false; },
    pcmLeak: (value) => { value.cacheFilesAfterStop = ["leaked.f32le"]; },
  };
  const detected = Object.fromEntries(Object.entries(controls).map(([name, mutate]) => {
    const candidate = structuredClone(golden);
    mutate(candidate);
    return [name, assessNativeAudioPreviewProduct(candidate).failures];
  }));
  const positive = assessNativeAudioPreviewProduct(golden);
  const green = positive.decision === "GREEN" && Object.values(detected).every((failures) => failures.length > 0);
  process.stdout.write(`${JSON.stringify({ schema: "editkin.native-audio-preview-product-evaluator-selftest/v1", decision: green ? "GREEN" : "BLOCK", positive: positive.decision, detected })}\n`);
  if (!green) process.exitCode = 1;
}

function createFixtureProject(voicePath: string, musicPath: string): EditProject {
  const project = createDemoProject();
  project.id = "slice43-native-audio";
  project.name = "Slice 43 native audio preview";
  project.revision = 43;
  project.updatedAt = "2026-08-28T00:00:00.000Z";
  project.assets = [
    { id: "voice", name: "Silent voice fixture", kind: "audio", uri: voicePath, duration: 5, role: "voice" },
    { id: "music", name: "Silent music fixture", kind: "audio", uri: musicPath, duration: 5, role: "background-music" },
  ];
  const clip = (id: string, assetId: string, trackId: string, volume: number) => ({
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: 5, volume,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  project.tracks = [
    { id: "video-main", name: "主畫面", kind: "video", locked: false, muted: false, clips: [] },
    { id: "audio-voice", name: "人聲", kind: "audio", locked: false, muted: false, clips: [clip("voice-clip", "voice", "audio-voice", 0.9)] },
    { id: "audio-music", name: "音樂", kind: "audio", locked: false, muted: false, clips: [clip("music-clip", "music", "audio-music", 0.35)] },
    { id: "caption-main", name: "字幕", kind: "caption", locked: false, muted: false, clips: [] },
  ];
  return validateProject(project);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolvePromise(port) : reject(new Error("Could not allocate CDP port")));
    });
  });
}

const delay = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolvePromise) => {
    let complete = false;
    const finish = (exited: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null) finish(true);
  });
}

async function stopApplication(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  if (await waitForExit(child, 5_000)) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await waitForExit(child, 5_000);
  }
}

interface CdpTarget { type: string; url?: string; webSocketDebuggerUrl: string }

async function waitForTarget(port: number, child: ChildProcess): Promise<CdpTarget> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Tauri exited before CDP became ready: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json() as CdpTarget[];
        const target = targets.find((item) => item.type === "page" && /^https?:\/\/tauri\.localhost\//.test(item.url ?? ""))
          ?? targets.find((item) => item.type === "page" && item.url !== "about:blank");
        if (target) return target;
      }
    } catch { /* WebView2 is starting. */ }
    await delay(200);
  }
  throw new Error("Tauri WebView2 target did not become ready within 60 seconds");
}

class CdpClient {
  private socket?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  async connect(url: string): Promise<void> {
    this.socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 10_000);
      this.socket!.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.socket!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    });
  }

  async evaluate(expression: string, timeoutMs = 10_000): Promise<any> {
    if (!this.socket) throw new Error("CDP is not connected");
    const id = ++this.nextId;
    const result = await new Promise<any>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP evaluation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "CDP evaluation failed");
    const value = result.result?.value;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  close(): void { this.socket?.close(); }
}

async function createSilentWave(path: string): Promise<void> {
  const result = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "5", "-c:a", "pcm_s16le", path,
  ], { cwd: root, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `FFmpeg fixture generation failed: ${result.status}`);
}

async function listManagedPcm(stateRoot: string): Promise<string[]> {
  const directory = join(stateRoot, "cache/media-cache/audio-preview");
  if (!existsSync(directory)) return [];
  return (await readdir(directory)).filter((name) => name.endsWith(".f32le"));
}

async function removeOwnedStateRoot(stateRoot: string): Promise<void> {
  const resolvedRoot = resolve(stateRoot);
  const ownedPrefix = `${resolve(evidenceRoot)}\\`;
  if (!resolvedRoot.startsWith(ownedPrefix) || !resolvedRoot.includes("state-")) {
    throw new Error(`Refusing to remove non-gate state root: ${resolvedRoot}`);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(resolvedRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await delay(250);
    }
  }
  process.stderr.write(`[audio-preview-gate] WebView2 state is still releasing; retained owned temp root: ${resolvedRoot}\n`);
}

async function runProductGate(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  if (process.platform !== "win32") throw new Error("This product gate requires the Windows Tauri/WASAPI product");
  if (!existsSync(executable)) throw new Error(`Tauri release executable missing: ${executable}`);
  if (!existsSync(ffmpeg)) throw new Error(`Bundled FFmpeg missing: ${ffmpeg}`);
  const voicePath = join(fixtureRoot, "silent-voice.wav");
  const musicPath = join(fixtureRoot, "silent-music.wav");
  await createSilentWave(voicePath);
  await createSilentWave(musicPath);
  const project = createFixtureProject(voicePath, musicPath);
  const stateRoot = await mkdtemp(join(evidenceRoot, "state-"));
  const port = await freePort();
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EDITKIN_INTEGRATION_SMOKE: "1",
      EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
      WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const client = new CdpClient();
  let measurement: GateMeasurement | undefined;
  try {
    const target = await waitForTarget(port, child);
    await client.connect(target.webSocketDebuggerUrl);
    let ready = { appReady: false, apiSurface: { start: false, status: false, stop: false } };
    for (let attempt = 0; attempt < 300; attempt += 1) {
      ready = await client.evaluate(`JSON.stringify({appReady:document.querySelector('.brand-copy strong')?.textContent==='Editkin'&&!document.body.innerText.includes('正在載入'),apiSurface:{start:typeof window.haoDesktop?.startNativeAudioPreview==='function',status:typeof window.haoDesktop?.nativeAudioPreviewStatus==='function',stop:typeof window.haoDesktop?.stopNativeAudioPreview==='function'}})`);
      if (ready.appReady && ready.apiSurface.start && ready.apiSurface.status && ready.apiSurface.stop) break;
      await delay(200);
    }
    await client.evaluate(`(()=>{window.__slice43Project=${JSON.stringify(project)};window.__slice43Before=JSON.stringify(window.__slice43Project);return JSON.stringify(true)})()`);
    const startEnvelope = await client.evaluate(`window.haoDesktop.startNativeAudioPreview(window.__slice43Project,${timelineStartSeconds}).then(value=>JSON.stringify({ok:true,value})).catch(error=>JSON.stringify({ok:false,error:String(error)}))`, 60_000);
    if (!startEnvelope.ok) throw new Error(`Native preview start failed: ${startEnvelope.error}`);
    let progress: Record<string, any> = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      progress = await client.evaluate("window.haoDesktop.nativeAudioPreviewStatus().then(value=>JSON.stringify(value))", 10_000);
      if (progress.active && progress.playback?.event === "progress" && progress.playback?.sampleMasterFrame > 0) break;
      await delay(50);
    }
    const stop = await client.evaluate("window.haoDesktop.stopNativeAudioPreview().then(value=>JSON.stringify(value))", 10_000);
    const statusAfterStop = await client.evaluate("window.haoDesktop.nativeAudioPreviewStatus().then(value=>JSON.stringify(value))", 10_000);
    const invalid = await client.evaluate("window.haoDesktop.startNativeAudioPreview(window.__slice43Project,-1).then(()=>JSON.stringify({rejected:false})).catch(()=>JSON.stringify({rejected:true}))", 10_000);
    const noAudio = await client.evaluate(`(()=>{const project=structuredClone(window.__slice43Project);for(const track of project.tracks)if(track.kind==='audio'||track.kind==='video')track.muted=true;return window.haoDesktop.startNativeAudioPreview(project,0).then(()=>JSON.stringify({rejected:false})).catch(()=>JSON.stringify({rejected:true}))})()`, 60_000);
    const invariants = await client.evaluate("JSON.stringify({unchanged:JSON.stringify(window.__slice43Project)===window.__slice43Before,alive:document.body?.textContent?.length>0})");
    await delay(250);
    measurement = {
      platform: process.platform,
      appReady: ready.appReady,
      apiSurface: ready.apiSurface,
      processAliveAfterNegativeControls: child.exitCode === null && invariants.alive,
      projectUnchanged: invariants.unchanged,
      start: startEnvelope.value,
      progress,
      stop,
      statusAfterStop,
      invalidStartRejected: invalid.rejected,
      noAudioRejected: noAudio.rejected,
      cacheFilesAfterStop: await listManagedPcm(stateRoot),
    };
    const assessment = assessNativeAudioPreviewProduct(measurement);
    const report = {
      schema: "editkin.native-audio-preview-product-gate/v1",
      decision: assessment.decision,
      measuredAt: new Date().toISOString(),
      executable,
      measurement,
      failures: assessment.failures,
      claimBoundary: "Proves a bounded EditGraph audio window is staged by the delivered service, played through real hao-core WASAPI output, and clocked/stopped through the Tauri product API. The mix executor remains FFmpeg staging; a fully native audio DAG, device hotplug replacement, multi-hour drift, and CoreAudio parity remain open.",
    };
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (assessment.decision !== "GREEN") process.exitCode = 1;
  } catch (error) {
    const report = {
      schema: "editkin.native-audio-preview-product-gate/v1",
      decision: "BLOCK",
      measuredAt: new Date().toISOString(),
      executable,
      measurement,
      failures: [error instanceof Error ? error.message : String(error)],
      stderr,
    };
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
    await stopApplication(child);
    await removeOwnedStateRoot(stateRoot);
  }
}

await mkdir(evidenceRoot, { recursive: true });
if (process.argv.includes("--self-test")) runEvaluatorSelfTest();
else await runProductGate();

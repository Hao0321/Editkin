import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createDemoProject } from "../src/domain/demo";
import { validateProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(process.argv.slice(2).find((argument) => argument.toLowerCase().endsWith("editkin.exe"))
  ?? "src-tauri/target/release/editkin.exe");
const nativeCore = join(dirname(executable), "runtime", "hao-core.exe");
const evidenceRoot = resolve(root, ".rd/benchmarks/native-audio-mix-product");
const evidencePath = join(evidenceRoot, "report.json");
const baselinePath = join(evidenceRoot, "baseline.json");
const fixtureRoot = join(evidenceRoot, "fixtures");
const ffmpeg = join(dirname(executable), "runtime", "ffmpeg.exe");
const oldProductReport = resolve(root, ".rd/benchmarks/native-audio-preview-product/report.json");
const timelineStartSeconds = 0.333333333333;
const sampleRate = 48_000;
const channels = 2;

import {
  assessNativeAudioMixProduct, goldenMeasurement, runEvaluatorSelfTest,
  type GateMeasurement, type NativeMixReceipt, type SignalOracle,
} from "./nativeAudioMixProductEvaluator";
import { assessResidentAudio, runResidentAudioJourney, residentEvaluatorSelfTest, type ResidentMeasurement } from "./nativeResidentAudioProduct";

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function float32Buffer(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function stereoTone(frequency: number, frames: number, amplitude: number, activeStart = 0, activeEnd = frames): Float32Array {
  const output = new Float32Array(frames * channels);
  for (let frame = activeStart; frame < Math.min(activeEnd, frames); frame += 1) {
    const sample = amplitude * Math.sin(2 * Math.PI * frequency * frame / sampleRate);
    output[frame * 2] = sample;
    output[frame * 2 + 1] = sample;
  }
  return output;
}

function toneAmplitude(samples: Float32Array, frequency: number, startFrame: number, endFrame: number): number {
  let sin = 0;
  let cos = 0;
  const boundedEnd = Math.min(endFrame, samples.length / channels);
  const count = Math.max(1, boundedEnd - startFrame);
  for (let frame = startFrame; frame < boundedEnd; frame += 1) {
    const value = (samples[frame * 2] + samples[frame * 2 + 1]) * 0.5;
    const angle = 2 * Math.PI * frequency * frame / sampleRate;
    sin += value * Math.sin(angle);
    cos += value * Math.cos(angle);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

async function runSignalOracle(directory: string): Promise<SignalOracle> {
  const frames = sampleRate * 2;
  const voiceFrames = sampleRate;
  const voicePath = join(directory, "oracle-voice.f32le");
  const musicPath = join(directory, "oracle-music.f32le");
  const manifestPath = join(directory, "oracle-manifest.json");
  const outputPath = join(directory, "oracle-output.f32le");
  await writeFile(voicePath, float32Buffer(stereoTone(997, voiceFrames, 0.6)));
  await writeFile(musicPath, float32Buffer(stereoTone(211, frames, 0.6)));
  const source = async (id: string, clipId: string, role: "voice" | "music", path: string, startFrame: number, gainDb: number, gainAutomation: Array<{ sample: number; valueDb: number }>) => ({
    id, clipId, assetId: `${id}-asset`, role, path, bytes: (await stat(path)).size, sha256: await sha256File(path), startFrame, gainDb, gainAutomation,
  });
  const manifest = {
    schema: "editkin.native-audio-preview-mix/v1", sampleRate, channels, durationFrames: frames,
    decoderExecutor: "ffmpeg-source-decode/v1",
    sources: [
      await source("voice-source", "voice-clip", "voice", voicePath, sampleRate / 2, -6.0206, []),
      await source("music-source", "music-clip", "music", musicPath, 0, 0, [
        { sample: 0, valueDb: -144 }, { sample: 9_600, valueDb: 0 }, { sample: 86_400, valueDb: 0 }, { sample: 95_999, valueDb: -144 },
      ]),
    ],
    ducking: { enabled: true, thresholdDb: -32, floorDb: -18, attackMs: 25, releaseMs: 180 },
    master: { limiterCeilingDb: -3 },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const child = spawnSync(nativeCore, ["audio-preview-mix", manifestPath, outputPath], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30_000 });
  if (child.status !== 0 || !existsSync(outputPath)) {
    return { commandSucceeded: false, receipt: {}, outputBytes: 0, outputSha256: "", outputPeak: 0, fadeRatio: 0, duckingRatio: 1, voiceBeforePlacement: 1, voiceAfterPlacement: 0 };
  }
  const receipt = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as NativeMixReceipt;
  const bytes = await readFile(outputPath);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const outputPeak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
  const fadeAmplitude = toneAmplitude(samples, 211, 800, 2_400);
  const middleAmplitude = toneAmplitude(samples, 211, 14_400, 19_200);
  const duckedAmplitude = toneAmplitude(samples, 211, 33_600, 38_400);
  const voiceBeforePlacement = toneAmplitude(samples, 997, 9_600, 19_200);
  const voiceAfterPlacement = toneAmplitude(samples, 997, 33_600, 38_400);
  return {
    commandSucceeded: true,
    receipt,
    outputBytes: bytes.length,
    outputSha256: createHash("sha256").update(bytes).digest("hex"),
    outputPeak,
    fadeRatio: middleAmplitude / Math.max(fadeAmplitude, 1e-9),
    duckingRatio: duckedAmplitude / Math.max(middleAmplitude, 1e-9),
    voiceBeforePlacement,
    voiceAfterPlacement,
  };
}

function createFixtureProject(voicePath: string, musicPath: string): EditProject {
  const project = createDemoProject();
  project.id = "slice44-native-audio";
  project.name = "Slice 44 native audio mix";
  project.revision = 44;
  project.updatedAt = "2026-08-28T00:00:00.000Z";
  project.assets = [
    { id: "voice", name: "Silent voice fixture", kind: "audio", uri: voicePath, duration: 20, role: "voice" },
    { id: "music", name: "Silent music fixture", kind: "audio", uri: musicPath, duration: 20, role: "background-music" },
  ];
  const clip = (id: string, assetId: string, trackId: string, volume: number) => ({
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: 20, volume,
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
    const finish = (exited: boolean) => { if (complete) return; complete = true; clearTimeout(timer); child.off("exit", onExit); resolvePromise(exited); };
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
  private reloadRequested = false;
  acceptedBeforeUnload = 0;
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
      if (message.method === "Page.javascriptDialogOpening" && this.reloadRequested && message.params?.type === "beforeunload") {
        this.reloadRequested = false;
        // Only the owned disposable fixture can reach this client. Match a
        // user accepting its reload prompt; never accept arbitrary dialogs.
        void this.command("Page.handleJavaScriptDialog", { accept: true }).then(() => { this.acceptedBeforeUnload += 1; });
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    });
  }

  private async send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.socket) throw new Error("CDP is not connected");
    const id = ++this.nextId;
    const result = await new Promise<any>((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
    return result;
  }

  async command(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    if (method === "Page.reload") this.reloadRequested = true;
    return this.send(method, params, timeoutMs);
  }

  async evaluate(expression: string, timeoutMs = 10_000): Promise<any> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "CDP evaluation failed");
    const value = result.result?.value;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  close(): void { this.socket?.close(); }
}

async function createSubAudibleWave(path: string, frequency: number): Promise<void> {
  const result = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`,
    "-af", "volume=0.00001", "-t", "20", "-c:a", "pcm_f32le", path,
  ], { cwd: root, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `FFmpeg fixture generation failed: ${result.status}`);
}

async function listCacheEntries(directory: string, prefix = ""): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listCacheEntries(join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

async function removeOwnedStateRoot(stateRoot: string): Promise<void> {
  const resolvedRoot = resolve(stateRoot);
  const ownedPrefix = `${resolve(evidenceRoot)}\\`;
  if (!resolvedRoot.startsWith(ownedPrefix) || !resolvedRoot.includes("state-")) throw new Error(`Refusing to remove non-gate state root: ${resolvedRoot}`);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(resolvedRoot, { recursive: true, force: true }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await delay(250);
    }
  }
  process.stderr.write(`[audio-mix-gate] WebView2 state is still releasing; retained owned temp root: ${resolvedRoot}\n`);
}

async function runBaseline(): Promise<void> {
  const oldBytes = await readFile(oldProductReport);
  const old = JSON.parse(oldBytes.toString("utf8"));
  const candidate = goldenMeasurement();
  candidate.start = old.measurement?.start ?? {};
  candidate.progress = old.measurement?.progress ?? {};
  candidate.signalOracle.commandSucceeded = false;
  candidate.signalOracle.receipt = {};
  const assessment = assessNativeAudioMixProduct(candidate);
  const report = {
    schema: "editkin.native-audio-mix-baseline/v1",
    decision: assessment.decision,
    expectedDecision: "BLOCK",
    baseline: "slice43-ffmpeg-window-staging",
    sourceReport: ".rd/benchmarks/native-audio-preview-product/report.json",
    sourceReportSha256: createHash("sha256").update(oldBytes).digest("hex"),
    failures: assessment.failures,
  };
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (assessment.decision !== "BLOCK" || !assessment.failures.includes("NATIVE_MIX_STAGE_CLAIM_INVALID")) process.exitCode = 1;
}

async function runOracleOnly(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  if (!existsSync(nativeCore)) throw new Error(`hao-core missing: ${nativeCore}`);
  const signalOracle = await runSignalOracle(fixtureRoot);
  const measurement = goldenMeasurement();
  measurement.signalOracle = signalOracle;
  const failures = assessNativeAudioMixProduct(measurement).failures
    .filter((failure) => failure.startsWith("ORACLE_") || failure === "OFFLINE_NATIVE_MIX_COMMAND_FAILED");
  const report = { schema: "editkin.native-audio-mix-signal-oracle/v1", decision: failures.length ? "BLOCK" : "GREEN", nativeCore, signalOracle, failures };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failures.length) process.exitCode = 1;
}

async function runProductGate(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  if (process.platform !== "win32") throw new Error("This product gate requires Windows Tauri/WASAPI");
  if (!existsSync(executable)) throw new Error(`Tauri release executable missing: ${executable}`);
  if (!existsSync(nativeCore)) throw new Error(`Delivered hao-core missing: ${nativeCore}`);
  if (!existsSync(ffmpeg)) throw new Error(`Bundled FFmpeg missing: ${ffmpeg}`);
  const voicePath = join(fixtureRoot, "silent-voice.wav");
  const musicPath = join(fixtureRoot, "silent-music.wav");
  await createSubAudibleWave(voicePath, 29);
  await createSubAudibleWave(musicPath, 23);
  const project = createFixtureProject(voicePath, musicPath);
  const signalOracle = await runSignalOracle(fixtureRoot);
  const stateRoot = await mkdtemp(join(evidenceRoot, "state-"));
  const port = await freePort();
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot, WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const client = new CdpClient();
  let measurement: GateMeasurement | ResidentMeasurement | undefined;
  try {
    const target = await waitForTarget(port, child);
    await client.connect(target.webSocketDebuggerUrl);
    await client.command("Page.enable");
    let ready = { appReady: false, apiSurface: { start: false, status: false, stop: false, saveRecovery: false, integrationSmoke: false } };
    const appReadyDeadline = Date.now() + 60_000;
    while (Date.now() < appReadyDeadline) {
      ready = await client.evaluate(`JSON.stringify({appReady:document.querySelector('.brand-copy strong')?.textContent==='Editkin'&&!document.body.innerText.includes('正在載入'),apiSurface:{start:typeof window.haoDesktop?.startNativeAudioPreview==='function',status:typeof window.haoDesktop?.nativeAudioPreviewStatus==='function',stop:typeof window.haoDesktop?.stopNativeAudioPreview==='function',saveRecovery:typeof window.haoDesktop?.saveRecovery==='function',integrationSmoke:typeof window.haoDesktop?.integrationSmokeEnabled==='function'}})`, 1_000);
      if (ready.appReady && Object.values(ready.apiSurface).every(Boolean)) break;
      await delay(200);
    }
    if (!ready.appReady || !Object.values(ready.apiSurface).every(Boolean)) throw new Error("Tauri app/API surface did not become ready within 60 seconds");
    // Fresh-profile onboarding mounts lazily. Dismiss it using the public UI
    // before staging playback; a programmatic click would bypass its backdrop.
    let guidePoint: { x: number; y: number } | undefined;
    const guideDeadline = Date.now() + 15000;
    while (Date.now() < guideDeadline) {
      guidePoint = await client.evaluate(`(()=>{const e=document.querySelector('[data-testid="guide-skip"]');if(!e)return JSON.stringify(null);const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return JSON.stringify(e.contains(document.elementFromPoint(x,y))?{x,y}:null)})()`);
      if (guidePoint) break;
      await delay(80);
    }
    if (!guidePoint) throw new Error("Fresh-profile onboarding did not become actionable");
    for (const type of ["mousePressed", "mouseReleased"]) await client.command("Input.dispatchMouseEvent", { type, ...guidePoint, button: "left", clickCount: 1 });
    await client.evaluate(`(()=>{window.__slice44Project=${JSON.stringify(project)};window.__slice44Before=JSON.stringify(window.__slice44Project);return JSON.stringify(true)})()`);
    await delay(600);
    const recoverySaved = await client.evaluate(`window.haoDesktop.saveRecovery(window.__slice44Project,undefined,window.__slice44Project.updatedAt).then(()=>JSON.stringify({saved:true})).catch(error=>JSON.stringify({saved:false,error:String(error)}))`, 10_000);
    if (!recoverySaved.saved) throw new Error(`Could not stage UI fixture through recovery: ${recoverySaved.error}`);
    await client.command("Page.reload", { ignoreCache: true });
    let uiReady = { ready: false, projectLoaded: false, playControlFound: false };
    const uiReadyDeadline = Date.now() + 30_000;
    while (Date.now() < uiReadyDeadline) {
      try {
        uiReady = await client.evaluate(`JSON.stringify({ready:document.querySelector('.brand-copy strong')?.textContent==='Editkin'&&!document.body.innerText.includes('正在載入'),projectLoaded:document.title.includes('Slice 44 native audio mix'),playControlFound:Boolean(document.querySelector('[data-testid="preview-play"],[data-testid="native-preview-play"]'))})`, 1_000);
        if (uiReady.ready && uiReady.projectLoaded && uiReady.playControlFound) break;
      } catch { /* the document is navigating */ }
      await delay(100);
    }
    if (!uiReady.ready || !uiReady.projectLoaded || !uiReady.playControlFound) throw new Error(`UI fixture did not become ready within 30 seconds: ${JSON.stringify(uiReady)}`);
    const capabilities = await client.evaluate("window.haoDesktop.residentAudio.capabilities().then(v=>JSON.stringify(v))");
    if (capabilities.supported && capabilities.gpuClock && capabilities.clockSchema === "editkin.resident-audio-clock/v1") {
      measurement = { route: "resident", actions: [], snapshots: {}, guards: {}, signalOracle };
      await runResidentAudioJourney(client, measurement);
      const assessment = assessResidentAudio(measurement);
      const report = { schema: "editkin.native-audio-mix-product-gate/v2", ...assessment, measuredAt: new Date().toISOString(), executable: { path: executable, sha256: await sha256File(executable) }, nativeCore: { path: nativeCore, sha256: await sha256File(nativeCore) }, measurement, acceptedBeforeUnload: client.acceptedBeforeUnload,
        claimBoundary: "Current resident route: trusted UI play/pause/resume/seek/reload, native owner/sample-clock observations and exclusion guards. Independent offline DAG oracle verifies placement/gain/fade/ducking/limiter; it is NOT proof of all resident DSP features, acoustic output, device replacement, hours-long A/V drift or CoreAudio." };
      await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ decision: report.decision, route: "resident", failures: report.failures, evidencePath })}\n`);
      if (assessment.decision !== "GREEN") process.exitCode = 1;
      return;
    }
    const uiJourney = await client.evaluate(`(async()=>{const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const button=document.querySelector('[data-testid="preview-play"],[data-testid="native-preview-play"]');const result={projectLoaded:document.title.includes('Slice 44 native audio mix'),playControlFound:Boolean(button),clickDispatched:false,enteredNativeMode:false,nativeBadgeVisible:false,compatibleFallbackVisible:false,sampleMasterFrame:0,timelineSeconds:0,stoppedFromUi:false};if(!button)return JSON.stringify(result);button.click();result.clickDispatched=true;const deadline=performance.now()+15000;do{const panel=document.querySelector('.preview-panel');const status=await window.haoDesktop.nativeAudioPreviewStatus();result.enteredNativeMode=panel?.dataset.nativeAudioMode==='native';result.nativeBadgeVisible=Boolean(document.querySelector('[data-testid="native-audio-active"]'));result.compatibleFallbackVisible=Boolean(document.querySelector('[data-testid="native-audio-fallback"]'));result.sampleMasterFrame=Math.max(result.sampleMasterFrame,Number(status.playback?.sampleMasterFrame)||0);result.timelineSeconds=Math.max(result.timelineSeconds,Number(status.playback?.timelineSeconds)||0);if(result.enteredNativeMode&&result.nativeBadgeVisible&&result.sampleMasterFrame>0&&result.timelineSeconds>0)break;await wait(40)}while(performance.now()<deadline);button.click();const stopDeadline=performance.now()+5000;do{const status=await window.haoDesktop.nativeAudioPreviewStatus();if(status.active===false){result.stoppedFromUi=true;break}await wait(40)}while(performance.now()<stopDeadline);return JSON.stringify(result)})()`, 25_000);
    await client.evaluate(`(()=>{window.__slice44Project=${JSON.stringify(project)};window.__slice44Before=JSON.stringify(window.__slice44Project);return JSON.stringify(true)})()`);
    const startEnvelope = await client.evaluate(`window.haoDesktop.startNativeAudioPreview(window.__slice44Project,${timelineStartSeconds}).then(value=>JSON.stringify({ok:true,value})).catch(error=>JSON.stringify({ok:false,error:String(error)}))`, 60_000);
    if (!startEnvelope.ok) throw new Error(`Native preview start failed: ${startEnvelope.error}`);
    let progress: Record<string, any> = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      progress = await client.evaluate("window.haoDesktop.nativeAudioPreviewStatus().then(value=>JSON.stringify(value))", 10_000);
      if (progress.active && progress.playback?.event === "progress" && progress.playback?.sampleMasterFrame > 0) break;
      await delay(50);
    }
    const stop = await client.evaluate("window.haoDesktop.stopNativeAudioPreview().then(value=>JSON.stringify(value))", 10_000);
    const statusAfterStop = await client.evaluate("window.haoDesktop.nativeAudioPreviewStatus().then(value=>JSON.stringify(value))", 10_000);
    const invalid = await client.evaluate("window.haoDesktop.startNativeAudioPreview(window.__slice44Project,-1).then(()=>JSON.stringify({rejected:false})).catch(()=>JSON.stringify({rejected:true}))", 10_000);
    const noAudio = await client.evaluate(`(()=>{const project=structuredClone(window.__slice44Project);for(const track of project.tracks)if(track.kind==='audio'||track.kind==='video')track.muted=true;return window.haoDesktop.startNativeAudioPreview(project,0).then(()=>JSON.stringify({rejected:false})).catch(()=>JSON.stringify({rejected:true}))})()`, 60_000);
    const invariants = await client.evaluate("JSON.stringify({unchanged:JSON.stringify(window.__slice44Project)===window.__slice44Before,alive:document.body?.textContent?.length>0})");
    await delay(250);
    measurement = {
      platform: process.platform,
      appReady: ready.appReady,
      apiSurface: ready.apiSurface,
      uiJourney,
      processAliveAfterNegativeControls: child.exitCode === null && invariants.alive,
      projectUnchanged: invariants.unchanged,
      start: startEnvelope.value,
      progress,
      stop,
      statusAfterStop,
      invalidStartRejected: invalid.rejected,
      noAudioRejected: noAudio.rejected,
      cacheEntriesAfterStop: await listCacheEntries(join(stateRoot, "cache/media-cache/audio-preview")),
      signalOracle,
    };
    const assessment = assessNativeAudioMixProduct(measurement);
    const report = {
      schema: "editkin.native-audio-mix-product-gate/v1",
      decision: assessment.decision,
      measuredAt: new Date().toISOString(),
      executable: { path: executable, sha256: await sha256File(executable) },
      nativeCore: { path: nativeCore, sha256: await sha256File(nativeCore) },
      measurement,
      failures: assessment.failures,
      claimBoundary: "Proves one bounded Windows Preview window uses FFmpeg only for independent source decode, executes timeline placement, clip gain, music fade automation, voice/music buses, sidechain ducking and master sample-peak limiting in hao-core, then reaches the real WASAPI sample clock. Device replacement, multi-hour A/V drift, final encoded loudness, extracted installer replay and CoreAudio remain open.",
    };
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (assessment.decision !== "GREEN") process.exitCode = 1;
  } catch (error) {
    let uiFailure;
    try { uiFailure = await client.evaluate(`JSON.stringify({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,3000),api:!!window.haoDesktop,ready:document.readyState})`, 2000); } catch (diagnosticError) { uiFailure = String(diagnosticError); }
    try { const shot = await client.command("Page.captureScreenshot", { format: "png" }, 2000); await writeFile(join(evidenceRoot,"last-failure.png"),Buffer.from(shot.data,"base64")); } catch { /* Never hide the primary failure if the page cannot be inspected. */ }
    const report = { schema: "editkin.native-audio-mix-product-gate/v1", decision: "BLOCK", measuredAt: new Date().toISOString(), executable, measurement, uiFailure, failures: [error instanceof Error ? error.message : String(error)], stderr };
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
if (process.argv.includes("--self-test")) { runEvaluatorSelfTest(); residentEvaluatorSelfTest(); }
else if (process.argv.includes("--baseline")) await runBaseline();
else if (process.argv.includes("--oracle")) await runOracleOnly();
else await runProductGate();

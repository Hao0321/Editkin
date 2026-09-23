import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmptyProject } from "../src/domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM, type EditProject } from "../src/domain/types";
import { buildAssFilter, renderProject } from "../src/render/ffmpeg";

const root = resolve(".");
const reportRoot = resolve(root, "../../.rd/benchmarks/editkin-color-render-20260822");
const ffmpeg = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const nativeCore = resolve(root, "native/bin/win32-x64/hao-core.exe");
const source = resolve(root, "public/demo-source.mp4");
const fontRoot = resolve(root, "public/fonts");
const colorRoot = resolve(root, "public/color/aces2");

function fixture(graded: boolean, log = false): EditProject {
  const project = createEmptyProject(graded ? "Graded" : "Reference", { id: graded ? "graded" : "reference", width: 640, height: 360, fps: 30 });
  project.assets.push({
    id: "source", name: log ? "Unresolved Log camera" : "Rec.709 camera", kind: "video", uri: source, duration: 12, width: 960, height: 540,
    color: { interpretation: "auto", transfer: log ? "logc3" : "bt709", primaries: "bt709", matrix: "bt709", range: "tv" },
  });
  project.tracks[0].clips.push({
    id: "shot", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 2,
    volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: graded ? { ...DEFAULT_COLOR, exposure: 0.75, temperature: 0.45, tint: -0.12, contrast: 1.12, pivot: 0.46, saturation: 1.18, shadows: 0.08, highlights: -0.12, blacks: -0.05, whites: 0.08 } : { ...DEFAULT_COLOR },
    keyframes: [],
  });
  project.captions = [{ id: "font-proof", text: "Editkin 專業調色", start: 0.2, duration: 1.5 }];
  project.captionStyle = { ...project.captionStyle, fontFamily: "LXGW WenKai Mono TC", fontSize: 42 };
  return project;
}

async function runBuffer(executable: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-200_000); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise({ stdout: Buffer.concat(stdout), stderr }) : reject(new Error(stderr.slice(-8_000))));
  });
}

async function frameEvidence(path: string) {
  const { stdout } = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  let sum = 0;
  for (let index = 0; index < stdout.length; index += 3) sum += 0.2126 * stdout[index] + 0.7152 * stdout[index + 1] + 0.0722 * stdout[index + 2];
  return { bytes: stdout.length, sha256: createHash("sha256").update(stdout).digest("hex"), meanLuma: Number((sum / Math.max(1, stdout.length / 3)).toFixed(3)) };
}

await rm(reportRoot, { recursive: true, force: true });
await mkdir(reportRoot, { recursive: true });
const referencePath = resolve(reportRoot, "reference.mp4");
const gradedPath = resolve(reportRoot, "graded.mp4");
const acesPath = resolve(reportRoot, "aces2-rec709.mp4");
const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, nativeCorePath: nativeCore, preferGpu: false, timeoutMs: 120_000, fontRoot, colorRoot };
const reference = await renderProject(fixture(false), referencePath, options);
const graded = await renderProject(fixture(true), gradedPath, options);
const acesProject = fixture(false);
acesProject.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
const aces = await renderProject(acesProject, acesPath, options);
const referenceFrame = await frameEvidence(referencePath);
const gradedFrame = await frameEvidence(gradedPath);
const acesFrame = await frameEvidence(acesPath);
let logBlocked = false;
try { await renderProject(fixture(false, true), resolve(reportRoot, "must-not-render.mp4"), options); }
catch (error) { logBlocked = /未解讀 Log/.test(error instanceof Error ? error.message : String(error)); }

const assPath = resolve(reportRoot, "font-proof.ass");
await writeFile(assPath, `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,LXGW WenKai Mono TC,42,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,24,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Editkin 字型\n`, "utf8");
const fontProbe = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "verbose", "-f", "lavfi", "-i", "color=black:s=640x360:d=1", "-vf", buildAssFilter(assPath, fontRoot), "-frames:v", "1", "-f", "null", "-"]);
const bundledFontSelected = /fontselect: \(LXGW WenKai Mono TC, 400, 0\).*LXGWWenKaiMonoTC-Regular/i.test(fontProbe.stderr);
const assertions = {
  actualFrameDiffers: referenceFrame.sha256 !== gradedFrame.sha256,
  exposureMateriallyChangesLuma: Math.abs(gradedFrame.meanLuma - referenceFrame.meanLuma) >= 3,
  unresolvedLogBlocksExport: logBlocked,
  bundledFontSelectedByLibass: bundledFontSelected,
  acesTransformChangesDecodedFrame: acesFrame.sha256 !== referenceFrame.sha256,
  outputsComplete: reference.duration === 2 && graded.duration === 2 && aces.duration === 2 && referenceFrame.bytes === 640 * 360 * 3 && gradedFrame.bytes === 640 * 360 * 3 && acesFrame.bytes === 640 * 360 * 3,
};
const report = {
  status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK",
  protocol: { id: "editkin-color-render-v1", chain: "input transform → primary → one look → graphics", frameTimeSeconds: 1, font: "LXGW WenKai Mono TC" },
  outputs: { reference, graded, aces },
  frames: { reference: referenceFrame, graded: gradedFrame, aces: acesFrame },
  font: { filter: buildAssFilter(assPath, fontRoot), bundledFontSelected },
  assertions,
  hdrRealFootage: { status: "NOT_MEASURED", reason: "HLG/PQ branches are contract-tested; camera-specific HDR footage requires a calibrated reference display and physical review." },
  humanColorApproval: { status: "REQUIRED", reason: "Machine scopes and frame metrics cannot certify creative color intent." },
};
await writeFile(resolve(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "GREEN") process.exitCode = 1;

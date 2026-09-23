import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { applyCommand } from "../src/domain/commands";
import { createDemoProject } from "../src/domain/demo";
import { createEmptyProject, findClip } from "../src/domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../src/domain/history";
import { compileClipAlphaPlan } from "../src/domain/clipAlphaPlan";
import { createClipMask } from "../src/domain/masks";
import { projectSchema } from "../src/domain/schema";
import {
  applyChromaKeyPixel,
  CHROMA_KEY_PRESETS,
  chromaKeyFfmpegFilter,
} from "../src/domain/chromaKey";
import { buildGpuEngineVideoPreviewGraph, buildGpuVideoPreviewSource } from "../src/render/gpuCompositor";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type TimelineClip } from "../src/domain/types";
import { renderProject } from "../src/render/ffmpeg";
import { applyClipAlphaPlanRgbaInPlace } from "../src/ui/alphaPlanPreview";
import { readProjectFile, writeProjectFileAtomic } from "../src/application/projectFiles";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = join(root, ".rd", "benchmarks", "editkin-self-authored-screen-keyer");
const reportPath = join(evidenceRoot, "report.json");
const retainedFormalArtifactPath = join(evidenceRoot, "formal-project-keyed.mp4");
const selfTest = process.argv.includes("--self-test");

interface SampleResult {
  screen: "green" | "blue";
  input: number[];
  preview: number[];
  formal: number[];
  maxDelta: number;
}

interface EvaluatorInput {
  samples: SampleResult[];
  disabledIdentity: boolean;
  projectFileSaveReopen: boolean;
  undoRedo: boolean;
  nativeAdmissionRejected: boolean;
  productDependencyBoundary: boolean;
  projectRenderExecuted: boolean;
  projectRenderArtifactBound: boolean;
  projectRenderBackgroundReplaced: boolean;
  projectRenderSubjectPreserved: boolean;
  sharedAlphaPlanCombination: boolean;
}

const thresholds = Object.freeze({
  requiredScreens: ["green", "blue"] as const,
  sampleRgbaBytes: 12,
  previewFormalMaxCodeDelta: 6,
  backingAlphaMax: 6,
  opaqueSubjectAlphaMin: 249,
  fractionalAlphaMinExclusive: 6,
  fractionalAlphaMaxExclusive: 249,
  projectCompositeMaxChannelDelta: 35,
  edgeSpillRule: "candidate channel excess must be strictly lower than the frozen raw input",
});

const dependencyBoundarySourcePaths = [
  "src/domain/chromaKey.ts", "src/domain/visualTypes.ts", "src/domain/projectValidation.ts", "src/domain/schema.ts",
  "src/domain/clipAlphaPlan.ts", "src/render/ffmpegComposite.ts", "src/render/gpuCompositor.ts",
  "src/ui/alphaPlanPreview.ts", "src/ui/AlphaProcessedPreviewMedia.tsx", "src/ui/MaskStudio.tsx", "src/ui/Preview.tsx",
] as const;

const directGateSourcePaths = [
  "src/application/projectFiles.ts", "src/domain/chromaKey.ts", "src/domain/clipAlphaPlan.ts", "src/domain/commands.ts",
  "src/domain/demo.ts", "src/domain/editGraph.ts", "src/domain/history.ts", "src/domain/masks.ts", "src/domain/projectValidation.ts",
  "src/domain/schema.ts", "src/domain/types.ts", "src/render/gpuCompositor.ts", "src/ui/alphaPlanPreview.ts",
  "src/ui/AlphaProcessedPreviewMedia.tsx", "src/ui/MaskStudio.tsx", "scripts/self-authored-screen-keyer-gate.ts",
] as const;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(path: string) {
  const bytes = await readFile(path);
  return { path: relative(root, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
}

async function resolveLocalTypeScriptModule(importer: string, specifier: string): Promise<string> {
  const base = resolve(dirname(importer), specifier);
  const candidates = /\.[cm]?[jt]sx?$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Unable to bind local executor dependency ${specifier} imported by ${relative(root, importer)}`);
}

async function directLocalTypeScriptDependencies(entrypoint: string): Promise<string[]> {
  const source = await readFile(entrypoint, "utf8");
  const specifiers = [
    ...source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/g),
  ].map((match) => match[1]!);
  const dependencies = await Promise.all([...new Set(specifiers)].map((specifier) => resolveLocalTypeScriptModule(entrypoint, specifier)));
  return [...new Set(dependencies)].sort();
}

function validRgbaSample(values: readonly number[]): boolean {
  return values.length === thresholds.sampleRgbaBytes
    && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
}

function edgeSpillExcess(values: readonly number[], screen: "green" | "blue"): number {
  const edgeOffset = 8;
  const dominant = screen === "green" ? 1 : 2;
  const neutralChannels = screen === "green" ? [0, 2] : [0, 1];
  const neutral = Math.max(...neutralChannels.map((channel) => values[edgeOffset + channel]));
  return Math.max(0, values[edgeOffset + dominant] - neutral);
}

function evaluate(input: EvaluatorInput): string[] {
  const failures: string[] = [];
  const sampleScreens = input.samples.map((sample) => sample.screen).sort();
  if (input.samples.length !== thresholds.requiredScreens.length
    || sampleScreens.join(",") !== [...thresholds.requiredScreens].sort().join(",")) {
    failures.push("exactly one green and one blue sample are required");
  }
  for (const sample of input.samples) {
    if (![sample.input, sample.preview, sample.formal].every(validRgbaSample)) {
      failures.push(`${sample.screen} sample was not a complete 3-pixel RGBA fixture`);
      continue;
    }
    const measuredMaxDelta = Math.max(...sample.formal.map((value, index) => Math.abs(value - sample.preview[index])));
    if (measuredMaxDelta !== sample.maxDelta) failures.push(`${sample.screen} reported preview/formal delta was stale`);
    if (measuredMaxDelta > thresholds.previewFormalMaxCodeDelta) {
      failures.push(`${sample.screen} preview/formal delta exceeded ${thresholds.previewFormalMaxCodeDelta}`);
    }
    const alphas = [sample.formal[3], sample.formal[7], sample.formal[11]];
    if (alphas[0] > thresholds.backingAlphaMax) failures.push(`${sample.screen} backing was not transparent`);
    if (alphas[1] < thresholds.opaqueSubjectAlphaMin) failures.push(`${sample.screen} opaque subject was lost`);
    if (alphas[2] <= thresholds.fractionalAlphaMinExclusive || alphas[2] >= thresholds.fractionalAlphaMaxExclusive) {
      failures.push(`${sample.screen} edge did not retain fractional alpha`);
    }
    if (edgeSpillExcess(sample.formal, sample.screen) >= edgeSpillExcess(sample.input, sample.screen)) {
      failures.push(`${sample.screen} edge despill did not reduce channel excess`);
    }
  }
  if (!input.disabledIdentity) failures.push("disabled keyer was not identity");
  if (!input.projectFileSaveReopen) failures.push("atomic project-file save/reopen lost keyer settings");
  if (!input.undoRedo) failures.push("Undo/Redo lost keyer settings");
  if (!input.nativeAdmissionRejected) failures.push("unsupported native GPU path did not fail closed");
  if (!input.productDependencyBoundary) failures.push("restricted external keyer dependency entered product source");
  if (!input.projectRenderExecuted) failures.push("EditGraph formal render did not execute");
  if (!input.projectRenderArtifactBound) failures.push("retained formal render artifact identity was missing or stale");
  if (!input.projectRenderBackgroundReplaced) failures.push("formal project render did not replace the screen with the lower layer");
  if (!input.projectRenderSubjectPreserved) failures.push("formal project render did not preserve the opaque subject");
  if (!input.sharedAlphaPlanCombination) failures.push("shared Alpha plan did not multiply Keyer and pixel Auto Roto matte");
  return failures;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2_000)}`)));
  });
}

function fixture(screen: "green" | "blue"): Uint8Array {
  return screen === "green"
    ? new Uint8Array([0, 177, 64, 255, 220, 35, 25, 255, 25, 150, 60, 128])
    : new Uint8Array([0, 71, 187, 255, 220, 45, 25, 255, 20, 65, 155, 128]);
}

function stillClip(id: string, assetId: string, trackId: string): TimelineClip {
  return {
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: .25, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

async function sampleRgb(videoPath: string, x: number, y: number): Promise<number[]> {
  if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable");
  const outputPath = `${videoPath}.${x}-${y}.rgb`;
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", "0.1", "-i", videoPath, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-y", outputPath]);
  return [...await readFile(outputPath)].slice(0, 3);
}

async function executeProjectRender(directory: string) {
  if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable");
  const ffprobePath = resolveFfprobePath();
  const plate = join(directory, "project-plate.png");
  const background = join(directory, "project-background.png");
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x00B140:s=64x32:d=0.1", "-vf", "drawbox=x=16:y=0:w=8:h=32:color=0x19963C:t=fill,drawbox=x=24:y=8:w=24:h=16:color=0xDC2319:t=fill", "-frames:v", "1", "-y", plate]);
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x184A9C:s=64x32:d=0.1", "-frames:v", "1", "-y", background]);
  let project = createEmptyProject("Screen keyer formal project", { id: "screen-keyer-formal", width: 64, height: 32, fps: 24 });
  project.assets.push(
    { id: "background", name: "Background", kind: "image", uri: background, duration: .25, width: 64, height: 32 },
    { id: "plate", name: "Green plate", kind: "image", uri: plate, duration: .25, width: 64, height: 32 },
  );
  project.tracks[0].clips.push(stillClip("background-clip", "background", project.tracks[0].id));
  project.tracks.push({ id: "key-layer", name: "Key layer", kind: "video", locked: false, muted: false, clips: [stillClip("plate-clip", "plate", "key-layer")] });
  project = applyCommand(project, { type: "set_clip_chroma_key", clipId: "plate-clip", settings: CHROMA_KEY_PRESETS.green });
  const output = join(directory, "project-keyed.mp4");
  await renderProject(project, output, { ffmpegPath, ffprobePath, preferGpu: false, timeoutMs: 120_000 });
  const backgroundPixel = await sampleRgb(output, 4, 4);
  const subjectPixel = await sampleRgb(output, 36, 16);
  const backgroundTarget = [24, 74, 156];
  const subjectTarget = [220, 35, 25];
  const distance = (left: number[], right: number[]) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
  return {
    outputPath: output, outputSha256: sha256(await readFile(output)), backgroundPixel, subjectPixel,
    backgroundReplaced: distance(backgroundPixel, backgroundTarget) <= thresholds.projectCompositeMaxChannelDelta,
    subjectPreserved: distance(subjectPixel, subjectTarget) <= thresholds.projectCompositeMaxChannelDelta,
  };
}

function resolveFfprobePath(): string {
  return process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor", "ffmpeg", "win32-x64", "ffprobe.exe");
}

async function executeSample(directory: string, screen: "green" | "blue"): Promise<SampleResult> {
  if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable");
  const settings = CHROMA_KEY_PRESETS[screen];
  const input = fixture(screen);
  const expanded = new Uint8Array(6 * 2 * 4);
  for (let y = 0; y < 2; y += 1) for (let logical = 0; logical < 3; logical += 1) for (let repeat = 0; repeat < 2; repeat += 1) {
    const source = logical * 4; const target = (y * 6 + logical * 2 + repeat) * 4;
    expanded.set(input.slice(source, source + 4), target);
  }
  const sourcePath = join(directory, `${screen}.rgba`);
  const outputPath = join(directory, `${screen}.keyed.rgba`);
  await writeFile(sourcePath, expanded);
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "6x2", "-framerate", "1", "-i", sourcePath, "-frames:v", "1", "-vf", chromaKeyFfmpegFilter(settings)!, "-f", "rawvideo", "-pix_fmt", "rgba", "-y", outputPath]);
  const expandedFormal = await readFile(outputPath);
  const formal = [0, 2, 4].flatMap((x) => [...expandedFormal.subarray(x * 4, x * 4 + 4)]);
  const previewProject = applyCommand(createDemoProject(), {
    type: "set_clip_chroma_key", clipId: "clip-demo", settings,
  });
  const previewPixels = new Uint8ClampedArray(input);
  applyClipAlphaPlanRgbaInPlace(
    previewPixels,
    3,
    1,
    compileClipAlphaPlan(previewProject, findClip(previewProject, "clip-demo"), "preview"),
    { localProjectFrame: 0 },
  );
  const preview = [...previewPixels];
  return {
    screen, input: [...input], preview, formal,
    maxDelta: Math.max(...formal.map((value, index) => Math.abs(value - preview[index]))),
  };
}

function mutationSelfTest(): string[] {
  const base: EvaluatorInput = {
    samples: [
      { screen: "green", input: [0, 180, 60, 255, 220, 35, 25, 255, 25, 150, 60, 128], preview: [0, 0, 0, 0, 220, 35, 25, 255, 50, 100, 70, 128], formal: [0, 0, 0, 0, 220, 35, 25, 255, 50, 100, 70, 128], maxDelta: 0 },
      { screen: "blue", input: [0, 70, 185, 255, 220, 35, 25, 255, 20, 65, 155, 128], preview: [0, 0, 0, 0, 220, 35, 25, 255, 40, 80, 105, 96], formal: [0, 0, 0, 0, 220, 35, 25, 255, 40, 80, 105, 96], maxDelta: 0 },
    ],
    disabledIdentity: true, projectFileSaveReopen: true, undoRedo: true, nativeAdmissionRejected: true, productDependencyBoundary: true,
    projectRenderExecuted: true, projectRenderArtifactBound: true, projectRenderBackgroundReplaced: true, projectRenderSubjectPreserved: true,
    sharedAlphaPlanCombination: true,
  };
  if (evaluate(base).length) throw new Error(`evaluator rejected valid control: ${evaluate(base).join("; ")}`);
  const mutations: Array<[string, (value: EvaluatorInput) => void]> = [
    ["screen-alpha", (value) => { value.samples[0].formal[3] = 255; }],
    ["subject-alpha", (value) => { value.samples[0].formal[7] = 0; }],
    ["fractional-alpha", (value) => { value.samples[0].formal[11] = 255; }],
    ["preview-formal", (value) => { value.samples[0].preview[4] = 210; }],
    ["edge-despill", (value) => { value.samples[0].formal[9] = 170; value.samples[0].preview[9] = 170; }],
    ["duplicate-screen-route", (value) => { value.samples[1].screen = "green"; }],
    ["truncated-rgba", (value) => { value.samples[0].formal.pop(); }],
    ["disabled-identity", (value) => { value.disabledIdentity = false; }],
    ["project-file-save-reopen", (value) => { value.projectFileSaveReopen = false; }],
    ["undo-redo", (value) => { value.undoRedo = false; }],
    ["native-admission", (value) => { value.nativeAdmissionRejected = false; }],
    ["dependency-boundary", (value) => { value.productDependencyBoundary = false; }],
    ["formal-render-execution", (value) => { value.projectRenderExecuted = false; }],
    ["formal-render-artifact-binding", (value) => { value.projectRenderArtifactBound = false; }],
    ["formal-background", (value) => { value.projectRenderBackgroundReplaced = false; }],
    ["formal-subject", (value) => { value.projectRenderSubjectPreserved = false; }],
    ["shared-alpha-plan", (value) => { value.sharedAlphaPlanCombination = false; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(base); mutate(candidate);
    if (!evaluate(candidate).length) throw new Error(`evaluator missed mutation: ${name}`);
  }
  process.stdout.write(`Self-authored screen-keyer evaluator calibration passed (${mutations.length} mutations)\n`);
  return mutations.map(([name]) => name);
}

async function main(): Promise<void> {
  const rejectedMutations = mutationSelfTest();
  if (selfTest) return;
  await mkdir(evidenceRoot, { recursive: true });
  await rm(retainedFormalArtifactPath, { force: true });
  const directory = await mkdtemp(join(tmpdir(), "editkin-keyer-"));
  try {
    const samples = await Promise.all([executeSample(directory, "green"), executeSample(directory, "blue")]);
    const disabled = { ...CHROMA_KEY_PRESETS.green, enabled: false };
    const disabledInput = [17, 44, 91, 123];
    const disabledIdentity = Object.values(applyChromaKeyPixel(...disabledInput as [number, number, number, number], disabled)).every((value, index) => value === disabledInput[index])
      && chromaKeyFfmpegFilter(disabled) === undefined;

    const initial = createHistory(createDemoProject());
    const changed = dispatchCommand(initial, { type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.green }, "keyer");
    const roundTrippedProject = projectSchema.parse(JSON.parse(JSON.stringify(changed.present)));
    const projectPath = join(directory, "screen-keyer-save-reopen.editkin.json");
    const savedProject = await writeProjectFileAtomic(projectPath, roundTrippedProject, null);
    const reopenedProject = await readProjectFile(projectPath);
    const projectFileSaveReopen = savedProject.revision === roundTrippedProject.revision + 1
      && reopenedProject.revision === savedProject.revision
      && findClip(reopenedProject, "clip-demo").chromaKey?.engine === "editkin-chroma-distance-keyer/v1"
      && findClip(reopenedProject, "clip-demo").chromaKey?.screen === "green";
    const undoRedo = findClip(undo(changed).present, "clip-demo").chromaKey === undefined
      && findClip(redo(undo(changed)).present, "clip-demo").chromaKey?.screen === "green";
    const nativeAdmissionRejected = buildGpuEngineVideoPreviewGraph(changed.present, 1) === undefined
      && buildGpuVideoPreviewSource(changed.present, 1) === undefined;
    const combinedProject = createDemoProject();
    const combinedClip = findClip(combinedProject, "clip-demo");
    combinedClip.chromaKey = { ...CHROMA_KEY_PRESETS.green };
    const pixelMask = createClipMask("keyer-roto-stack", "subject");
    pixelMask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
      width: 2, height: 1, analysisFps: combinedProject.fps, frameCount: 1,
      sequenceUri: "keyer-roto.alpha8", manifestUri: "keyer-roto.json", framePreviewUris: ["keyer-roto-0.png"],
      meanBoundaryChatter: 0, frozen: true, qualityState: "diagnostic",
    };
    combinedClip.masks = [pixelMask];
    const combinedPixels = new Uint8ClampedArray([0, 177, 64, 255, 220, 35, 25, 255]);
    applyClipAlphaPlanRgbaInPlace(combinedPixels, 2, 1, compileClipAlphaPlan(combinedProject, combinedClip), {
      localProjectFrame: 0,
      matteAlpha: new Float32Array([1, .5]),
    });
    const sharedAlphaPlanCombination = combinedPixels[3] === 0 && combinedPixels[7] >= 127 && combinedPixels[7] <= 128;
    const productSources = await Promise.all(dependencyBoundarySourcePaths.map((path) => readFile(join(root, path), "utf8")));
    const productDependencyBoundary = productSources.every((source) => !/CorridorKey|SAM2Matting|corridor[_-]?key|sam2[_-]?matting/i.test(source));
    const projectRenderExecution = await executeProjectRender(directory);
    await copyFile(projectRenderExecution.outputPath, retainedFormalArtifactPath);
    const retainedArtifact = await fileIdentity(retainedFormalArtifactPath);
    const { outputPath: _temporaryOutputPath, ...projectRenderFacts } = projectRenderExecution;
    const projectRender = { ...projectRenderFacts, retainedArtifact };
    const input: EvaluatorInput = {
      samples, disabledIdentity, projectFileSaveReopen, undoRedo, nativeAdmissionRejected, productDependencyBoundary,
      projectRenderExecuted: Boolean(projectRender.outputSha256),
      projectRenderArtifactBound: retainedArtifact.sha256 === projectRender.outputSha256,
      projectRenderBackgroundReplaced: projectRender.backgroundReplaced,
      projectRenderSubjectPreserved: projectRender.subjectPreserved, sharedAlphaPlanCombination,
    };
    const failures = evaluate(input);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const ffmpegEntrypoint = join(root, "src", "render", "ffmpeg.ts");
    const ffmpegDirectDependencies = await directLocalTypeScriptDependencies(ffmpegEntrypoint);
    const sourceIdentityPaths = [...new Set([
      ...directGateSourcePaths.map((path) => join(root, path)),
      ffmpegEntrypoint,
      ...ffmpegDirectDependencies,
    ])].sort();
    const report = {
      schema: "editkin.self-authored-screen-keyer-gate/v2", generatedAt: new Date().toISOString(), productVersion: packageJson.version,
      decision: failures.length ? "BLOCK" : "GREEN_BOUNDED_REC709_KEYER",
      decisionScope: "internal_component_only",
      obligationClosure: "NOT_CLAIMED",
      claimBoundary: "Self-authored Rec.709 green/blue screen chromaticity keyer with fractional alpha and edge despill. Shared ClipAlphaPlan Canvas Preview and formal FFmpeg GEQ use the same scalar key equation, and the bounded Keyer × pixel Auto Roto alpha multiplication control passes. Native resident GPU, ACES, 2.5D transparent depth, optical-alpha-on-Keyer, real-footage quality, public installer, and competitor superiority are not claimed.",
      claimContract: {
        claimId: "self-authored-screen-keyer/internal-rec709-compatibility/v2",
        claim: "The current source-owned Rec.709 green/blue keyer preserves an opaque subject, produces transparent backing plus fractional edge alpha, strictly reduces edge spill, and keeps the actual Canvas Preview executor within the bounded code-value delta of the formal FFmpeg executor on both frozen fixtures.",
        baseline: "The same frozen raw RGBA pixels before keying: opaque backing and unreduced dominant-channel edge spill; disabled keyer must remain a bit-exact identity.",
        candidate: "Current EditGraph command/schema plus ClipAlphaPlan Preview executor and formal FFmpeg composite executor from the exact source and executable identities retained below.",
        frozenInputs: {
          pixelFixtures: "One 3-pixel RGBA fixture per green/blue route: backing, opaque red subject, semi-transparent spill edge.",
          projectFixture: "Generated 64x32 green plate over a blue lower layer with an opaque red subject.",
        },
        thresholds,
        decisionRule: "GREEN only when the known-good control is accepted, every task-shaped mutation is rejected, both frozen routes meet every numeric threshold, and all atomic project-file save/reopen, Undo/Redo, fail-closed admission, bounded dependency-boundary, project-render, and Keyer×pixel-matte controls are true.",
        seriousErrors: ["missing or duplicated screen route", "non-fractional edge", "despill regression", "Preview/formal drift", "raw fallback", "project-file save/reopen loss", "unsupported-path admission", "external restricted Keyer dependency"],
      },
      evaluatorCalibration: { knownGoodAccepted: true, mutationCount: rejectedMutations.length, rejectedMutations },
      dependencyBoundary: "The bounded production keyer execution sources named below contain no CorridorKey/SAM2Matting runtime import or identifier; this is not an installer-wide dependency audit.",
      metrics: { ...input, projectRender }, failures,
      retainedFormalArtifact: retainedArtifact,
      qualityAcceptance: "NOT_MEASURED_SEPARATE_P3_CELL",
      openInternalRequirements: [
        "native resident GPU and ACES2 path",
        "alpha plus layout and dynamic or processed Track Matte",
        "real green/blue plate Preview/formal pixel parity",
        "MCP atomic apply",
        "long-duration performance envelope",
        "fresh-installed desktop UI save/reopen and isolated delivered journey",
      ],
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      executorIdentities: await Promise.all([ffmpegPath!, resolveFfprobePath()].map((path) => fileIdentity(path))),
      dependencyBoundarySourceIdentities: await Promise.all(dependencyBoundarySourcePaths.map((path) => fileIdentity(join(root, path)))),
      sourceClosure: {
        entrypoint: relative(root, ffmpegEntrypoint).replaceAll("\\", "/"),
        directLocalDependencies: ffmpegDirectDependencies.map((path) => relative(root, path).replaceAll("\\", "/")),
      },
      sourceIdentities: await Promise.all(sourceIdentityPaths.map((path) => fileIdentity(path))),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (failures.length) throw new Error(`screen keyer gate blocked: ${failures.join("; ")}`);
    process.stdout.write(`Self-authored screen keyer gate GREEN · report ${reportPath}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

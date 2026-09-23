import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { createDemoProject } from "../src/domain/demo";
import { validateProject } from "../src/domain/editGraph";
import type {
  MotionGraphicPresetSeed,
  MotionGraphicVisualStyle,
  MotionTrack,
  NormalizedPoint,
} from "../src/domain/types";
import type { GpuEngineVideoMotionGraphicReceipt } from "../src/desktop/gpuTypes";
import { motionGraphicExpectedSample, motionGraphicReceiptMatches } from "../src/desktop/residentGpuPreviewReceipts";
import { createMotionGraphic } from "../src/motion/composition";
import type { EngineNode } from "../src/render/engineGraph";
import { buildGpuEngineVideoPreviewGraph } from "../src/render/gpuCompositor";

const root = resolve(import.meta.dirname, "..");
const executableArgument = process.argv.indexOf("--compositor");
const executable = executableArgument >= 0 && process.argv[executableArgument + 1]
  ? resolve(process.argv[executableArgument + 1])
  : resolve(root, "native/bin/win32-x64/editkin-gpu-compositor.exe");
const fixture = resolve(root, "public/demo-source.mp4");
const fontRoot = resolve(root, "public/fonts");
const evidenceRoot = resolve(root, "../..", ".rd/benchmarks/editkin-hologram-native");
const reportPath = join(evidenceRoot, "report.json");
const selfTest = process.argv.includes("--self-test");

const HOLOGRAM_STYLES = [
  "holo_scan_cyan",
  "holo_grid_lime",
  "target_lock_red",
  "spectral_wire_violet",
  "depth_glass_blue",
  "telemetry_beam_amber",
  "neon_extrude_white",
  "quantum_label_magenta",
] as const satisfies readonly MotionGraphicVisualStyle[];

type HologramStyle = (typeof HOLOGRAM_STYLES)[number];
type Quad = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
type ProductPreview = NonNullable<ReturnType<typeof buildGpuEngineVideoPreviewGraph>>;
type NativeResponse = { id?: string; event?: string; ok?: boolean; result?: any; error?: string };

interface StyleObservation {
  style: HologramStyle;
  graphVisualStyle: string;
  staticReceiptVisualStyle: string | null;
  activeReceiptVisualStyle: string | null;
  atlasSha256: string;
  frameSha256: string;
  staticReceiptMatches: boolean;
  activeReceiptMatches: boolean;
  textureUploadCount: number;
}

interface GateReport {
  schema: "editkin.hologram-native-gate/v1";
  status: "GREEN" | "BLOCK";
  styleObservations: StyleObservation[];
  distinctAtlasHashCount: number;
  distinctFrameHashCount: number;
  illegalVisualStyleRejected: boolean;
  surfaceTracking: {
    graphTrackingMode: string | null;
    receiptTrackingMode: string | null;
    graphVisualStyle: string | null;
    receiptVisualStyle: string | null;
    exactQuadReceipt: boolean;
    staticReceiptMatches?: boolean;
    activeReceiptMatches?: boolean;
    receiptMatches: boolean;
    atlasContinuity: boolean;
    expectedSample?: unknown;
    receiptSample?: unknown;
  };
  textMutation: {
    graphTextChanged: boolean;
    atlasHashChanged: boolean;
    decodedOutputHashChanged: boolean;
    originalReceiptMatches: boolean;
    modifiedReceiptMatches: boolean;
  };
  receiptIntegrity: {
    honestReceiptsMatch: boolean;
    calibratedNegativesRejected: string[];
  };
  directExecution: boolean;
  productPathCpuPixelCopies: number;
  releaseFencePendingCount: number;
  [key: string]: unknown;
}

interface InspectedPreview {
  graphNode: EngineNode;
  staticReceipt: GpuEngineVideoMotionGraphicReceipt;
  activeReceipt: GpuEngineVideoMotionGraphicReceipt;
  staticReceiptMatches: boolean;
  activeReceiptMatches: boolean;
  frameBytes: Buffer;
  frameSha256: string;
  directExecution: boolean;
  productPathCpuPixelCopies: number;
  releaseFencePendingCount: number;
  textureUploadCount: number;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameQuad(actual: unknown, expected: unknown, tolerance = 0.00001): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== 4 || expected.length !== 4) return false;
  return actual.every((corner, index) => {
    const expectedCorner = expected[index];
    return corner && expectedCorner
      && typeof corner.x === "number" && typeof corner.y === "number"
      && typeof expectedCorner.x === "number" && typeof expectedCorner.y === "number"
      && Math.abs(corner.x - expectedCorner.x) <= tolerance
      && Math.abs(corner.y - expectedCorner.y) <= tolerance;
  });
}

function assertGreen(report: GateReport): void {
  if (report.schema !== "editkin.hologram-native-gate/v1" || report.status !== "GREEN") {
    throw new Error("hologram native report is not GREEN");
  }
  if (report.styleObservations.length !== HOLOGRAM_STYLES.length) {
    throw new Error("hologram native gate did not exercise all eight styles");
  }
  const observedStyles = new Set(report.styleObservations.map((observation) => observation.style));
  if (HOLOGRAM_STYLES.some((style) => !observedStyles.has(style))) {
    throw new Error("hologram native gate style inventory drifted");
  }
  if (report.styleObservations.some((observation) => observation.graphVisualStyle !== observation.style
    || observation.staticReceiptVisualStyle !== observation.style
    || observation.activeReceiptVisualStyle !== observation.style
    || !isSha256(observation.atlasSha256)
    || !isSha256(observation.frameSha256)
    || !observation.staticReceiptMatches
    || !observation.activeReceiptMatches
    || observation.textureUploadCount !== 1)) {
    throw new Error("hologram visual style transport or receipt is incomplete");
  }
  if (report.distinctAtlasHashCount !== HOLOGRAM_STYLES.length
    || report.distinctFrameHashCount !== HOLOGRAM_STYLES.length) {
    throw new Error("hologram styles collapsed to the same raster or decoded output");
  }
  if (!report.illegalVisualStyleRejected) throw new Error("native loader accepted an illegal visualStyle");
  if (report.surfaceTracking.graphTrackingMode !== "surface"
    || report.surfaceTracking.receiptTrackingMode !== "surface"
    || report.surfaceTracking.graphVisualStyle !== "holo_grid_lime"
    || report.surfaceTracking.receiptVisualStyle !== "holo_grid_lime"
    || !report.surfaceTracking.exactQuadReceipt
    || !report.surfaceTracking.receiptMatches
    || !report.surfaceTracking.atlasContinuity) {
    throw new Error("surface-tracked hologram transport or receipt failed");
  }
  if (!report.textMutation.graphTextChanged
    || !report.textMutation.atlasHashChanged
    || !report.textMutation.decodedOutputHashChanged
    || !report.textMutation.originalReceiptMatches
    || !report.textMutation.modifiedReceiptMatches) {
    throw new Error("editable text did not change the native hologram output identity");
  }
  if (!report.receiptIntegrity.honestReceiptsMatch
    || report.receiptIntegrity.calibratedNegativesRejected.length !== 6) {
    throw new Error("hologram receipt evaluator accepted a calibrated false receipt");
  }
  if (!report.directExecution || report.productPathCpuPixelCopies !== 0 || report.releaseFencePendingCount !== 0) {
    throw new Error("hologram gate left the direct resident GPU contract");
  }
}

function fakeHash(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function syntheticSelfTest(): void {
  const styleObservations = HOLOGRAM_STYLES.map((style, index): StyleObservation => ({
    style,
    graphVisualStyle: style,
    staticReceiptVisualStyle: style,
    activeReceiptVisualStyle: style,
    atlasSha256: fakeHash(index + 1),
    frameSha256: fakeHash(index + 17),
    staticReceiptMatches: true,
    activeReceiptMatches: true,
    textureUploadCount: 1,
  }));
  const valid: GateReport = {
    schema: "editkin.hologram-native-gate/v1",
    status: "GREEN",
    styleObservations,
    distinctAtlasHashCount: 8,
    distinctFrameHashCount: 8,
    illegalVisualStyleRejected: true,
    surfaceTracking: {
      graphTrackingMode: "surface",
      receiptTrackingMode: "surface",
      graphVisualStyle: "holo_grid_lime",
      receiptVisualStyle: "holo_grid_lime",
      exactQuadReceipt: true,
      receiptMatches: true,
      atlasContinuity: true,
    },
    textMutation: {
      graphTextChanged: true,
      atlasHashChanged: true,
      decodedOutputHashChanged: true,
      originalReceiptMatches: true,
      modifiedReceiptMatches: true,
    },
    receiptIntegrity: {
      honestReceiptsMatch: true,
      calibratedNegativesRejected: ["visual-style", "tracking-mode", "track-id", "quad", "atlas-shape", "glyph-count"],
    },
    directExecution: true,
    productPathCpuPixelCopies: 0,
    releaseFencePendingCount: 0,
  };
  assertGreen(valid);
  const negatives: GateReport[] = [
    { ...valid, styleObservations: valid.styleObservations.slice(0, 7) },
    { ...valid, distinctAtlasHashCount: 7 },
    { ...valid, illegalVisualStyleRejected: false },
    { ...valid, surfaceTracking: { ...valid.surfaceTracking, exactQuadReceipt: false } },
    { ...valid, textMutation: { ...valid.textMutation, decodedOutputHashChanged: false } },
    { ...valid, receiptIntegrity: { ...valid.receiptIntegrity, calibratedNegativesRejected: [] } },
    { ...valid, directExecution: false },
    { ...valid, productPathCpuPixelCopies: 1 },
  ];
  const calibratedNegatives = negatives.filter((negative) => {
    try { assertGreen(negative); return false; } catch { return true; }
  }).length;
  if (calibratedNegatives !== negatives.length) throw new Error("hologram evaluator accepted a calibrated negative");
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluator: valid.schema, calibratedNegatives })}\n`);
}

function surfaceTrack(): MotionTrack {
  const quads: Quad[] = [
    [{ x: .12, y: .28 }, { x: .48, y: .25 }, { x: .50, y: .48 }, { x: .10, y: .50 }],
    [{ x: .20, y: .30 }, { x: .60, y: .27 }, { x: .63, y: .52 }, { x: .18, y: .55 }],
    [{ x: .28, y: .32 }, { x: .72, y: .28 }, { x: .75, y: .56 }, { x: .25, y: .60 }],
  ];
  return {
    id: "hologram-surface-track",
    clipId: "clip-demo",
    name: "Hologram surface fixture",
    engine: "editkin-hologram-native-fixture/v1",
    analysisFps: 30,
    initialRect: { x: .12, y: .34, width: .18, height: .18 },
    points: [
      { frame: 0, time: 0, rect: { x: .12, y: .34, width: .18, height: .18 }, confidence: 1, status: "manual", rotationDegrees: 0, scale: 1, quad: quads[0] },
      { frame: 45, time: 1.5, rect: { x: .20, y: .36, width: .20, height: .19 }, confidence: .96, status: "tracked", rotationDegrees: 4, scale: 1.05, quad: quads[1] },
      { frame: 89, time: 89 / 30, rect: { x: .28, y: .38, width: .22, height: .20 }, confidence: .93, status: "tracked", rotationDegrees: 7, scale: 1.10, quad: quads[2] },
    ],
    lostRatio: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function buildProductPreview(style: HologramStyle, text: string, tracked = false): ProductPreview {
  const project = createDemoProject();
  project.id = `hologram-native-${style}-${tracked ? "surface" : "static"}`;
  project.name = "Hologram native gate";
  project.width = 960;
  project.height = 540;
  project.fps = 30;
  project.assets[0].uri = fixture;
  project.assets[0].duration = 3;
  project.assets[0].width = 960;
  project.assets[0].height = 540;
  project.tracks[0].clips[0].duration = 3;
  project.tracks[0].clips[0].sourceStart = 0;
  const track = tracked ? surfaceTrack() : undefined;
  if (track) project.motionTracks.push(track);
  const seed: MotionGraphicPresetSeed = {
    presetId: `gate-${style}`,
    name: "原生全息測試",
    kind: tracked ? "tag" : "title",
    x: .08,
    y: .12,
    width: tracked ? .42 : .62,
    fontSize: tracked ? 36 : 46,
    fontFamily: "Noto Sans TC",
    fontWeight: 800,
    letterSpacing: 1,
    outlineWidth: 3,
    shadowDepth: 3,
    cornerRadius: 10,
    textColor: "#F5FEFFFF",
    backgroundColor: "#06141CCC",
    accentColor: "#52F7FFFF",
    visualStyle: style,
    animation: "fade",
    trackingMode: tracked ? "surface" : undefined,
    offsetX: 0,
    offsetY: 0,
  };
  project.motionGraphics.push(createMotionGraphic(
    `graphic-${style}`,
    tracked ? "tag" : "title",
    text,
    0,
    3,
    track?.id,
    seed,
  ));
  validateProject(project);
  const preview = buildGpuEngineVideoPreviewGraph(project, 1);
  if (!preview) throw new Error(`product admission rejected ${style}${tracked ? " surface tracking" : ""}`);
  return preview;
}

class NativeClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  private readonly pending = new Map<string, (message: NativeResponse) => void>();
  private sequence = 0;
  private stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams, lines: Interface) {
    this.child = child;
    this.lines = lines;
  }

  static async start(): Promise<NativeClient> {
    const child = spawn(executable, ["serve"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, EDITKIN_FONT_ROOT: fontRoot },
    });
    const lines = createInterface({ input: child.stdout });
    const client = new NativeClient(child, lines);
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      readyReject = rejectReady;
    });
    child.stderr.on("data", (chunk) => { client.stderr += String(chunk); });
    child.once("error", (error) => readyReject(error));
    lines.on("line", (line) => {
      const message = JSON.parse(line) as NativeResponse;
      if (message.event === "ready") readyResolve();
      else if (message.id) client.pending.get(message.id)?.(message);
    });
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, rejectReady) => {
          readyTimer = setTimeout(() => rejectReady(new Error(`GPU compositor did not become ready: ${client.stderr}`)), 30_000);
        }),
      ]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
    return client;
  }

  request(command: string, payload: Record<string, unknown> = {}): Promise<NativeResponse> {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = `hologram-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${command} timed out: ${this.stderr}`));
      }, 60_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolveRequest(message);
      });
      this.child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  }

  async close(): Promise<void> {
    try { if (this.child.exitCode === null) await this.request("shutdown"); } catch { /* process cleanup below is authoritative */ }
    this.lines.close();
    if (this.child.exitCode === null) this.child.kill();
  }
}

async function inspectPreview(
  client: NativeClient,
  workspace: string,
  sessionId: string,
  preview: ProductPreview,
  timelineFrame = 30,
): Promise<InspectedPreview> {
  const graphPath = join(workspace, `${sessionId}-graph.json`);
  const bindingsPath = join(workspace, `${sessionId}-bindings.json`);
  const framePath = join(workspace, `${sessionId}-frame.png`);
  await writeFile(graphPath, JSON.stringify(preview.graph));
  await writeFile(bindingsPath, JSON.stringify(preview.assetBindings));
  const loaded = await client.request("engine_video_load", { sessionId, graphPath, bindingsPath, timelineFrame });
  if (!loaded.ok) throw new Error(`${sessionId} failed native load: ${JSON.stringify(loaded)}`);
  const verified = await client.request("engine_video_verify_frame", {
    sessionId,
    timelineFrame,
    toleranceSeconds: 1 / 30,
    outputPath: framePath,
  });
  if (!verified.ok) throw new Error(`${sessionId} failed decoded verification: ${JSON.stringify(verified)}`);
  const graphNode = preview.graph.nodes.find((node) => node.kind === "motion_graphic");
  const staticReceipt = loaded.result?.motionGraphics?.[0] as GpuEngineVideoMotionGraphicReceipt | undefined;
  const activeReceipt = verified.result?.activeMotionGraphics?.[0] as GpuEngineVideoMotionGraphicReceipt | undefined;
  if (!graphNode || !staticReceipt || !activeReceipt) throw new Error(`${sessionId} omitted graph or motion-graphic receipts`);
  const frameBytes = await readFile(framePath);
  const released = await client.request("engine_video_release", { sessionId });
  if (!released.ok) throw new Error(`${sessionId} failed release: ${JSON.stringify(released)}`);
  return {
    graphNode,
    staticReceipt,
    activeReceipt,
    staticReceiptMatches: motionGraphicReceiptMatches(staticReceipt, graphNode, preview.graph),
    activeReceiptMatches: motionGraphicReceiptMatches(activeReceipt, graphNode, preview.graph, timelineFrame),
    frameBytes,
    frameSha256: sha256(frameBytes),
    directExecution: loaded.result?.engineGraph?.directExecution === true,
    productPathCpuPixelCopies: Number(verified.result?.productPathCpuPixelCopies ?? -1),
    releaseFencePendingCount: Number(released.result?.fences?.pendingFenceCount ?? -1),
    textureUploadCount: Number(staticReceipt.textureUploadCount ?? -1),
  };
}

function receiptNegativeControls(surface: InspectedPreview, preview: ProductPreview, timelineFrame: number): string[] {
  const variants: Array<[string, GpuEngineVideoMotionGraphicReceipt]> = [];
  const copy = () => structuredClone(surface.activeReceipt);
  variants.push(["visual-style", { ...copy(), visualStyle: "solid_panel" }]);
  variants.push(["tracking-mode", { ...copy(), trackingMode: "anchor" }]);
  variants.push(["track-id", { ...copy(), trackId: "wrong-track" }]);
  const wrongQuad = copy();
  if (wrongQuad.sampledDestinationQuad?.[0]) wrongQuad.sampledDestinationQuad[0].x += .02;
  variants.push(["quad", wrongQuad]);
  variants.push(["atlas-shape", { ...copy(), atlasSha256: "not-a-sha256" }]);
  variants.push(["glyph-count", { ...copy(), glyphCount: copy().glyphCount + 1 }]);
  return variants.filter(([, receipt]) => !motionGraphicReceiptMatches(receipt, surface.graphNode, preview.graph, timelineFrame))
    .map(([name]) => name);
}

async function rejectIllegalVisualStyle(client: NativeClient, workspace: string, preview: ProductPreview): Promise<boolean> {
  const graph = structuredClone(preview.graph);
  const node = graph.nodes.find((candidate) => candidate.kind === "motion_graphic");
  if (!node) throw new Error("illegal-style fixture has no motion graphic node");
  node.visualStyle = "invented_hologram_shader";
  const graphPath = join(workspace, "illegal-style-graph.json");
  const bindingsPath = join(workspace, "illegal-style-bindings.json");
  await writeFile(graphPath, JSON.stringify(graph));
  await writeFile(bindingsPath, JSON.stringify(preview.assetBindings));
  const response = await client.request("engine_video_load", {
    sessionId: "illegal-style",
    graphPath,
    bindingsPath,
    timelineFrame: 30,
  });
  if (response.ok) await client.request("engine_video_release", { sessionId: "illegal-style" });
  return response.ok !== true && /invalid motion graphic|unsupported visual style/i.test(String(response.error));
}

async function executeGate(): Promise<GateReport> {
  const workspace = await mkdtemp(join(tmpdir(), "editkin-hologram-native-"));
  const client = await NativeClient.start();
  try {
    const bound = await client.request("surface_bind", { parentHwnd: "0", x: 0, y: 0, width: 320, height: 180 });
    if (!bound.ok) throw new Error(`native surface bind failed: ${JSON.stringify(bound)}`);

    const inspectedStyles: Array<InspectedPreview & { style: HologramStyle; preview: ProductPreview }> = [];
    for (const style of HOLOGRAM_STYLES) {
      const preview = buildProductPreview(style, "全息掃描 1700");
      const inspected = await inspectPreview(client, workspace, `style-${style}`, preview);
      inspectedStyles.push({ ...inspected, style, preview });
    }

    const original = inspectedStyles[0];
    const modifiedPreview = buildProductPreview("holo_scan_cyan", "全息掃描 1701");
    const modified = await inspectPreview(client, workspace, "text-modified", modifiedPreview);
    const surfacePreview = buildProductPreview("holo_grid_lime", "平面追蹤", true);
    const surface = await inspectPreview(client, workspace, "surface-tracked", surfacePreview);
    const illegalVisualStyleRejected = await rejectIllegalVisualStyle(client, workspace, original.preview);

    const surfaceTracking = surface.graphNode.tracking as { samples?: Array<{ timelineFrame: number; destinationQuad?: Quad }> } | undefined;
    const expectedSurfaceSample = surfaceTracking?.samples?.find((sample) => sample.timelineFrame === 30);
    const expectedReceiptSample = motionGraphicExpectedSample(surface.graphNode, surfacePreview.graph, 30);
    const calibratedNegativesRejected = receiptNegativeControls(surface, surfacePreview, 30);
    const styleObservations = inspectedStyles.map(({ style, graphNode, staticReceipt, activeReceipt, staticReceiptMatches, activeReceiptMatches, frameSha256, textureUploadCount }): StyleObservation => ({
      style,
      graphVisualStyle: String(graphNode.visualStyle),
      staticReceiptVisualStyle: staticReceipt.visualStyle ?? null,
      activeReceiptVisualStyle: activeReceipt.visualStyle ?? null,
      atlasSha256: staticReceipt.atlasSha256,
      frameSha256,
      staticReceiptMatches,
      activeReceiptMatches,
      textureUploadCount,
    }));

    await mkdir(evidenceRoot, { recursive: true });
    for (const observation of inspectedStyles) {
      await writeFile(join(evidenceRoot, `${observation.style}.png`), observation.frameBytes);
    }
    await writeFile(join(evidenceRoot, "text-modified.png"), modified.frameBytes);
    await writeFile(join(evidenceRoot, "surface-tracked.png"), surface.frameBytes);

    const inspected = [...inspectedStyles, modified, surface];
    const report: GateReport = {
      schema: "editkin.hologram-native-gate/v1",
      status: "GREEN",
      styleObservations,
      distinctAtlasHashCount: new Set(styleObservations.map((observation) => observation.atlasSha256)).size,
      distinctFrameHashCount: new Set(styleObservations.map((observation) => observation.frameSha256)).size,
      illegalVisualStyleRejected,
      surfaceTracking: {
        graphTrackingMode: String(surface.graphNode.trackingMode ?? ""),
        receiptTrackingMode: surface.activeReceipt.trackingMode ?? null,
        graphVisualStyle: String(surface.graphNode.visualStyle ?? ""),
        receiptVisualStyle: surface.activeReceipt.visualStyle ?? null,
        exactQuadReceipt: sameQuad(surface.activeReceipt.sampledDestinationQuad, expectedSurfaceSample?.destinationQuad),
        staticReceiptMatches: surface.staticReceiptMatches,
        activeReceiptMatches: surface.activeReceiptMatches,
        receiptMatches: surface.activeReceiptMatches && surface.staticReceiptMatches,
        atlasContinuity: surface.activeReceipt.atlasSha256 === surface.staticReceipt.atlasSha256,
        expectedSample: expectedReceiptSample,
        receiptSample: {
          opacity: surface.activeReceipt.sampledOpacity,
          translateX: surface.activeReceipt.sampledTranslateX,
          translateY: surface.activeReceipt.sampledTranslateY,
          scale: surface.activeReceipt.sampledScale,
          rotationRadians: surface.activeReceipt.sampledRotationRadians,
          trackingX: surface.activeReceipt.sampledTrackingX,
          trackingY: surface.activeReceipt.sampledTrackingY,
          trackingConfidence: surface.activeReceipt.sampledTrackingConfidence,
          trackingStatus: surface.activeReceipt.sampledTrackingStatus,
          trackingRotationRadians: surface.activeReceipt.sampledTrackingRotationRadians,
          trackingScale: surface.activeReceipt.sampledTrackingScale,
          destinationQuad: surface.activeReceipt.sampledDestinationQuad,
        },
      },
      textMutation: {
        graphTextChanged: original.graphNode.text !== modified.graphNode.text,
        atlasHashChanged: original.staticReceipt.atlasSha256 !== modified.staticReceipt.atlasSha256,
        decodedOutputHashChanged: original.frameSha256 !== modified.frameSha256,
        originalReceiptMatches: original.staticReceiptMatches && original.activeReceiptMatches,
        modifiedReceiptMatches: modified.staticReceiptMatches && modified.activeReceiptMatches,
      },
      receiptIntegrity: {
        honestReceiptsMatch: inspected.every((item) => item.staticReceiptMatches && item.activeReceiptMatches
          && item.staticReceipt.atlasSha256 === item.activeReceipt.atlasSha256
          && item.staticReceipt.visualStyle === item.activeReceipt.visualStyle),
        calibratedNegativesRejected,
      },
      directExecution: inspected.every((item) => item.directExecution),
      productPathCpuPixelCopies: Math.max(...inspected.map((item) => item.productPathCpuPixelCopies)),
      releaseFencePendingCount: Math.max(...inspected.map((item) => item.releaseFencePendingCount)),
      executable,
      executableSha256: sha256(await readFile(executable)),
      fixtureSha256: sha256(await readFile(fixture)),
      artifacts: {
        evidenceRoot,
        styleFrames: Object.fromEntries(inspectedStyles.map((item) => [item.style, item.frameSha256])),
        modifiedTextFrameSha256: modified.frameSha256,
        surfaceFrameSha256: surface.frameSha256,
      },
      claimBoundary: "Frozen native integration evidence for eight procedural styles, editable text identity, and one synthetic surface-tracking quad; aesthetic quality and real-footage tracking remain unmeasured.",
    };
    try { assertGreen(report); } catch (error) {
      report.status = "BLOCK";
      report.failure = error instanceof Error ? error.message : String(error);
    }
    return report;
  } finally {
    try { await client.request("surface_release"); } catch { /* client shutdown still runs */ }
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (selfTest) return syntheticSelfTest();
  const report = await executeGate();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ measuredAt: new Date().toISOString(), ...report }, null, 2)}\n`);
  assertGreen(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

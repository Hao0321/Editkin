import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EngineRenderGraph } from "../render/engineGraph";
import { assertNativeMotionPaintFrameReceipt, assertNativeMotionPaintLoadReceipt,
  prepareNativeMotionPaintReceiptExpectations } from "./nativeMotionPaintReceipt";

const signature = "original receipt identity control";
const sha = createHash("sha256").update(signature).digest("hex");
const displaySignature = "original explicit display intent receipt control";
const displaySha = createHash("sha256").update(displaySignature).digest("hex");
const displayProcessor = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const timeline = { timelineStartFrame: 1, sourceStartFrame: 0, durationFrames: 3 };
const frames = [[{ x: .1, y: .2, scale: 1, opacity: .5 }], [{ x: .3, y: .4, scale: 1, opacity: .8 }], [{ x: .5, y: .6, scale: 1, opacity: 1 }]];
function graph(rows = frames, layerCount = 1): EngineRenderGraph {
  return { schema: "editkin.engine-graph/v1", graphId: "receipt-control", width: 4, height: 4,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [{ id: "paint", kind: "native_motion_paint", inputs: [], enabled: true, graphicId: "title",
      track: { schema: "editkin.native-motion-paint-track/v1", sourceSignature: signature, timeline, frames: rows,
        scene: { width: 4, height: 4, background: [0, 0, 0, 0], max_scale: 32, layers: Array.from({ length: layerCount }, (_, index) => ({ id: `glyph-${index}`,
          path: { fill_rule: "non_zero", commands: [{ type: "M", x: 0, y: 0 }, { type: "L", x: 1, y: 0 },
            { type: "L", x: 1, y: 1 }, { type: "Z" }] }, paint: { kind: "solid", color: [1, 0, 0, .5] }, clips: [] })) } } },
      { id: "output", kind: "output", inputs: ["paint"], enabled: true, format: "rgba16_float" }], outputNode: "output" };
}
function colorBinding(display = false, overlayOrder = 0) {
  return { nodeId: "paint", graphicId: "title", sourceSignatureSha256: display ? displaySha : sha,
    colorIntent: display ? "display_rec709_sdr" : "scene_linear_rec709",
    compositionBoundary: display ? "after_aces2_before_output_encoding" : "before_aces2", overlayOrder };
}
function active(frame: number, uploads: number, cacheHit: boolean, poseContentCacheHit = false, rows = frames) {
  const work = cacheHit || poseContentCacheHit ? 0 : 1;
  return { nodeId: "paint", graphicId: "title", executor: "editkin.resident-native-motion-paint/v1", sourceSignatureSha256: sha,
    timeline, timelineFrame: frame, localFrame: frame - 1, layerCount: rows[frame - 1].length,
    poses: rows[frame - 1].map(pose => Object.fromEntries(Object.entries(pose).map(([key, value]) => [key, Math.fround(value)]))),
    workingColorSpace: "linear_rec709", workingFormat: "rgba16float", alphaMode: "premultiplied", cacheHit,
    colorIntent: "scene_linear_rec709", compositionBoundary: "before_aces2", overlayOrder: 0,
    poseContentCacheHit, reuseReason: (cacheHit ? "same_frame" : poseContentCacheHit ? "exact_pose_content" : "none") as string,
    rasterCount: uploads, textureUploadCount: uploads, frameRasterCount: work, frameTextureUploadCount: work,
    frameCpuUploadBytes: work * 128, rasterMilliseconds: work, uploadMilliseconds: work };
}
function load(frame = 0, rows = frames) {
  return { nativeMotionPaintCount: 1, nativeMotionPaintResidentTextureCount: 1, nativeMotionPaintTextureUploads: 1,
    nativeMotionPaintInitialRasterCount: 1, nativeMotionPaintInitialCpuUploadBytes: 128,
    nativeMotionPaintColorBindings: [colorBinding()],
    activeNativeMotionPaints: frame ? [active(frame, 1, false, false, rows)] : [] };
}
function displayGraph(rows = frames, withLegacy = false): EngineRenderGraph {
  const current = graph(rows), paint = current.nodes[0];
  paint.track = { ...paint.track as Record<string, unknown>, schema: "editkin.native-motion-paint-track/v2",
    colorIntent: "display_rec709_sdr", sourceSignature: displaySignature };
  const source = { id: "source", inputs: [], enabled: true, kind: "source", assetId: "video", mediaKind: "video", inputColorSpace: "rec709" };
  const prefix = withLegacy ? [
    { id: "legacy", inputs: [], enabled: true, kind: "motion_graphic", graphicId: "legacy-title" },
    { id: "legacy-composite", inputs: [source.id, "legacy"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
  ] : [];
  current.nodes = [source, ...prefix,
    { id: "display", inputs: [withLegacy ? "legacy-composite" : source.id], enabled: true, kind: "color", processor: displayProcessor,
      inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709_sdr" }, paint,
    { id: "display-paint", inputs: ["display", paint.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
    { id: "output", inputs: ["display-paint"], enabled: true, kind: "output", format: "rgba16_float" }];
  return current;
}
function displayLoad(frame = 0, overlayOrder = 0, rows = frames) {
  const current = load(frame, rows);
  current.nativeMotionPaintColorBindings = [colorBinding(true, overlayOrder)];
  for (const paint of current.activeNativeMotionPaints) Object.assign(paint, colorBinding(true, overlayOrder));
  return current;
}
function displayReceipt(frame: number, uploads: number, cacheHit: boolean, poseContentCacheHit = false, overlayOrder = 0, rows = frames) {
  const current = receipt(frame, uploads, cacheHit, poseContentCacheHit, rows);
  Object.assign(current.activeNativeMotionPaints[0], colorBinding(true, overlayOrder));
  return current;
}
function receipt(frame: number, uploads: number, cacheHit: boolean, poseContentCacheHit = false, rows = frames) {
  const work = cacheHit || poseContentCacheHit ? 0 : 1;
  return { activeNativeMotionPaints: [active(frame, uploads, cacheHit, poseContentCacheHit, rows)], nativeMotionPaintResidentTextureCount: 1,
    nativeMotionPaintTextureUploads: uploads, decodedVideoCpuPixelCopies: 0,
    productPathCpuPixelCopies: work, nativePaintCpuUploadBytes: work * 128 };
}

describe("native paint exact receipt state", () => {
  it("accounts inactive initial resources, same-frame cache and reverse seek without double charging", async () => {
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph());
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, load())).toMatchObject({ cpuPixelCopies: 1, cpuUploadBytes: 128, activeGraphicIds: [] });
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 2, false))).toMatchObject({ cpuPixelCopies: 1, totalTextureUploadCount: 2, activeGraphicIds: ["title"] });
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 2, true))).toMatchObject({ cpuPixelCopies: 0, totalTextureUploadCount: 2 });
    assertNativeMotionPaintFrameReceipt(expected, 3, receipt(3, 3, false));
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 4, false))).toMatchObject({ cpuPixelCopies: 1, totalTextureUploadCount: 4 });
  });
  it.each(["signature", "node", "pose", "cache", "decoded-copy", "false-zero-copy", "missing-active"])("rejects %s without advancing the accepted frame", async defect => {
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph());
    assertNativeMotionPaintLoadReceipt(expected, 0, load());
    const invalid = receipt(1, 2, false), item = invalid.activeNativeMotionPaints[0];
    if (defect === "signature") item.sourceSignatureSha256 = "0".repeat(64);
    if (defect === "node") item.nodeId = "other";
    if (defect === "pose") item.poses[0].x += 0.00001;
    if (defect === "cache") item.cacheHit = true;
    if (defect === "decoded-copy") invalid.decodedVideoCpuPixelCopies = 1;
    if (defect === "false-zero-copy") invalid.productPathCpuPixelCopies = 0;
    if (defect === "missing-active") invalid.activeNativeMotionPaints = [];
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 1, invalid)).toThrow(/receipt/);
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 2, false)).totalTextureUploadCount).toBe(2);
  });
  it("refuses copied expectations, omitted inactive load work and reload on the old generation", async () => {
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph());
    expect(() => assertNativeMotionPaintLoadReceipt(structuredClone(expected), 0, load())).toThrow(/foreign/);
    const hidden = load(); hidden.nativeMotionPaintInitialCpuUploadBytes = 0;
    expect(() => assertNativeMotionPaintLoadReceipt(expected, 0, hidden)).toThrow(/initial resources/);
    assertNativeMotionPaintLoadReceipt(expected, 0, load());
    expect(() => assertNativeMotionPaintLoadReceipt(expected, 0, load())).toThrow(/generation/);
    const replacement = await prepareNativeMotionPaintReceiptExpectations(graph());
    expect(assertNativeMotionPaintLoadReceipt(replacement, 1, load(1)).totalTextureUploadCount).toBe(1);
  });

  it("reuses all-layer exact holds in forward and reverse seeks without relabelling same-frame hits", async () => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 },
      { x: 1, y: 2, scale: .5, opacity: 1 }]);
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph(rows, 2));
    assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 1, true, false, rows)))
      .toMatchObject({ cpuPixelCopies: 0, rasterCount: 0, textureUploadCount: 0, totalTextureUploadCount: 1 });
    for (const frame of [2, 3, 1]) {
      expect(assertNativeMotionPaintFrameReceipt(expected, frame, receipt(frame, 1, false, true, rows)))
        .toMatchObject({ cpuPixelCopies: 0, cpuUploadBytes: 0, rasterCount: 0, textureUploadCount: 0, totalTextureUploadCount: 1 });
    }
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 1, true, false, rows)).cpuUploadBytes).toBe(0);
  });

  it.each(["x", "y", "scale", "opacity"] as const)("does actual work when the second layer's %s changes by one f32 ULP", async field => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 },
      { x: 1, y: 1, scale: .5, opacity: .5 }]);
    const before = rows[0][1][field];
    const bits = new Uint32Array(new Float32Array([before]).buffer);
    bits[0]++;
    rows[1][1][field] = new Float32Array(bits.buffer)[0];
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph(rows, 2));
    assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, false, true, rows))).toThrow(/receipt/);
    expect(assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 2, false, false, rows)))
      .toMatchObject({ cpuPixelCopies: 1, cpuUploadBytes: 128, rasterCount: 1, textureUploadCount: 1, totalTextureUploadCount: 2 });
  });

  it.each(["missing-pose-flag", "missing-reason", "wrong-reason", "same-frame-flag", "both-flags", "pose", "extra-pose-field",
    "missing-layer", "upload-count", "raster-count", "frame-work", "upload-bytes", "raster-time", "upload-time", "aggregate"])
    ("refuses false exact-pose reuse %s without committing its cache state", async defect => {
      const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
      const expected = await prepareNativeMotionPaintReceiptExpectations(graph(rows));
      assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
      const invalid = receipt(2, 1, false, true, rows), item = invalid.activeNativeMotionPaints[0];
      if (defect === "missing-pose-flag") delete (item as Partial<typeof item>).poseContentCacheHit;
      if (defect === "missing-reason") delete (item as Partial<typeof item>).reuseReason;
      if (defect === "wrong-reason") item.reuseReason = "same_frame";
      if (defect === "same-frame-flag") { item.cacheHit = true; item.poseContentCacheHit = false; item.reuseReason = "same_frame"; }
      if (defect === "both-flags") item.cacheHit = true;
      if (defect === "pose") item.poses[0].opacity = .6;
      if (defect === "extra-pose-field") item.poses[0].revealedCommandCount = 4;
      if (defect === "missing-layer") item.poses = [];
      if (defect === "upload-count") item.textureUploadCount++;
      if (defect === "raster-count") item.rasterCount++;
      if (defect === "frame-work") item.frameRasterCount = 1;
      if (defect === "upload-bytes") item.frameCpuUploadBytes = 128;
      if (defect === "raster-time") item.rasterMilliseconds = .01;
      if (defect === "upload-time") item.uploadMilliseconds = .01;
      if (defect === "aggregate") invalid.nativeMotionPaintTextureUploads++;
      expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, invalid)).toThrow(/receipt/);
      // A failed frame 2 must not turn this accepted retry into a same-frame hit.
      expect(assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, false, true, rows)).totalTextureUploadCount).toBe(1);
    });

  it("rejects a forged negative-zero pose against positive-zero wire-compatible authored content", async () => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph(rows));
    assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
    const invalid = receipt(2, 1, false, true, rows);
    invalid.activeNativeMotionPaints[0].poses[0].x = -0;
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, invalid)).toThrow(/exact poses/);
    expect(assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, false, true, rows)).cpuPixelCopies).toBe(0);
  });

  it("invalidates on an inactive frame and charges the next active sample despite equal poses", async () => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
    const expected = await prepareNativeMotionPaintReceiptExpectations(graph(rows));
    assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
    assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, false, true, rows));
    expect(assertNativeMotionPaintFrameReceipt(expected, 4, { activeNativeMotionPaints: [],
      nativeMotionPaintResidentTextureCount: 1, nativeMotionPaintTextureUploads: 1,
      decodedVideoCpuPixelCopies: 0, productPathCpuPixelCopies: 0, nativePaintCpuUploadBytes: 0 }).cpuPixelCopies).toBe(0);
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, true, false, rows))).toThrow(/receipt/);
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 1, false, true, rows))).toThrow(/receipt/);
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, receipt(1, 2, false, false, rows)).cpuPixelCopies).toBe(1);
  });

  it("keeps the authored graph snapshot private and never imports another source generation's hold cache", async () => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
    const authored = graph(rows), expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    assertNativeMotionPaintLoadReceipt(expected, 1, load(1, rows));
    rows[1][0].x = 1;
    const original = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
    expect(assertNativeMotionPaintFrameReceipt(expected, 2, receipt(2, 1, false, true, original)).cpuPixelCopies).toBe(0);
    const replacement = await prepareNativeMotionPaintReceiptExpectations(graph(original));
    assertNativeMotionPaintLoadReceipt(replacement, 0, load());
    expect(() => assertNativeMotionPaintFrameReceipt(replacement, 2, receipt(2, 1, false, true, original))).toThrow(/receipt/);
    const wrongSource = receipt(2, 2, false, false, original);
    wrongSource.activeNativeMotionPaints[0].sourceSignatureSha256 = "0".repeat(64);
    expect(() => assertNativeMotionPaintFrameReceipt(replacement, 2, wrongSource)).toThrow(/identity/);
    expect(assertNativeMotionPaintFrameReceipt(replacement, 2, receipt(2, 2, false, false, original)).cpuPixelCopies).toBe(1);
  });

  it("rejects unrecognised dynamic-reveal pose fields before creating immutable expectations", async () => {
    const rows = frames.map(poses => poses.map(pose => ({ ...pose, revealedCommandCount: 4 })));
    await expect(prepareNativeMotionPaintReceiptExpectations(graph(rows))).rejects.toThrow(/invalid authored track/);
  });
});

describe("native paint authored display boundary receipts", () => {
  it("binds an inactive display track at load and then accounts its active samples with the original clock", async () => {
    const expected = await prepareNativeMotionPaintReceiptExpectations(displayGraph());
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, displayLoad())).toMatchObject({ cpuPixelCopies: 1, activeGraphicIds: [] });
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, displayReceipt(1, 2, false)))
      .toMatchObject({ cpuPixelCopies: 1, cpuUploadBytes: 128, totalTextureUploadCount: 2 });
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, displayReceipt(1, 2, true)))
      .toMatchObject({ cpuPixelCopies: 0, totalTextureUploadCount: 2 });
    expect(assertNativeMotionPaintFrameReceipt(expected, 3, displayReceipt(3, 3, false)).cpuPixelCopies).toBe(1);
  });

  it.each([false, true])("counts legacy Motion slots in global overlay order (display=%s)", async display => {
    const authored = displayGraph(frames, true);
    if (!display) {
      const paint = authored.nodes.find(node => node.id === "paint")!;
      paint.track = graph().nodes[0].track;
      authored.nodes.find(node => node.id === "legacy-composite")!.inputs = ["source", "legacy"];
      authored.nodes.find(node => node.id === "display")!.inputs = ["display-paint"];
      authored.nodes.find(node => node.id === "display-paint")!.inputs = ["legacy-composite", "paint"];
      authored.nodes.find(node => node.id === "output")!.inputs = ["display"];
    }
    const expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    const initial = display ? displayLoad(0, 1) : load();
    initial.nativeMotionPaintColorBindings[0].overlayOrder = 1;
    assertNativeMotionPaintLoadReceipt(expected, 0, initial);
    const correct = display ? displayReceipt(1, 2, false, false, 1) : receipt(1, 2, false);
    correct.activeNativeMotionPaints[0].overlayOrder = 1;
    const wrong = structuredClone(correct); wrong.activeNativeMotionPaints[0].overlayOrder = 0;
    expect(() => assertNativeMotionPaintFrameReceipt(expected, 1, wrong)).toThrow(/order.*binding/);
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, correct).cpuPixelCopies).toBe(1);
  });

  it("does not count caption or particle nodes as Motion overlay slots", async () => {
    const authored = displayGraph();
    authored.nodes.push({ id: "particle", inputs: [], enabled: true, kind: "particle_emitter" },
      { id: "caption", inputs: [], enabled: true, kind: "caption" },
      { id: "particle-composite", inputs: ["source", "particle"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 },
      { id: "caption-composite", inputs: ["particle-composite", "caption"], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
    authored.nodes.find(node => node.id === "display")!.inputs = ["caption-composite"];
    const expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, displayLoad()).totalTextureUploadCount).toBe(1);
  });

  it("keeps a scene prefix before the display suffix and validates every inactive binding in authored order", async () => {
    const authored = displayGraph(), scene = { ...graph().nodes[0], id: "scene-paint", graphicId: "scene-title" };
    authored.nodes.push(scene, { id: "scene-composite", inputs: ["source", scene.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
    authored.nodes.find(node => node.id === "display")!.inputs = ["scene-composite"];
    const expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    const sceneBinding = { ...colorBinding(), nodeId: scene.id, graphicId: scene.graphicId };
    const initial = { ...displayLoad(), nativeMotionPaintCount: 2, nativeMotionPaintResidentTextureCount: 2,
      nativeMotionPaintTextureUploads: 2, nativeMotionPaintInitialRasterCount: 2, nativeMotionPaintInitialCpuUploadBytes: 256,
      nativeMotionPaintColorBindings: [sceneBinding, colorBinding(true, 1)] };
    expect(() => assertNativeMotionPaintLoadReceipt(expected, 0, { ...initial,
      nativeMotionPaintColorBindings: [...initial.nativeMotionPaintColorBindings].reverse() })).toThrow(/identity binding/);
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, initial)).toMatchObject({ nativePaintCount: 2,
      cpuPixelCopies: 2, cpuUploadBytes: 256, totalTextureUploadCount: 2, activeGraphicIds: [] });
  });

  it.each([false, true])("rejects missing/forged inactive-load color bindings without consuming the generation (display=%s)", async display => {
    const expected = await prepareNativeMotionPaintReceiptExpectations(display ? displayGraph() : graph());
    const initial = display ? displayLoad() : load();
    const cases: unknown[] = [undefined, null, [], [...initial.nativeMotionPaintColorBindings, ...initial.nativeMotionPaintColorBindings]];
    const binding = initial.nativeMotionPaintColorBindings[0];
    for (const field of ["nodeId", "graphicId", "sourceSignatureSha256", "colorIntent", "compositionBoundary", "overlayOrder"]) {
      const omitted: Record<string, unknown> = { ...binding }; delete omitted[field]; cases.push([omitted]);
      cases.push([{ ...binding, [field]: null }]);
    }
    cases.push([{ ...binding, sourceSignatureSha256: "0".repeat(64) }],
      [{ ...binding, colorIntent: display ? "scene_linear_rec709" : "display_rec709_sdr" }],
      [{ ...binding, compositionBoundary: display ? "before_aces2" : "after_aces2_before_output_encoding" }],
      [{ ...binding, overlayOrder: 1 }], [{ ...binding, hiddenDomain: "display" }]);
    for (const invalid of cases) {
      expect(() => assertNativeMotionPaintLoadReceipt(expected, 0, { ...initial, nativeMotionPaintColorBindings: invalid })).toThrow(/receipt/);
    }
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, initial).totalTextureUploadCount).toBe(1);
  });

  it.each([false, true])("refuses active intent/boundary/order/source/clock drift without advancing a pose-content hold (display=%s)", async display => {
    const rows = Array.from({ length: 3 }, () => [{ x: 0, y: 0, scale: 1, opacity: .5 }]);
    const expected = await prepareNativeMotionPaintReceiptExpectations(display ? displayGraph(rows) : graph(rows));
    const initial = display ? displayLoad(1, 0, rows) : load(1, rows);
    assertNativeMotionPaintLoadReceipt(expected, 1, initial);
    const correct = display ? displayReceipt(2, 1, false, true, 0, rows) : receipt(2, 1, false, true, rows);
    const changed = [{ colorIntent: display ? "scene_linear_rec709" : "display_rec709_sdr" },
      { compositionBoundary: display ? "before_aces2" : "after_aces2_before_output_encoding" }, { overlayOrder: 1 },
      { sourceSignatureSha256: "0".repeat(64) }, { timelineFrame: 3 }, { localFrame: 0 }];
    for (const fields of changed) {
      const invalid = structuredClone(correct); Object.assign(invalid.activeNativeMotionPaints[0], fields);
      expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, invalid)).toThrow(/receipt/);
    }
    for (const field of ["colorIntent", "compositionBoundary", "overlayOrder"]) {
      const invalid = structuredClone(correct);
      delete (invalid.activeNativeMotionPaints[0] as Record<string, unknown>)[field];
      expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, invalid)).toThrow(/receipt/);
      Object.assign(invalid.activeNativeMotionPaints[0], { [field]: null });
      expect(() => assertNativeMotionPaintFrameReceipt(expected, 2, invalid)).toThrow(/receipt/);
    }
    expect(assertNativeMotionPaintFrameReceipt(expected, 2, correct)).toMatchObject({ cpuPixelCopies: 0, totalTextureUploadCount: 1 });
  });

  it("keeps source and boundary metadata tied to the private pre-load graph snapshot", async () => {
    const authored = displayGraph(), expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    const track = authored.nodes.find(node => node.id === "paint")!.track as Record<string, unknown>;
    track.colorIntent = "scene_linear_rec709"; track.sourceSignature = "untrusted replacement";
    authored.nodes.find(node => node.id === "display-paint")!.inputs.reverse();
    assertNativeMotionPaintLoadReceipt(expected, 0, displayLoad());
    expect(assertNativeMotionPaintFrameReceipt(expected, 1, displayReceipt(1, 2, false)).cpuPixelCopies).toBe(1);
  });

  it.each(["missing-intent", "null-intent", "wrong-intent", "v1-with-intent", "unknown-track-field"])
    ("rejects an authored %s instead of falling back to scene", async defect => {
      const authored = displayGraph(), track = authored.nodes.find(node => node.id === "paint")!.track as Record<string, unknown>;
      if (defect === "missing-intent") delete track.colorIntent;
      if (defect === "null-intent") track.colorIntent = null;
      if (defect === "wrong-intent") track.colorIntent = "scene_linear_rec709";
      if (defect === "v1-with-intent") track.schema = "editkin.native-motion-paint-track/v1";
      if (defect === "unknown-track-field") track.gamma = 2.2;
      await expect(prepareNativeMotionPaintReceiptExpectations(authored)).rejects.toThrow(/authored color intent/);
    });

  it.each(["pre-aces", "hdr", "double-aces", "graded-aces", "blend", "opacity", "effect-suffix", "scene-suffix", "shared-source", "3d", "matte"])
    ("rejects incompatible display topology %s before load", async defect => {
      const authored = displayGraph(), display = authored.nodes.find(node => node.id === "display")!, composite = authored.nodes.find(node => node.id === "display-paint")!;
      if (defect === "pre-aces") {
        composite.inputs = ["source", "paint"]; display.inputs = [composite.id]; authored.nodes.find(node => node.id === "output")!.inputs = [display.id];
      }
      if (defect === "hdr") { display.processor = "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1"; display.outputSpace = "rec2100_pq_1000"; }
      if (defect === "double-aces") {
        authored.nodes.push({ ...display, id: "second-display", inputs: ["source"] }); display.inputs = ["second-display"];
      }
      if (defect === "graded-aces") display.grade = { exposure: .5 };
      if (defect === "blend") composite.blendMode = "multiply";
      if (defect === "opacity") composite.opacity = .5;
      if (defect === "effect-suffix") {
        authored.nodes.push({ id: "effect", inputs: [composite.id], enabled: true, kind: "effect" }); authored.nodes.find(node => node.id === "output")!.inputs = ["effect"];
      }
      if (defect === "scene-suffix") {
        const extra = { ...graph().nodes[0], id: "scene-paint", graphicId: "scene-title" };
        authored.nodes.push(extra, { id: "scene-composite", inputs: [composite.id, extra.id], enabled: true, kind: "composite", blendMode: "normal", opacity: 1 });
        authored.nodes.find(node => node.id === "output")!.inputs = ["scene-composite"];
      }
      if (defect === "shared-source") display.inputs = ["paint"];
      if (defect === "3d") {
        authored.nodes.push({ id: "camera", inputs: ["source"], enabled: true, kind: "camera" }); display.inputs = ["camera"];
      }
      if (defect === "matte") composite.matteInput = "source";
      await expect(prepareNativeMotionPaintReceiptExpectations(authored)).rejects.toThrow(/receipt/);
    });

  it("accepts supported background exposure/effect work without grading the display boundary", async () => {
    const authored = displayGraph();
    authored.nodes.push({ id: "background-effect", inputs: ["source"], enabled: true, kind: "effect" },
      { id: "background-exposure", inputs: ["background-effect"], enabled: true, kind: "color", processor: "editkin-linear-primary/v1",
        inputSpace: "linear_rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709", grade: { exposure: .5 } });
    authored.nodes.find(node => node.id === "display")!.inputs = ["background-exposure"];
    const expected = await prepareNativeMotionPaintReceiptExpectations(authored);
    expect(assertNativeMotionPaintLoadReceipt(expected, 0, displayLoad()).totalTextureUploadCount).toBe(1);
  });
});

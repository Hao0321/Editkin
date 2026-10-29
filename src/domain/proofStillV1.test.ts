import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./editGraph";
import { editorCommandSchema, projectSchema } from "./schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "./types";
import {
  assertProofStillClipV1, assertProofStillProjectV1, parseProofStillEvidenceReferenceV1, parseProofStillV1, projectContainsProofStillV1,
  proofStillCanvasFitV1, proofStillDefaultLayoutV1, proofStillDerivedLayoutCropV1, proofStillEvidenceReferenceV1, proofStillOutputRectV1,
  PROOF_STILL_REFUSAL_CODES_V1, type ProofStillV1,
} from "./proofStillV1";

const SHA = "a".repeat(64);
function proof(patch: Partial<ProofStillV1> = {}): ProofStillV1 {
  return { schema: "editkin.proof-still/v1", sourceSha256: SHA, sourceWidth: 1600, sourceHeight: 900,
    crop: { x: 100, y: 100, width: 800, height: 450 }, redactions: [{ id: "email", rect: { x: 120, y: 120, width: 200, height: 40 }, fill: "#000000" }],
    target: { rect: { x: 400, y: 300, width: 160, height: 60 } }, hold: "static", confirmation: { by: "agent", note: "Email row redacted after viewing kf-1." }, ...patch };
}
const canvas = { width: 1920, height: 1080 };
function asset(patch: Partial<MediaAsset> = {}): MediaAsset {
  return { id: "shot", name: "Shot", kind: "image", uri: "shots/settings.png", duration: 5, width: 1600, height: 900, ...patch };
}
function clip(value: ProofStillV1 = proof(), patch: Partial<TimelineClip> = {}): TimelineClip {
  return { id: "proof-1", assetId: "shot", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layout: proofStillDefaultLayoutV1(value, canvas), proofStill: value, ...patch };
}
const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message.split(":")[0]; } return "ADMITTED"; };

describe("editkin.proof-still/v1 model (design P2)", () => {
  it("admits a valid still and keeps it unchanged through parse", () => {
    expect(parseProofStillV1(proof())).toEqual(proof());
    expect(assertProofStillClipV1(clip(), { asset: asset(), canvas, actualSourceSha256: SHA })).toEqual(proof());
  });

  it.each([
    ["source sha", { sourceSha256: "XYZ" }],
    ["fill colour", { redactions: [{ id: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, fill: "black" }] }],
    ["non-integer source pixels", { crop: { x: .5, y: 0, width: 100, height: 100 } }],
    ["moving hold", { hold: "pan" as unknown as "static" }],
    ["unconfirmed regions", { confirmation: { by: "agent", note: "" } }],
    ["untrimmed note", { confirmation: { by: "user", note: " padded " } }],
    ["unknown confirmer", { confirmation: { by: "model" as "agent", note: "n" } }],
    ["blur instead of solid fill", { redactions: [{ id: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, fill: "#000000", mode: "blur" } as never] }],
    ["more than 32 regions", { redactions: Array.from({ length: 33 }, (_, i) => ({ id: `r${i}`, rect: { x: 0, y: i * 10, width: 10, height: 10 }, fill: "#000000" })) }],
  ])("refuses an invalid structure: %s", (_label, patch) => {
    expect(code(() => parseProofStillV1(proof(patch as Partial<ProofStillV1>)))).toBe("PROOF_STILL_SCHEMA_INVALID");
  });

  it.each([
    ["crop", { crop: { x: 1000, y: 100, width: 800, height: 450 } }],
    ["redaction", { redactions: [{ id: "a", rect: { x: 1590, y: 10, width: 20, height: 20 }, fill: "#000000" }] }],
    ["target", { target: { rect: { x: 400, y: 880, width: 100, height: 40 } } }],
  ])("refuses a %s outside the source bounds", (_label, patch) => {
    expect(code(() => parseProofStillV1(proof(patch as Partial<ProofStillV1>)))).toBe("PROOF_STILL_RECT_OUT_OF_BOUNDS");
  });

  it("refuses rectangles smaller than 4 source pixels, duplicate ids, a target outside the crop and a fully redacted target", () => {
    expect(code(() => parseProofStillV1(proof({ redactions: [{ id: "a", rect: { x: 10, y: 10, width: 3, height: 40 }, fill: "#000000" }] })))).toBe("PROOF_STILL_RECT_TOO_SMALL");
    expect(code(() => parseProofStillV1(proof({ crop: { x: 0, y: 0, width: 1600, height: 3 }, target: undefined })))).toBe("PROOF_STILL_RECT_TOO_SMALL");
    expect(code(() => parseProofStillV1(proof({ redactions: [proof().redactions[0], { ...proof().redactions[0], rect: { x: 600, y: 120, width: 50, height: 50 } }] }))))
      .toBe("PROOF_STILL_REDACTION_ID_DUPLICATE");
    expect(code(() => parseProofStillV1(proof({ target: { rect: { x: 850, y: 300, width: 100, height: 60 } } })))).toBe("PROOF_STILL_TARGET_OUTSIDE_CROP");
    const target = { x: 400, y: 300, width: 160, height: 60 };
    expect(code(() => parseProofStillV1(proof({ redactions: [{ id: "all", rect: { x: 390, y: 290, width: 200, height: 100 }, fill: "#000000" }] })))).toBe("PROOF_STILL_TARGET_FULLY_REDACTED");
    // Two halves together also cover it; one half alone leaves the target visible.
    const halves = [{ id: "l", rect: { x: 400, y: 300, width: 80, height: 60 }, fill: "#000000" }, { id: "r", rect: { x: 480, y: 290, width: 90, height: 80 }, fill: "#111111" }];
    expect(code(() => parseProofStillV1(proof({ target: { rect: target }, redactions: halves })))).toBe("PROOF_STILL_TARGET_FULLY_REDACTED");
    expect(code(() => parseProofStillV1(proof({ target: { rect: target }, redactions: [halves[0]] })))).toBe("ADMITTED");
  });

  it.each([
    ["missing asset", () => assertProofStillClipV1(clip(), { asset: undefined, canvas }), "PROOF_STILL_ASSET_MISSING"],
    ["video asset", () => assertProofStillClipV1(clip(), { asset: asset({ kind: "video" }), canvas }), "PROOF_STILL_ASSET_NOT_IMAGE"],
    ["composition asset", () => assertProofStillClipV1(clip(), { asset: asset({ compositionId: "c" }), canvas }), "PROOF_STILL_ASSET_NOT_IMAGE"],
    ["non-screenshot container", () => assertProofStillClipV1(clip(), { asset: asset({ uri: "shots/anim.gif" }), canvas }), "PROOF_STILL_SOURCE_FORMAT_UNSUPPORTED"],
    ["dimension mismatch", () => assertProofStillClipV1(clip(), { asset: asset({ width: 1599 }), canvas }), "PROOF_STILL_SOURCE_DIMENSIONS_MISMATCH"],
    ["non-square display ratio", () => assertProofStillClipV1(clip(), { asset: asset({ displayAspectRatio: 2 }), canvas }), "PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED"],
    ["recorded derivative sha", () => assertProofStillClipV1(clip(), { asset: asset({ derivatives: { sourceSha256: "b".repeat(64), generatedAt: "x" } }), canvas }), "PROOF_STILL_SOURCE_SHA_MISMATCH"],
    ["actual file sha", () => assertProofStillClipV1(clip(), { asset: asset(), canvas, actualSourceSha256: "c".repeat(64) }), "PROOF_STILL_SOURCE_SHA_MISMATCH"],
    ["keyframes", () => assertProofStillClipV1(clip(proof(), { keyframes: [{ id: "k", time: 1, transform: { ...DEFAULT_TRANSFORM, scale: 1.2 }, color: { ...DEFAULT_COLOR }, easing: "linear" }] }), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_KEYFRAMES"],
    ["expressions", () => assertProofStillClipV1(clip(proof(), { expressions: { x: "hao.expression/v1:wiggle(1,2)" } }), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_EXPRESSIONS"],
    ["transform3d", () => assertProofStillClipV1(clip(proof(), { transform3d: { position: [0, 0, 0], rotationDegrees: [0, 10, 0], scale: [1, 1, 1] } }), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_TRANSFORM3D"],
    ["floating frame", () => assertProofStillClipV1(clip(proof(), { floatingFrame: { schema: "editkin.floating-video-frame/v1", style: "matte", size: .6, yawDegrees: 0, pitchDegrees: 0 } }), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_FLOATING_FRAME"],
    ["speed", () => assertProofStillClipV1(clip(proof(), { speed: 2 } as Partial<TimelineClip>), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_SPEED"],
    ["time remap", () => assertProofStillClipV1(clip(proof(), { timeRemap: {} } as unknown as Partial<TimelineClip>), { asset: asset(), canvas }), "PROOF_STILL_STATIC_HOLD_TIME_REMAP"],
    ["adjustment role", () => assertProofStillClipV1(clip(proof(), { layer: { enabled: true, blendMode: "normal", role: "adjustment" } }), { asset: asset(), canvas }), "PROOF_STILL_LAYER_ROLE_REFUSED"],
    ["native effect", () => assertProofStillClipV1(clip(proof(), { creative: { effectPresetIds: [], nativeEffectInstances: [{ enabled: true } as never] } }), { asset: asset(), canvas }), "PROOF_STILL_NATIVE_EFFECT_REFUSED"],
    ["an enabled mask", () => assertProofStillClipV1(clip(proof(), { masks: [{ enabled: true } as never] }), { asset: asset(), canvas }), "PROOF_STILL_ALPHA_PROCESSING_REFUSED"],
    ["a chroma key", () => assertProofStillClipV1(clip(proof(), { chromaKey: { enabled: true } as never }), { asset: asset(), canvas }), "PROOF_STILL_ALPHA_PROCESSING_REFUSED"],
    ["missing layout", () => assertProofStillClipV1(clip(proof(), { layout: undefined }), { asset: asset(), canvas }), "PROOF_STILL_LAYOUT_REQUIRED"],
    ["hand-moved crop", () => assertProofStillClipV1(clip(proof(), { layout: { ...proofStillDefaultLayoutV1(proof(), canvas), crop: { x: .1, y: .1, width: .5, height: .5 } } }), { asset: asset(), canvas }), "PROOF_STILL_LAYOUT_CROP_MISMATCH"],
    ["resized canvas", () => assertProofStillClipV1(clip(), { asset: asset(), canvas: { width: 1080, height: 1920 } }), "PROOF_STILL_LAYOUT_CROP_MISMATCH"],
    ["empty viewport", () => assertProofStillClipV1(clip(proof(), { layout: { ...proofStillDefaultLayoutV1(proof(), canvas), viewport: { x: 0, y: 0, width: 0, height: .5 } } }), { asset: asset(), canvas }), "PROOF_STILL_LAYOUT_VIEWPORT_INVALID"],
    ["invalid canvas", () => assertProofStillClipV1(clip(), { asset: asset(), canvas: { width: 0, height: 1080 } }), "PROOF_STILL_CANVAS_INVALID"],
  ])("refuses a clip with %s", (_label, run, expected) => {
    expect(PROOF_STILL_REFUSAL_CODES_V1).toContain(expected);
    expect(code(run)).toBe(expected);
  });

  it("refuses a proof still used as another clip's track-matte source and finds stills inside compositions", () => {
    const project = createEmptyProject("matte", canvas);
    project.assets.push(asset());
    project.tracks[0].clips.push(clip());
    expect(code(() => assertProofStillProjectV1(project))).toBe("ADMITTED");
    project.tracks[0].clips.push({ ...clip(undefined, { id: "other" }), proofStill: undefined, layout: undefined, layer: { enabled: true, blendMode: "normal", trackMatte: { sourceClipId: "proof-1", mode: "luma" } } });
    expect(code(() => assertProofStillProjectV1(project))).toBe("PROOF_STILL_TRACK_MATTE_SOURCE_REFUSED");
    const nested = createEmptyProject("nested", canvas);
    expect(projectContainsProofStillV1(nested)).toBe(false);
    const composition: EditProject["compositions"][number] = { schema: "editkin.composition/v1", id: "c", name: "c", width: 800, height: 450, fps: 30, duration: 3,
      tracks: [{ id: "t", name: "t", kind: "video", locked: false, muted: false, clips: [clip()] }], captions: [], captionStyle: nested.captionStyle, motionTracks: [], motionGraphics: [],
      director: nested.director, updatedAt: nested.updatedAt };
    nested.compositions.push(composition);
    expect(projectContainsProofStillV1(nested)).toBe(true);
  });

  it("derives layout.crop from the compositor's own canvas fit (FFmpeg decrease + centred pad)", () => {
    // 1366x768 into 1920x1080: width min(round(1080*1366/768)=1921, 1920) = 1920, height round(1920*768/1366) = 1079, pad y = 0.
    expect(proofStillCanvasFitV1(1366, 768, canvas)).toEqual({ width: 1920, height: 1079, x: 0, y: 0 });
    expect(proofStillCanvasFitV1(1170, 2532, canvas)).toEqual({ width: 499, height: 1080, x: 710, y: 0 });
    const value = proof(), crop = proofStillDerivedLayoutCropV1(value, canvas);
    expect([crop.x * 1920, crop.y * 1080, crop.width * 1920, crop.height * 1080].map(v => Math.round(v * 1e9) / 1e9)).toEqual([120, 120, 960, 540]);
    const layout = proofStillDefaultLayoutV1(value, canvas);
    expect(layout.viewport).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    const target = proofStillOutputRectV1(value, value.target!.rect, layout, canvas);
    // Source (400,300,160,60) x1.2 → canvas (480,360,192,72), inside crop (120,120,960,540) x2 → (720,480,384,144).
    expect([target.x * 1920, target.y * 1080, target.width * 1920, target.height * 1080].map(v => Math.round(v * 1e6) / 1e6)).toEqual([720, 480, 384, 144]);
  });

  it("is one optional clip field in the project and command schemas, with the same refusals", () => {
    const project = createEmptyProject("schema", canvas);
    project.assets.push(asset());
    project.tracks[0].clips.push(clip());
    expect(projectSchema.parse(structuredClone(project)).tracks[0].clips[0].proofStill).toEqual(proof());
    const plain = structuredClone(project); delete plain.tracks[0].clips[0].proofStill;
    expect("proofStill" in projectSchema.parse(plain).tracks[0].clips[0]).toBe(false);
    const bad = editorCommandSchema.safeParse({ type: "add_clip", clip: clip(proof({ target: { rect: { x: 850, y: 300, width: 100, height: 60 } } })) });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.some(issue => issue.message === "PROOF_STILL_TARGET_OUTSIDE_CROP")).toBe(true);
  });

  it("binds the editorial evidence ref to one material frame grammar", () => {
    const reference = proofStillEvidenceReferenceV1("1".repeat(64), "2".repeat(64), "kf-1");
    expect(reference.length).toBeLessThanOrEqual(160);
    expect(parseProofStillEvidenceReferenceV1(reference)).toEqual({ materialId: "1".repeat(64), semanticReceiptSha256: "2".repeat(64), frameId: "kf-1" });
    expect(parseProofStillEvidenceReferenceV1(`mi:${"1".repeat(64)}:${"2".repeat(64)}:cue:0`)).toBeUndefined();
    expect(parseProofStillEvidenceReferenceV1(`mi:${"1".repeat(64)}:${"2".repeat(64)}:frame:kf-13`)).toBeUndefined();
  });
});

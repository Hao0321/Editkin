import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { createDemoProject } from "../domain/demo";
import type { EditProject } from "../domain/types";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, PREPARED_GLYPH_PARSER_VERSION } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { sha256Canonical, sha256Text } from "../application/autopilotInvocationIdentity";
import type { CurrentAutopilotPlan } from "../application/autopilotPlan";
import type { EditorialPlan } from "../application/editorialPlan";
import { originalMotionCueEvidenceReference, prepareOriginalMotionSourceEvidence,
  type OriginalMotionSourceEvidence, type OriginalMotionSourceRights, type OriginalMotionSourceSet } from "../application/originalMotionSourceEvidence";
import type { OriginalMotionAuthoringFile, OriginalMotionTextProvider } from "./originalMotionSourceFile";
import { verifyCurrentOriginalMotionEvidence } from "./originalMotionWorkflow";
import { workspaceRoot } from "./storage";

const files = vi.hoisted(() => ({ read: vi.fn(), provider: vi.fn() }));
vi.mock("./originalMotionSourceFile", () => ({ readOriginalMotionAuthoringSource: files.read, originalMotionTextProvider: files.provider }));

const faceId = "EditkinFace-bebas-neue-400";
const rights: OriginalMotionSourceRights = { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration",
  realityProof: false, importedReferenceMedia: false, declaration: "Original source-route unit fixture; no observed media, atomic apply or art claim." };
let bytes: Uint8Array;
beforeAll(async () => { bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile))); });
beforeEach(() => { files.read.mockReset(); files.provider.mockReset(); });

function input(project: EditProject, overlay: boolean): OriginalMotionAuthoringFile["authoring"] {
  return { expectedRevision: project.revision, sceneId: "route-scene", intent: overlay ? "authored_overlay" : "standalone_showcase",
    reason: "An original glyph keeps its identity during an authored focus handoff", startFrame: 0, durationFrames: 90,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: project.width / 2, centerY: project.height / 2, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "route-text", kind: "text", text: "FOCUS", typographyRole: "heading", fontWeight: 400,
      range: { startFrame: 0, endFrame: 90 }, xPixels: 100, yPixels: 80, widthPixels: 430, fontSize: 48, minFontSize: 32,
      maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text" }],
    semanticCues: [{ id: "opening", frame: 0, purpose: "Introduce the authored glyph", graphicIds: ["route-text"], evidenceRefs: ["authoring:opening"] },
      { id: "focus", frame: 30, purpose: "Move focal emphasis", graphicIds: ["route-text"], evidenceRefs: ["authoring:focus"],
        focus: { centerX: project.width / 2 + 10, centerY: project.height / 2, zoom: 1.02 } }] };
}

function sourceMetadata(payload: OriginalMotionAuthoringFile) {
  const text = `${canonicalJson(payload)}\n`;
  return { sourcePath: ".editkin/original-sources/route-fixture.json", sourceSha256: sha256Text(text),
    sourcePayloadSha256: sha256Canonical(payload), bytes: Buffer.byteLength(text, "utf8") };
}
function reseal(evidence: OriginalMotionSourceEvidence) {
  const { sourceSha256: _old, ...body } = evidence;
  evidence.sourceSha256 = sha256Canonical(body);
}
function provider(sourceBytes = bytes): OriginalMotionTextProvider {
  return Object.assign((face: string, text: string) => prepareGlyphRun(face, text, sourceBytes), { dispose() {} });
}

/** Actual compiler/glyph objects with a deterministic verified-file supplier.
 * This route projection is not a full v4 plan or an actual file/IO receipt. */
async function fixture(overlay = false) {
  // The stable domain media fixture exercises overlay ownership only; this
  // suite does not claim its URI has current licensed/semantic byte evidence.
  const project = overlay ? createDemoProject() : createEmptyProject("Original route unit", { id: "route-project", width: 640, height: 360, fps: 30 });
  const spec = bundledFontFaceSpec(faceId), payload: OriginalMotionAuthoringFile = { schema: "editkin.original-motion-authoring/v1",
    usage: overlay ? "authored_overlay" : "standalone", audio: overlay ? "preserve_source_audio" : "silent", fps: project.fps,
    authoring: input(project, overlay), rights: structuredClone(rights), fontBindings: [{ graphicId: "route-text", faceId,
      fontSha256: spec.sha256, manifestSha256: spec.manifestSha256, parserVersion: PREPARED_GLYPH_PARSER_VERSION }] };
  const source = sourceMetadata(payload), actual = await prepareOriginalMotionSourceEvidence(project, payload.authoring, payload.rights, 0,
    { authoringSource: source, prepareText: (face, text) => prepareGlyphRun(face, text, bytes) });
  const set: OriginalMotionSourceSet = { schema: "editkin.original-motion-source/v1", sources: [actual.evidence] };
  const editorial: Pick<EditorialPlan, "graphics" | "narrative"> = { graphics: actual.preparation.editorialGraphics,
    narrative: { backbone: "An original authored focal handoff", setupPayoffs: [], beats: actual.evidence.scene.semanticCues.map((cue, ordinal, cues) => ({
      id: `beat-${ordinal}`, range: { startFrame: cue.frame, endFrame: cues[ordinal + 1]?.frame ?? actual.evidence.scene.durationFrames },
      role: ordinal === 0 ? "promise" as const : "payoff" as const, summary: cue.purpose, primaryFocus: cue.purpose, energy: .5,
      evidenceRefs: [originalMotionCueEvidenceReference(actual.evidence.sourceSha256, cue.id)] })) } };
  const plan = { schema: "hao.video-autopilot.edit-plan/v4", commands: actual.preparation.commands, editorial,
    ...(overlay ? { materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [] }, originalMotionEvidence: set }
      : { materialEvidence: { ...set, receipts: [] } }) } as unknown as CurrentAutopilotPlan;
  const loaded = { source, payload };
  files.read.mockImplementation(async () => structuredClone(loaded)); files.provider.mockReturnValue(provider());
  return { project, plan, set, loaded, editorial };
}

describe("original Motion workflow route with verified supplier and real source compiler", () => {
  it("leaves the legacy media route untouched without any original source or font IO", async () => {
    const project = createDemoProject(), before = canonicalJson(project);
    const plan = { schema: "hao.video-autopilot.edit-plan/v4", materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [] },
      commands: [] } as unknown as CurrentAutopilotPlan;
    await expect(verifyCurrentOriginalMotionEvidence(plan, project)).resolves.toBeUndefined();
    expect(files.read).not.toHaveBeenCalled(); expect(files.provider).not.toHaveBeenCalled();
    expect(canonicalJson(project)).toBe(before);
  });

  it("rejects actual standalone asset, clip or caption contamination before reading a file", async () => {
    const f = await fixture(), demo = createDemoProject();
    for (const mutate of [(project: EditProject) => { project.assets = structuredClone(demo.assets); },
      (project: EditProject) => { project.tracks[0].clips = structuredClone(demo.tracks[0].clips); },
      (project: EditProject) => { project.captions.push({ id: "existing-caption", text: "An actual saved caption", start: 0, duration: 2 }); }]) {
      const contaminated = structuredClone(f.project); mutate(contaminated);
      await expect(verifyCurrentOriginalMotionEvidence(f.plan, contaminated)).rejects.toThrow(/genuinely media-free/);
    }
    expect(files.read).not.toHaveBeenCalled(); expect(files.provider).not.toHaveBeenCalled();
  });

  it("re-reads supplied source metadata and recompiles real physical glyphs without modifying the project", async () => {
    const f = await fixture(), before = canonicalJson(f.project);
    const result = await verifyCurrentOriginalMotionEvidence(f.plan, f.project);
    expect(result).toMatchObject({ state: "SOURCE_BOUND_REVIEW_REQUIRED", sourceCount: 1, graphicCount: 1 });
    expect(result?.sourceSetSha256).toBe(sha256Canonical(f.set));
    // Actual route: authored payload verification, precompile source read,
    // then postcompile source read. The forged-layout control still stops at two.
    expect(files.read).toHaveBeenCalledTimes(3);
    for (const args of files.read.mock.calls) expect(args).toEqual([f.loaded.source.sourcePath, workspaceRoot()]);
    expect(files.provider).toHaveBeenCalledTimes(1); expect(canonicalJson(f.project)).toBe(before);
    expect(f.project.assets).toEqual([]); expect(f.project.tracks.flatMap(track => track.clips)).toEqual([]);
  });

  it("allows an authored overlay on saved domain media but still rejects wrong actual font bytes", async () => {
    const f = await fixture(true), before = canonicalJson(f.project);
    expect(f.project.assets.length).toBeGreaterThan(0); expect(f.project.tracks[0].clips.length).toBeGreaterThan(0);
    await expect(verifyCurrentOriginalMotionEvidence(f.plan, f.project)).resolves.toMatchObject({ state: "SOURCE_BOUND_REVIEW_REQUIRED" });
    expect(canonicalJson(f.project)).toBe(before);
    const corrupt = bytes.slice(); corrupt[0] ^= 1; files.provider.mockReturnValue(provider(corrupt));
    await expect(verifyCurrentOriginalMotionEvidence(f.plan, f.project)).rejects.toThrow(/physical font SHA/);
    expect(canonicalJson(f.project)).toBe(before);
  });

  it("rejects a newly read file or its declared physical-font intent before starting glyph preparation", async () => {
    const changedFile = await fixture(); changedFile.loaded.payload.authoring.camera.initial.centerX += 1;
    changedFile.loaded.source = sourceMetadata(changedFile.loaded.payload);
    await expect(verifyCurrentOriginalMotionEvidence(changedFile.plan, changedFile.project)).rejects.toThrow(/file and manifest differ/);
    expect(files.provider).not.toHaveBeenCalled();
    const fontIntent = await fixture(); fontIntent.loaded.payload.fontBindings[0].fontSha256 = sha256Canonical("newly-declared-wrong-face");
    fontIntent.loaded.source = sourceMetadata(fontIntent.loaded.payload);
    fontIntent.set.sources[0].authoringSource = structuredClone(fontIntent.loaded.source); reseal(fontIntent.set.sources[0]);
    await expect(verifyCurrentOriginalMotionEvidence(fontIntent.plan, fontIntent.project)).rejects.toThrow(/font intent/);
    expect(files.provider).not.toHaveBeenCalled();
  });

  it("does not accept a correctly resealed forged contour-layout digest after current-file checks", async () => {
    const f = await fixture(), evidence = f.set.sources[0], previousSha = evidence.sourceSha256;
    evidence.graphicBindings[0].layoutSha256 = sha256Canonical("unobserved-contours"); reseal(evidence);
    const replace = (reference: string) => reference.replace(`original:${previousSha}:`, `original:${evidence.sourceSha256}:`);
    for (const event of f.editorial.graphics) event.evidenceRefs = event.evidenceRefs.map(replace);
    for (const beat of f.editorial.narrative.beats) beat.evidenceRefs = beat.evidenceRefs.map(replace);
    await expect(verifyCurrentOriginalMotionEvidence(f.plan, f.project)).rejects.toThrow(/recompiled source\/layout\/font\/safety identities/);
    expect(files.read).toHaveBeenCalledTimes(2); expect(files.provider).toHaveBeenCalledTimes(1);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import type { SpringTargetTrack } from "../domain/motionContinuity";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { canonicalJson } from "../shared/canonicalJson";
import { createOriginalMotionRenderBindingVerifier, type OriginalMotionRenderBindingExpected } from "./originalMotionRenderBinding";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const track = (value: number): SpringTargetTrack => ({ fps: 30, initialPosition: value, initialTarget: value,
  initialVelocity: 0, spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] });

/** Controlled authority unit fixture only. No actual disk/HMAC/apply/output claim. */
function fixture() {
  const project = createEmptyProject("Complete original source binding fixture", { id: "original-sequence", width: 1080, height: 1920, fps: 30 });
  project.revision = 2;
  const graphic = createMotionGraphic("same-object", "card", "", 0, 18, undefined, findMotionGraphicPreset("reel_native_disc").seed);
  graphic.x = .3; graphic.y = .45; graphic.width = .25;
  if (!graphic.vectorV2) throw new Error("Actual original vector preset required");
  graphic.vectorV2.heightPixels = 120;
  project.motionGraphics = [graphic];
  project.motionScenes = [{ schema: "editkin.motion-scene-2d/v1", id: "original-scene", startFrame: 0, durationFrames: 540, fps: 30,
    graphicIds: [graphic.id], camera: { centerX: track(540), centerY: track(960), zoom: track(1) },
    safeArea: { left: 48, right: 48, top: 72, bottom: 72 }, semanticCues: [
      { id: "opening", frame: 0, purpose: "Introduce the original object", graphicIds: [graphic.id], evidenceRefs: ["authoring:opening"] },
      { id: "focus", frame: 180, purpose: "Focus the same object", graphicIds: [graphic.id], evidenceRefs: ["authoring:focus"] },
      { id: "closing", frame: 360, purpose: "Close the complete sequence", graphicIds: [graphic.id], evidenceRefs: ["authoring:closing"] },
    ] }];
  validateProject(project);
  const projectIdentity = { id: project.id, revision: project.revision, pathSha256: sha("owned-original.editkin.json"), contentSha256: sha(project) };
  const expected: OriginalMotionRenderBindingExpected = { planSha256: sha("controlled-plan"), projectIdentity, project,
    originalSourceEvidenceSha256: sha("controlled-original-evidence") };
  const receipt = { schema: "hao.video-autopilot.execution-receipt/v1", state: "committed", receiptId: "controlled-commit",
    planSchema: "hao.video-autopilot.edit-plan/v4", planSha256: expected.planSha256,
    projectRevisionBefore: 1, projectRevisionAfter: 2, projectIdentityAfter: { ...projectIdentity },
    originalMotionBinding: { schema: "editkin.original-motion-render-binding/v1",
      originalSourceEvidenceSha256: expected.originalSourceEvidenceSha256,
      sceneProjectSha256: sha({ motionScenes: project.motionScenes, motionGraphics: project.motionGraphics }), renderContentSha256: sha(project) },
    quality: { inputState: "editable", outputState: "review_required", certified: false },
    createdAt: "2026-10-01T00:00:00.000Z", committedAt: "2026-10-01T00:00:01.000Z",
    // The projection permits actual upstream fields; none can act as caller proof.
    source: { fixture: true }, audit: { fixture: true }, issuerSeal: "authority owns authentication" };
  let reads = 0;
  const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt(identity, plan) {
    reads++; expect(identity).toEqual(projectIdentity); expect(plan).toBe(expected.planSha256);
    expect(Object.isFrozen(identity)).toBe(true); return receipt;
  } });
  return { project, expected, receipt, verifier, reads: () => reads };
}

describe("original Motion committed render binding (controlled authority, no actual issuer IO proof)", () => {
  it("reads only its injected authority and binds the full saved 540-frame scene without certifying output", async () => {
    const f = fixture(), check = await f.verifier.verify(f.expected);
    expect(f.reads()).toBe(1);
    expect(check.executionReceiptId).toBe(f.receipt.receiptId);
    expect(check.originalMotionBinding).toEqual(f.receipt.originalMotionBinding);
    expect(check.projectIdentity).toEqual(f.expected.projectIdentity);
    expect(check.qualityCertified).toBe(false);
    expect(Object.isFrozen(check)).toBe(true); expect(Object.isFrozen(check.originalMotionBinding)).toBe(true);
    expect(f.project.assets).toEqual([]); expect(f.project.tracks.flatMap(value => value.clips)).toEqual([]);
    expect(f.project.motionScenes![0].durationFrames).toBe(540);
  });

  it("refuses caller receipt/proof fields before consulting authority and propagates failed authentication", async () => {
    const f = fixture();
    await expect(f.verifier.verify({ ...f.expected, receipt: f.receipt } as OriginalMotionRenderBindingExpected)).rejects.toThrow(/caller receipt/);
    await expect(f.verifier.verify({ ...f.expected, issuerProof: "forged" } as OriginalMotionRenderBindingExpected)).rejects.toThrow(/caller receipt/);
    expect(f.reads()).toBe(0);
    const denied = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() { throw new Error("current-process issuer seal rejected"); } });
    await expect(denied.verify(f.expected)).rejects.toThrow(/issuer seal rejected/);
    expect(() => createOriginalMotionRenderBindingVerifier({} as never)).toThrow(/authenticated/);
  });

  it("reports a verified persistent authority using a distinct closed v2 render binding", async () => {
    const f = fixture();
    const sealedProjection = { schema: "editkin.original-motion-commit-seal/v2", scope: "protected_user",
      keyId: "a".repeat(64), protection: "windows_dpapi_current_user" };
    (f.receipt as { issuerSeal: unknown }).issuerSeal = sealedProjection;
    // This remains a controlled trusted-reader fixture, not an OS authentication
    // or rendered artifact. Its purpose is the exact versioned output contract.
    const check = await f.verifier.verify(f.expected);
    expect(check.schema).toBe("editkin.original-motion-render-binding-check/v2");
    expect(check.scope).toBe("protected-user-authenticated-commit");
    if (check.schema !== "editkin.original-motion-render-binding-check/v2") throw new Error("Expected v2 binding");
    expect(check.authority).toEqual({ keyId: sealedProjection.keyId, protection: sealedProjection.protection });
    expect(Object.isFrozen(check.authority)).toBe(true); expect(check.qualityCertified).toBe(false);
    for (const patch of [{ keyId: "bad" }, { protection: "caller_key" }, { scope: "workspace" }]) {
      (f.receipt as { issuerSeal: unknown }).issuerSeal = { ...sealedProjection, ...patch };
      await expect(f.verifier.verify(f.expected)).rejects.toThrow();
    }
  });

  it("rejects missing/pending/legacy receipts and missing or malformed original binding", async () => {
    const f = fixture();
    for (const receipt of [undefined, { ...f.receipt, state: "pending" }, { ...f.receipt, planSchema: "hao.video-autopilot.edit-plan/v3" },
      { ...f.receipt, originalMotionBinding: undefined }, { ...f.receipt, originalMotionBinding: { ...f.receipt.originalMotionBinding, sceneProjectSha256: "bad" } }]) {
      const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() { return receipt; } });
      await expect(verifier.verify(f.expected)).rejects.toThrow();
    }
  });

  it("rejects wrong plan, source evidence, scene object and full project-content hashes independently", async () => {
    const f = fixture();
    const patches = [ { ...f.receipt, planSha256: sha("other-plan") },
      ...(["originalSourceEvidenceSha256", "sceneProjectSha256", "renderContentSha256"] as const).map(key => ({ ...f.receipt,
        originalMotionBinding: { ...f.receipt.originalMotionBinding, [key]: sha("other-value") } })) ];
    for (const receipt of patches) {
      const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() { return receipt; } });
      await expect(verifier.verify(f.expected)).rejects.toThrow(/plan|source evidence|scene objects|content hash/);
    }
  });

  it("rejects all post-commit identity fields, non-atomic revision and invalid chronology", async () => {
    const f = fixture();
    for (const projectIdentityAfter of [{ ...f.receipt.projectIdentityAfter, id: "other-project" },
      { ...f.receipt.projectIdentityAfter, revision: 3 }, { ...f.receipt.projectIdentityAfter, pathSha256: sha("other-path") },
      { ...f.receipt.projectIdentityAfter, contentSha256: sha("other-content") }]) {
      const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() { return { ...f.receipt, projectIdentityAfter }; } });
      await expect(verifier.verify(f.expected)).rejects.toThrow(/identity\/revision\/content/);
    }
    for (const receipt of [{ ...f.receipt, projectRevisionBefore: 0 }, { ...f.receipt, projectRevisionAfter: 3 },
      { ...f.receipt, committedAt: "2026-09-30T00:00:00.000Z" }, { ...f.receipt, createdAt: "invalid" }]) {
      const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() { return receipt; } });
      await expect(verifier.verify(f.expected)).rejects.toThrow(/identity\/revision\/content|chronology/);
    }
  });

  it("rejects actual edited scene/cue/camera/graphic bodies even when the caller refreshes its current identity", async () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => { f.project.motionScenes![0].camera.centerX.events = [{ frame: 180, target: 560 }]; },
      (f: ReturnType<typeof fixture>) => { f.project.motionScenes![0].semanticCues[1].purpose = "edited purpose"; },
      (f: ReturnType<typeof fixture>) => { f.project.motionGraphics[0].accentColor = "#123456"; },
    ]) {
      const f = fixture(); edit(f); f.expected.projectIdentity.contentSha256 = sha(f.project);
      await expect(f.verifier.verify(f.expected)).rejects.toThrow(/identity\/revision\/content/);
    }
    const f = fixture(); f.project.name = "edited non-scene content";
    await expect(f.verifier.verify(f.expected)).rejects.toThrow(/current project identity\/revision\/content/);
  });

  it("rejects project/source drift while the real authority read is pending", async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    const verifier = createOriginalMotionRenderBindingVerifier({ readAuthenticatedCommittedReceipt: () => new Promise(resolve => { finish = resolve; }) });
    const pending = verifier.verify(f.expected);
    f.project.motionScenes![0].camera.zoom.events = [{ frame: 180, target: 1.08 }];
    f.expected.projectIdentity.contentSha256 = sha(f.project);
    finish(f.receipt);
    await expect(pending).rejects.toThrow(/changed during authenticated/);
    const f2 = fixture(); let finish2!: (value: unknown) => void;
    const verifier2 = createOriginalMotionRenderBindingVerifier({ readAuthenticatedCommittedReceipt: () => new Promise(resolve => { finish2 = resolve; }) });
    const pending2 = verifier2.verify(f2.expected); f2.expected.originalSourceEvidenceSha256 = sha("new-source"); finish2(f2.receipt);
    await expect(pending2).rejects.toThrow(/changed during authenticated/);
  });

  it("requires actual saved scenes/graphics and never treats an input receipt as a factory authority", async () => {
    const f = fixture();
    for (const clear of [(value: ReturnType<typeof fixture>) => { value.project.motionScenes = []; },
      (value: ReturnType<typeof fixture>) => { value.project.motionGraphics = []; }]) {
      const other = fixture(); clear(other);
      await expect(other.verifier.verify(other.expected)).rejects.toThrow(/current saved scenes and graphics/);
      expect(other.reads()).toBe(0);
    }
    expect(() => createOriginalMotionRenderBindingVerifier(f.receipt as never)).toThrow(/authenticated/);
  });
});

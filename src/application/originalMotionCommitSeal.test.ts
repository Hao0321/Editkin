import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import {
  AUTOPILOT_AUDIT_RECEIPT_TTL_MS, autopilotPlanSourceFromIdentity,
  consumeAcceptedAutopilotAuditReceipt, createAcceptedAutopilotAuditReceipt,
  createAutopilotProjectAuditIdentity, readLiveAutopilotIdentity,
  sealAuthenticatedOriginalMotionCommit, sha256Canonical,
  verifyAcceptedAutopilotAuditReceipt, verifyAuthenticatedOriginalMotionCommit,
  type LiveAutopilotIdentity,
} from "./autopilotInvocationIdentity";
import { createOriginalMotionRenderBindingVerifier } from "./originalMotionRenderBinding";
import type { OriginalMotionScene2dInput } from "./originalMotionScene2d";
import {
  originalMaterialEvidenceSchema, prepareOriginalMotionSourceEvidence,
  type OriginalMotionSourceRights, type OriginalMotionSourceSet,
} from "./originalMotionSourceEvidence";

const faceId = "EditkinFace-bebas-neue-400";
const rights: OriginalMotionSourceRights = { origin: "self_authored", medium: "native_vector_and_glyph",
  contentKind: "authored_illustration", realityProof: false, importedReferenceMedia: false,
  declaration: "Original type and focal handoff; no imported reference media or observed reality claim." };
const initial = createEmptyProject("Complete original commit unit fixture", { id: "original-commit-unit", width: 640, height: 360, fps: 30 });
let root: string;
let invocation: LiveAutopilotIdentity;
let prepared: Awaited<ReturnType<typeof prepareOriginalMotionSourceEvidence>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-original-commit-"));
  const skillPath = join(root, "SKILL.md"), plugins = join(root, "plugins");
  await mkdir(plugins);
  await writeFile(skillPath, "---\nname: video-autopilot\n---\n1. Read authored source.\n2. Audit before applying.\n", "utf8");
  await writeFile(join(root, "workflow_contract.json"), JSON.stringify({ schema: "hao.video-autopilot.workflow-contract/v1",
    contract_revision: 6, plan_schema: "hao.video-autopilot.edit-plan/v4", legacy_plan_policy: "reject",
    plan_hash_algorithm: "sha256-canonical-json-utf8-keys-v1" }), "utf8");
  invocation = await readLiveAutopilotIdentity({ skillPath, pluginRoots: [plugins] });
  const input: OriginalMotionScene2dInput = { expectedRevision: initial.revision, sceneId: "complete-original-unit",
    intent: "standalone_showcase", reason: "One original glyph object remains identifiable through an eighteen-second focal handoff",
    startFrame: 0, durationFrames: 540, safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "same-glyph-object", kind: "text", text: "FOCUS", typographyRole: "heading", fontWeight: 400,
      range: { startFrame: 0, endFrame: 540 }, xPixels: 100, yPixels: 80, widthPixels: 430,
      fontSize: 48, minFontSize: 32, maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text" }],
    semanticCues: [{ id: "opening", frame: 0, purpose: "Introduce the same authored object", graphicIds: ["same-glyph-object"], evidenceRefs: ["authoring:opening"] },
      { id: "focus", frame: 180, purpose: "Focus the same authored object", graphicIds: ["same-glyph-object"], evidenceRefs: ["authoring:focus"], focus: { centerX: 330, centerY: 180, zoom: 1.02 } },
      { id: "closing", frame: 360, purpose: "Return focus for the closing hold", graphicIds: ["same-glyph-object"], evidenceRefs: ["authoring:closing"], focus: { centerX: 320, centerY: 180, zoom: 1 } }] };
  const bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)));
  prepared = await prepareOriginalMotionSourceEvidence(initial, input, rights, 0, { prepareText: (face, text) => prepareGlyphRun(face, text, bytes) });
});

afterAll(async () => {
  if (!root) return;
  // Only this suite's generated direct child of the platform temporary root.
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-original-commit-")) throw new Error("Unexpected original commit fixture cleanup path");
  await rm(root, { recursive: true, force: true });
});

function fixture(caseId: string) {
  const project = structuredClone(initial), source: OriginalMotionSourceSet = {
    schema: "editkin.original-motion-source/v1", sources: [structuredClone(prepared.evidence)],
  };
  const projectPath = join(root, "original.editkin.json"), planSha256 = sha256Canonical({ unitCase: caseId });
  const materialEvidence = originalMaterialEvidenceSchema.parse({ ...source, receipts: [] });
  const expected = { planSha256, project: createAutopilotProjectAuditIdentity(projectPath, project),
    invocation: structuredClone(invocation), materialEvidence, originalSourceEvidence: source };
  return { project, projectPath, source, expected };
}

function committedFixture(caseId: string) {
  const f = fixture(caseId), audit = createAcceptedAutopilotAuditReceipt(f.expected);
  verifyAcceptedAutopilotAuditReceipt(audit, f.expected);
  consumeAcceptedAutopilotAuditReceipt(audit);
  const project = applyCommand(f.project, { type: "batch", commands: structuredClone(prepared.preparation.commands) });
  // Unit projection of the atomic result. No disk write/apply or output claim.
  project.revision = f.project.revision + 1;
  validateProject(project);
  const projectIdentity = createAutopilotProjectAuditIdentity(f.projectPath, project), createdAt = new Date(Date.now() - 2_000).toISOString();
  const base = { schema: "hao.video-autopilot.execution-receipt/v1", state: "committed", receiptId: `unit-${caseId}`,
    planSchema: "hao.video-autopilot.edit-plan/v4", planSha256: f.expected.planSha256,
    projectRevisionBefore: f.project.revision, projectRevisionAfter: project.revision, projectIdentityAfter: projectIdentity,
    source: autopilotPlanSourceFromIdentity(f.expected.invocation), audit: { receiptSha256: audit.receiptSha256, auditedAt: audit.auditedAt },
    originalMotionEvidence: f.source, originalMotionBinding: { schema: "editkin.original-motion-render-binding/v1",
      originalSourceEvidenceSha256: sha256Canonical(f.source), sceneProjectSha256: sha256Canonical({ motionScenes: project.motionScenes ?? [], motionGraphics: project.motionGraphics }),
      renderContentSha256: projectIdentity.contentSha256 }, quality: { inputState: "editable", outputState: "review_required", certified: false },
    createdAt, committedAt: new Date(Date.parse(createdAt) + 1_000).toISOString() };
  const signed = sealAuthenticatedOriginalMotionCommit(base);
  const expected = { planSha256: f.expected.planSha256, projectIdentity, project, originalSourceEvidenceSha256: sha256Canonical(f.source) };
  const verifier = createOriginalMotionRenderBindingVerifier({ async readAuthenticatedCommittedReceipt() {
    return verifyAuthenticatedOriginalMotionCommit(signed);
  } });
  return { ...f, project, base, signed, expected, verifier };
}

describe("original Motion typed audit and actual same-process commit seal", () => {
  it("preserves the legacy v1 material hash and canonical receipt base", () => {
    const f = fixture("legacy"), materialEvidence = { schema: "hao.editkin.material-intelligence/v1", receipts: [{ unitOpaqueMaterial: "legacy" }] };
    const { originalSourceEvidence: _original, ...input } = f.expected, expected = { ...input, materialEvidence };
    const receipt = createAcceptedAutopilotAuditReceipt(expected);
    expect(receipt.schema).toBe("hao.video-autopilot.audit-receipt/v1");
    expect(receipt).toHaveProperty("materialEvidenceSha256", sha256Canonical(materialEvidence));
    expect(receipt).not.toHaveProperty("sourceKind"); expect(receipt).not.toHaveProperty("originalSourceEvidenceSha256");
    const { receiptSha256, issuerProof: _proof, ...base } = receipt;
    expect(receiptSha256).toBe(sha256Canonical(base));
    expect(verifyAcceptedAutopilotAuditReceipt(receipt, expected)).toEqual(receipt);
    consumeAcceptedAutopilotAuditReceipt(receipt);
  });

  it("binds true compiled original v2 source without manufacturing a material SHA", () => {
    const f = fixture("pure"), receipt = createAcceptedAutopilotAuditReceipt(f.expected), spec = bundledFontFaceSpec(faceId);
    expect(f.project.assets).toEqual([]); expect(f.project.tracks.flatMap(track => track.clips)).toEqual([]);
    expect(f.source.sources[0].scene.durationFrames).toBe(540);
    expect(f.source.sources[0].graphicBindings[0].physicalFont).toMatchObject({ faceId, fontSha256: spec.sha256, manifestSha256: spec.manifestSha256 });
    expect(f.expected.materialEvidence.receipts).toEqual([]);
    expect(receipt).toMatchObject({ schema: "hao.video-autopilot.audit-receipt/v2", sourceKind: "original_motion_scene",
      originalSourceEvidenceSha256: sha256Canonical(f.source) });
    expect(receipt).not.toHaveProperty("materialEvidenceSha256");
    expect(verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toEqual(receipt);
    consumeAcceptedAutopilotAuditReceipt(receipt);
  });

  it("keeps hybrid v2 original and media hashes distinct and verifies both", () => {
    const f = fixture("hybrid");
    // Opaque unit payload tests only the issuer's source-kind/hash routing;
    // it is never submitted as an actual observed media admission receipt.
    const materialEvidence = { schema: "hao.editkin.material-intelligence/v1", receipts: [{ unitOpaqueMaterial: "hybrid" }] };
    const expected = { ...f.expected, materialEvidence }, receipt = createAcceptedAutopilotAuditReceipt(expected);
    expect(receipt).toMatchObject({ schema: "hao.video-autopilot.audit-receipt/v2", sourceKind: "media_with_authored_overlay",
      originalSourceEvidenceSha256: sha256Canonical(f.source), materialEvidenceSha256: sha256Canonical(materialEvidence) });
    expect(sha256Canonical(f.source)).not.toBe(sha256Canonical(materialEvidence));
    expect(verifyAcceptedAutopilotAuditReceipt(receipt, expected)).toEqual(receipt);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...expected, materialEvidence: { ...materialEvidence, receipts: [] } })).toThrow(/素材語意證據/);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toThrow(/證據|kind/);
    consumeAcceptedAutopilotAuditReceipt(receipt);
  });

  it("rejects source tampering, rehashed forgery, current project and invocation drift", () => {
    const f = fixture("audit-drift"), receipt = createAcceptedAutopilotAuditReceipt(f.expected);
    expect(() => verifyAcceptedAutopilotAuditReceipt({ ...receipt, auditedAt: "2026-01-01T00:00:00.000Z" }, f.expected)).toThrow(/竄改/);
    const { receiptSha256: _old, issuerProof, ...body } = { ...receipt, planSha256: sha256Canonical("forged-plan") };
    expect(() => verifyAcceptedAutopilotAuditReceipt({ ...body, receiptSha256: sha256Canonical(body), issuerProof }, f.expected)).toThrow(/不是由目前/);
    const changedSource = structuredClone(f.source), physicalFont = changedSource.sources[0].graphicBindings[0].physicalFont;
    if (!physicalFont) throw new Error("Actual compiled physical font fixture missing");
    physicalFont.fontSha256 = sha256Canonical("wrong-font-bytes");
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...f.expected, originalSourceEvidence: changedSource })).toThrow(/原創／素材/);
    const changedProject = structuredClone(f.project); changedProject.name += " changed";
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...f.expected,
      project: createAutopilotProjectAuditIdentity(f.projectPath, changedProject) })).toThrow(/專案 revision/);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...f.expected,
      invocation: { ...f.expected.invocation, bindingSha256: sha256Canonical("different-live-invocation") } })).toThrow(/identity/);
    consumeAcceptedAutopilotAuditReceipt(receipt);
  });

  it("enforces the real TTL boundary and consumes each issued audit once", () => {
    const f = fixture("ttl"), now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const receipt = createAcceptedAutopilotAuditReceipt({ ...f.expected, auditedAt: new Date(now).toISOString() });
      clock.mockReturnValue(now + AUTOPILOT_AUDIT_RECEIPT_TTL_MS - 1);
      expect(verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toEqual(receipt);
      clock.mockReturnValue(now + AUTOPILOT_AUDIT_RECEIPT_TTL_MS);
      // The exact boundary prunes expiresAt <= now before the registry lookup.
      // Its replay rejection is distinct from the explicit age check at TTL+1.
      expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toThrow(/有界佇列淘汰，不可重播/);
      expect(() => consumeAcceptedAutopilotAuditReceipt(receipt)).toThrow(/不可重播/);
      clock.mockReturnValue(now + AUTOPILOT_AUDIT_RECEIPT_TTL_MS + 1);
      expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toThrow(/已過期/);
      clock.mockReturnValue(now);
      expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, f.expected)).toThrow(/不可重播/);
      const single = fixture("single-use"), one = createAcceptedAutopilotAuditReceipt(single.expected);
      expect(verifyAcceptedAutopilotAuditReceipt(one, single.expected)).toEqual(one);
      consumeAcceptedAutopilotAuditReceipt(one);
      expect(() => consumeAcceptedAutopilotAuditReceipt(one)).toThrow(/不可重播/);
      expect(() => verifyAcceptedAutopilotAuditReceipt(one, single.expected)).toThrow(/不可重播/);
    } finally { clock.mockRestore(); }
  });

  it("authenticates the actual process seal before current-project render binding checks", async () => {
    const f = committedFixture("sealed-positive"), reopened = JSON.parse(JSON.stringify(f.signed));
    expect(verifyAuthenticatedOriginalMotionCommit(reopened)).toBe(reopened);
    expect(f.signed).toHaveProperty("issuerSeal.scope", "same_process");
    expect(f.signed).toHaveProperty("issuerSeal.receiptSha256", sha256Canonical(f.base));
    expect(() => sealAuthenticatedOriginalMotionCommit(f.signed)).toThrow(/new committed/);
    const check = await f.verifier.verify(f.expected);
    expect(check.scope).toBe("same-process-authenticated-commit"); expect(check.qualityCertified).toBe(false);
    expect(check.projectIdentity.contentSha256).toBe(sha256Canonical(f.project));
    expect(check.originalMotionBinding.sceneProjectSha256).toBe(sha256Canonical({ motionScenes: f.project.motionScenes, motionGraphics: f.project.motionGraphics }));
  });

  it("rejects unsigned, forged and post-seal source/receipt changes without trusting rehashed input", () => {
    const f = committedFixture("seal-forgery"), seal = f.signed.issuerSeal as Record<string, unknown>;
    expect(() => verifyAuthenticatedOriginalMotionCommit(f.base)).toThrow();
    expect(() => sealAuthenticatedOriginalMotionCommit({ ...f.base, state: "pending" })).toThrow(/committed/);
    expect(() => verifyAuthenticatedOriginalMotionCommit({ ...f.signed, issuerSeal: { ...seal, issuerProof: "0".repeat(64) } })).toThrow(/not committed by this process/);
    for (const patch of [{ projectRevisionAfter: f.project.revision + 1 }, { quality: { outputState: "ready", certified: true } }]) {
      expect(() => verifyAuthenticatedOriginalMotionCommit({ ...f.signed, ...patch })).toThrow(/changed|unsigned/);
    }
    const altered = structuredClone(f.base), font = altered.originalMotionEvidence.sources[0].graphicBindings[0].physicalFont;
    if (!font) throw new Error("Actual compiled physical font fixture missing");
    font.fontSha256 = sha256Canonical("forged-current-font");
    expect(() => verifyAuthenticatedOriginalMotionCommit({ ...altered, issuerSeal: seal })).toThrow(/changed|unsigned/);
    expect(() => verifyAuthenticatedOriginalMotionCommit({ ...altered,
      issuerSeal: { ...seal, receiptSha256: sha256Canonical(altered) } })).toThrow(/not committed by this process/);
  });

  it("rejects current camera, font-source and revision drift after a genuine seal", async () => {
    const camera = committedFixture("current-camera");
    camera.project.motionScenes![0].camera.zoom.events = [{ frame: 180, target: 1.03 }];
    camera.expected.projectIdentity = createAutopilotProjectAuditIdentity(camera.projectPath, camera.project);
    await expect(camera.verifier.verify(camera.expected)).rejects.toThrow(/identity\/revision\/content/);
    const font = committedFixture("current-font"), changedSource = structuredClone(font.source), physicalFont = changedSource.sources[0].graphicBindings[0].physicalFont;
    if (!physicalFont) throw new Error("Actual compiled physical font fixture missing");
    physicalFont.manifestSha256 = sha256Canonical("new-compiled-pack");
    font.expected.originalSourceEvidenceSha256 = sha256Canonical(changedSource);
    await expect(font.verifier.verify(font.expected)).rejects.toThrow(/source evidence/);
    const revision = committedFixture("current-revision"); revision.project.revision++;
    revision.expected.projectIdentity = createAutopilotProjectAuditIdentity(revision.projectPath, revision.project);
    await expect(revision.verifier.verify(revision.expected)).rejects.toThrow(/identity\/revision\/content/);
  });
});

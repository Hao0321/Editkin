import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { parseAutopilotPlan, autopilotPlanSha256 } from "../application/autopilotPlan";
import { prepareOriginalMotionSourceEvidence, originalMotionCueEvidenceReference } from "../application/originalMotionSourceEvidence";
import type { OriginalMotionScene2dInput } from "../application/originalMotionScene2d";
import { canonicalJson, createAutopilotProjectAuditIdentity, sha256Canonical, sha256Text } from "../application/autopilotInvocationIdentity";
import { verifyOriginalMotionCommitAuthority, type OriginalMotionCommitAuthorityKey } from "../application/originalMotionCommitAuthority";
import { readProjectFile } from "../application/projectFiles";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";

type CommitFault = "missing-file" | "missing-state" | "pending-state" | "identity" | "filename" | "missing-seal" | "commit-error" | undefined;
const controls = vi.hoisted(() => ({ fault: undefined as CommitFault, originalCalls: 0, blockOriginalBeforeCommit: false, keyUnavailable: false }));

// Only the OS key backend is controlled here; the durable seal, audit and
// project/receipt disk boundaries are real. Separate backend tests exercise OS IO.
vi.mock("../security/userCommitSigningKey", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const syntheticKey = Buffer.alloc(32, 42), keyId = createHash("sha256").update(syntheticKey).digest("hex");
  return {
    prepareUserCommitSigningKey: async () => {
      if (controls.keyUnavailable) throw new Error("Controlled OS signing authority unavailable");
      return { keyId, protection: "posix_owner_only" };
    },
    signUserCommitDigest: async (digest: string, expectedKeyId: string) => {
      if (controls.keyUnavailable || expectedKeyId !== keyId) throw new Error("Controlled signing key missing or changed");
      return { keyId, protection: "posix_owner_only", issuerProof: createHmac("sha256", syntheticKey).update(`original-motion-commit:v2:${digest}`).digest("hex") };
    },
  };
});

// Discovery, recipe compilation and material measurement are controlled at this
// test boundary. Plan parsing, source/issuer/replay guards, command application,
// policy, atomic project/receipt I/O and the original commit seal are real.
vi.mock("../application/autopilotInvocationIdentity", async importOriginal => {
  const actual = await importOriginal<typeof import("../application/autopilotInvocationIdentity")>();
  return { ...actual, readLiveAutopilotIdentity: async () => ({
    schema: "editkin.video-autopilot.live-identity/v1", bindingSha256: "f".repeat(64),
    engine: { schema: "editkin.engine-continuity-pin/v1", sha256: actual.sha256Canonical((await import("../motion/engineContinuity")).EDITKIN_ENGINE_CONTINUITY) },
    skill: { id: "video-autopilot", revision: 183, sha256: "a".repeat(64), hardRuleCount: 1 },
    workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 2, sha256: "b".repeat(64), planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
    knowledge: { schema: "editkin.community-knowledge/v1", revision: 77, packSha256: "c".repeat(64), stableRulesSha256: "d".repeat(64), includedModuleCount: 1, stableRuleCount: 1 },
    plugins: { schema: "editkin.plugin-registry-identity/v1", sha256: "e".repeat(64), pluginCount: 0, diagnosticCount: 0 },
  }) };
});
vi.mock("../plugins/registry", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/registry")>(),
  discoverInstalledPlugins: async () => ({ plugins: [], diagnostics: [] }),
  pluginRegistryIdentity: () => ({ sha256: "e".repeat(64) }),
  installedSkillPackCandidates: () => [],
  resolveSkillCapabilityQueries: () => ({ resolutions: [] }),
  verifyPluginAutomationApplications: () => [],
}));
vi.mock("../plugins/skillPack", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/skillPack")>(),
  verifyEditkinSkillSelectionReceipt: (selection: unknown) => selection,
}));
vi.mock("../plugins/workflowProfileFileStore", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/workflowProfileFileStore")>(),
  readHostWorkflowProfile: async () => ({ profile: {} }), assertSelectionUsesHostWorkflowProfile: () => ({}),
}));
vi.mock("./autopilotDesignTools", async importOriginal => ({ ...await importOriginal<typeof import("./autopilotDesignTools")>(),
  verifyAutopilotDesign: async () => ({ state: "CONTROLLED_DESIGN_BOUNDARY" }),
}));
vi.mock("./originalMotionWorkflow", async importOriginal => ({ ...await importOriginal<typeof import("./originalMotionWorkflow")>(),
  verifyCurrentOriginalMotionEvidence: async (plan: { materialEvidence: { schema: string } }) => {
    if (plan.materialEvidence.schema !== "editkin.original-motion-source/v1") return undefined;
    controls.originalCalls += 1;
    if (controls.blockOriginalBeforeCommit && controls.originalCalls === 3) throw new Error("Controlled original source changed before commit");
    return { state: "CONTROLLED_ORIGINAL_RECOMPILATION_BOUNDARY" };
  },
}));
vi.mock("../application/autopilotMaterialEvidence", async importOriginal => ({ ...await importOriginal<typeof import("../application/autopilotMaterialEvidence")>(),
  verifyCurrentAutopilotMaterialEvidence: async () => ({ receiptCount: 1 }),
}));
vi.mock("../application/autoColorEvidence", async importOriginal => ({ ...await importOriginal<typeof import("../application/autoColorEvidence")>(),
  verifyAutoColorDecisions: async () => ({ state: "NOT_REQUIRED" }),
}));
vi.mock("../application/rotoKeyerAutopilot", async importOriginal => ({ ...await importOriginal<typeof import("../application/rotoKeyerAutopilot")>(),
  verifyRotoKeyerPlanForProject: async () => ({ state: "NOT_REQUIRED" }),
}));
vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, commitAutopilotReceipt: async (pendingPath: string, receipt: Record<string, unknown>, key?: OriginalMotionCommitAuthorityKey) => {
    if (controls.fault === "commit-error") throw new Error("Controlled commit write failed");
    const name = await actual.commitAutopilotReceipt(pendingPath, receipt, key);
    const path = join(dirname(pendingPath), name);
    if (controls.fault === "missing-file") await rm(path);
    else if (controls.fault && controls.fault !== "filename") {
      const persisted = JSON.parse(await readFile(path, "utf8"));
      if (controls.fault === "missing-state") delete persisted.state;
      else if (controls.fault === "pending-state") persisted.state = "pending";
      else if (controls.fault === "identity") persisted.projectIdentityAfter.contentSha256 = "0".repeat(64);
      else if (controls.fault === "missing-seal") delete persisted.issuerSeal;
      await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);
    }
    return controls.fault === "filename" ? `other.${name}` : name;
  } };
});

import { applyAutopilotPlan, auditAutopilotPlan } from "./autopilotTools";
import { createProjectFile, readProject } from "./storage";

const prefix = "editkin-apply-commit-parity-";
const roots: string[] = [];
let priorWorkspace: string | undefined;
let workspace: string;
const projectPath = "parity.editkin.json";
function body(result: { content: { type: string; text: string }[] }) { return JSON.parse(result.content[0].text); }

beforeEach(async () => {
  controls.fault = undefined; controls.originalCalls = 0; controls.blockOriginalBeforeCommit = false; controls.keyUnavailable = false;
  priorWorkspace = process.env.EDITKIN_WORKSPACE;
  // Real temporary path: macOS tmpdir() sits under the /var symlink and Windows runners report 8.3 short names.
  workspace = await mkdtemp(join(await realpath(tmpdir()), prefix)); roots.push(workspace);
  process.env.EDITKIN_WORKSPACE = workspace;
});
afterEach(async () => {
  if (priorWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE;
  else process.env.EDITKIN_WORKSPACE = priorWorkspace;
  for (const created of roots.splice(0)) {
    const target = resolve(created);
    if (dirname(target) !== await realpath(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error("Refuse unowned parity fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
});

async function originalFixture() {
  const before = await createProjectFile(projectPath, "Original receipt parity", 640, 360, 30);
  const input: OriginalMotionScene2dInput = { sceneId: "parity-scene", expectedRevision: before.revision, intent: "standalone_showcase",
    reason: "Keep an original stable panel through three authored camera cues", startFrame: 0, durationFrames: 90,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" }, typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "parity-panel", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 220, yPixels: 140, widthPixels: 120, heightPixels: 70, cornerRadiusPixels: 8, colorRole: "accent" }],
    semanticCues: [0, 35, 70].map((frame, index) => ({ id: `phase-${index}`, frame, purpose: "Authored stable-panel handoff", graphicIds: ["parity-panel"], evidenceRefs: [`brief:phase-${index}`], focus: { centerX: 320 + index, centerY: 180, zoom: 1 } })),
  };
  const rights = { origin: "self_authored" as const, medium: "native_vector_and_glyph" as const, contentKind: "authored_illustration" as const, realityProof: false as const, importedReferenceMedia: false as const, declaration: "Original test illustration with no external media or factual proof" };
  const payload = { schema: "editkin.original-motion-authoring/v1", usage: "standalone", audio: "silent", fps: before.fps, authoring: input, rights, fontBindings: [] };
  const sourcePath = ".editkin/original-sources/parity.json", raw = `${canonicalJson(payload)}\n`;
  await mkdir(join(workspace, ".editkin", "original-sources"), { recursive: true });
  await writeFile(join(workspace, sourcePath), raw);
  const prepared = await prepareOriginalMotionSourceEvidence(before, input, rights, 1, { authoringSource: {
    sourcePath, sourceSha256: sha256Text(raw), sourcePayloadSha256: sha256Canonical(payload), bytes: Buffer.byteLength(raw),
  } });
  const base = createAutopilotV4Fixture();
  const plan = parseAutopilotPlan({ ...base, materialEvidence: { schema: "editkin.original-motion-source/v1", sources: [prepared.evidence], receipts: [] },
    commands: [base.commands[0], ...prepared.preparation.commands], editorial: { ...base.editorial,
      graphics: prepared.preparation.editorialGraphics, transitions: [],
      narrative: { ...base.editorial.narrative, beats: base.editorial.narrative.beats.map((beat, index) => ({ ...beat, range: { startFrame: index * 30, endFrame: (index + 1) * 30 }, evidenceRefs: [originalMotionCueEvidenceReference(prepared.evidence.sourceSha256, `phase-${index}`)] })) },
      audio: { ...base.editorial.audio, mode: "silent_original", layers: [], impactFrames: [], breathFrames: [] },
      color: { ...base.editorial.color, sourceMode: "authored_palette", shotMatchRequired: false },
    } });
  const audit = body(await auditAutopilotPlan(projectPath, plan));
  return { before, plan, audit };
}

describe("atomic Autopilot response and persisted committed receipt", () => {
  it("returns the actual committed state and exact saved identity without claiming certification", async () => {
    const { before, plan, audit } = await originalFixture();
    const response = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
    const saved = await readProjectFile(join(workspace, projectPath));
    const persisted = JSON.parse(await readFile(join(workspace, ".editkin-receipts", response.receipt.receiptFile), "utf8"));
    const { issuerSeal, ...diskProjection } = persisted;
    const { receiptFile, ...responseProjection } = response.receipt;
    expect(responseProjection).toEqual(diskProjection);
    expect(response).toMatchObject({ status: "REVIEW_REQUIRED", receipt: { state: "committed", projectRevisionBefore: before.revision, projectRevisionAfter: before.revision + 1,
      quality: { outputState: "review_required", certified: false }, planSha256: autopilotPlanSha256(plan) } });
    expect(response.receipt.projectIdentityAfter).toEqual(createAutopilotProjectAuditIdentity(join(workspace, projectPath), saved));
    expect(response.receipt.originalMotionBinding.renderContentSha256).toBe(sha256Canonical(saved));
    expect(issuerSeal.scope).toBe("protected_user");
    await expect(verifyOriginalMotionCommitAuthority(persisted)).resolves.toEqual(persisted);
    expect(receiptFile).toBe(`parity.${persisted.receiptId}.committed.json`);
    expect(saved.motionScenes).toHaveLength(1);
    expect(saved.motionGraphics).toHaveLength(1);
    expect(controls.originalCalls).toBe(3);
  });

  it("keeps ordinary media response and physical committed receipt in parity", async () => {
    await writeFile(join(workspace, "owned.mp4"), "Controlled material boundary; not decoded media");
    const before = await createProjectFile(projectPath, "Media receipt parity", 640, 360, 30, [
      { type: "import_asset", asset: { id: "asset-source-1", name: "owned", kind: "video", uri: "owned.mp4", duration: 3 } },
      { type: "add_clip", clip: { id: "clip-source-1", assetId: "asset-source-1", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
    ]);
    const plan = createAutopilotV4Fixture(), audit = body(await auditAutopilotPlan(projectPath, plan));
    const response = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
    const persisted = JSON.parse(await readFile(join(workspace, ".editkin-receipts", response.receipt.receiptFile), "utf8"));
    const { receiptFile: _receiptFile, ...responseProjection } = response.receipt;
    expect(responseProjection).toEqual(persisted);
    expect(persisted.state).toBe("committed");
    expect(persisted.issuerSeal).toBeUndefined();
    expect((await readProject(projectPath)).revision).toBe(before.revision + 1);
  });

  it.each(["missing-file", "missing-state", "pending-state", "identity", "filename", "missing-seal"] as const)("rejects %s after the real commit instead of inventing a successful response", async fault => {
    const { before, plan, audit } = await originalFixture();
    controls.fault = fault;
    const expectedError = fault === "missing-file" ? /ENOENT/
      : fault === "missing-state" || fault === "pending-state" ? /must have committed state/
      : fault === "identity" ? /identity or content/
      : fault === "filename" ? /filename differs/
      : /issuerSeal|unsigned|committed receipt/;
    if (fault === "missing-seal") {
      // The guard parses issuerSeal as the schema root, so absence has path [].
      await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toMatchObject({
        name: "ZodError", issues: [{ code: "invalid_type", expected: "object", path: [] }],
      });
    } else await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow(expectedError);
    // The atomic write happened. A readback error must not claim rollback or
    // invite replay of the consumed audit receipt.
    expect((await readProject(projectPath)).revision).toBe(before.revision + 1);
    await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow(/未簽發|已被套用|不可重播|revision|內容已過期/);
  });

  it("does not return committed state when receipt commit itself fails", async () => {
    const { before, plan, audit } = await originalFixture();
    controls.fault = "commit-error";
    await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow("Controlled commit write failed");
    expect((await readProject(projectPath)).revision).toBe(before.revision + 1);
  });

  it("prepares signing authority before consuming audit or mutating project/receipt files", async () => {
    const { before, plan, audit } = await originalFixture();
    const bytesBefore = await readFile(join(workspace, projectPath));
    controls.keyUnavailable = true;
    await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow("Controlled OS signing authority unavailable");
    expect(await readFile(join(workspace, projectPath))).toEqual(bytesBefore);
    expect((await readProject(projectPath)).revision).toBe(before.revision);
    await expect(readdir(join(workspace, ".editkin-receipts"))).rejects.toMatchObject({ code: "ENOENT" });
    controls.keyUnavailable = false;
    // The exact same audit is still available because preparation failed before
    // the one-use consume boundary. This is not a post-commit replay.
    const result = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect((await readProject(projectPath)).revision).toBe(before.revision + 1);
  });

  it("retains the current original source check at the atomic write boundary", async () => {
    const { before, plan, audit } = await originalFixture();
    controls.blockOriginalBeforeCommit = true;
    await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow("Controlled original source changed before commit");
    expect((await readProject(projectPath)).revision).toBe(before.revision);
  });

  it("rejects a changed audit identity before project persistence", async () => {
    const { before, plan, audit } = await originalFixture();
    const changed = structuredClone(audit.auditReceipt); changed.project.contentSha256 = "0".repeat(64);
    await expect(applyAutopilotPlan(projectPath, plan, changed)).rejects.toThrow(/竄改/);
    expect((await readProject(projectPath)).revision).toBe(before.revision);
  });

  it("rejects replay after a successful commit and leaves the saved project unchanged", async () => {
    const { plan, audit } = await originalFixture();
    await applyAutopilotPlan(projectPath, plan, audit.auditReceipt);
    const saved = await readFile(join(workspace, projectPath));
    await expect(applyAutopilotPlan(projectPath, plan, audit.auditReceipt)).rejects.toThrow(/未簽發|已被套用|不可重播|revision|內容已過期/);
    expect((await readFile(join(workspace, projectPath))).equals(saved)).toBe(true);
  });
});

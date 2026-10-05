import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, findClip } from "../domain/editGraph";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { compactAutopilotContract, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { editorialPlanSchema } from "./editorialPlan";
import { verifyCurrentAutopilotMaterialEvidence, type AutopilotMaterialEvidenceRuntime } from "./autopilotMaterialEvidence";
import { hashMaterialJson, sealMaterialPacket, type MaterialCacheIdentity } from "./materialEvidenceCache";
import { colorDigest } from "./materialColorSamplingRuntime";
import { materialColorRequestSnapshot } from "./materialColorSamplingValidation";
import type { MaterialColorReceipt, MaterialColorRuntimeIdentity } from "./materialColorSamplingTypes";
import { MATERIAL_INTELLIGENCE_SCHEMA, recordMaterialSemantics, type MaterialIntelligencePacket } from "./materialIntelligence";

const controls = vi.hoisted(() => ({ sourcePath: "", beforeCommitDrift: false, probeCalls: 0, cancelAfterMaterial: undefined as AbortController | undefined }));

// Only existing discovery/design/colour/roto suppliers and the media PROBE are
// controlled. Real byte I/O, cache/semantic verification, current plan parsing,
// same-process audit receipts, project commands and the atomic lease stay real.
// Synthetic bytes and frame metadata are not an actual decoded silent video,
// transcript measurement, native MCP launch or artwork acceptance.
vi.mock("./inspectMedia", async original => ({ ...await original<typeof import("./inspectMedia")>(),
  inspectMedia: async (): Promise<MediaProbe> => { controls.probeCalls++; return { duration: 10, hasVideo: true, hasAudio: false }; },
}));
vi.mock("./autopilotInvocationIdentity", async original => {
  const actual = await original<typeof import("./autopilotInvocationIdentity")>();
  return { ...actual, readLiveAutopilotIdentity: async () => ({
    schema: "editkin.video-autopilot.live-identity/v1", bindingSha256: "f".repeat(64),
    engine: { schema: "editkin.engine-continuity-pin/v1", sha256: actual.sha256Canonical((await import("../motion/engineContinuity")).EDITKIN_ENGINE_CONTINUITY) },
    skill: { id: "video-autopilot", revision: 183, sha256: "a".repeat(64), hardRuleCount: 1 },
    workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 6, sha256: "b".repeat(64), planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
    knowledge: { schema: "editkin.community-knowledge/v1", revision: 77, packSha256: "c".repeat(64), stableRulesSha256: "d".repeat(64), includedModuleCount: 1, stableRuleCount: 1 },
    plugins: { schema: "editkin.plugin-registry-identity/v1", sha256: "e".repeat(64), pluginCount: 0, diagnosticCount: 0 },
  }) };
});
vi.mock("../plugins/registry", async original => ({ ...await original<typeof import("../plugins/registry")>(),
  discoverInstalledPlugins: async () => ({ plugins: [], diagnostics: [] }), pluginRegistryIdentity: () => ({ sha256: "e".repeat(64) }),
  installedSkillPackCandidates: () => [], resolveSkillCapabilityQueries: () => ({ resolutions: [] }), verifyPluginAutomationApplications: () => [],
}));
vi.mock("../plugins/skillPack", async original => ({ ...await original<typeof import("../plugins/skillPack")>(), verifyEditkinSkillSelectionReceipt: (selection: unknown) => selection }));
vi.mock("../plugins/workflowProfileFileStore", async original => ({ ...await original<typeof import("../plugins/workflowProfileFileStore")>(), readHostWorkflowProfile: async () => ({ profile: {} }), assertSelectionUsesHostWorkflowProfile: () => ({}) }));
vi.mock("../mcp/autopilotDesignTools", async original => ({ ...await original<typeof import("../mcp/autopilotDesignTools")>(), verifyAutopilotDesign: async () => ({ state: "CONTROLLED_DESIGN_BOUNDARY" }) }));
vi.mock("./autoColorEvidence", async original => ({ ...await original<typeof import("./autoColorEvidence")>(), verifyAutoColorDecisions: async () => {
  controls.cancelAfterMaterial?.abort(new Error("cancelled after material")); return { state: "NOT_REQUIRED" };
} }));
vi.mock("./rotoKeyerAutopilot", async original => ({ ...await original<typeof import("./rotoKeyerAutopilot")>(), verifyRotoKeyerPlanForProject: async () => ({ state: "NOT_REQUIRED" }) }));
vi.mock("../mcp/storage", async original => {
  const actual = await original<typeof import("../mcp/storage")>();
  return { ...actual, writeProject: async (...args: Parameters<typeof actual.writeProject>) => {
    if (controls.beforeCommitDrift) {
      const options = args[3];
      args[3] = { ...options, beforeCommit: async () => {
        await writeFile(controls.sourcePath, "owned silent fixture bytes B");
        await options?.beforeCommit?.();
      } };
    }
    return actual.writeProject(...args);
  } };
});
import { auditAutopilotPlan, applyAutopilotPlan } from "../mcp/autopilotTools";
import { readProject, writeProject } from "../mcp/storage";

const roots: string[] = [];
const prefix = "editkin-silent-source-";
let oldWorkspace: string | undefined, oldCache: string | undefined;
beforeEach(() => {
  controls.beforeCommitDrift = false; controls.probeCalls = 0; controls.cancelAfterMaterial = undefined;
  oldWorkspace = process.env.EDITKIN_WORKSPACE; oldCache = process.env.EDITKIN_CACHE_ROOT;
});
afterEach(async () => {
  if (oldWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = oldWorkspace;
  if (oldCache === undefined) delete process.env.EDITKIN_CACHE_ROOT; else process.env.EDITKIN_CACHE_ROOT = oldCache;
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith(prefix)) throw Error("Unowned fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

const silentAudio: CurrentAutopilotPlan["editorial"]["audio"] = { mode: "silent_media", dialoguePriority: true, blanketWhooshEveryCut: false, layers: [], impactFrames: [], breathFrames: [] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root);
  const sourcePath = join(root, "owned source.mp4"), bytes = Buffer.from("owned silent fixture bytes A");
  await writeFile(sourcePath, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const project = createEmptyProject("Silent byte identity", { id: "silent-project", fps: 30 });
  project.assets.push({ id: "asset-a", name: "Synthetic bytes, controlled probe", kind: "video", uri: sourcePath, duration: 10 });
  project.tracks[0].clips.push({ id: "clip-a", assetId: "asset-a", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 1, duration: 4, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const runtimeBody = { schema: "editkin.material-color-runtime/v1" as const, status: "unmeasured" as const, reason: "synthetic-source-only-fixture", tools: [], implementations: [] };
  const colorRuntime: MaterialColorRuntimeIdentity = { ...runtimeBody, identitySha256: colorDigest(runtimeBody) };
  const sample = { id: "kf-1", time: 0, sceneIndex: 0 };
  const colorBody: Omit<Extract<MaterialColorReceipt, { status: "unmeasured" | "not_applicable" }>, "receiptSha256"> = {
    schema: "editkin.material-color-receipt/v1", status: "unmeasured", reason: "synthetic-source-only-fixture", identity: colorRuntime,
    request: materialColorRequestSnapshot({ sourcePath, sourceSha256: sha, sourceStart: 1, duration: 4, kind: "video", samples: [sample], sceneCount: 1, sceneCountVerified: true, sceneCuts: [] }),
    source: { sha256: sha, start: 1, duration: 4 },
    coverage: { requestedCount: 1, sampledCount: 0, sceneCount: 1, sceneCountVerified: true, sceneAttributionVerified: true, sceneCuts: [], sampledSceneIndices: [], omittedSceneIndices: [0] }, mapping: [],
  };
  // Historical frame-metadata seal is deliberately narrow: the current audio
  // proof is the independent probe plus current bytes, not a revision-4 pixel
  // extraction claim. No decoder, transcript producer or captured art ran.
  const frameBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frameSha = createHash("sha256").update(frameBytes).digest("hex");
  const identity: MaterialCacheIdentity = { schema: MATERIAL_INTELLIGENCE_SCHEMA, engineRevision: 3, assetId: "asset-a", clipId: "clip-a", sourceSha256: sha, sourceStart: 1, duration: 4, fps: 30, kind: "video", language: "en", includeTranscript: false, maxKeyframes: 1, colorRuntime, preparationSha256: "a".repeat(64) };
  const materialId = hashMaterialJson(identity);
  let packet: MaterialIntelligencePacket = sealMaterialPacket({
    schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
    source: { assetId: "asset-a", clipId: "clip-a", sourceSha256: sha, sourceStart: 1, duration: 4, fps: 30, kind: "video", hasAudio: false },
    analysis: { scene: { state: "ready", cuts: [] },
      transcript: { state: "not_applicable", cueCount: 0, cues: [] },
      color: { ...colorBody, receiptSha256: colorDigest(colorBody) },
    }, keyframes: [{ ...sample, sha256: frameSha, bytes: frameBytes.length, mimeType: "image/jpeg", fileName: "frame-01.jpg" }], createdAt: "2026-10-03T00:00:00.000Z",
  }, identity);
  const directory = join(root, "material-intelligence", materialId); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "frame-01.jpg"), frameBytes);
  const save = async (reseal = true) => {
    if (reseal) packet = sealMaterialPacket(packet, identity);
    await writeFile(join(directory, "manifest.json"), JSON.stringify(packet));
  };
  await save();
  const semantic = await recordMaterialSemantics(root, { materialId, sourceSha256: sha, overallTopic: "Synthetic source guard fixture", contentType: "test", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 1, summary: "Declared synthetic frame, not decoded pixels", subjects: [], actions: [], objects: [], importance: .5, evidenceFrameIds: [sample.id], transcriptCueIndexes: [] }],
  });
  const evidence: Extract<CurrentAutopilotPlan["materialEvidence"], { schema: typeof MATERIAL_INTELLIGENCE_SCHEMA }> = { schema: MATERIAL_INTELLIGENCE_SCHEMA,
    receipts: [{ materialId, assetId: "asset-a", clipId: "clip-a", sourceSha256: sha, semanticReceiptSha256: semantic.semanticReceiptSha256 }] };
  const probe = vi.fn(async (): Promise<MediaProbe> => ({ duration: 10, hasAudio: false, hasVideo: true }));
  const runtime: AutopilotMaterialEvidenceRuntime = { cacheRoot: root, resolveSource: vi.fn(async () => sourcePath), inspectMedia: probe };
  const verify = (commands: EditorCommand[] = [], audio = silentAudio) => verifyCurrentAutopilotMaterialEvidence(evidence, project, runtime, [], { audio, commands });
  return { root, sourcePath, bytes, sha, project, identity, materialId, directory, evidence, probe, runtime, get packet() { return packet; }, save, verify };
}

function mediaPlan(): CurrentAutopilotPlan {
  const base = createAutopilotV4Fixture();
  const plan = parseAutopilotPlan({ ...base, source: { ...base.source, workflowContractRevision: 6 }, editorial: { ...base.editorial, audio: structuredClone(silentAudio) } });
  if (plan.schema !== "hao.video-autopilot.edit-plan/v4") throw Error("Expected current fixture");
  return plan;
}
function body(result: { content: { type: string; text: string }[] }) { return JSON.parse(result.content[0].text); }
async function mcpFixture() {
  const f = await fixture(); process.env.EDITKIN_WORKSPACE = f.root; process.env.EDITKIN_CACHE_ROOT = f.root; controls.sourcePath = f.sourcePath;
  await writeProject("silent.editkin.json", f.project, null);
  const plan = parseAutopilotPlan({ ...mediaPlan(), materialEvidence: f.evidence });
  return { ...f, plan, projectPath: "silent.editkin.json" };
}

describe("explicit verified silent media", () => {
  it("accepts zero layers only for explicit silent media while preserving media colour requirements", () => {
    const plan = parseAutopilotPlan(mediaPlan());
    expect(plan.schema).toBe("hao.video-autopilot.edit-plan/v4");
    const invalid = mediaPlan(); invalid.editorial.color.shotMatchRequired = false;
    expect(() => parseAutopilotPlan(invalid)).toThrow(/shot matching/);
    const contract = compactAutopilotContract(); expect(contract.audioExecution.silentMedia.zeroLayersAndAccents).toBe(true);
  });
  it("retains source_layers/omitted layer requirements and silent_original's original-only restriction", () => {
    const p = mediaPlan(); const editorial = p.editorial;
    expect(() => editorialPlanSchema.parse({ ...editorial, audio: { ...silentAudio, mode: "source_layers" } })).toThrow(/actual source layers/);
    expect(() => editorialPlanSchema.parse({ ...editorial, audio: { ...silentAudio, mode: undefined } })).toThrow(/actual source layers/);
    expect(() => parseAutopilotPlan({ ...p, editorial: { ...editorial, audio: { ...silentAudio, mode: "silent_original" } } })).toThrow(/Media plans retain/);
    expect(() => editorialPlanSchema.parse({ ...editorial, audio: { ...silentAudio, mode: "silent_original", impactFrames: [0] } })).toThrow(/Silent original/);
  });
  it.each(["layers", "impactFrames", "breathFrames"] as const)("rejects silent_media %s claims", field => {
    const plan = mediaPlan();
    if (field === "layers") plan.editorial.audio.layers.push({ id: "fake", role: "music", purpose: "invented audio", evidenceRefs: ["fake"] });
    else plan.editorial.audio[field].push(0);
    expect(() => parseAutopilotPlan(plan)).toThrow(/Silent media/);
  });
  it("accepts actual sealed/hash-bound bytes with an independent controlled false probe without project mutation", async () => {
    const f = await fixture(), before = JSON.stringify(f.project);
    await expect(f.verify()).resolves.toMatchObject({ receiptCount: 1, silentMedia: { independentlyProbedSourceCount: 1, currentAndPredictedClipCoverage: true, pointInTimeOnly: true } });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(f.sourcePath, undefined); expect(JSON.stringify(f.project)).toBe(before);
  });
  it.each([true, undefined])("rejects a cached false flag when independent probe hasAudio=%s", async value => {
    const f = await fixture(); f.probe.mockImplementation(async () => {
      const probe: MediaProbe = { duration: 10, hasVideo: true, hasAudio: true }; if (value === undefined) Reflect.deleteProperty(probe, "hasAudio"); else probe.hasAudio = value; return probe;
    });
    await expect(f.verify()).rejects.toThrow(/實際來源 probe 並未確認無音訊/);
  });
  it.each([true, undefined])("rejects a sealed cached hasAudio=%s before probing", async value => {
    const f = await fixture(); if (value === undefined) Reflect.deleteProperty(f.packet.source, "hasAudio"); else f.packet.source.hasAudio = value;
    await f.save(); await expect(f.verify()).rejects.toThrow(/完整性封存且明示 hasAudio=false/); expect(f.probe).not.toHaveBeenCalled();
  });
  it("refuses legacy unsealed false evidence and corrupted sealed evidence", async () => {
    const f = await fixture(); delete f.packet.cache; delete f.packet.analysis.color; await f.save(false);
    await expect(f.verify()).rejects.toThrow(/完整性封存且明示/);
    await f.save(); f.packet.source.hasAudio = true; await f.save(false);
    await expect(f.verify()).rejects.toThrow(/完整性驗證失敗/);
  });
  it("rejects manufactured speech/cues even when both cached and independently probed audio are false", async () => {
    const f = await fixture(); f.packet.analysis.transcript = { state: "ready", cueCount: 1, cues: [{ start: 0, end: 1, text: "Invented speech must not enter a silent route" }] };
    await f.save(); await expect(f.verify()).rejects.toThrow(/不能製造逐字稿／語音證據/);
  });
  it("rejects self-consistent semantic transcript indexes without actual no-audio cue evidence", async () => {
    const f = await fixture(), ref = f.evidence.receipts[0];
    const prior = JSON.parse(await readFile(join(f.directory, "semantics", `${ref.semanticReceiptSha256}.json`), "utf8"));
    delete prior.transcriptEvidence; prior.segments[0].transcriptCueIndexes = [0];
    const { semanticReceiptSha256: _hash, createdAt: _date, ...normalized } = prior;
    const sha = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    await writeFile(join(f.directory, "semantics", `${sha}.json`), JSON.stringify({ ...normalized, semanticReceiptSha256: sha, createdAt: "2026-10-03T00:00:00.000Z" }));
    ref.semanticReceiptSha256 = sha; await expect(f.verify()).rejects.toThrow(/語意不能含語音逐字稿證據/);
  });
  it("refuses absent receipts and missing source files", async () => {
    const f = await fixture(); f.evidence.receipts = []; await expect(f.verify()).rejects.toThrow(/缺少素材證據/);
    const g = await fixture(); await rm(g.sourcePath); await expect(g.verify()).rejects.toThrow();
  });
  it("rejects source replacement before analysis or during probe", async () => {
    const f = await fixture(); await writeFile(f.sourcePath, "owned silent fixture bytes B"); await expect(f.verify()).rejects.toThrow(/實際來源 SHA-256/);
    const g = await fixture(); g.probe.mockImplementation(async () => { await writeFile(g.sourcePath, "owned silent fixture bytes B"); return { duration: 10, hasVideo: true, hasAudio: false }; });
    await expect(g.verify()).rejects.toThrow(/probe 期間改變/);
  });
  it("rejects restored-byte/restored-mtime ABA changes throughout the probe interval", async () => {
    const f = await fixture(), before = await stat(f.sourcePath);
    f.probe.mockImplementation(async () => { await writeFile(f.sourcePath, "owned silent fixture bytes B"); await writeFile(f.sourcePath, f.bytes); await utimes(f.sourcePath, before.atime, before.mtime); return { duration: 10, hasVideo: true, hasAudio: false }; });
    await expect(f.verify()).rejects.toThrow(/檔案版本在 probe 期間改變/);
  });
  it("rejects authorized resolver drift and project mutations during awaited probe", async () => {
    const f = await fixture(), alias = join(f.root, "same bytes alias.mp4"); await writeFile(alias, f.bytes);
    let calls = 0; f.runtime.resolveSource = async () => ++calls === 1 ? f.sourcePath : alias;
    await expect(f.verify()).rejects.toThrow(/驗證完成前改變/);
    const g = await fixture(); g.probe.mockImplementation(async () => { g.project.assets[0].uri = alias; return { duration: 10, hasVideo: true, hasAudio: false }; });
    await expect(g.verify()).rejects.toThrow(/專案在素材驗證期間改變/);
  });
  it("accepts harmless split/trim/timeline movement within verified windows and rechecks on the next call", async () => {
    const f = await fixture();
    await expect(f.verify([{ type: "split_clip", clipId: "clip-a", at: 2, newClipId: "split-b" }, { type: "move_clip", clipId: "split-b", timelineStart: 4 }])).resolves.toMatchObject({ silentMedia: { independentlyProbedSourceCount: 1 } });
    await writeFile(f.sourcePath, "owned silent fixture bytes B"); await expect(f.verify()).rejects.toThrow(/實際來源 SHA-256/);
  });
  it("rejects extending source windows and uncovered current clips even on muted tracks", async () => {
    const f = await fixture(); await expect(f.verify([{ type: "add_clip", clip: { ...structuredClone(f.project.tracks[0].clips[0]), id: "outside-window", sourceStart: 0, duration: 4, timelineStart: 4 } }])).rejects.toThrow(/超出已驗證/);
    const g = await fixture(); g.project.assets.push({ id: "unknown", name: "No evidence", uri: g.sourcePath, kind: "video", duration: 10 }); g.project.tracks[0].muted = true;
    g.project.tracks[0].clips.push({ ...structuredClone(g.project.tracks[0].clips[0]), id: "hidden", assetId: "unknown", timelineStart: 4 });
    await expect(g.verify()).rejects.toThrow(/來源未驗證/);
  });
  it("rejects uncovered predicted clips and asset rewrites including deleted-clip hiding", async () => {
    const f = await fixture(); f.project.assets.push({ id: "unknown", name: "Unanalysed asset", uri: f.sourcePath, kind: "video", duration: 10 });
    await expect(f.verify([{ type: "add_clip", clip: { ...structuredClone(f.project.tracks[0].clips[0]), id: "new-unknown", assetId: "unknown", timelineStart: 4 } }])).rejects.toThrow(/來源未驗證/);
    await expect(f.verify([{ type: "delete_clip", clipId: "clip-a" }, { type: "set_asset_color_interpretation", assetId: "asset-a", interpretation: "rec709" }])).rejects.toThrow(/完整 asset identity/);
  });
  it("rejects recursive audio imports and source relinks rather than concealing them in a silent plan", async () => {
    const f = await fixture();
    await expect(f.verify([{ type: "batch", commands: [{ type: "import_asset", asset: { id: "audio", name: "Audio", kind: "audio", uri: f.sourcePath, duration: 10 } }] }])).rejects.toThrow(/不允許匯入/);
    await expect(f.verify([{ type: "relink_asset_source", assetId: "asset-a", sourceUri: f.sourcePath, expectedSourceSha256: f.sha }])).rejects.toThrow(/不允許匯入或改寫/);
  });
  it("rejects composition/frame sequence material and uncovered nested media", async () => {
    const f = await fixture(); f.project.assets[0].compositionId = "virtual-composition"; await expect(f.verify()).rejects.toThrow(/composition/);
    const g = await fixture(); g.probe.mockResolvedValue({ duration: 10, hasVideo: true, hasAudio: false, imageSequence: { schema: "editkin.openexr-sequence/v1", format: "openexr", frameCount: 300, startFrame: 0, lastFrame: 299, timebase: { numerator: 1, denominator: 30 }, sequenceSha256: "a".repeat(64), manifestSha256: "b".repeat(64), previewUri: "preview.png" } });
    await expect(g.verify()).rejects.toThrow(/實際來源 probe/);
    const h = await fixture(); await expect(h.verify([{ type: "precompose_clips", compositionId: "comp-new", assetId: "comp-asset", replacementClipId: "comp-clip", targetTrackId: h.project.tracks[0].id, name: "Nested media", clipIds: ["clip-a"] }])).rejects.toThrow(/composition/);
  });
  it("rejects cancellation before I/O and after a settled probe and bounds one verification lifetime", async () => {
    const f = await fixture(), early = new AbortController(); early.abort(new Error("cancel-before-source")); f.runtime.signal = early.signal;
    await expect(f.verify()).rejects.toThrow("cancel-before-source"); expect(f.probe).not.toHaveBeenCalled();
    const g = await fixture(), late = new AbortController(); g.runtime.signal = late.signal; g.probe.mockImplementation(async () => { late.abort(new Error("cancel-after-probe")); return { duration: 10, hasVideo: true, hasAudio: false }; });
    await expect(g.verify()).rejects.toThrow("cancel-after-probe");
    const h = await fixture(); h.runtime.timeoutMs = 1; h.probe.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { duration: 10, hasVideo: true, hasAudio: false }; });
    await expect(h.verify()).rejects.toThrow(/驗證逾時/);
  });
  it("preserves ordinary legacy verification without requiring a silence probe", async () => {
    const f = await fixture(); delete f.packet.cache; delete f.packet.analysis.color; f.packet.source.hasAudio = true; await f.save(false);
    await expect(verifyCurrentAutopilotMaterialEvidence(f.evidence, f.project, f.runtime)).resolves.toEqual({ receiptCount: 1, materialIds: [f.materialId] }); expect(f.probe).not.toHaveBeenCalled();
  });
  it("uses the real shared guard at audit/apply/precommit and commits only review_required", async () => {
    const f = await mcpFixture(); const audit = body(await auditAutopilotPlan(f.projectPath, f.plan));
    expect(audit.status).toBe("ACCEPTED"); const result = body(await applyAutopilotPlan(f.projectPath, f.plan, audit.auditReceipt));
    expect(result.receipt.quality.outputState).toBe("review_required"); expect(controls.probeCalls).toBe(3);
    expect((await readProject(f.projectPath)).assets[0].uri).toBe(f.sourcePath);
  });
  it("rejects bytes changed inside the actual atomic beforeCommit callback with zero project commit", async () => {
    const f = await mcpFixture(), audit = body(await auditAutopilotPlan(f.projectPath, f.plan)); const before = await readFile(join(f.root, f.projectPath));
    controls.beforeCommitDrift = true; await expect(applyAutopilotPlan(f.projectPath, f.plan, audit.auditReceipt)).rejects.toThrow(/實際來源 SHA-256/);
    expect(await readFile(join(f.root, f.projectPath))).toEqual(before); expect(findClip(await readProject(f.projectPath), "clip-a").sourceStart).toBe(1);
  });
  it("does not issue an audit receipt after cancellation in a later dependency", async () => {
    const f = await mcpFixture(), signal = new AbortController(); controls.cancelAfterMaterial = signal;
    await expect(auditAutopilotPlan(f.projectPath, f.plan, signal.signal)).rejects.toThrow("cancelled after material");
  });
});

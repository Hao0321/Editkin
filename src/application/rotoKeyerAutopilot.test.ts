import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMA_KEY_PRESETS } from "../domain/chromaKey";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createEmptyProject } from "../domain/editGraph";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { parseAutopilotPlan } from "./autopilotPlan";
import {
  ROTO_KEYER_CAPABILITY_SCHEMA,
  ROTO_KEYER_CONTRACT_REVISION,
  ROTO_KEYER_EVIDENCE_SCHEMA,
  ROTO_KEYER_PLAN_SCHEMA,
  assertRotoKeyerMaterialEvidenceBinding,
  assertRotoKeyerPlanCommandBinding,
  buildRotoKeyerDecision,
  inspectRotoKeyerCapabilities,
  rotoKeyerSha256,
  type RotoKeyerCapabilitySnapshot,
  type RotoKeyerEvidenceReceipt,
} from "./rotoKeyerAutopilot";

function clip(id = "clip-source-1"): TimelineClip {
  return {
    id, assetId: "asset-source-1", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

function project(): EditProject {
  const value = createEmptyProject("Roto Keyer", { id: "roto-keyer-project", width: 640, height: 360, fps: 30 });
  value.assets.push({ id: "asset-source-1", name: "Plate", kind: "video", uri: "plate.mp4", duration: 3, width: 640, height: 360 });
  value.tracks[0].clips.push(clip());
  return value;
}

function evidence(screen: "none" | "green" | "blue" | "ambiguous", confidence = .92): RotoKeyerEvidenceReceipt {
  const base = {
    schema: ROTO_KEYER_EVIDENCE_SCHEMA,
    materialId: "c".repeat(64), sourceSha256: "d".repeat(64), semanticReceiptSha256: "e".repeat(64),
    assetId: "asset-source-1", clipId: "clip-source-1",
    observation: {
      subjectPresence: "single" as const, screen, screenCoverage: screen === "none" ? 0 : .62,
      edgeClass: "hair_or_fur" as const, confidence, evidenceFrameIds: ["kf-1", "kf-2"],
      ...(screen === "ambiguous" || confidence < .75 ? { uncertainty: "幕色或判讀信心不足" } : {}),
      note: "已查看開頭與結尾關鍵幀，主體與背景狀態一致。",
    },
    evidenceFrames: [
      { id: "kf-1", sha256: "1".repeat(64), time: 0 },
      { id: "kf-2", sha256: "2".repeat(64), time: 2.9 },
    ],
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  return { ...base, receiptSha256: rotoKeyerSha256(base) };
}

function capability(autoAvailable = true): RotoKeyerCapabilitySnapshot {
  const base = {
    schema: ROTO_KEYER_CAPABILITY_SCHEMA,
    contractRevision: ROTO_KEYER_CONTRACT_REVISION,
    routes: [
      { route: "no_op", engine: "none", available: true, productEligible: true, qualityState: "not_applicable", rights: "not_applicable", reasonCode: "explicit-no-op" },
      { route: "manual_mask", engine: "editkin-editgraph-manual-mask/v1", available: true, productEligible: true, qualityState: "editable", rights: "editkin-owned", reasonCode: "editable-manual-mask" },
      { route: "self_authored_auto_roto", engine: "editkin-native-color-temporal-roto/v1", available: autoAvailable, productEligible: autoAvailable, qualityState: "diagnostic", rights: "editkin-owned", reasonCode: autoAvailable ? "ready" : "unavailable" },
      { route: "self_authored_screen_keyer", engine: "editkin-chroma-distance-keyer/v1", available: true, productEligible: true, qualityState: "unmeasured", rights: "editkin-owned", reasonCode: "ready" },
    ],
    runtime: {
      nativeCore: { available: autoAvailable, productAttested: autoAvailable, reasonCode: autoAvailable ? "product-manifest-attested" : "runtime-unavailable" },
      ffmpeg: { available: autoAvailable, productAttested: autoAvailable, reasonCode: autoAvailable ? "product-manifest-attested" : "runtime-unavailable" },
    },
    productEngineAdmission: {
      mode: "closed_world_route_enum",
      editkinOwnedOnly: true,
      externalModelPacksAllowed: false,
      researchRoutesAllowed: false,
    },
  } as Omit<RotoKeyerCapabilitySnapshot, "snapshotSha256">;
  return { ...base, snapshotSha256: rotoKeyerSha256(base) };
}

describe("Video Autopilot Roto/Keyer closed-world plan", () => {
  it("does not admit arbitrary existing executables as an Editkin-owned product runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-roto-runtime-red-"));
    try {
      const nativeCorePath = join(root, "hao-core.exe");
      const ffmpegPath = join(root, "ffmpeg.exe");
      await Promise.all([writeFile(nativeCorePath, "external-native"), writeFile(ffmpegPath, "external-ffmpeg")]);
      const snapshot = await inspectRotoKeyerCapabilities({ nativeCorePath, ffmpegPath, cacheRoot: join(root, "cache") });
      const route = snapshot.routes.find((candidate) => candidate.route === "self_authored_auto_roto")!;
      expect(route).toMatchObject({ available: false, productEligible: false });
      expect(snapshot.runtime.nativeCore).toMatchObject({ available: true, productAttested: false });
      expect(snapshot.runtime.ffmpeg).toMatchObject({ available: true, productAttested: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rehashes executable bytes even when a replacement preserves size and mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-roto-runtime-cache-red-"));
    try {
      const nativeCorePath = join(root, "hao-core.exe");
      const ffmpegPath = join(root, "ffmpeg.exe");
      await Promise.all([writeFile(nativeCorePath, "AAAA"), writeFile(ffmpegPath, "FFFF")]);
      const fixedTime = new Date("2026-08-01T00:00:00.000Z");
      await utimes(nativeCorePath, fixedTime, fixedTime);
      const beforeInfo = await stat(nativeCorePath);
      const before = await inspectRotoKeyerCapabilities({ nativeCorePath, ffmpegPath, cacheRoot: join(root, "cache") });
      await writeFile(nativeCorePath, "BBBB");
      await utimes(nativeCorePath, beforeInfo.atime, beforeInfo.mtime);
      const after = await inspectRotoKeyerCapabilities({ nativeCorePath, ffmpegPath, cacheRoot: join(root, "cache") });
      expect(after.runtime.nativeCore.sha256).not.toBe(before.runtime.nativeCore.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds explicit green-screen evidence to one exact editable command and current v4 plan", async () => {
    const built = await buildRotoKeyerDecision(project(), evidence("green"), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 96,
    });
    const fixture = createAutopilotV4Fixture();
    const plan = {
      ...fixture,
      rotoKeyer: { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] },
      commands: [...fixture.commands, built.command!],
    };
    const parsed = parseAutopilotPlan(plan);
    expect(parsed.schema).toBe("hao.video-autopilot.edit-plan/v4");
    expect("rotoKeyer" in parsed ? parsed.rotoKeyer?.decisions[0] : undefined).toMatchObject({ route: "self_authored_screen_keyer", screen: "green", humanReview: { status: "pending" } });
    expect(parsed.commands).toContainEqual({ type: "set_clip_chroma_key", clipId: "clip-source-1", settings: CHROMA_KEY_PRESETS.green });
  });

  it("requires every Roto/Keyer decision to be covered by the exact v4 semantic material receipt", async () => {
    const built = await buildRotoKeyerDecision(project(), evidence("green"), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 96,
    });
    const rotoKeyer = { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] } as const;
    const exact = [{
      materialId: built.decision.materialId,
      sourceSha256: built.decision.sourceSha256,
      semanticReceiptSha256: built.decision.semanticReceiptSha256,
      assetId: built.decision.assetId,
      clipId: built.decision.clipId,
    }];
    expect(() => assertRotoKeyerMaterialEvidenceBinding(rotoKeyer, exact)).not.toThrow();
    expect(() => assertRotoKeyerMaterialEvidenceBinding(rotoKeyer, [])).toThrow(/semantic material receipt/);
    expect(() => assertRotoKeyerMaterialEvidenceBinding(rotoKeyer, [{ ...exact[0], semanticReceiptSha256: "0".repeat(64) }])).toThrow(/semantic material receipt/);
  });

  it("rejects implicit keying, wrong-screen evidence and ambiguous/no-screen false keying", async () => {
    const fixture = createAutopilotV4Fixture();
    const command = { type: "set_clip_chroma_key" as const, clipId: "clip-source-1", settings: CHROMA_KEY_PRESETS.green };
    expect(() => parseAutopilotPlan({ ...fixture, commands: [...fixture.commands, command] })).toThrow(/必須綁定/);
    const keyedClip = { ...clip("embedded-keyed"), chromaKey: CHROMA_KEY_PRESETS.green };
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, [{ type: "add_clip", clip: keyedClip }], "review_required", 100)).toThrow(/不可內嵌/);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, [{ type: "add_clip", clip: clip("clean-clip") }], "review_required", 100)).not.toThrow();
    const maskedClip = {
      ...clip("embedded-masked"),
      trackId: "embedded-track",
      masks: [{
        id: "embedded-mask", name: "Embedded mask", kind: "polygon" as const, mode: "add" as const,
        enabled: true, inverted: false, opacity: 1, feather: 0, expansion: 0,
        path: [{ id: "p1", x: .2, y: .2 }, { id: "p2", x: .8, y: .2 }, { id: "p3", x: .5, y: .8 }],
        keyframes: [], refine: { edgeShift: 0, contrast: .5, chatterReduction: .2 },
      }],
    };
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, [{
      type: "add_track",
      track: { id: "embedded-track", name: "Embedded", kind: "video", locked: false, muted: false, clips: [maskedClip] },
    }], "review_required", 100)).toThrow(/不可內嵌/);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, [{
      type: "add_track",
      track: { id: "clean-track", name: "Clean", kind: "video", locked: false, muted: false, clips: [{ ...clip("clean-track-clip"), trackId: "clean-track" }] },
    }], "review_required", 100)).not.toThrow();
    await expect(buildRotoKeyerDecision(project(), evidence("blue"), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80,
    })).rejects.toThrow(/同色/);
    await expect(buildRotoKeyerDecision(project(), evidence("ambiguous", .7), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80,
    })).rejects.toThrow(/高信心/);
    await expect(buildRotoKeyerDecision(project(), evidence("none"), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80,
    })).rejects.toThrow(/同色/);
  });

  it("keeps no-op explicit and command-free", async () => {
    const built = await buildRotoKeyerDecision(project(), evidence("ambiguous", .7), capability(), {
      route: "no_op", decisionContextTokens: 48,
    });
    expect(built.command).toBeUndefined();
    expect(() => assertRotoKeyerPlanCommandBinding(
      { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] }, [], "review_required", 48,
    )).not.toThrow();
  });

  it("binds a manual mask command but rejects a hidden pixel matte", async () => {
    const manual = {
      type: "add_clip_mask" as const,
      clipId: "clip-source-1",
      mask: {
        id: "manual-subject", name: "Manual subject", kind: "polygon" as const, mode: "add" as const,
        enabled: true, inverted: false, opacity: 1, feather: .02, expansion: 0,
        path: [{ id: "p1", x: .2, y: .2 }, { id: "p2", x: .8, y: .2 }, { id: "p3", x: .5, y: .8 }],
        keyframes: [], refine: { edgeShift: 0, contrast: .5, chatterReduction: .2 },
      },
    };
    const built = await buildRotoKeyerDecision(project(), evidence("ambiguous", .7), capability(), {
      route: "manual_mask", decisionContextTokens: 72, command: manual,
    });
    expect(() => assertRotoKeyerPlanCommandBinding(
      { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] }, [manual], "review_required", 100,
    )).not.toThrow();
    const hiddenMatte = structuredClone(manual) as typeof manual & { mask: { matteSequence?: unknown } };
    hiddenMatte.mask.matteSequence = { engine: "editkin-native-color-temporal-roto/v1" };
    expect(() => assertRotoKeyerPlanCommandBinding(
      { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] }, [hiddenMatte as never], "review_required", 100,
    )).toThrow();
  });

  it("rejects forged receipts, stale exact commands, external routes, capability gaps and review bypass", async () => {
    const built = await buildRotoKeyerDecision(project(), evidence("green"), capability(), {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 96,
    });
    const plan = { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [built.decision] };
    expect(() => assertRotoKeyerPlanCommandBinding({ ...plan, decisions: [{ ...built.decision, decisionSha256: "f".repeat(64) }] }, [built.command!], "review_required", 100)).toThrow(/竄改/);
    expect(() => assertRotoKeyerPlanCommandBinding(plan, [{ ...(built.command as Extract<typeof built.command, { type: "set_clip_chroma_key" }>), settings: CHROMA_KEY_PRESETS.blue }], "review_required", 100)).toThrow(/exact editable command/);
    expect(() => assertRotoKeyerPlanCommandBinding(plan, [built.command!], "machine_checked", 100)).toThrow(/review_required/);
    expect(() => assertRotoKeyerPlanCommandBinding(plan, [built.command!], "review_required", 80)).toThrow(/Token/);
    expect(() => parseAutopilotPlan({
      ...createAutopilotV4Fixture(),
      rotoKeyer: { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [{ ...built.decision, engine: "editkin-sam21-video-memory-roto/v1", route: "research" }] },
      commands: [...createAutopilotV4Fixture().commands, built.command!],
    })).toThrow();
    const unavailable = capability();
    unavailable.routes = unavailable.routes.map((route) => route.route === "self_authored_screen_keyer" ? { ...route, available: false } : route);
    await expect(buildRotoKeyerDecision(project(), evidence("green"), unavailable, {
      route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 96,
    })).rejects.toThrow(/unavailable/);
  });
});

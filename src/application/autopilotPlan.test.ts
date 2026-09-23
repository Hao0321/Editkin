import { describe, expect, it } from "vitest";
import { assertAutopilotProjectTimelineBinding, AUTOPILOT_MAX_PLAN_BYTES, AUTOPILOT_PLAN_SCHEMA, AUTOPILOT_PLAN_SCHEMA_V1, autopilotPlanCoverage, autopilotPlanSha256, compactAutopilotContract, parseAutopilotPlan } from "./autopilotPlan";
import { createAutopilotV2Fixture, createAutopilotV3Fixture, createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";

describe("video-autopilot plan contract", () => {
  it("publishes the closed-world Roto/Keyer planning tool IDs without exposing research routes", () => {
    expect(compactAutopilotContract().rotoKeyerAutomation).toMatchObject({
      inspect: "inspect_roto_keyer_capabilities",
      evidence: "record_roto_keyer_evidence",
      bindManualNoOpOrKeyer: "build_autopilot_roto_keyer_decision",
      prepareSelfAuthoredAutoRoto: "prepare_autopilot_auto_roto",
      routes: ["no_op", "manual_mask", "self_authored_auto_roto", "self_authored_screen_keyer"],
    });
  });
  it("accepts a bounded v4 evidence-bound editorial plan and produces a stable receipt hash", () => {
    const parsed = parseAutopilotPlan(createAutopilotV4Fixture());
    expect(parsed.budget.selectedMemoryRuleIds).toHaveLength(2);
    expect(autopilotPlanSha256(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(autopilotPlanCoverage(parsed).level).toBe("current_multimodal_editorial_contract");
  });

  it("keeps v2 and v1 as explicit legacy layers, never current parity", () => {
    expect(autopilotPlanCoverage(parseAutopilotPlan(createAutopilotV2Fixture())).level).toBe("legacy_editorial_compatibility_only");
    const current = createAutopilotV4Fixture();
    const legacy = {
      schema: AUTOPILOT_PLAN_SCHEMA_V1,
      source: { skillId: "video-autopilot", revision: current.source.revision, skillSha256: current.source.skillSha256 },
      route: current.route,
      budget: current.budget,
      assurances: current.assurances,
      quality: current.quality,
      commands: current.commands,
    };
    expect(autopilotPlanCoverage(parseAutopilotPlan(legacy)).level).toBe("legacy_compatibility_only");
  });

  it("rejects context overflow and duplicate memory injection", () => {
    const plan = createAutopilotV4Fixture();
    expect(() => parseAutopilotPlan({ ...plan, budget: { ...plan.budget, contextTokens: 1_101 } })).toThrow();
    expect(() => parseAutopilotPlan({ ...plan, budget: { ...plan.budget, selectedMemoryRuleIds: ["M117", "M117"] } })).toThrow(/重複/);
    expect(() => parseAutopilotPlan({
      ...plan,
      inference: { ...plan.inference, context: { ...plan.inference.context, packetTokens: plan.budget.contextTokens - 1 } },
    })).toThrow(/budget.*receipt/i);
    expect(() => parseAutopilotPlan({ ...plan, padding: "x".repeat(AUTOPILOT_MAX_PLAN_BYTES + 1) })).toThrow(/bytes/);
  });

  it("rejects missing build payoff, unmotivated transitions and unsupported certification", () => {
    const plan = createAutopilotV4Fixture();
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, narrative: { ...plan.editorial.narrative, beats: plan.editorial.narrative.beats.slice(0, 2), setupPayoffs: [] } } })).toThrow(/payoff/);
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, transitions: [{ id: "bad-j-cut", atFrame: 30, kind: "j_cut", motivation: "motion", evidenceRefs: ["audio:a"] }] } })).toThrow();
    expect(() => parseAutopilotPlan({ ...plan, quality: { state: "certified_95" } })).toThrow();
  });

  it("requires tracking and matte prerequisites for expensive graphics", () => {
    const plan = createAutopilotV4Fixture();
    const event = { id: "label", presetId: "exp26w2_live_tag", range: { startFrame: 0, endFrame: 20 }, kind: "tracked_value_label", purpose: "proof", message: "速度 100 km/h", evidenceRefs: ["telemetry:speed"] };
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, graphics: [event] } })).toThrow(/trackingId/);
  });

  it("blocks editorial graphics that never become visible native commands", () => {
    const plan = createAutopilotV4Fixture();
    const event = {
      id: "promise-title", presetId: "studio_marker_burst", range: { startFrame: 0, endFrame: 45 }, kind: "title_card", purpose: "stakes",
      message: "正版 vs 仿冒", evidenceRefs: ["material:opening"],
    } as const;
    expect(() => parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, graphics: [event] } })).toThrow(/add_motion_graphic/);
  });

  it("lets v4 select the registered planar-tracking preset and rejects a non-fade alias", () => {
    const plan = createAutopilotV4Fixture();
    const event = {
      id: "surface-label", presetId: "surface-track", range: { startFrame: 0, endFrame: 45 },
      kind: "tracked_value_label", purpose: "proof", message: "追蹤證據", evidenceRefs: ["material:subject"], trackingId: "subject-track",
    } as const;
    const preset = findMotionGraphicPreset(event.presetId);
    const graphic = createMotionGraphic(event.id, "tag", event.message, 0, 1.5, event.trackingId, preset.seed);
    const accepted = { ...plan, editorial: { ...plan.editorial, graphics: [event] }, commands: [...plan.commands, { type: "add_motion_graphic" as const, graphic }] };
    expect(() => parseAutopilotPlan(accepted)).not.toThrow();
    expect(() => parseAutopilotPlan({ ...accepted, commands: [...plan.commands, { type: "add_motion_graphic" as const, graphic: { ...graphic, animation: "pop" as const } }] })).toThrow(/未忠實解析 preset/);
  });

  it("carries a registered motion-composition/v2 seed through the v4 preset binding", () => {
    const plan = createAutopilotV4Fixture();
    const event = {
      id: "v2-promise-title", presetId: "v2-word-cascade", range: { startFrame: 0, endFrame: 45 },
      kind: "title_card", purpose: "stakes", message: "ONE TWO THREE", evidenceRefs: ["material:opening"],
    } as const;
    const preset = findMotionGraphicPreset(event.presetId);
    const graphic = createMotionGraphic(event.id, "title", event.message, 0, 1.5, undefined, preset.seed);
    const accepted = { ...plan, editorial: { ...plan.editorial, graphics: [event] }, commands: [...plan.commands, { type: "add_motion_graphic" as const, graphic }] };
    expect(parseAutopilotPlan(accepted).commands).toContainEqual(expect.objectContaining({ type: "add_motion_graphic", graphic: expect.objectContaining({ schema: "hao.motion-composition/v2", presetId: event.presetId }) }));
    const tampered = structuredClone(accepted);
    const command = tampered.commands.find((candidate) => candidate.type === "add_motion_graphic" && candidate.graphic.id === event.id);
    if (command?.type === "add_motion_graphic") command.graphic.motionV2!.sequence.staggerFrames += 1;
    expect(() => parseAutopilotPlan(tampered)).toThrow(/未忠實解析 preset/);
  });

  it("binds an evidence-backed person name and affiliation as one matched lower-third pair", () => {
    const plan = createAutopilotV4Fixture();
    const identityEvidenceRef = `mi:${plan.materialEvidence.receipts[0].materialId}:${plan.materialEvidence.receipts[0].semanticReceiptSha256}:cue:0`;
    const events = [{
      id: "speaker-name", presetId: "lower_third_clean_blue_name", range: { startFrame: 0, endFrame: 45 },
      kind: "lower_third_name", purpose: "identity", message: "王小明", evidenceRefs: [identityEvidenceRef],
    }, {
      id: "speaker-unit", presetId: "lower_third_clean_blue_unit", range: { startFrame: 0, endFrame: 45 },
      kind: "lower_third_affiliation", purpose: "identity", message: "Editkin 創辦人", evidenceRefs: [identityEvidenceRef],
    }] as const;
    const commands = events.map((event) => ({
      type: "add_motion_graphic" as const,
      graphic: createMotionGraphic(
        event.id,
        event.kind === "lower_third_name" ? "card" : "tag",
        event.message,
        event.kind === "lower_third_name" ? 0 : 0.08,
        event.kind === "lower_third_name" ? 1.5 : 1.42,
        undefined,
        findMotionGraphicPreset(event.presetId).seed,
      ),
    }));
    const accepted = { ...plan, editorial: { ...plan.editorial, graphics: events }, commands: [...plan.commands, ...commands] };
    const parsed = parseAutopilotPlan(accepted);
    expect(parsed.schema).toBe(AUTOPILOT_PLAN_SCHEMA);
    if (parsed.schema !== AUTOPILOT_PLAN_SCHEMA) throw new Error("fixture must remain v4");
    expect(() => assertAutopilotProjectTimelineBinding(parsed, 30)).not.toThrow();
    expect(() => parseAutopilotPlan({ ...accepted, editorial: { ...accepted.editorial, graphics: [events[0]] }, commands: [...plan.commands, commands[0]] })).toThrow(/成對出現|一對一/);

    const freeForm = {
      ...accepted,
      editorial: { ...accepted.editorial, graphics: events.map((event) => ({ ...event, evidenceRefs: ["transcript:introduction"] })) },
    };
    expect(() => parseAutopilotPlan(freeForm)).toThrow(/material semantic transcript cue/);

    const madeUp = `mi:${"9".repeat(64)}:${"8".repeat(64)}:cue:0`;
    const uncarried = {
      ...accepted,
      editorial: { ...accepted.editorial, graphics: events.map((event) => ({ ...event, evidenceRefs: [madeUp] })) },
    };
    expect(() => parseAutopilotPlan(uncarried)).toThrow(/沒有解析到 plan 隨附/);

    const mismatchedEvidence = {
      ...accepted,
      editorial: {
        ...accepted.editorial,
        graphics: [events[0], { ...events[1], evidenceRefs: [`mi:${plan.materialEvidence.receipts[0].materialId}:${plan.materialEvidence.receipts[0].semanticReceiptSha256}:cue:1`] }],
      },
    };
    expect(() => parseAutopilotPlan(mismatchedEvidence)).toThrow(/共享同一組/);

    const wrongPurpose = {
      ...accepted,
      editorial: { ...accepted.editorial, graphics: events.map((event, index) => ({ ...event, purpose: index === 0 ? "context" : event.purpose })) },
    };
    expect(() => parseAutopilotPlan(wrongPurpose)).toThrow(/purpose|identity/);

    const rogueCommand = {
      type: "add_motion_graphic" as const,
      graphic: createMotionGraphic("rogue-name", "card", "杜撰人物", 0, 1.5, undefined, findMotionGraphicPreset("lower_third_clean_blue_name").seed),
    };
    expect(() => parseAutopilotPlan({ ...accepted, commands: [...accepted.commands, rogueCommand] })).toThrow(/沒有 evidence-bound editorial identity event/);

    const forgedTiming = structuredClone(parsed);
    for (const command of forgedTiming.commands) {
      if (command.type !== "add_motion_graphic" || !command.graphic.id.startsWith("speaker-")) continue;
      command.graphic.timelineStart = command.graphic.id === "speaker-name" ? 100 : 100.08;
      command.graphic.duration = command.graphic.id === "speaker-name" ? 0.1 : 0.02;
    }
    expect(() => assertAutopilotProjectTimelineBinding(forgedTiming, 30)).toThrow(/沒有忠實對應 editorial frame range/);
  });

  it("requires a visible title and challenge ledger for multi-round gaming shorts", () => {
    const plan = createAutopilotV4Fixture();
    const gaming = {
      ...plan,
      route: { mode: "build", format: "shorts", domain: "gaming" },
      extensions: {
        ...plan.extensions,
        skillSelection: createEmptyEditkinSkillSelectionReceipt(plan.source.pluginRegistrySha256, { format: "shorts", domain: "gaming", semanticRoles: [] }),
      },
      editorial: {
        ...plan.editorial,
        brief: { ...plan.editorial.brief, premise: "正版與仿冒陀螺連打 12 局" },
        delivery: {
          ...plan.editorial.delivery,
          platforms: ["youtube_shorts", "instagram_reels"],
          variants: [{ id: "vertical-main", aspectRatio: "9:16", purpose: "直式主版" }],
        },
      },
    } as const;
    expect(() => parseAutopilotPlan(gaming)).toThrow(/空 graphics/);

    const title = {
      id: "promise-title", presetId: "studio_marker_burst", range: { startFrame: 0, endFrame: 45 }, kind: "title_card", purpose: "stakes",
      message: "正版 vs 仿冒", evidenceRefs: ["material:opening"],
    } as const;
    const ledger = {
      id: "round-ledger", presetId: "exp26w2_score_gauge", range: { startFrame: 0, endFrame: 90 }, kind: "challenge_ledger", purpose: "state_change",
      message: "ROUND 01 / 12", evidenceRefs: ["material:round-01"],
    } as const;
    const graphic = (event: typeof title | typeof ledger) => {
      const preset = findMotionGraphicPreset(event.presetId);
      return createMotionGraphic(event.id, preset.seed.kind ?? "card", event.message, 0, 3, undefined, preset.seed);
    };
    const accepted = {
      ...gaming,
      editorial: { ...gaming.editorial, graphics: [title, ledger] },
      commands: [
        ...gaming.commands,
        { type: "add_motion_graphic", graphic: graphic(title) },
        { type: "add_motion_graphic", graphic: graphic(ledger) },
      ],
    } as const;
    expect(() => parseAutopilotPlan(accepted)).not.toThrow();
    const forged = structuredClone(accepted);
    const forgedGraphic = forged.commands.find((command) => command.type === "add_motion_graphic" && command.graphic.id === title.id);
    if (forgedGraphic?.type === "add_motion_graphic") forgedGraphic.graphic.accentColor = "#000000";
    expect(() => parseAutopilotPlan(forged)).toThrow(/未忠實解析 preset/);
  });

  it("rejects a forged Markdown router identity and an unmeasured direct-apply profile", () => {
    const plan = createAutopilotV4Fixture();
    expect(() => parseAutopilotPlan({ ...plan, inference: { ...plan.inference, context: { ...plan.inference.context, markdownRouterSha256: "f".repeat(64) } } })).toThrow(/router hash/);
    expect(() => parseAutopilotPlan({ ...plan, inference: { ...plan.inference, safeguards: { ...plan.inference.safeguards, executionMode: "direct_apply" } } })).toThrow(/direct_apply/);
  });
});

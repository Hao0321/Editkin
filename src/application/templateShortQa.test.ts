import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commands";
import type { MotionGraphic } from "../domain/types";
import { TEMPLATE_SHORT_FIXTURE_ROLE_MAPS, compileTemplateShortFixture, templateBeatsFromRoleMap } from "./templateShortFixtures";
import type { TemplateShortFamily } from "./templateShortBrief";
import { SHORTS_TEXT_SAFE, analyzeCompiledTemplate, floorOf, textPlacementFindings, templateShortStatus, type TemplateShortQaFinding,
  type TemplateShortQaPacket } from "./templateShortQa";

const compiled = new Map<TemplateShortFamily, ReturnType<typeof compileTemplateShortFixture>>();
const fixture = (family: TemplateShortFamily) => {
  if (!compiled.has(family)) compiled.set(family, compileTemplateShortFixture(family));
  return compiled.get(family)!;
};
const analyze = async (family: TemplateShortFamily, edit?: (packet: TemplateShortQaPacket) => void) => {
  const { project, packet } = await fixture(family), copy = structuredClone(packet);
  edit?.(copy);
  return analyzeCompiledTemplate(copy, templateBeatsFromRoleMap(copy, TEMPLATE_SHORT_FIXTURE_ROLE_MAPS[family], project.fps), project);
};

describe("template short analytic QA on today's trip_pop_v1 compiles", () => {
  it.each(["strike_reframe", "context_stack"] as const)("%s passes Q3/Q4 and the beat coverage: no BLOCK", async family => {
    const { blocks, flags } = await analyze(family);
    expect(blocks).toEqual([]);
    // Every art flag names its seconds (Hao 2026-10-09); place and brand staying past the hook stay FLAG until ROADMAP 1.8.
    for (const flag of flags) {
      expect(flag.severity).toBe("FLAG");
      expect(flag.seconds?.length).toBeGreaterThan(0);
      if (flag.id === "Q11_hook_only") expect(flag.role).toMatch(/^design:(kicker|brand)/);
    }
  }, 60_000);

  it("uses the theme tests' Shorts v2 numbers", () => {
    expect(SHORTS_TEXT_SAFE).toEqual({ left: 40, right: 930, top: 260, bottom: 1660 });
    expect([floorOf("subtitle"), floorOf("subtitle:1"), floorOf("hero:detail"), floorOf("item:0:detail"), floorOf("item:0:label"), floorOf("headline:0")])
      .toEqual([60, 60, 60, 40, 40, 32]);
  });
});

describe("template short analytic QA on synthetic edits", () => {
  it("a 200 px headline at x 960 is a Q3 BLOCK", () => {
    const graphic = { id: "g-headline", text: "其實是來看水簾", fontSize: 200 } as MotionGraphic;
    const packet = { instance: { roles: [{ key: "headline:0", kind: "graphic", id: "g-headline" }] }, commands: [{ type: "add_motion_graphic", graphic }],
      layouts: [{ graphicId: "g-headline", segments: [{ x: 960, y: 700, outline: { ink: { xMin: 4, xMax: 196, yMin: -170, yMax: 20 } } }] }] } as unknown as TemplateShortQaPacket;
    expect(textPlacementFindings(packet, { width: 1080, height: 1920 })).toEqual([{ id: "Q3_safe_area", severity: "BLOCK", role: "headline:0",
      detail: "headline:0「其實是來看水簾」 超出 Shorts 安全區：x964–1156 y530–720；請縮短文案" }]);
    graphic.fontSize = 28;
    (packet.layouts[0].segments[0] as { x: number }).x = 300;
    expect(textPlacementFindings(packet, { width: 1080, height: 1920 }).map(finding => finding.id)).toEqual(["Q4_text_size"]);
  });

  it("a held pose of exactly one frame inside an entrance is a Q8 FLAG at that frame, and a two-frame hold is not", async () => {
    // Two text parts of one role group: A enters over frames 90–99 (linear), B starts at frame 100 and moves from 101.
    const stall = (bStart: number) => (packet: TemplateShortQaPacket) => {
      // The brand and the place line (the chrome texts), whatever order the family draws them in.
      const keyOf = new Map(packet.instance.roles.map(role => [role.id, role.key]));
      const texts = ["design:brand", "design:kicker"].map(key => packet.commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.text
        && keyOf.get(command.graphic.id) === key ? [command.graphic] : [])[0]);
      texts.forEach((graphic, index) => {
        packet.instance.roles.find(role => role.id === graphic.id)!.key = `qa:probe:${index}`;
        graphic.timelineStart = (index === 0 ? 90 : bStart) / 30; graphic.duration = 2;
        graphic.motionV2 = { sequence: { unit: graphic.motionV2!.sequence.unit, order: "forward", exitOrder: "forward", staggerFrames: 0 },
          entrance: { durationFrames: 10, offsetXPixels: 0, offsetYPixels: 40, scale: 1, opacity: 0, easing: { type: "linear" } },
          exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } };
      });
    };
    const held = (await analyze("strike_reframe", stall(100))).flags.filter(flag => flag.id === "Q8_stall");
    expect(held).toEqual([{ id: "Q8_stall", severity: "FLAG", role: "qa:probe", frames: [99], seconds: [3.3], detail: "qa:probe 在動作中停了一格" }]);
    expect((await analyze("strike_reframe", stall(101))).flags.filter(flag => flag.id === "Q8_stall")).toEqual([]);
  }, 60_000);

  it("a media window at 0.2 of the canvas is a Q10 FLAG", async () => {
    const { flags } = await analyze("strike_reframe", packet => {
      const layout = packet.commands.find((command): command is Extract<EditorCommand, { type: "set_clip_layout" }> => command.type === "set_clip_layout")!;
      layout.layout = { ...layout.layout!, viewport: { x: .25, y: .3, width: .5, height: .4 } };
    });
    const share = flags.filter(flag => flag.id === "Q10_footage_share");
    expect(share).toHaveLength(1);
    expect(share[0]).toMatchObject({ severity: "FLAG", role: "source:0:clip", detail: "實拍只佔畫面 20%（至少 35%）" });
  }, 60_000);
});

describe("template short run status (Hao 2026-10-09)", () => {
  const flag: TemplateShortQaFinding = { id: "Q8_stall", severity: "FLAG", role: "tag", frames: [111], seconds: [3.7], detail: "tag 在動作中停了一格" };
  const base = { blocks: [], technical: { pass: true }, flags: [], statusCeiling: "READY", policyMode: "agent_reference_comparison",
    frameObservedNumbers: false, spotCheckDrawn: false } as const;
  it("still delivers an art FLAG as NEEDS_FIX with the seconds to fix", () => {
    expect(templateShortStatus({ ...base, flags: [flag, { ...flag, id: "Q11_hook_only", seconds: [2.53] }, flag] }))
      .toEqual({ status: "NEEDS_FIX", deliver: true, fixSeconds: [2.53, 3.7] });
  });
  it("never delivers a technical failure, and a BLOCK stops before delivery", () => {
    expect(templateShortStatus({ ...base, flags: [flag], technical: { pass: false, failures: ["missing audio stream"] } }))
      .toEqual({ status: "RENDER_FAILED_PROJECT_APPLIED", deliver: false, fixSeconds: [] });
    expect(templateShortStatus({ ...base, blocks: [{ id: "Q3_safe_area", severity: "BLOCK", detail: "x" }] })).toMatchObject({ status: "BLOCK_TEMPLATE_QA", deliver: false });
  });
  it("is REVIEW_REQUIRED for an uncertified pair, a human policy or frame-only numbers; otherwise SPOT_CHECK_DUE or READY", () => {
    expect(templateShortStatus({ ...base, statusCeiling: "REVIEW_REQUIRED" }).status).toBe("REVIEW_REQUIRED");
    expect(templateShortStatus({ ...base, policyMode: "human" }).status).toBe("REVIEW_REQUIRED");
    expect(templateShortStatus({ ...base, frameObservedNumbers: true }).status).toBe("REVIEW_REQUIRED");
    expect(templateShortStatus({ ...base, spotCheckDrawn: true })).toEqual({ status: "SPOT_CHECK_DUE", deliver: true, fixSeconds: [] });
    expect(templateShortStatus(base)).toEqual({ status: "READY", deliver: true, fixSeconds: [] });
  });
});

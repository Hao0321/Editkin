import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EditorCommand } from "../domain/commands";
import { referenceMotionDesignSystems, type ReferenceMotionDesignSystem, type ReferenceMotionTemplateId } from "../motion/referenceMotionTemplates";
import { AUTOPILOT_MAX_COMMANDS, AUTOPILOT_MAX_PLAN_BYTES, parseAutopilotPlan } from "./autopilotPlan";
import { MOTION_TREATMENT_FAMILIES } from "./motionTreatment";
import { REFERENCE_MOTION_BEAT_TABLES, TEMPLATE_BEAT_TEXT_BOUNDS, templateBeatTexts, templateFamilyBeatTable } from "./referenceMotionBeatTables";
import type { ReferenceMotionTemplateBeat } from "./referenceMotionTemplateCommands";
import { TEMPLATE_SHORT_FAMILIES, TEMPLATE_SHORT_COPY_LIMITS, TemplateShortBlockError, templateShortBriefSchema, type TemplateShortCopy } from "./templateShortBrief";
import { TEMPLATE_SHORT_FIXTURE_COPY, TEMPLATE_SHORT_THEME_FIXTURES, compileDesignThemeFixture, compileTemplateShortFixture, templateBeatsFromRoleMap,
  templateShortComposeFixture, warmTemplateShortFonts, type TemplateShortRoleMapBeat } from "./templateShortFixtures";
import { assertTemplateBeatCoverage, composeTemplateShortPlan, type TemplateShortPacket } from "./templateShortPlan";

// M1 one-tool Short, wave 2 step 2.2 (design §5.4–5.5): the fast gate that every template-emitted beat map is valid on every theme.
const FAMILIES = Object.keys(TEMPLATE_SHORT_THEME_FIXTURES) as ReferenceMotionTemplateId[];
beforeAll(() => warmTemplateShortFonts(referenceMotionDesignSystems), 120_000);
const V1 = new Set<string>(TEMPLATE_SHORT_FAMILIES);
type Compiled = Awaited<ReturnType<typeof compileDesignThemeFixture>>;
const beatsOf = (packet: unknown) => (packet as { beats?: ReferenceMotionTemplateBeat[] }).beats;
// A family draws its beats in its layout, which every theme shares: one compile tells whether the family declares any yet.
const probes = new Map<ReferenceMotionTemplateId, Promise<Compiled>>();
const probe = (family: ReferenceMotionTemplateId) => {
  if (!probes.has(family)) probes.set(family, compileDesignThemeFixture(family, "trip_pop_v1"));
  return probes.get(family)!;
};

/** The design §5.4 invariant plus the parts the product check leaves implicit: every compiled role (visible or not) in
 * exactly one beat, and beat starts that come from the compiled timing: a compiled phase start, or the frame one of the
 * beat's own graphics enters (a poster footage window may already be on screen, so not necessarily the earliest one). */
function assertBeatMap(packet: Pick<TemplateShortPacket, "instance" | "commands"> & { phases: ReadonlyArray<{ startFrame: number; endFrame: number }> },
  beats: readonly ReferenceMotionTemplateBeat[], fps: number) {
  assertTemplateBeatCoverage(packet, beats);
  const keys = packet.instance.roles.map(role => role.key), claimed = beats.flatMap(beat => beat.roleKeys);
  expect([...claimed].sort()).toEqual([...keys].sort());
  const input = packet.instance.input;
  expect(beats[0].startFrame).toBe(input.startFrame);
  expect(beats.at(-1)!.endFrame).toBe(input.startFrame + input.durationFrames);
  const idOf = new Map(packet.instance.roles.map(role => [role.key, role.id]));
  const starts = new Set(packet.phases.map(phase => phase.startFrame));
  for (const beat of beats.slice(1)) {
    const ids = new Set(beat.roleKeys.map(key => idOf.get(key)));
    const graphicStarts = packet.commands.flatMap(command => command.type === "add_motion_graphic" && ids.has(command.graphic.id)
      ? [Math.round(command.graphic.timelineStart * fps)] : []);
    expect({ beat: beat.id, followsCompiledTiming: starts.has(beat.startFrame) || graphicStarts.includes(beat.startFrame) })
      .toEqual({ beat: beat.id, followsCompiledTiming: true });
  }
}

describe.each(FAMILIES)("template beat map contract: %s", family => {
  it.each(referenceMotionDesignSystems)(`%s`, async theme => {
    const declared = (beatsOf((await probe(family)).packet) ?? []).length > 0;
    if (!declared) {
      // Not yet declared (reported once): no beat table, not selectable, and the brief cannot name it.
      if (theme !== "trip_pop_v1") return;
      expect(beatsOf((await probe(family)).packet)).toEqual([]);
      expect(V1.has(family)).toBe(false);
      expect(templateFamilyBeatTable(family)).toBeUndefined();
      expect(templateShortBriefSchema.safeParse({ schema: "editkin.template-short-brief/v1", shortId: "ts-20261009-probe-3f9a1c",
        seen: [{ kf: "kf-1", note: "probe" }], copy: { payoff: "probe" }, family }).success).toBe(false);
      return;
    }
    if (!V1.has(family)) {
      // Declared but not a v1 Short family yet: its map must still be valid on every theme.
      const { project, packet } = theme === "trip_pop_v1" ? await probe(family) : await compileDesignThemeFixture(family, theme);
      assertBeatMap(packet, beatsOf(packet)!, project.fps);
      return;
    }
    // A v1 family: the brief copy through the product adapter, its beats, its beat-table words and the composed v4 plan.
    const inputs = await templateShortComposeFixture(family as typeof TEMPLATE_SHORT_FAMILIES[number], theme);
    const beats = beatsOf(inputs.packet)!;
    assertBeatMap(inputs.packet as TemplateShortPacket & { phases: Array<{ startFrame: number; endFrame: number }> }, beats, inputs.project.fps);
    expect(beats.map(beat => beat.id)).toEqual(Object.keys(REFERENCE_MOTION_BEAT_TABLES[family as keyof typeof REFERENCE_MOTION_BEAT_TABLES].beats));
    const composed = composeTemplateShortPlan(inputs);
    expect(() => parseAutopilotPlan(composed.plan)).not.toThrow();
    expect(composed.commandCount).toBeLessThanOrEqual(AUTOPILOT_MAX_COMMANDS);
    expect(composed.bytes).toBeLessThanOrEqual(AUTOPILOT_MAX_PLAN_BYTES);
    expect(composed.beats).toEqual(beats.map(beat => ({ id: beat.id, range: [beat.startFrame, beat.endFrame] })));
  }, 120_000);
});

describe("template beat map contract: the beat tables", () => {
  const longest = (length: number, seed: string) => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  const payoff = longest(TEMPLATE_SHORT_COPY_LIMITS.payoff, "其實是來看水簾");
  const extremes: Record<keyof typeof REFERENCE_MOTION_BEAT_TABLES, TemplateShortCopy[]> = {
    strike_reframe: [{ hook: "看", payoff: "水" },
      { hook: longest(24, "來看蝙蝠"), payoff, accent: payoff.slice(0, 12), proof: longest(40, "名字叫蝙蝠洞"), place: longest(24, "桃園復興"), tag: longest(8, "天然大岩洞") }],
    context_stack: [{ payoff: "懸", points: [{ label: "一" }, { label: "二" }] },
      { payoff, accent: payoff.slice(0, 12), place: longest(24, "桃園復興"), points: Array.from({ length: 4 }, () => ({ label: longest(24, "站上和平橋"), detail: longest(40, "往下看瀑布") })) }],
  };
  it.each(Object.keys(REFERENCE_MOTION_BEAT_TABLES) as Array<keyof typeof REFERENCE_MOTION_BEAT_TABLES>)("%s: every sentence fits its schema bound for the shortest and the longest copy", family => {
    const table = REFERENCE_MOTION_BEAT_TABLES[family], beats = Object.keys(table.beats).map(id => ({ id }));
    for (const copy of extremes[family]) {
      for (const row of templateBeatTexts(family, copy, beats)) {
        for (const key of ["summary", "application", "primaryFocus"] as const) {
          expect(row[key].length).toBeGreaterThanOrEqual(TEMPLATE_BEAT_TEXT_BOUNDS[key].min);
          expect(row[key].length).toBeLessThanOrEqual(TEMPLATE_BEAT_TEXT_BOUNDS[key].max);
        }
      }
    }
    for (const [name, reason] of Object.entries(table.useReasons)) {
      expect(MOTION_TREATMENT_FAMILIES).toContain(name);
      expect(reason.length).toBeLessThanOrEqual(TEMPLATE_BEAT_TEXT_BOUNDS.useReason.max);
    }
    expect(table.skillRoles.length).toBeGreaterThan(0);
  });

  it("every selectable v1 family declares beats and has a table; a beat the table lacks is BLOCK_TEMPLATE_BEATS", () => {
    expect(TEMPLATE_SHORT_FAMILIES.every(family => templateFamilyBeatTable(family))).toBe(true);
    expect(() => templateBeatTexts("strike_reframe", TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, [{ id: "hook" }, { id: "encore" }]))
      .toThrow(new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", "beat encore of strike_reframe has no beat-table entry"));
  });
});

// r53 replay (design §5.5): the actual T01 r53 compile and the hand maps that failed and fixed it (src/application/__fixtures__/t01-r53-compile.json).
interface R53Fixture {
  fps: number;
  instance: { input: { startFrame: number; durationFrames: number }; roles: Array<{ key: string; kind: string; id: string; parentId?: string }> };
  phases: Array<{ role: string; startFrame: number; endFrame: number }>;
  commands: Array<{ type: string; target?: string; startFrame?: number; endFrame?: number; frame?: number }>;
  handMaps: { staleR52: TemplateShortRoleMapBeat[]; correctedR53b: TemplateShortRoleMapBeat[] };
}
const r53 = JSON.parse(readFileSync(resolve("src/application/__fixtures__/t01-r53-compile.json"), "utf8")) as R53Fixture;
/** The compile's visible command targets and timings as the minimal commands the beat checker reads. */
function r53Packet() {
  const fps = r53.fps;
  const commands = r53.commands.map(row => row.type === "add_motion_graphic"
    ? { type: row.type, graphic: { id: row.target, timelineStart: row.startFrame! / fps, duration: (row.endFrame! - row.startFrame!) / fps } }
    : row.type === "set_clip_layout" ? { type: row.type, clipId: row.target }
    : row.type === "add_clip_mask" ? { type: row.type, mask: { id: row.target } }
    : row.type === "add_keyframe" ? { type: row.type, keyframe: { id: row.target, time: row.frame! / fps } }
    : { type: row.type }) as unknown as EditorCommand[];
  return { instance: r53.instance, commands, phases: r53.phases } as unknown as Pick<TemplateShortPacket, "instance" | "commands"> & { phases: R53Fixture["phases"] };
}

describe("r53 replay: the checker that would have stopped r53 at build time", () => {
  it("the stale r52 hand map fails on the real r53 compile with exactly: role previous:hook is in no beat", () => {
    const packet = r53Packet(), beats = templateBeatsFromRoleMap(packet, r53.handMaps.staleR52, r53.fps);
    expect(() => assertTemplateBeatCoverage(packet, beats)).toThrow(new TemplateShortBlockError("BLOCK_TEMPLATE_BEATS", "role previous:hook is in no beat"));
  });

  it("the r53b corrected map passes on the same compile, with previous:hook and previous both in the hook", () => {
    const packet = r53Packet(), beats = templateBeatsFromRoleMap(packet, r53.handMaps.correctedR53b, r53.fps);
    expect(() => assertTemplateBeatCoverage(packet, beats)).not.toThrow();
    expect(beats[0].roleKeys).toEqual(expect.arrayContaining(["previous:hook", "previous"]));
    expect(beats.map(beat => [beat.startFrame, beat.endFrame])).toEqual([[0, 75], [75, 330]]);
  });

  it("today's template-emitted strike_reframe × trip_pop_v1 beats with T01's copy pass, previous:hook and previous in the hook", async () => {
    const { packet } = await compileTemplateShortFixture("strike_reframe", "trip_pop_v1");
    const beats = beatsOf(packet)!;
    expect(() => assertTemplateBeatCoverage(packet, beats)).not.toThrow();
    expect(beats[0].roleKeys).toEqual(expect.arrayContaining(["previous:hook", "previous"]));
    // The stale map still fails on today's compile too: names in a hand map rot, the template's own beats cannot.
    expect(() => assertTemplateBeatCoverage(packet, templateBeatsFromRoleMap(packet, r53.handMaps.staleR52, 30)))
      .toThrow("BLOCK_TEMPLATE_BEATS: role previous:hook is in no beat");
  }, 60_000);
});

describe("template beat map contract: theme coverage", () => {
  it("covers every theme and family the design themes ship", () => {
    expect(referenceMotionDesignSystems).toHaveLength(8);
    expect(FAMILIES).toHaveLength(17);
    const themes: readonly ReferenceMotionDesignSystem[] = referenceMotionDesignSystems;
    expect(new Set(themes).size).toBe(8);
  });
});

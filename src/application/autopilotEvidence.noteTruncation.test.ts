import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import {
  AUTOPILOT_OUTCOME_NOTE_MAX,
  AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER as MARKER,
  autopilotOutcomeSchema,
  truncateAutopilotOutcomeNote,
} from "./autopilotEvidence";

function event(note: string) {
  return {
    schema: "hao.video-autopilot.learning-event/v1",
    planSha256: "a".repeat(64),
    checkpoint: "agent_review",
    platform: "youtube_shorts",
    artifactId: "r52-unit-038",
    selectedMemoryRuleIds: [],
    metrics: {},
    review: { accepted: false, severeError: false, note, reviewer: "agent", evidenceSha256: "b".repeat(64) },
  };
}
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("over-long outcome notes are truncated instead of failing the record", () => {
  it("records a note longer than 1000 UTF-16 units, cut with the ellipsis marker", () => {
    const note = "第三段字幕壓到品牌標籤，需要把標籤退場提前。".repeat(80);
    const parsed = autopilotOutcomeSchema.parse(event(note));
    expect(parsed.review.note.length).toBeLessThanOrEqual(AUTOPILOT_OUTCOME_NOTE_MAX);
    expect(parsed.review.note.endsWith(MARKER)).toBe(true);
    expect(note.startsWith(parsed.review.note.slice(0, -MARKER.length))).toBe(true);
    // The MCP handler parses the already-parsed outcome again; truncation must be stable.
    expect(autopilotOutcomeSchema.parse(parsed).review.note).toBe(parsed.review.note);
  });

  it("keeps notes at the limit unchanged and still trims whitespace", () => {
    const exact = "字".repeat(AUTOPILOT_OUTCOME_NOTE_MAX);
    expect(autopilotOutcomeSchema.parse(event(exact)).review.note).toBe(exact);
    expect(autopilotOutcomeSchema.parse(event(`  開場清楚  `)).review.note).toBe("開場清楚");
    expect(truncateAutopilotOutcomeNote(`${"字".repeat(AUTOPILOT_OUTCOME_NOTE_MAX)}  `)).toBe(exact);
    const over = truncateAutopilotOutcomeNote("字".repeat(AUTOPILOT_OUTCOME_NOTE_MAX + 1));
    expect(over).toBe(`${"字".repeat(AUTOPILOT_OUTCOME_NOTE_MAX - MARKER.length)}${MARKER}`);
  });

  it("never splits a surrogate pair, a combining sequence or an emoji ZWJ cluster", () => {
    const emoji = truncateAutopilotOutcomeNote("😀".repeat(700));
    expect(emoji.length).toBeLessThanOrEqual(AUTOPILOT_OUTCOME_NOTE_MAX);
    expect(loneSurrogate.test(emoji)).toBe(false);
    expect([...emoji.slice(0, -MARKER.length)].every(character => character === "😀")).toBe(true);
    const combining = truncateAutopilotOutcomeNote("é".repeat(700)).slice(0, -MARKER.length);
    expect(combining.length % 2).toBe(0);
    expect(combining.endsWith("é")).toBe(true);
    const family = "👨‍👩‍👧‍👦";
    const families = truncateAutopilotOutcomeNote(family.repeat(200)).slice(0, -MARKER.length);
    expect(families.length % family.length).toBe(0);
    expect(families.length).toBeGreaterThan(AUTOPILOT_OUTCOME_NOTE_MAX - MARKER.length - family.length);
  });

  it("still exposes a plain string input to MCP clients (JSON Schema input conversion)", () => {
    const tool = z.object({ projectPath: z.string(), outcome: autopilotOutcomeSchema });
    const schema = z.toJSONSchema(tool, { io: "input" }) as unknown as { properties: { outcome: { properties: { review: { properties: { note: Record<string, unknown> } } } } } };
    const note = schema.properties.outcome.properties.review.properties.note;
    expect(note.type).toBe("string");
    expect(note.maxLength).toBeUndefined();
    expect(String(note.description)).toContain(MARKER);
    const standard = (autopilotOutcomeSchema as unknown as { "~standard": { jsonSchema?: { input(options: { target: string }): unknown } } })["~standard"];
    if (standard.jsonSchema) expect(() => standard.jsonSchema!.input({ target: "draft-2020-12" })).not.toThrow();
  });
});

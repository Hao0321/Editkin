import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_OUTCOME_NOTE_MAX, AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER } from "../application/autopilotEvidence";

// Only the project/receipt storage boundary is controlled; the registered tool schema and handler are the real ones.
const controls = vi.hoisted(() => ({
  tools: new Map<string, { config: { inputSchema: { safeParse(input: unknown): { success: boolean; data?: any } } }; handler: (input: unknown) => Promise<any> }>(),
  written: [] as Array<Record<string, any>>,
}));
vi.mock("./storage", async original => ({
  ...await original<typeof import("./storage")>(),
  readProject: vi.fn(async () => ({ id: "outcome-note-project" })),
  readAutopilotExecutionAttribution: vi.fn(async () => ({ executionReceiptId: "receipt-038", executionReceiptFile: "receipt-038.json",
    skillSelectionReceiptSha256: "c".repeat(64), profileSha256: "d".repeat(64), selectedSkills: [] })),
  writeAutopilotLearningEvent: vi.fn(async (_projectPath: string, event: Record<string, any>) => { controls.written.push(event); return "outcome.learning.json"; }),
}));
import { registerAutopilotTools } from "./autopilotTools";

describe("record_autopilot_outcome with an over-long review note", () => {
  registerAutopilotTools({ registerTool: (name: string, config: any, handler: any) => controls.tools.set(name, { config, handler }) } as never);
  const note = "r52 038-outcome：".concat("字幕基線壓到平台 UI，hook 卡退場太晚，品牌在 payoff 又出現一次。".repeat(60));
  const input = {
    projectPath: "units/038/project.editkin.json",
    outcome: {
      schema: "hao.video-autopilot.learning-event/v1", planSha256: "a".repeat(64), checkpoint: "agent_review", platform: "youtube_shorts",
      artifactId: "r52-unit-038", selectedMemoryRuleIds: [], metrics: {},
      review: { accepted: false, severeError: false, note, reviewer: "agent", evidenceSha256: "b".repeat(64) },
    },
  };

  it("passes the tool's input validation instead of rejecting the whole record", () => {
    expect(note.length).toBeGreaterThan(AUTOPILOT_OUTCOME_NOTE_MAX);
    const parsed = controls.tools.get("record_autopilot_outcome")!.config.inputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    expect(parsed.data.outcome.review.note.length).toBeLessThanOrEqual(AUTOPILOT_OUTCOME_NOTE_MAX);
  });

  it("records the event with the truncated note and the usual handoff", async () => {
    const result = await controls.tools.get("record_autopilot_outcome")!.handler(input);
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({ status: "RECORDED", eventFile: "outcome.learning.json", handoff: { checkpoint: "agent_review" } });
    const stored = controls.written.at(-1)!;
    expect(stored.review.note.length).toBeLessThanOrEqual(AUTOPILOT_OUTCOME_NOTE_MAX);
    expect(stored.review.note.endsWith(AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER)).toBe(true);
    expect(note.startsWith(stored.review.note.slice(0, -AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER.length))).toBe(true);
    expect(stored.attribution).toMatchObject({ executionReceiptId: "receipt-038" });
  });
});

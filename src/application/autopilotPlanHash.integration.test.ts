import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { autopilotPlanSha256, parseAutopilotPlan, type AutopilotPlan } from "./autopilotPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
  return value;
}

function skillDigest(value: unknown): string {
  const skill = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL
    ? dirname(resolve(process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL))
    : resolve(homedir(), ".codex/skills/video-autopilot");
  const child = spawnSync(process.env.EDITKIN_PYTHON_EXECUTABLE ?? "python", ["-X", "utf8", "-c",
    "import json,sys;sys.path.insert(0,sys.argv[1]);from workflow_state import plan_sha256;print(plan_sha256(json.load(sys.stdin)))", skill],
  { input: JSON.stringify(value), encoding: "utf8", windowsHide: true, timeout: 15000 });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trim();
}

describe("current Skill and Editkin plan identity", () => {
  it("binds authored, schema-parsed and recursively reordered v4 plans to one digest", () => {
    const raw = JSON.parse(JSON.stringify(createAutopilotV4Fixture())) as AutopilotPlan;
    const parsed = parseAutopilotPlan(raw);
    const permuted = reorder(raw) as typeof raw;
    expect(autopilotPlanSha256(raw)).toBe(autopilotPlanSha256(parsed));
    expect(autopilotPlanSha256(permuted)).toBe(autopilotPlanSha256(parsed));
    expect(skillDigest(raw)).toBe(autopilotPlanSha256(parsed));
    expect(skillDigest(permuted)).toBe(autopilotPlanSha256(parsed));
  });

  it("retains content and ordered-array binding instead of accepting genuine tampering", () => {
    const raw = JSON.parse(JSON.stringify(createAutopilotV4Fixture())) as AutopilotPlan;
    const original = autopilotPlanSha256(raw);
    const changed = structuredClone(raw);
    changed.budget.contextTokens += 1;
    expect(autopilotPlanSha256(changed)).not.toBe(original);
    const commands = structuredClone(raw);
    commands.commands.push({ type: "rename_project", name: "tampered" });
    expect(autopilotPlanSha256(commands)).not.toBe(original);
    expect(autopilotPlanSha256({ ...commands, commands: [...commands.commands].reverse() })).not.toBe(autopilotPlanSha256(commands));
  });

  it("preserves existing material cue/semantic receipt hashing", () => {
    const cue = { start: 0.1, end: 1.25, text: "字幕不變 😀" };
    expect(skillDigest(cue)).toBe(createHash("sha256").update(JSON.stringify(cue)).digest("hex"));
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { agentRunArgument } from "./agentRunArgument";
describe("Kit run argument transport", () => {
  const run = "videos/_AUTOPILOT/editkin-v4/current";
  it("passes a valid ID unchanged for original binding and receipt verification", () => {
    expect(agentRunArgument(run, "finish_kit_two_clip_edit", run)).toBe(run);
    expect(agentRunArgument("other-run", "finish_kit_two_clip_edit", run)).toBe("other-run");
  });
  it("rejects a closing tag without executing or silently repairing the request", () => {
    try { agentRunArgument(run + "\n</parameter]", "finish_kit_two_clip_edit", run); throw Error("expected rejection"); }
    catch (error) {
      const packet = JSON.parse((error as Error).message);
      expect(packet.mutationAttempted).toBe(false);
      expect(packet.correctedCall).toEqual({ name: "finish_kit_two_clip_edit", arguments: { run } });
      expect(packet.correctionIsOnlyAHint).toBe(true);
    }
  });
  it.each([undefined, {}, "", "x".repeat(1025), "other-run\n</parameter]", run + "\0"])("does not suggest a different bound run for %s", value => {
    try { agentRunArgument(value, "finish_kit_two_clip_edit", run); throw Error("expected rejection"); }
    catch (error) { expect(JSON.parse((error as Error).message).correctedCall).toBeUndefined(); }
  });
});

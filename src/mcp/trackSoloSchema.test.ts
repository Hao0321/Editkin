import { describe, expect, it } from "vitest";
import { editorCommandSchema } from "./schemas";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { timelineWindow } from "./timelineWindow";
describe("additive solo command in the existing MCP edit surface", () => {
  it("parses, applies and reads the actual track state, while the old absence remains false", () => {
    const project = createDemoProject(), trackId = project.tracks[0].id;
    expect(timelineWindow(project, 0, 3, 80).tracks.find(track => track.id === trackId)!.solo).toBe(false);
    const command = editorCommandSchema.parse({ type: "set_track_solo", trackId, solo: true });
    const changed = applyCommand(project, command);
    expect(timelineWindow(changed, 0, 3, 80).tracks.find(track => track.id === trackId)!.solo).toBe(true);
    expect(project.tracks[0].solo).toBeUndefined();
  });
  it("preserves the existing slip command and rejects non-boolean solo", () => {
    expect(editorCommandSchema.parse({ type: "slip_clip", clipId: "clip", sourceStart: 1 })).toEqual({ type: "slip_clip", clipId: "clip", sourceStart: 1 });
    expect(editorCommandSchema.safeParse({ type: "set_track_solo", trackId: "video-main", solo: 1 }).success).toBe(false);
  });
});

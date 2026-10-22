import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { prepareClipTimeRemapV1, clipSpeedPrepareSchemaV1, registerClipTimeRemapToolsV1 } from "./clipTimeRemapToolsV1";
function fixture() {
  const project = createEmptyProject("time remap tool"); project.assets = [{ id: "video", name: "video", kind: "video", uri: "video.mp4", duration: 16 }];
  project.tracks[0].clips = [{ id: "clip", assetId: "video", trackId: "video-main", timelineStart: 0, sourceStart: 1, duration: 4, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const readProject = vi.fn(async () => project); return { project, input: { projectPath: "owned.editkin.json", clipId: "clip", speed: 2 }, dependencies: { readProject } };
}
describe("read-only clip source clock preparation", () => {
  it("prepares a bounded source-bound command without replacing media or writing the project", async () => {
    const f = fixture(), before = JSON.stringify(f.project), result = await prepareClipTimeRemapV1("speed", f.input, undefined, f.dependencies);
    expect(result).toMatchObject({ status: "DRAFT_SOURCE_CLOCK_COMMAND", mutationPerformed: false, mediaStagingBytes: 0, directApplyAllowed: false, previewExportConsumerReady: false });
    expect(result.command).toMatchObject({ type: "set_clip_speed", speed: 2, expected: { assetId: "video", sourceStart: 1, duration: 4 } });
    expect(result.clock).toMatchObject({ sourceEndSeconds: 9, totalOutputFrames: 120, timelineDurationSeconds: 4 }); expect(JSON.stringify(f.project)).toBe(before);
  });
  it("strict input rejects force/certification fields and cancellation prevents preparation", async () => {
    const f = fixture(); for (const extra of [{ force: true }, { qualityCertified: true }]) expect(() => clipSpeedPrepareSchemaV1.parse({ ...f.input, ...extra })).toThrow();
    const controller = new AbortController(); controller.abort(Error("CONTROL_CANCEL")); await expect(prepareClipTimeRemapV1("speed", f.input, controller.signal, f.dependencies)).rejects.toThrow("CONTROL_CANCEL"); expect(f.dependencies.readProject).not.toHaveBeenCalled();
  });
  it("registers only separate read-only draft tools, preserving the old B4 entry", () => {
    const names: string[] = []; registerClipTimeRemapToolsV1({ registerTool: (name: string) => names.push(name) } as never); expect(names).toEqual(["prepare_clip_speed", "prepare_clip_time_remap"]);
  });
});

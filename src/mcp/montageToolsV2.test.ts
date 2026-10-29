import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { compileBeatMontageReadOnlyV2, compileBeatMontageInputSchemaV2, registerMontageToolsV2 } from "./montageToolsV2";
function fixture() {
  const project = createEmptyProject("V2 tool"); project.assets = [{ id: "video", name: "video", kind: "video", uri: "video.mp4", duration: 4 }, { id: "music", name: "music", kind: "audio", uri: "music.wav", duration: 4 }];
  const input = { projectPath: "owned.editkin.json", targetTrackId: "video-main", idPrefix: "v2", beats: [{ timeSeconds: 0, energy: .5, downbeat: true }, { timeSeconds: 1, energy: .5, downbeat: false }], pace: { lowThreshold: .2, highThreshold: .8 },
    candidates: [{ shotId: "shot", assetId: "video", sourceStart: 0, sourceEnd: 4, salience: .8, storyOrder: 0 }],
    music: { assetId: "music", trackId: "audio-main", clipId: "music-clip", sourceStart: 0, sourceSha256: "a".repeat(64), rightsEvidenceRefs: ["owned-source-license"] } };
  const readProject = vi.fn(async () => project); return { project, input, dependencies: { readProject } };
}
describe("read-only separate montage V2 tool", () => {
  it("binds a project snapshot, returns flat draft commands and leaves the project unchanged", async () => {
    const f = fixture(), before = JSON.stringify(f.project), result = await compileBeatMontageReadOnlyV2(f.input, undefined, f.dependencies);
    expect(result).toMatchObject({ status: "DRAFT_COMMAND_CANDIDATE", mutationPerformed: false, directApplyAllowed: false, certificationPerformed: false });
    expect(result.projectBinding.sha256).toMatch(/^[a-f0-9]{64}$/); expect(result.commands).toHaveLength(2); expect(JSON.stringify(f.project)).toBe(before);
  });
  it("preabort reads nothing; abort during project reading produces no candidate", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(Error("CONTROL_CANCEL"));
    await expect(compileBeatMontageReadOnlyV2(f.input, controller.signal, f.dependencies)).rejects.toThrow("CONTROL_CANCEL"); expect(f.dependencies.readProject).not.toHaveBeenCalled();
    const second = new AbortController(); await expect(compileBeatMontageReadOnlyV2(f.input, second.signal, { readProject: async () => { second.abort(Error("LATE_CANCEL")); return f.project; } })).rejects.toThrow("LATE_CANCEL");
  });
  it("strict input rejects authority or force injection and registers only the new draft tool", () => {
    const f = fixture(); for (const extra of [{ force: true }, { accepted: true }, { qualityCertified: true }]) expect(() => compileBeatMontageInputSchemaV2.parse({ ...f.input, ...extra })).toThrow();
    const names: string[] = []; registerMontageToolsV2({ registerTool: (name: string) => names.push(name) } as never); expect(names).toEqual(["compile_beat_montage_v2"]);
  });
});

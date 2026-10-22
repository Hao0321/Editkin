import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createProjectSession } from "../application/projectSession";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import { isLocalMediaFile, relinkDesktopAsset } from "./useDesktopMissingMedia";
import { problemCause } from "../application/plainProblems";

const sha = "a".repeat(64);
function fixture(pinned: string | null = sha) {
  const project = createDemoProject();
  const asset = project.assets.find(item => item.kind === "video")!;
  asset.uri = "D:\\old\\IMG_0001.MOV";
  asset.derivatives = pinned ? { sourceSha256: pinned, generatedAt: "2026-10-10T00:00:00.000Z" } : undefined;
  const session = createProjectSession(project);
  const runCommand = vi.fn((command: EditorCommand) => {
    session.setHistory(history => ({ ...history, past: [...history.past, history.present], present: applyCommand(history.present, command), future: [] }));
    return true;
  });
  const getProject = (): EditProject => session.getSnapshot().history.present;
  return { asset, session, runCommand, getProject };
}

describe("finding a moved media file again (desktop)", () => {
  it("only local single files are checked for being missing", () => {
    const base = createDemoProject().assets[0];
    expect(isLocalMediaFile({ ...base, uri: "D:\\a.mp4" })).toBe(true);
    expect(isLocalMediaFile({ ...base, uri: "/Users/a.mp4" })).toBe(true);
    expect(isLocalMediaFile({ ...base, uri: "creative://studio.hao.creator-library/x" })).toBe(false);
    expect(isLocalMediaFile({ ...base, uri: "D:\\a.mov", compositionId: "c1" })).toBe(false);
  });

  it("links back only the byte-identical file, as one undoable command, and refreshes its preview", async () => {
    const f = fixture();
    const mergeRuntimeUrls = vi.fn();
    const rebuildPreview = vi.fn(async () => undefined);
    const api = { pickRelinkMedia: vi.fn(async () => ({ canceled: false as const, path: "E:\\moved\\IMG_0001.MOV", sha256: sha, bytes: 10 })),
      previewUrls: vi.fn(async () => ({ [f.asset.id]: "asset://moved" })) };
    expect(await relinkDesktopAsset({ api, getProject: f.getProject, runCommand: f.runCommand, mergeRuntimeUrls, rebuildPreview }, f.asset.id)).toBe(true);
    expect(f.runCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "relink_asset_source", assetId: f.asset.id, sourceUri: "E:\\moved\\IMG_0001.MOV", expectedSourceSha256: sha }), expect.any(String));
    expect(f.getProject().assets.find(item => item.id === f.asset.id)?.uri).toBe("E:\\moved\\IMG_0001.MOV");
    expect(f.session.getSnapshot().history.past).toHaveLength(1);
    expect(mergeRuntimeUrls).toHaveBeenCalledWith({ [f.asset.id]: "asset://moved" });
    expect(rebuildPreview).toHaveBeenCalledWith(f.asset.id);
  });

  it("refuses a different file and a media file without a fingerprint, in plain categories", async () => {
    const f = fixture();
    const api = { pickRelinkMedia: vi.fn(async () => ({ canceled: false as const, path: "E:\\other.MOV", sha256: "b".repeat(64), bytes: 10 })), previewUrls: vi.fn() };
    const refused = await relinkDesktopAsset({ api, getProject: f.getProject, runCommand: f.runCommand }, f.asset.id).catch(error => error as Error);
    expect(problemCause("relink", (refused as Error).message)).toBe("notSameFile");
    expect(f.runCommand).not.toHaveBeenCalled();
    const unpinned = fixture(null);
    const noPrint = await relinkDesktopAsset({ api, getProject: unpinned.getProject, runCommand: unpinned.runCommand }, unpinned.asset.id).catch(error => error as Error);
    expect(problemCause("relink", (noPrint as Error).message)).toBe("noFingerprint");
    expect(api.pickRelinkMedia).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the picker is closed", async () => {
    const f = fixture();
    const api = { pickRelinkMedia: vi.fn(async () => ({ canceled: true as const })), previewUrls: vi.fn() };
    expect(await relinkDesktopAsset({ api, getProject: f.getProject, runCommand: f.runCommand }, f.asset.id)).toBe(false);
    expect(f.runCommand).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { creativeAssetUri } from "../shared/creativeAssetUri";
import { fixtureReceiptV1 } from "../application/musicBeats.fixture";
import type { analyzeMusicBeatsV1 } from "../application/musicBeats";
import { analyzeMusicBeatsToolV1, musicBeatsToolInputSchemaV1 } from "./musicBeatsToolsV1";

function setup() {
  const project = createEmptyProject("Owned music analysis", { id: "beat-control" });
  project.assets = [{ id: "music", name: "Owned music", kind: "audio", uri: "D:/owned.wav", duration: 20, bpm: 90 }];
  const receipt = fixtureReceiptV1(), analyze = vi.fn(async (_request: Parameters<typeof analyzeMusicBeatsV1>[0], _runtime: Parameters<typeof analyzeMusicBeatsV1>[1]) => ({ key: "a".repeat(64), receiptSha256: "b".repeat(64),
    binding: { source: { sha256: "a".repeat(64), bytes: 10 } }, receipt, cacheHit: false, elapsedMs: 1 }));
  const dependencies = { readProject: vi.fn(async () => project), analyze,
    creative: vi.fn(async () => ({ absolutePath: "D:/real-library.wav", sha256: "a".repeat(64), asset: { bpm: 180 } })),
    runtime: () => ({ ffmpegPath: "D:/ffmpeg.exe", ffprobePath: "D:/ffprobe.exe", nativeCorePath: "D:/core.exe", cacheRoot: "D:/cache" }) } as any;
  return { project, receipt, analyze, dependencies };
}
const input = { projectPath: "owned.json", assetId: "music", durationSeconds: 2 };
describe("read-only source music analysis MCP", () => {
  it("returns a project-bound summary with metadata prior and no editing command", async () => {
    const f = setup(), before = structuredClone(f.project), result = await analyzeMusicBeatsToolV1(input, undefined, f.dependencies);
    expect(result.mutationPerformed).toBe(false); expect(result.counts.beats).toBe(1); expect(result.priorOrigin).toBe("project_metadata_hint");
    expect(f.analyze.mock.calls[0][0]).toMatchObject({ sourcePath: "D:/owned.wav", priorBpm: 90 });
    expect(result).not.toHaveProperty("commands"); expect(f.project).toEqual(before); expect(f.dependencies.readProject).toHaveBeenCalledTimes(2);
  });
  it("uses the verified original library path and its BPM, with explicit caller hint precedence", async () => {
    const f = setup(); f.project.assets[0].uri = creativeAssetUri("music:owned");
    const library = await analyzeMusicBeatsToolV1(input, undefined, f.dependencies);
    expect(library.priorOrigin).toBe("verified_library_metadata"); expect(f.analyze.mock.calls[0][0]).toMatchObject({ sourcePath: "D:/real-library.wav", priorBpm: 180 });
    const caller = await analyzeMusicBeatsToolV1({ ...input, priorBpm: 120 }, undefined, f.dependencies);
    expect(caller.priorOrigin).toBe("caller_hint"); expect(f.analyze.mock.calls[1][0].priorBpm).toBe(120);
  });
  it("paginates actual events and refuses a stale result ID", async () => {
    const f = setup(); f.receipt.analysis.beats.push({ ...f.receipt.analysis.beats[0], timeSeconds: 1 });
    const result = await analyzeMusicBeatsToolV1({ ...input, include: "beats", limit: 1 }, undefined, f.dependencies);
    expect(result.events).toHaveLength(1); expect(result.nextOffset).toBe(1);
    const next = await analyzeMusicBeatsToolV1({ ...input, include: "beats", offset: 1, limit: 1, expectedResultId: result.resultId }, undefined, f.dependencies);
    expect(next.events?.[0].timeSeconds).toBe(1); expect(next.nextOffset).toBeNull();
    await expect(analyzeMusicBeatsToolV1({ ...input, expectedResultId: `${"c".repeat(64)}:${"d".repeat(64)}` }, undefined, f.dependencies)).rejects.toThrow("RESULT_CHANGED");
  });
  it("refuses project changes during analysis and a substituted library source", async () => {
    const f = setup(); f.analyze.mockImplementationOnce(async () => { f.project.revision++; return { key: "a".repeat(64), receiptSha256: "b".repeat(64), binding: {}, receipt: f.receipt, cacheHit: false, elapsedMs: 1 } as any; });
    await expect(analyzeMusicBeatsToolV1(input, undefined, f.dependencies)).rejects.toThrow("PROJECT_CHANGED");
    const library = setup(); library.project.assets[0].uri = creativeAssetUri("music:owned"); library.receipt.sourceSha256 = "e".repeat(64);
    await expect(analyzeMusicBeatsToolV1(input, undefined, library.dependencies)).rejects.toThrow("LIBRARY_SOURCE_CHANGED");
  });
  it("propagates cancellation and rejects unknown fields before reading a project", async () => {
    const f = setup(), controller = new AbortController(); controller.abort(Error("human cancel"));
    await expect(analyzeMusicBeatsToolV1(input, controller.signal, f.dependencies)).rejects.toThrow("human cancel"); expect(f.dependencies.readProject).not.toHaveBeenCalled();
    expect(musicBeatsToolInputSchemaV1.safeParse({ ...input, applyImmediately: true }).success).toBe(false);
    expect(musicBeatsToolInputSchemaV1.safeParse({ ...input, limit: 201 }).success).toBe(false);
  });
});

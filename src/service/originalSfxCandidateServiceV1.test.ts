import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ORIGINAL_SFX_GENERATOR_PINS_V1, originalSfxListRequestedV1, originalSfxRootV1, listOriginalSfxCandidatesV1, resolveOriginalSfxCandidateV1, materializeOriginalSfxCandidatesV1 } from "./originalSfxCandidateServiceV1";
import { creativeAssetUri, listCreativeLibrary, materializeCreativeAssets } from "../application/creativeLibrary";
import { createEmptyProject } from "../domain/editGraph";
import { mergeOriginalSfxCandidatesV1, assertOriginalSfxCandidateSummaryV1 } from "../domain/originalSfxCandidateContractV1";
let root: string;
const runtime = () => ({ personalMusicRoot: join(root, "user-assets/music"), creativePackRoot: join(root, "legacy") });
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "editkin-original-sfx-c-")); await mkdir(join(root, "legacy")); await writeFile(join(root,"legacy/editkin-pack.json"),JSON.stringify({schemaVersion:1,id:"owned-empty-legacy",name:"Legacy",version:"1",attribution:"Original fixture",source:{privateImagesEmbedded:false},assets:[],assetCount:0,assetBytes:0,portability:{relativePathsOnly:true,privateWorkspaceEmbedded:false,originalPrivateReferencesEmbedded:false}})); });
afterAll(async () => { await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "originalSfxCandidateServiceV1.test.ts", root, testsTerminal: true }), { flag: "wx" }); console.log(`SFX_C_OWNED_TEST_FIXTURE=${root}`); });
describe("explicit original candidate service boundary", () => {
  it("binds declared generator pins to the actual source, and default requests do not create a pack", async () => {
    for (const pin of ORIGINAL_SFX_GENERATOR_PINS_V1) { const bytes = await readFile(pin.path); expect(bytes.length).toBe(pin.bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256); }
    expect(originalSfxListRequestedV1({})).toBe(false); expect(originalSfxListRequestedV1({ includeOriginalSfxCandidates: false })).toBe(false);
    await expect(lstat(originalSfxRootV1(runtime()))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listCreativeLibrary(runtime().creativePackRoot)).assets).toEqual([]);
    await expect(resolveOriginalSfxCandidateV1({ assetId: "sfx:editkin-procedural-v1-tick-01" }, runtime())).rejects.toThrow("SFX_CANDIDATES_NOT_GENERATED");
  });
  it("generates one bounded pack for simultaneous explicit list calls; default library stays unchanged", async () => {
    expect(originalSfxListRequestedV1({ includeOriginalSfxCandidates: true })).toBe(true);
    const [a, b] = await Promise.all([listOriginalSfxCandidatesV1(runtime()), listOriginalSfxCandidatesV1(runtime())]);
    expect(a).toEqual(b); expect(a.assets).toHaveLength(40); expect(a.defaultEnabled).toBe(false); expect(a.assetBytes).toBe(1586720);
    expect((await listCreativeLibrary(runtime().creativePackRoot)).assets).toEqual([]);
    const merged = mergeOriginalSfxCandidatesV1(await listCreativeLibrary(runtime().creativePackRoot), a)!;
    expect(merged.assetCount).toBe(40); expect(a.assets.every(s => !s.redistributable && !s.defaultEnabled && s.domains.length === 0)).toBe(true);
  });
  it("resolves all candidates for preview/import and materializes virtual URIs without changing originals", async () => {
    const summary = await listOriginalSfxCandidatesV1(runtime());
    for (const item of summary.assets) { const source = await resolveOriginalSfxCandidateV1({ assetId: item.id, mode: "media" }, runtime()); expect(source.asset).toEqual(item); expect((await readFile(source.absolutePath)).length).toBe(item.bytes); }
    const initial = createEmptyProject("candidate virtual", { id: "candidate-virtual" }), sound = summary.assets[0];
    initial.assets = [{ id: "a", kind: "audio", name: sound.name, uri: creativeAssetUri(sound.id), duration: sound.duration! }];
    const before = JSON.stringify(initial), materialized = await materializeOriginalSfxCandidatesV1(initial, runtime());
    expect(JSON.stringify(initial)).toBe(before); expect(materialized.assets[0].uri).toBe((await resolveOriginalSfxCandidateV1({ assetId: sound.id }, runtime())).absolutePath);
    const legacy = createEmptyProject("old path"); expect(await materializeOriginalSfxCandidatesV1(legacy, runtime())).toEqual(await materializeCreativeAssets(legacy, runtime().creativePackRoot));
  });
  it("rejects client storage overrides, invalid flags, IDs and unconfigured host paths", async () => {
    for (const payload of [{ includeOriginalSfxCandidates: true, personalMusicRoot: "C:/" }, { includeOriginalSfxCandidates: "true" }, { includeOriginalSfxCandidates: true, root: "C:/" }]) expect(() => originalSfxListRequestedV1(payload)).toThrow();
    for (const id of ["../outside", "sfx:editkin-procedural-v1-tick-99"]) await expect(resolveOriginalSfxCandidateV1({ assetId: id }, runtime())).rejects.toThrow();
    await expect(resolveOriginalSfxCandidateV1({ assetId: "sfx:editkin-procedural-v1-tick-01", sourcePath: "C:/" }, runtime())).rejects.toThrow();
    expect(() => originalSfxRootV1({ personalMusicRoot: "relative/music" })).toThrow();
  });
  it("keeps incomplete existing roots and rejects linked parents", async () => {
    const partial = { personalMusicRoot: join(root, "partial/music") }; await mkdir(join(root, "partial/original-sfx-v1"), { recursive: true });
    await expect(listOriginalSfxCandidatesV1(partial)).rejects.toThrow(); expect((await lstat(join(root, "partial/original-sfx-v1"))).isDirectory()).toBe(true);
    const alias = join(root, "alias"); await symlink(join(root,"user-assets"), alias, "junction");
    try { await expect(listOriginalSfxCandidatesV1({ personalMusicRoot: join(alias, "music") })).rejects.toThrow(); } finally { await unlink(alias); }
  });
  it("rejects a changed original WAV and illegal candidate certification without overwriting it", async () => {
    const summary = await listOriginalSfxCandidatesV1(runtime()), source = await resolveOriginalSfxCandidateV1({ assetId: summary.assets[0].id }, runtime()), before = await readFile(source.absolutePath);
    try { const bad = Buffer.from(before); bad[100] ^= 1; await writeFile(source.absolutePath, bad); await expect(resolveOriginalSfxCandidateV1({ assetId: summary.assets[0].id }, runtime())).rejects.toThrow("SFX_ORIGINAL_CONTENT_MISMATCH"); expect(await readFile(source.absolutePath)).toEqual(bad); } finally { await writeFile(source.absolutePath, before); }
    expect(() => assertOriginalSfxCandidateSummaryV1({ ...summary, defaultEnabled: true } as never)).toThrow();
    expect(() => mergeOriginalSfxCandidatesV1(summary, summary)).toThrow("SFX_CANDIDATE_ID_COLLISION");
  });
});

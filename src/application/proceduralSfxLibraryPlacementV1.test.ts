import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProceduralSfxLibraryV1, type ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import { writeProceduralSfxPackV1 } from "./proceduralSfxPackV1";
import { prepareProceduralSfxPlacementV1, applyPreparedProceduralSfxPlacementV1 } from "./proceduralSfxPlacementV1";
import { PROCEDURAL_SFX_CATALOGUE_V1 as catalogue } from "./proceduralSfxCatalogueV1";
import { synthesizeProceduralSfxV1 } from "./proceduralSfxSynthV1";
import { createEmptyProject, migrateProject } from "../domain/editGraph";
import { createProjectSession } from "./projectSession";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { proceduralSfxLibraryRequestV1Schema } from "../domain/proceduralSfxLibraryContractV1";

const pins = ["Catalogue", "Synth"].map(kind => ({ path: `src/application/proceduralSfx${kind}V1.ts`, bytes: 10, sha256: "b".repeat(64) }));
let root: string, tempRoot: string, library: ProceduralSfxLibraryV1, manifest: Awaited<ReturnType<typeof writeProceduralSfxPackV1>>;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ref = (item: { id: string; sha256: string }) => ({ id: item.id, sha256: item.sha256 });
beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "editkin-procedural-sfx-b-")); root = join(tempRoot, "pack");
  manifest = await writeProceduralSfxPackV1(root, pins); library = await createProceduralSfxLibraryV1(root, pins);
});
afterAll(async () => {
  // The wrapper records the exact owned fixture for later PowerShell retirement. No blanket temp cleanup.
  await writeFile(join(tempRoot, "TEST-OWNER.json"), JSON.stringify({ producer: "proceduralSfxLibraryPlacementV1.test.ts", root: tempRoot, packAudioBytes: manifest.audioBytes, testsTerminal: true }), { flag: "wx" });
  console.log(`SFX_B_OWNED_TEST_FIXTURE=${tempRoot}`);
});
async function changed(filename: string, mutate: (bytes: Buffer) => Uint8Array | string, action: () => Promise<unknown>) {
  const path = join(root, filename), before = await readFile(path);
  try { await writeFile(path, mutate(before)); await action(); } finally { await writeFile(path, before); }
}
function sessionFixture() {
  const project = createEmptyProject("owned SFX placement", { id: "sfx-placement-project", fps: 30 });
  const session = createProjectSession(project);
  return { project, session };
}
const request = () => ({ trackId: "audio-main", idPrefix: "sfx-test", hits: [
  { id: manifest.items[0].id, sha256: manifest.items[0].sha256, frame: 15, gain: .5 },
  { id: manifest.items[0].id, sha256: manifest.items[0].sha256, frame: 45, gain: .4 },
] });
describe("host-selected original SFX library", () => {
  it("pages all 40 candidate entries and filters by kind without certifying content/defaults", async () => {
    const a = await library.list(), b = await library.list({ offset: a.nextOffset });
    expect(a.total).toBe(40); expect(a.entries).toHaveLength(20); expect(b.entries).toHaveLength(20);
    expect([...a.entries, ...b.entries].map(e => e.id)).toEqual(catalogue.map(r => r.id));
    expect(a.entries.every(e => !e.contentVerified && !e.defaultEnabled && !e.redistributable)).toBe(true);
    const kind = await library.list({ kind: "tick", limit: 3 }); expect(kind.total).toBe(5); expect(kind.nextOffset).toBe(3);
  });
  it("resolves original bounded bytes and source identity for every candidate", async () => {
    for (const item of manifest.items) {
      const result = await library.resolve(ref(item)), bytes = await readFile(result.absolutePath);
      expect(result.entry.contentVerified).toBe(true); expect(hash(bytes)).toBe(result.entry.sha256);
      expect(result.pcm).toEqual(synthesizeProceduralSfxV1(item.id));
      expect(result.entry.sourceSha256).toBe(hash(await readFile(join(root, item.sourceFilename))));
    }
  });
  it("rejects client root/pin/operation overrides and unknown references", async () => {
    for (const payload of [{ operation: "list", root: "C:/" }, { operation: "list", generatorPins: pins }, { operation: "list", limit: 21 }, { operation: "resolve", id: "../tick", sha256: "a".repeat(64) }]) {
      expect(() => proceduralSfxLibraryRequestV1Schema.parse(payload)).toThrow();
    }
    await expect(library.resolve({ id: manifest.items[0].id, sha256: "a".repeat(64) })).rejects.toThrow("SFX_ASSET_REFERENCE_MISMATCH");
  });
  it("rejects generator pins and caller mutation of the constructor pins", async () => {
    await expect(createProceduralSfxLibraryV1(root, pins.map(p => ({ ...p, sha256: "c".repeat(64) })))).rejects.toThrow("SFX_GENERATOR_PIN_MISMATCH");
    const mutable = pins.map(p => ({ ...p })), isolated = await createProceduralSfxLibraryV1(root, mutable); mutable[0].sha256 = "c".repeat(64);
    expect((await isolated.list()).total).toBe(40);
  });
  it("rejects changed manifest after mounting instead of silently adopting it", async () => {
    await changed("MANIFEST.json", b => b.toString() + " ", async () => { await expect(library.list()).rejects.toThrow("SFX_LIBRARY_MANIFEST_CHANGED"); });
  });
  it("rejects source recipe, rights, external samples and generator substitution", async () => {
    for (const mutate of [
      (v: any) => { v.recipe.seed += 1; }, (v: any) => { v.publicRedistributionApproved = true; },
      (v: any) => { v.thirdPartySamplesUsed = true; }, (v: any) => { v.generators[0].sha256 = "c".repeat(64); },
    ]) await changed(manifest.items[0].sourceFilename, b => { const value = JSON.parse(b.toString()); mutate(value); return JSON.stringify(value); }, async () => { await expect(library.resolve(ref(manifest.items[0]))).rejects.toThrow(); });
  });
  it("rejects content and over-budget files before handing out a path", async () => {
    await changed(manifest.items[0].path, b => { const bad = Buffer.from(b); bad[100] ^= 1; return bad; }, async () => { await expect(library.resolve(ref(manifest.items[0]))).rejects.toThrow("SFX_ORIGINAL_CONTENT_MISMATCH"); });
    await changed(manifest.items[0].path, () => Buffer.alloc(96_045), async () => { await expect(library.resolve(ref(manifest.items[0]))).rejects.toThrow(/size limit/); });
  });
  it("rejects a forged self-consistent manifest/sidecar/content pair using the original synthesis", async () => {
    const item = manifest.items[0], wavPath = join(root, item.path), sourcePath = join(root, item.sourceFilename), manifestPath = join(root, "MANIFEST.json");
    const [originalWav, originalSource, originalManifest] = await Promise.all([readFile(wavPath), readFile(sourcePath), readFile(manifestPath)]);
    try {
      const bad = Buffer.from(originalWav); bad[100] ^= 1; const forgedSha = hash(bad), sidecar = JSON.parse(originalSource.toString()), index = JSON.parse(originalManifest.toString());
      sidecar.wavSha256 = forgedSha; index.items[0].sha256 = forgedSha;
      await writeFile(wavPath, bad); await writeFile(sourcePath, JSON.stringify(sidecar)); await writeFile(manifestPath, JSON.stringify(index));
      const forged = await createProceduralSfxLibraryV1(root, pins);
      await expect(forged.resolve({ id: item.id, sha256: forgedSha })).rejects.toThrow("SFX_ORIGINAL_CONTENT_MISMATCH");
    } finally { await writeFile(wavPath, originalWav); await writeFile(sourcePath, originalSource); await writeFile(manifestPath, originalManifest); }
  });
  it("rejects traversal filenames even if the pack is mounted afterwards", async () => {
    await changed("MANIFEST.json", b => { const value = JSON.parse(b.toString()); value.items[0].path = "../outside.wav"; return JSON.stringify(value); }, async () => { await expect(createProceduralSfxLibraryV1(root, pins)).rejects.toThrow("SFX_MANIFEST_CATALOGUE_MISMATCH"); });
  });
  it("rejects an owned junction root and cancellation", async () => {
    const alias = join(tempRoot, "alias"); await symlink(root, alias, "junction");
    try { await expect(createProceduralSfxLibraryV1(alias, pins)).rejects.toThrow(/LINK|ALIAS/); } finally { await unlink(alias); }
    const controller = new AbortController(); controller.abort(); await expect(library.list({}, controller.signal)).rejects.toThrow();
  });
});
describe("atomic editable original SFX placement", () => {
  it("adds one asset/two full-length clips as one Undo, then saves/reopens and preserves sources", async () => {
    const { project, session } = sessionFixture(), before = JSON.stringify(project), packet = await prepareProceduralSfxPlacementV1(session, library, request());
    expect(JSON.stringify(project)).toBe(before); const result = await applyPreparedProceduralSfxPlacementV1(session, packet);
    expect(result).toMatchObject({ importedSounds: 1, insertedHits: 2, undoSteps: 1, defaultEnabled: false });
    const history = session.getSnapshot().history; expect(history.past).toHaveLength(1); expect(history.present.assets).toHaveLength(1);
    expect(history.present.tracks[1].clips.map(c => c.timelineStart)).toEqual([.5, 1.5]);
    expect(history.present.tracks[1].clips.every(c => c.duration === catalogue[0].durationSamples / 48000)).toBe(true);
    const file = join(tempRoot, "SAVED.editkin.json"); await writeFile(file, JSON.stringify(history.present), { flag: "wx" });
    const reopened = migrateProject(JSON.parse(await readFile(file, "utf8"))); expect(reopened.tracks[1].clips).toEqual(history.present.tracks[1].clips);
    expect(undo(history).present.assets).toEqual(project.assets); expect(redo(undo(history)).present.assets).toEqual(history.present.assets);
    await expect(applyPreparedProceduralSfxPlacementV1(session, packet)).rejects.toThrow();
  });
  it("rejects same-ID project replacement and content changes after preparation", async () => {
    for (const replace of [true, false]) {
      const { project, session } = sessionFixture(), packet = await prepareProceduralSfxPlacementV1(session, library, request());
      if (replace) session.replaceProject(structuredClone(project));
      else { const next = dispatchCommandSafely(session.getSnapshot().history, { type: "rename_track", trackId: "audio-main", name: "changed" }); session.setHistory(next.state); }
      const before = JSON.stringify(session.getSnapshot().history); await expect(applyPreparedProceduralSfxPlacementV1(session, packet)).rejects.toThrow("SFX_PREPARATION_PROJECT_CHANGED");
      expect(JSON.stringify(session.getSnapshot().history)).toBe(before);
    }
  });
  it("rejects drift during delayed resolution before making a packet", async () => {
    const { session } = sessionFixture(); let release!: () => void, started!: () => void;
    const held = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
    const delayed: ProceduralSfxLibraryV1 = { ...library, resolve: async (ref, signal) => { started(); await held; return library.resolve(ref, signal); } };
    const pending = prepareProceduralSfxPlacementV1(session, delayed, request()); await entered;
    const next = dispatchCommandSafely(session.getSnapshot().history, { type: "rename_track", trackId: "audio-main", name: "during resolve" }); session.setHistory(next.state); release();
    await expect(pending).rejects.toThrow("SFX_PREPARATION_PROJECT_CHANGED"); expect(session.getSnapshot().history.present.assets).toHaveLength(0);
  });
  it("rejects a file changed after prepare with no partial asset/clip commit", async () => {
    const { session } = sessionFixture(), packet = await prepareProceduralSfxPlacementV1(session, library, request()), before = JSON.stringify(session.getSnapshot().history);
    await changed(manifest.items[0].path, b => { const bad = Buffer.from(b); bad[100] ^= 1; return bad; }, async () => { await expect(applyPreparedProceduralSfxPlacementV1(session, packet)).rejects.toThrow(); });
    expect(JSON.stringify(session.getSnapshot().history)).toBe(before);
  });
  it("rejects forged/mutated packets and another session", async () => {
    const { session } = sessionFixture(), packet = await prepareProceduralSfxPlacementV1(session, library, request());
    await expect(applyPreparedProceduralSfxPlacementV1(session, structuredClone(packet))).rejects.toThrow("SFX_PREPARED_PACKET_INVALID");
    await expect(applyPreparedProceduralSfxPlacementV1(sessionFixture().session, packet)).rejects.toThrow("SFX_PREPARED_PACKET_INVALID");
    packet.sourceBindings[0].sha256 = "a".repeat(64); await expect(applyPreparedProceduralSfxPlacementV1(session, packet)).rejects.toThrow("SFX_PREPARED_PACKET_INVALID");
    expect(session.getSnapshot().history.past).toHaveLength(0);
  });
  it("rejects serializer-hook forgery and concurrent apply can commit only once", async () => {
    const forged = sessionFixture(), packet = await prepareProceduralSfxPlacementV1(forged.session, library, request());
    const original = structuredClone(packet);
    Object.assign(packet, { toJSON: () => original });
    await expect(applyPreparedProceduralSfxPlacementV1(forged.session, packet)).rejects.toThrow();
    expect(forged.session.getSnapshot().history.past).toHaveLength(0);
    const live = sessionFixture(), prepared = await prepareProceduralSfxPlacementV1(live.session, library, request());
    const replies = await Promise.allSettled([applyPreparedProceduralSfxPlacementV1(live.session, prepared), applyPreparedProceduralSfxPlacementV1(live.session, prepared)]);
    expect(replies.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(live.session.getSnapshot().history.past).toHaveLength(1);
    expect(live.session.getSnapshot().history.present.tracks[1].clips).toHaveLength(2);
  });
  it("rejects locked/muted/occupied tracks, invalid frame and duplicate ids without touching the project", async () => {
    for (const mode of ["locked", "muted", "overlap", "frame", "id"] as const) {
      const { project, session } = sessionFixture(), payload = request();
      if (mode === "locked") project.tracks[1].locked = true; if (mode === "muted") project.tracks[1].muted = true;
      if (mode === "overlap") payload.hits[1].frame = payload.hits[0].frame; if (mode === "frame") payload.hits[0].frame = NaN;
      if (mode === "id") project.assets.push({ id: "sfx-test-asset-1", name: "existing", kind: "audio", uri: "existing.wav", duration: 1 });
      const before = JSON.stringify(project); await expect(prepareProceduralSfxPlacementV1(session, library, payload)).rejects.toThrow(); expect(JSON.stringify(project)).toBe(before);
    }
  });
});

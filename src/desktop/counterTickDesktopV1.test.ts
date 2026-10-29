import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { createProjectSession } from "../application/projectSession";
import { dispatchCommandSafely, undo } from "../domain/history";
import { PROCEDURAL_SFX_CATALOGUE_V1 } from "../application/proceduralSfxCatalogueV1";
import { encodeProceduralSfxWavV1, synthesizeProceduralSfxV1 } from "../application/proceduralSfxSynthV1";
import { applyPreparedProceduralSfxPlacementV1 } from "../application/proceduralSfxPlacementV1";
import { creativeAssetUri } from "../shared/creativeAssetUri";
import type { OriginalSfxCandidateSummaryV1 } from "../domain/originalSfxCandidateContractV1";
import { prepareCounterTickDesktopV1 } from "./counterTickDesktopV1";
import type { PickedMedia } from "./mediaTypes";

// Transport mocks use actual deterministic PCM hashes; native/service source verification is separate evidence.
const summary: OriginalSfxCandidateSummaryV1 = (() => {
  const assets = PROCEDURAL_SFX_CATALOGUE_V1.map(r => {
    const wav = encodeProceduralSfxWavV1(synthesizeProceduralSfxV1(r.id)), digest = createHash("sha256").update(wav).digest("hex");
    return { id: r.id, name: `${r.kind} ${r.variant}`, category: "original-sfx-candidate" as const, mediaKind: "audio" as const, role: "sound-effect", domains: [],
      bytes: wav.length, duration: r.durationSamples / 48_000, license: "Original; private-owner-only", provenance: `Local original mathematical synthesis; source-sha256=${"b".repeat(64)}; wav-sha256=${digest}`,
      redistributable: false as const, distributionScope: "private-owner-only" as const, rightsBasis: r.rightsBasis, certification: r.certification, defaultEnabled: false as const };
  });
  return { id: "mock-original", name: "mock original", version: "1", attribution: "Fixture only", assets, assetCount: 40, sfxAssetCount: 40, musicAssetCount: 0, restrictedAssetCount: 40, assetBytes: assets.reduce((n, a) => n + a.bytes, 0), candidateOnly: true, defaultEnabled: false };
})();
function fixture() {
  const project = createEmptyProject("Desktop counter source", { id: "desktop-counter", fps: 30 });
  project.motionGraphics = [createMotionGraphic("g1", "counter", "1/3", .5, 1), createMotionGraphic("g2", "counter", "2/3", 1.5, 1)];
  const session = createProjectSession(project), calls: string[] = [];
  const api = {
    listOriginalSfxCandidates: async () => { calls.push("list"); return structuredClone(summary); },
    resolveOriginalSfxCandidate: async (id: string): Promise<PickedMedia & { absolutePath: string }> => {
      calls.push("resolve"); const a = summary.assets.find(a => a.id === id)!;
      return { absolutePath: `D:/owned/${id.slice(4)}.wav`, previewUrl: "https://asset.local/tick.wav", asset: {
        id: "host-import-id", kind: "audio", name: a.name, uri: creativeAssetUri(a.id), duration: a.duration!, role: a.role, license: a.license,
        provenance: a.provenance, rightsBasis: a.rightsBasis, distributionScope: a.distributionScope, redistributable: false,
      } };
    },
    prepareMedia: async (asset: PickedMedia["asset"]) => {
      calls.push("prepare"); const sha = summary.assets.find(a => a.id.endsWith("tick-01"))!.provenance.split("wav-sha256=")[1];
      return { assetId: asset.id, derivatives: { sourceSha256: sha, generatedAt: "2026-10-15T00:00:00Z" }, runtimeUrls: { [asset.id]: "https://asset.local/tick.wav" }, cacheHit: false };
    },
  };
  const request = { enabled: true, durationFrames: 90, trackId: "counter-new-track", newTrack: { name: "Counter sounds" }, idPrefix: "desktop-counter",
    bindings: [{ source: "editorial_states", role: "challenge_ledger", graphicIds: ["g1", "g2"] }], sound: { variant: 1, gain: .42 } };
  return { project, session, api, request, calls };
}
describe("verified desktop counter source and atomic new audio track", () => {
  it("prepares without editing, revalidates source on apply, and adds track/asset/ticks as one Undo", async () => {
    const { project, session, api, request, calls } = fixture(), original = JSON.stringify(project);
    const packet = await prepareCounterTickDesktopV1(session, api, request);
    expect(JSON.stringify(project)).toBe(original); expect(session.getSnapshot().history.past).toHaveLength(0);
    expect(calls).toEqual(["list", "resolve", "prepare"]);
    await applyPreparedProceduralSfxPlacementV1(session, packet.placement); expect(calls).toEqual(["list", "resolve", "prepare", "resolve"]);
    const history = session.getSnapshot().history, track = history.present.tracks.find(t => t.id === request.trackId)!;
    expect(track.clips.map(c => c.timelineStart)).toEqual([.5, 1.5]); expect(history.past).toHaveLength(1); expect(history.present.assets).toHaveLength(1);
    expect(history.present.motionGraphics).toEqual(project.motionGraphics); expect(undo(history).present).toEqual(project);
    await expect(applyPreparedProceduralSfxPlacementV1(session, packet.placement)).rejects.toThrow("PACKET_INVALID");
  });
  it("omitting newTrack reuses an existing track; track creation cannot collide with an existing id", async () => {
    const f = fixture(), { newTrack: _, ...request } = f.request;
    const before = f.project.tracks.length, packet = await prepareCounterTickDesktopV1(f.session, f.api, { ...request, trackId: "audio-main" });
    await applyPreparedProceduralSfxPlacementV1(f.session, packet.placement); expect(f.session.getSnapshot().history.present.tracks).toHaveLength(before);
    const other = fixture(); await expect(prepareCounterTickDesktopV1(other.session, other.api, { ...other.request, trackId: "audio-main" })).rejects.toThrow("NEW_TRACK_ID_CONFLICT");
    expect(other.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("rejects forged host source path, creative URI, rights and source metadata before any edit", async () => {
    for (const mutate of [
      (p: PickedMedia & { absolutePath: string }) => { p.absolutePath = "D:/owned/../elsewhere.wav"; },
      (p: PickedMedia & { absolutePath: string }) => { p.asset.uri = creativeAssetUri("sfx:editkin-procedural-v1-pop-01"); },
      (p: PickedMedia & { absolutePath: string }) => { p.asset.redistributable = true; },
      (p: PickedMedia & { absolutePath: string }) => { p.asset.provenance = "Unverified source"; },
    ]) {
      const f = fixture(), resolve = f.api.resolveOriginalSfxCandidate;
      f.api.resolveOriginalSfxCandidate = async id => { const p = await resolve(id); mutate(p); return p; };
      await expect(prepareCounterTickDesktopV1(f.session, f.api, f.request)).rejects.toThrow("HOST_REPLY_INVALID");
      expect(f.session.getSnapshot().history.past).toHaveLength(0); expect(f.session.getSnapshot().history.present.assets).toHaveLength(0);
    }
  });
  it("rejects prepared media with another source SHA or asset id and leaves history untouched", async () => {
    for (const wrong of ["sha", "id"]) {
      const f = fixture(), prepare = f.api.prepareMedia;
      f.api.prepareMedia = async a => { const result = await prepare(a); if (wrong === "sha") result.derivatives.sourceSha256 = "c".repeat(64); else result.assetId = "other"; return result; };
      await expect(prepareCounterTickDesktopV1(f.session, f.api, f.request)).rejects.toThrow("MEDIA_SOURCE_SHA_INVALID"); expect(f.session.getSnapshot().history.past).toHaveLength(0);
    }
  });
  it("same-id project replacement and cancellation during host I/O cannot finish preparation", async () => {
    const f = fixture(), list = f.api.listOriginalSfxCandidates;
    f.api.listOriginalSfxCandidates = async () => { const result = await list(); f.session.replaceProject(structuredClone(f.project)); return result; };
    await expect(prepareCounterTickDesktopV1(f.session, f.api, f.request)).rejects.toThrow("PROJECT_CHANGED");
    const cancelled = fixture(), controller = new AbortController(), resolve = cancelled.api.resolveOriginalSfxCandidate;
    cancelled.api.resolveOriginalSfxCandidate = async id => { const result = await resolve(id); controller.abort(); return result; };
    await expect(prepareCounterTickDesktopV1(cancelled.session, cancelled.api, cancelled.request, controller.signal)).rejects.toThrow();
    expect(cancelled.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("changed source between prepare and apply cannot create a track or leave a partial sound import", async () => {
    const f = fixture(), packet = await prepareCounterTickDesktopV1(f.session, f.api, f.request), resolve = f.api.resolveOriginalSfxCandidate;
    f.api.resolveOriginalSfxCandidate = async id => { const p = await resolve(id); p.asset.provenance = p.asset.provenance!.replace("source-sha256=", "source-sha256=0"); return p; };
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, packet.placement)).rejects.toThrow("HOST_REPLY_INVALID");
    expect(f.session.getSnapshot().history.present.tracks.some(t => t.id === f.request.trackId)).toBe(false); expect(f.session.getSnapshot().history.present.assets).toHaveLength(0);
  });
  it("edits after preparation and a soloed unrelated track prevent inaudible or stale creation", async () => {
    const f = fixture(), packet = await prepareCounterTickDesktopV1(f.session, f.api, f.request);
    const next = dispatchCommandSafely(f.session.getSnapshot().history, { type: "rename_track", trackId: "audio-main", name: "changed" }); f.session.setHistory(next.state);
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, packet.placement)).rejects.toThrow("PROJECT_CHANGED");
    const solo = fixture(); solo.project.tracks[0].solo = true;
    await expect(prepareCounterTickDesktopV1(solo.session, solo.api, solo.request)).rejects.toThrow("TARGET_TRACK_UNAVAILABLE"); expect(solo.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("concurrent apply can commit only one new audio track and one history step", async () => {
    const f = fixture(), packet = await prepareCounterTickDesktopV1(f.session, f.api, f.request);
    const replies = await Promise.allSettled([applyPreparedProceduralSfxPlacementV1(f.session, packet.placement), applyPreparedProceduralSfxPlacementV1(f.session, packet.placement)]);
    expect(replies.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.session.getSnapshot().history.past).toHaveLength(1);
    expect(f.session.getSnapshot().history.present.tracks.filter(t => t.id === f.request.trackId)).toHaveLength(1);
  });
});

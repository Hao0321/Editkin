import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { makeRotoHoldoutFixtureV1 } from "./__fixtures__/rotoHoldoutLabelKitV1.fixture";
import { draftRotoHoldoutReviewV1, importRotoHoldoutLabelsV1 } from "./rotoHoldoutLabelImportV1";
import { prepareRotoHoldoutGateInputV1 } from "./rotoHoldoutGateInputV1";
import { rotoHoldoutDigestV1 } from "./rotoHoldoutIoV1";
import { rotoHoldoutAlpha8V1 } from "./rotoHoldoutPngV1";
import { runRotoHoldoutLabelKitCliV1 } from "../../scripts/roto-holdout-label-kit";
let root: string;
const runtime = { ffmpegPath: "unused-by-label-import", ffprobePath: "unused-by-label-import" };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-holdout-flow-")); });
afterEach(async () => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-holdout-flow-") || (await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) throw Error("Fixture cleanup boundary");
  await rm(root, { recursive: true, force: true });
});
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
async function externalEvidence(f: Awaited<ReturnType<typeof makeRotoHoldoutFixtureV1>>) {
  const bytes = Buffer.concat(await Promise.all(f.kit.clips[0].samples.map(async s => rotoHoldoutAlpha8V1(await readFile(join(f.root, s.maskPath)), 16, 16).alpha)));
  async function ref(name: string, value: unknown) {
    const path = join(root, name); const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); await writeFile(path, data);
    return { path, sha256: rotoHoldoutDigestV1(data) };
  }
  return { schema: "editkin.roto-holdout-gate-evidence/v1", candidateImplementationSha256: f.kit.candidate.implementationSha256,
    algorithmFrozenBeforeGroundTruthReveal: false, evaluatorIndependent: false, datasetVisibility: "instrument-only",
    rightsReceipt: await ref("rights.json", { schema: "editkin.holdout-rights-receipt/v1", datasetId: "instrument", commercialUsePermitted: false, sourceSeparatedFromTraining: false, ownerOrLicense: "instrument fixture only" }),
    correctionJournal: await ref("corrections.json", { schema: "editkin.roto-correction-journal/v1", reviewerIds: [f.review.reviewerIdHash],
      entries: [{ clipId: "clip-a", reviewerId: f.review.reviewerIdHash, actions: 0, seconds: 1, completed: true }] }),
    performanceReceipt: await ref("performance.json", { schema: "editkin.roto-performance-receipt/v1", deviceIdentity: "instrument only",
      samples: [0, 1, 2].map(() => ({ clipId: "clip-a", frames: 5, elapsedMs: 2, peakVramBytes: 0, failed: false })) }),
    clips: [{ id: "clip-a", candidateAlpha8: await ref("candidate.alpha8", bytes), formalAlpha8: await ref("formal.alpha8", bytes) }] };
}
describe("actual PNG -> reviewed alpha -> unchanged acceptance-gate input", () => {
  it("creates a convenient draft while preserving every false approval", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), path = join(root, "draft.json");
    expect(await draftRotoHoldoutReviewV1(f.kitPath, path, runtime)).toMatchObject({ approvalsCreated: 0, frames: 5 });
    const draft = JSON.parse(await readFile(path, "utf8")); expect(draft.entries.every((e: { approved: boolean }) => !e.approved)).toBe(true);
    expect(draft.entries.map((e: { maskSha256: string }) => e.maskSha256)).toEqual(f.review.entries.map(e => e.maskSha256));
    await expect(importRotoHoldoutLabelsV1(f.kitPath, path, join(root, "rejected"), runtime)).rejects.toThrow();
  });
  it("imports exact manually supplied grayscale values and never announces quality acceptance", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), out = join(root, "labels");
    const result = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, out, runtime);
    expect(result).toMatchObject({ frames: 5, qualityAcceptanceReady: false, status: "HUMAN_LABELS_IMPORTED_QUALITY_UNMEASURED" });
    const labels = JSON.parse(await readFile(result.manifestPath, "utf8")); expect(labels.reviewerIdHash).toBe(f.review.reviewerIdHash);
    for (const [i, s] of f.kit.clips[0].samples.entries()) {
      const expected = rotoHoldoutAlpha8V1(await readFile(join(f.root, s.maskPath)), 16, 16).alpha;
      expect(await readFile(join(out, labels.clips[0].labels[i].alphaPath))).toEqual(expected);
    }
  });
  it("requires a separate deliberate confirmation for an all-black mask", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), s = f.kit.clips[0].samples[0];
    await writeFile(join(f.root, s.maskPath), f.blank); f.review.entries[0].maskSha256 = rotoHoldoutDigestV1(f.blank); await json(f.reviewPath, f.review);
    await expect(importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "blank-refused"), runtime)).rejects.toThrow(/MASK_REVIEW/);
    f.review.entries[0].allBackgroundConfirmed = true; await json(f.reviewPath, f.review);
    await expect(importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "blank-confirmed"), runtime)).resolves.toMatchObject({ frames: 5, qualityAcceptanceReady: false });
  });
  it.each(["source", "candidate", "frame", "mask", "review"]) ("refuses changed %s without publishing a labels manifest", async kind => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), s = f.kit.clips[0].samples[0], out = join(root, "out");
    if (kind === "source") await writeFile(f.kit.clips[0].source.path, "changed source");
    if (kind === "candidate") await writeFile(f.kit.candidate.artifacts[0].path, "changed candidate");
    if (kind === "frame") await writeFile(join(f.root, s.framePath), f.blank);
    if (kind === "mask") await writeFile(join(f.root, s.maskPath), f.blank);
    if (kind === "review") { f.review.entries[0].approved = false; await json(f.reviewPath, f.review); }
    await expect(importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, out, runtime)).rejects.toThrow();
    await expect(readFile(join(out, "labels.json"))).rejects.toThrow();
  });
  it("observes cancellation during import and retains a bounded incomplete receipt", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), controller = new AbortController(), out = join(root, "cancelled");
    await expect(importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, out, { ...runtime, signal: controller.signal,
      onProgress: () => controller.abort(Error("instrument cancel")) })).rejects.toThrow(/cancel/);
    await expect(readFile(join(out, "labels.json"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(out, "INCOMPLETE.json"), "utf8")).completedFrames).toBe(1);
  });
  it("detects mask drift after an earlier frame was already consumed", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")); let mutate: Promise<void> | undefined;
    await expect(importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "changed-mid-import"), { ...runtime,
      onProgress: p => { if (p.completed === 1) mutate = writeFile(join(f.root, f.kit.clips[0].samples[0].maskPath), f.blank); } })).rejects.toThrow();
    await mutate;
  });
  it("prepares true contiguous byte order in the existing gate schema, keeping every independent flag supplied", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), imported = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "labels"), runtime);
    const evidence = await externalEvidence(f), prepared = await prepareRotoHoldoutGateInputV1(imported.manifestPath, evidence, join(root, "gate"), runtime);
    const gate = JSON.parse(await readFile(prepared.manifestPath, "utf8"));
    expect(gate).toMatchObject({ schema: "editkin.roto-quality-holdout/v1", datasetVisibility: "instrument-only", evaluatorIndependent: false,
      algorithmFrozenBeforeGroundTruthReveal: false, candidateImplementationSha256: f.kit.candidate.implementationSha256 });
    expect(prepared).toMatchObject({ frames: 5, truthBytes: 1280, qualityAcceptanceReady: false, status: "GATE_INPUT_PREPARED_NOT_EVALUATED" });
    const truth = await readFile(join(dirname(prepared.manifestPath), gate.clips[0].truthAlpha8.path));
    expect(truth).toEqual(await readFile(evidence.clips[0].candidateAlpha8.path));
    expect(rotoHoldoutDigestV1(truth)).toBe(gate.clips[0].truthAlpha8.sha256);
  });
  it("refuses sparse starter labels as temporal gate evidence", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit"), "five-points"), imported = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "labels"), runtime);
    await expect(prepareRotoHoldoutGateInputV1(imported.manifestPath, await externalEvidence(f), join(root, "gate"), runtime)).rejects.toThrow(/SPARSE/);
  });
  it.each(["candidate-hash", "rights-dataset", "raw-sequence", "truth-tamper", "truth-and-import-rehash", "duplicate-clip"]) ("refuses gate evidence %s", async kind => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), imported = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "labels"), runtime);
    const evidence = await externalEvidence(f), labels = JSON.parse(await readFile(imported.manifestPath, "utf8"));
    if (kind === "candidate-hash") evidence.candidateImplementationSha256 = "0".repeat(64);
    if (kind === "rights-dataset") { const data = Buffer.from(JSON.stringify({ schema: "editkin.holdout-rights-receipt/v1", datasetId: "other" })); await writeFile(evidence.rightsReceipt.path, data); evidence.rightsReceipt.sha256 = rotoHoldoutDigestV1(data); }
    if (kind === "raw-sequence") await writeFile(evidence.clips[0].candidateAlpha8.path, Buffer.from([1]));
    if (kind === "truth-tamper" || kind === "truth-and-import-rehash") {
      const data = Buffer.alloc(256, 64); await writeFile(join(dirname(imported.manifestPath), labels.clips[0].labels[0].alphaPath), data);
      if (kind === "truth-and-import-rehash") { labels.clips[0].labels[0].alphaSha256 = rotoHoldoutDigestV1(data); await json(imported.manifestPath, labels); }
    }
    if (kind === "duplicate-clip") evidence.clips.push({ ...evidence.clips[0] });
    await expect(prepareRotoHoldoutGateInputV1(imported.manifestPath, evidence, join(root, "gate"), runtime)).rejects.toThrow();
    await expect(readFile(join(root, "gate/holdout.json"))).rejects.toThrow();
  });
  it("requires object-label identities for occlusion categories instead of inventing identity from alpha", async () => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")); f.kit.clips[0].categories = ["full-occlusion"];
    await json(f.kitPath, f.kit); f.review.kitSha256 = rotoHoldoutDigestV1(await readFile(f.kitPath)); await json(f.reviewPath, f.review);
    const imported = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "labels"), runtime);
    await expect(prepareRotoHoldoutGateInputV1(imported.manifestPath, await externalEvidence(f), join(root, "gate"), runtime)).rejects.toThrow(/OBJECT_IDENTITIES/);
  });
  it.each(["root", "clip", "frame"]) ("refuses unknown imported-label fields at %s scope", async level => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "kit")), imported = await importRotoHoldoutLabelsV1(f.kitPath, f.reviewPath, join(root, "labels"), runtime);
    const labels = JSON.parse(await readFile(imported.manifestPath, "utf8"));
    const target = level === "root" ? labels : level === "clip" ? labels.clips[0] : labels.clips[0].labels[0]; target.syntheticApprovalOverride = true;
    await json(imported.manifestPath, labels);
    await expect(prepareRotoHoldoutGateInputV1(imported.manifestPath, await externalEvidence(f), join(root, "gate"), runtime)).rejects.toThrow();
  });
  it.each([["invalid", "--output", "D:/unused"], ["create", "--output"], ["create", "--unknown", "value"], ["import", "--output", "D:/a", "--output", "D:/b"]]) ("refuses malformed CLI arguments %o", async (...args) => {
    await expect(runRotoHoldoutLabelKitCliV1(args)).rejects.toThrow(/USAGE/);
  });
});

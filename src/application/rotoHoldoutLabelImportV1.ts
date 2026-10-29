import { dirname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import * as z from "zod/v4";
import { parseRotoHoldoutKitV1, parseRotoHoldoutReviewV1, rotoHoldoutReviewTemplateV1, rotoHoldoutTrackingSchemaV1, ROTO_HOLDOUT_MAX_BYTES_V1,
  type RotoHoldoutKitV1, type RotoHoldoutReviewV1 } from "./rotoHoldoutLabelKitV1";
import { assertRotoHoldoutLocalPathV1, createRotoHoldoutOutputV1, readRotoHoldoutFileV1, rotoHoldoutBudgetV1,
  rotoHoldoutCandidateDigestV1, rotoHoldoutDigestV1, rotoHoldoutFileIdentityV1, rotoHoldoutOwnedPathV1, type RotoHoldoutRuntimeV1 } from "./rotoHoldoutIoV1";
import { readRotoHoldoutPngV1, rotoHoldoutAlpha8V1 } from "./rotoHoldoutPngV1";

export const rotoHoldoutAlphaPathV1 = (id: string, frame: number) => `alpha/${id}/${String(frame).padStart(6, "0")}.alpha8`;
export async function loadRotoHoldoutKitV1(path: string, check: () => number) {
  const bytes = await readRotoHoldoutFileV1(path, 4 * 1024 * 1024), kit = parseRotoHoldoutKitV1(JSON.parse(bytes.toString("utf8")));
  if (rotoHoldoutCandidateDigestV1(kit.candidate.artifacts) !== kit.candidate.implementationSha256) throw Error("ROTO_HOLDOUT_CANDIDATE_IDENTITY_INVALID");
  for (const ref of [...kit.clips.map(c => c.source), ...kit.candidate.artifacts]) {
    const current = await rotoHoldoutFileIdentityV1(ref.path, check);
    if (current.sha256 !== ref.sha256 || current.bytes !== ref.bytes) throw Error("ROTO_HOLDOUT_FROZEN_INPUT_CHANGED");
  }
  return { kit, root: dirname(resolve(path)), path: resolve(path), sha256: rotoHoldoutDigestV1(bytes) };
}
export async function readRotoHoldoutLabelV1(root: string, c: RotoHoldoutKitV1["clips"][number], s: RotoHoldoutKitV1["clips"][number]["samples"][number]) {
  const reference = await readRotoHoldoutFileV1(rotoHoldoutOwnedPathV1(root, s.framePath), c.width * c.height * 4 + 65536);
  if (rotoHoldoutDigestV1(reference) !== s.frameSha256) throw Error("ROTO_HOLDOUT_REFERENCE_FRAME_CHANGED");
  readRotoHoldoutPngV1(reference, c.width, c.height);
  const mask = await readRotoHoldoutFileV1(rotoHoldoutOwnedPathV1(root, s.maskPath), c.width * c.height * 4 + 65536);
  return { ...rotoHoldoutAlpha8V1(mask, c.width, c.height), maskSha256: rotoHoldoutDigestV1(mask) };
}

/** This hashes the current masks for convenient review, but every approval remains false. */
export async function draftRotoHoldoutReviewV1(kitPath: string, outputPath: string, runtime: RotoHoldoutRuntimeV1) {
  const check = rotoHoldoutBudgetV1(runtime), frozen = await loadRotoHoldoutKitV1(kitPath, check);
  const draft = rotoHoldoutReviewTemplateV1(frozen.kit, frozen.sha256);
  const entries: Array<Omit<typeof draft.entries[number], "maskSha256"> & { maskSha256: string }> = [];
  for (const c of frozen.kit.clips) for (const s of c.samples) {
    check(); const label = await readRotoHoldoutLabelV1(frozen.root, c, s);
    entries.push({ clipId: c.id, frame: s.frame, approved: false, maskSha256: label.maskSha256, allBackgroundConfirmed: false, tracking: null });
  }
  await assertRotoHoldoutLocalPathV1(dirname(outputPath)); check();
  await writeFile(outputPath, JSON.stringify({ ...draft, entries }, null, 2) + "\n", { flag: "wx" });
  return { outputPath, frames: entries.length, status: "AWAITING_HUMAN_CONFIRMATION" as const, approvalsCreated: 0 };
}
export interface RotoHoldoutImportedLabelV1 {
  frame: number; timeSeconds: number; frameSha256: string; maskSha256: string; alphaPath: string; alphaSha256: string;
  allBackgroundConfirmed: boolean; tracking: RotoHoldoutReviewV1["entries"][number]["tracking"];
}
export interface RotoHoldoutImportV1 {
  schema: "editkin.roto-holdout-label-import/v1"; status: "HUMAN_LABELS_IMPORTED_QUALITY_UNMEASURED";
  kitPath: string; kitSha256: string; reviewPath: string; reviewSha256: string; reviewerIdHash: string; reviewedAt: string;
  candidateImplementationSha256: string; clips: Array<{ id: string; labels: RotoHoldoutImportedLabelV1[] }>;
  qualityAcceptanceReady: false;
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/), pathString = z.string().min(1).max(4096);
const importedSchema = z.strictObject({ schema: z.literal("editkin.roto-holdout-label-import/v1"), status: z.literal("HUMAN_LABELS_IMPORTED_QUALITY_UNMEASURED"),
  kitPath: pathString, kitSha256: sha256, reviewPath: pathString, reviewSha256: sha256, reviewerIdHash: z.string().regex(/^[a-f0-9]{16,128}$/),
  reviewedAt: z.string().refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s), candidateImplementationSha256: sha256,
  clips: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), labels: z.array(z.strictObject({
    frame: z.number().int().min(0).max(1439), timeSeconds: z.number().finite().nonnegative(), frameSha256: sha256, maskSha256: sha256,
    alphaPath: pathString, alphaSha256: sha256, allBackgroundConfirmed: z.boolean(), tracking: rotoHoldoutTrackingSchemaV1.nullable() })).min(1).max(1440) })).min(1).max(10),
  qualityAcceptanceReady: z.literal(false) });
export function parseRotoHoldoutImportV1(input: unknown): RotoHoldoutImportV1 { return importedSchema.parse(input); }
export async function importRotoHoldoutLabelsV1(kitPath: string, reviewPath: string, outputPath: string, runtime: RotoHoldoutRuntimeV1) {
  const check = rotoHoldoutBudgetV1(runtime), frozen = await loadRotoHoldoutKitV1(kitPath, check);
  const reviewBytes = await readRotoHoldoutFileV1(reviewPath, 4 * 1024 * 1024);
  const review = parseRotoHoldoutReviewV1(JSON.parse(reviewBytes.toString("utf8")), frozen.kit, frozen.sha256, Date.now());
  const estimated = frozen.kit.clips.reduce((n, c) => n + c.width * c.height * c.samples.length, 0);
  if (estimated + reviewBytes.length > ROTO_HOLDOUT_MAX_BYTES_V1) throw Error("ROTO_HOLDOUT_IMPORT_BYTE_BUDGET_EXCEEDED");
  const approvals = new Map(review.entries.map(e => [`${e.clipId}:${e.frame}`, e]));
  const output = await createRotoHoldoutOutputV1(outputPath, check);
  const imported: RotoHoldoutImportV1 = { schema: "editkin.roto-holdout-label-import/v1", status: "HUMAN_LABELS_IMPORTED_QUALITY_UNMEASURED",
    kitPath: frozen.path, kitSha256: frozen.sha256, reviewPath: resolve(reviewPath), reviewSha256: rotoHoldoutDigestV1(reviewBytes),
    reviewerIdHash: review.reviewerIdHash, reviewedAt: review.reviewedAt, candidateImplementationSha256: frozen.kit.candidate.implementationSha256,
    clips: [], qualityAcceptanceReady: false };
  let completed = 0;
  try {
    for (const c of frozen.kit.clips) {
      const labels = [];
      for (const s of c.samples) {
        check(); const label = await readRotoHoldoutLabelV1(frozen.root, c, s), approval = approvals.get(`${c.id}:${s.frame}`)!;
        if (label.maskSha256 !== approval.maskSha256 || label.allBackground !== approval.allBackgroundConfirmed) throw Error("ROTO_HOLDOUT_MASK_REVIEW_MISMATCH");
        const alphaPath = rotoHoldoutAlphaPathV1(c.id, s.frame); await output.write(alphaPath, label.alpha);
        labels.push({ frame: s.frame, timeSeconds: s.timeSeconds, frameSha256: s.frameSha256, maskSha256: label.maskSha256,
          alphaPath, alphaSha256: rotoHoldoutDigestV1(label.alpha), allBackgroundConfirmed: approval.allBackgroundConfirmed, tracking: approval.tracking });
        completed++; runtime.onProgress?.({ clipId: c.id, frame: s.frame, completed, total: review.entries.length });
      }
      imported.clips.push({ id: c.id, labels });
    }
    const end = await loadRotoHoldoutKitV1(kitPath, check);
    if (end.sha256 !== frozen.sha256 || rotoHoldoutDigestV1(await readRotoHoldoutFileV1(reviewPath, 4 * 1024 * 1024)) !== imported.reviewSha256) throw Error("ROTO_HOLDOUT_REVIEW_CHANGED");
    for (const c of frozen.kit.clips) for (const s of c.samples) {
      check(); const label = await readRotoHoldoutLabelV1(frozen.root, c, s);
      if (label.maskSha256 !== approvals.get(`${c.id}:${s.frame}`)!.maskSha256) throw Error("ROTO_HOLDOUT_MASK_CHANGED_DURING_IMPORT");
    }
    await output.write("labels.json", JSON.stringify(imported, null, 2) + "\n");
    return { manifestPath: join(output.path, "labels.json"), frames: completed, writtenBytes: output.writtenBytes,
      status: imported.status, qualityAcceptanceReady: false as const };
  } catch (error) {
    try { await writeFile(join(output.path, "INCOMPLETE.json"), JSON.stringify({ status: "INCOMPLETE", error: String(error), completedFrames: completed }) + "\n", { flag: "wx" }); } catch { /* Original failure wins. */ }
    throw error;
  }
}

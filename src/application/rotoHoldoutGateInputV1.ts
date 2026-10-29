import * as z from "zod/v4";
import { dirname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadRotoHoldoutKitV1, parseRotoHoldoutImportV1, readRotoHoldoutLabelV1, rotoHoldoutAlphaPathV1 } from "./rotoHoldoutLabelImportV1";
import { parseRotoHoldoutReviewV1, ROTO_HOLDOUT_MAX_BYTES_V1 } from "./rotoHoldoutLabelKitV1";
import { createRotoHoldoutOutputV1, readRotoHoldoutFileV1, rotoHoldoutBudgetV1, rotoHoldoutDigestV1,
  rotoHoldoutFileIdentityV1, rotoHoldoutOwnedPathV1, type RotoHoldoutRuntimeV1 } from "./rotoHoldoutIoV1";

const reference = z.strictObject({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const evidenceSchema = z.strictObject({ schema: z.literal("editkin.roto-holdout-gate-evidence/v1"),
  candidateImplementationSha256: z.string().regex(/^[a-f0-9]{64}$/), algorithmFrozenBeforeGroundTruthReveal: z.boolean(),
  evaluatorIndependent: z.boolean(), datasetVisibility: z.string().trim().min(1).max(64), rightsReceipt: reference,
  correctionJournal: reference, performanceReceipt: reference,
  clips: z.array(z.strictObject({ id: z.string(), candidateAlpha8: reference, formalAlpha8: reference,
    truthLabels8: reference.optional(), candidateLabels8: reference.optional() })).min(1).max(10) });

/** Writes the existing gate's input, never runs or weakens its acceptance thresholds. Sparse samples cannot become temporal truth. */
export async function prepareRotoHoldoutGateInputV1(labelsPath: string, evidenceInput: unknown, outputPath: string, runtime: RotoHoldoutRuntimeV1) {
  const check = rotoHoldoutBudgetV1(runtime), evidence = evidenceSchema.parse(evidenceInput);
  const labelBytes = await readRotoHoldoutFileV1(labelsPath, 4 * 1024 * 1024), labels = parseRotoHoldoutImportV1(JSON.parse(labelBytes.toString("utf8")));
  if (labels.schema !== "editkin.roto-holdout-label-import/v1" || labels.status !== "HUMAN_LABELS_IMPORTED_QUALITY_UNMEASURED"
    || labels.qualityAcceptanceReady !== false) throw Error("ROTO_HOLDOUT_IMPORTED_LABELS_REQUIRED");
  const frozen = await loadRotoHoldoutKitV1(labels.kitPath, check), kit = frozen.kit;
  if (kit.sampleMode !== "contiguous") throw Error("ROTO_HOLDOUT_SPARSE_LABELS_NOT_TEMPORAL_TRUTH");
  const reviewBytes = await readRotoHoldoutFileV1(labels.reviewPath, 4 * 1024 * 1024);
  const review = parseRotoHoldoutReviewV1(JSON.parse(reviewBytes.toString("utf8")), kit, frozen.sha256, Date.now());
  if (labels.kitSha256 !== frozen.sha256 || labels.reviewSha256 !== rotoHoldoutDigestV1(reviewBytes)
    || labels.reviewerIdHash !== review.reviewerIdHash || labels.reviewedAt !== review.reviewedAt
    || labels.candidateImplementationSha256 !== kit.candidate.implementationSha256
    || evidence.candidateImplementationSha256 !== kit.candidate.implementationSha256) throw Error("ROTO_HOLDOUT_IMPORT_BINDING_CHANGED");
  if (!Array.isArray(labels.clips) || labels.clips.length !== kit.clips.length || evidence.clips.length !== kit.clips.length
    || new Set(evidence.clips.map(c => c.id)).size !== evidence.clips.length) throw Error("ROTO_HOLDOUT_GATE_CLIP_COVERAGE_INVALID");
  const importedRoot = dirname(resolve(labelsPath)), approvals = new Map(review.entries.map(e => [`${e.clipId}:${e.frame}`, e]));
  const externals = [];
  for (const ref of [evidence.rightsReceipt, evidence.correctionJournal, evidence.performanceReceipt]) {
    const identity = await rotoHoldoutFileIdentityV1(ref.path, check);
    if (identity.sha256 !== ref.sha256 || identity.bytes > 4 * 1024 * 1024) throw Error("ROTO_HOLDOUT_GATE_RECEIPT_CHANGED"); externals.push(identity);
  }
  const rights = JSON.parse((await readRotoHoldoutFileV1(externals[0].path, 4 * 1024 * 1024)).toString("utf8"));
  if (rights.schema !== "editkin.holdout-rights-receipt/v1" || rights.datasetId !== kit.datasetId) throw Error("ROTO_HOLDOUT_RIGHTS_DATASET_MISMATCH");
  for (const [index, c] of kit.clips.entries()) {
    const imported = labels.clips[index], provided = evidence.clips.find(e => e.id === c.id);
    if (!provided || imported.id !== c.id || !Array.isArray(imported.labels) || imported.labels.length !== c.frameCount) throw Error("ROTO_HOLDOUT_LABEL_COVERAGE_INVALID");
    for (const [n, s] of c.samples.entries()) {
      const label = imported.labels[n], approval = approvals.get(`${c.id}:${s.frame}`)!;
      if (label.frame !== s.frame || label.timeSeconds !== s.timeSeconds || label.frameSha256 !== s.frameSha256 || label.maskSha256 !== approval.maskSha256
        || label.alphaPath !== rotoHoldoutAlphaPathV1(c.id, s.frame) || label.allBackgroundConfirmed !== approval.allBackgroundConfirmed
        || JSON.stringify(label.tracking) !== JSON.stringify(approval.tracking)) throw Error("ROTO_HOLDOUT_IMPORTED_FRAME_CHANGED");
      const bytes = await readRotoHoldoutFileV1(rotoHoldoutOwnedPathV1(importedRoot, label.alphaPath), c.width * c.height);
      if (bytes.length !== c.width * c.height || rotoHoldoutDigestV1(bytes) !== label.alphaSha256) throw Error("ROTO_HOLDOUT_ALPHA_TRUTH_CHANGED");
      const approvedPng = await readRotoHoldoutLabelV1(frozen.root, c, s);
      if (approvedPng.maskSha256 !== approval.maskSha256 || approvedPng.allBackground !== approval.allBackgroundConfirmed
        || rotoHoldoutDigestV1(approvedPng.alpha) !== label.alphaSha256) throw Error("ROTO_HOLDOUT_ALPHA_NOT_THE_REVIEWED_PNG");
    }
    if (c.categories.some(category => ["multi-object", "full-occlusion", "reappearance"].includes(category)) && (!provided.truthLabels8 || !provided.candidateLabels8)) throw Error("ROTO_HOLDOUT_OBJECT_IDENTITIES_REQUIRED");
    for (const ref of [provided.candidateAlpha8, provided.formalAlpha8, provided.truthLabels8, provided.candidateLabels8]) {
      if (!ref) continue;
      const identity = await rotoHoldoutFileIdentityV1(ref.path, check);
      if (identity.sha256 !== ref.sha256 || identity.bytes !== c.width * c.height * c.frameCount) throw Error("ROTO_HOLDOUT_GATE_SEQUENCE_INVALID"); externals.push(identity);
    }
  }
  const expectedBytes = kit.clips.reduce((n, c) => n + c.width * c.height * c.frameCount, 0);
  if (expectedBytes > ROTO_HOLDOUT_MAX_BYTES_V1 - 65536) throw Error("ROTO_HOLDOUT_GATE_TRUTH_BYTE_BUDGET_EXCEEDED");
  const output = await createRotoHoldoutOutputV1(outputPath, check); const clips = [];
  try {
    for (const [index, c] of kit.clips.entries()) {
      const imported = labels.clips[index], provided = evidence.clips.find(e => e.id === c.id)!;
      async function* chunks() {
        for (const label of imported.labels) {
          check(); const bytes = await readRotoHoldoutFileV1(rotoHoldoutOwnedPathV1(importedRoot, label.alphaPath), c.width * c.height);
          if (rotoHoldoutDigestV1(bytes) !== label.alphaSha256) throw Error("ROTO_HOLDOUT_ALPHA_TRUTH_CHANGED"); yield bytes;
        }
      }
      const path = await output.sequence(`truth/${c.id}.alpha8`, c.width * c.height * c.frameCount, chunks());
      const truth = await rotoHoldoutFileIdentityV1(path, check);
      clips.push({ id: c.id, width: c.width, height: c.height, frames: c.frameCount, fps: c.analysisFps, categories: c.categories,
        source: { path: c.source.path, sha256: c.source.sha256 }, truthAlpha8: { path: `truth/${c.id}.alpha8`, sha256: truth.sha256 },
        candidateAlpha8: provided.candidateAlpha8, formalAlpha8: provided.formalAlpha8,
        ...(provided.truthLabels8 ? { truthLabels8: provided.truthLabels8 } : {}), ...(provided.candidateLabels8 ? { candidateLabels8: provided.candidateLabels8 } : {}) });
    }
    for (const ref of externals) {
      const current = await rotoHoldoutFileIdentityV1(ref.path, check); if (current.sha256 !== ref.sha256) throw Error("ROTO_HOLDOUT_EXTERNAL_EVIDENCE_CHANGED");
    }
    const end = await loadRotoHoldoutKitV1(labels.kitPath, check);
    if (end.sha256 !== frozen.sha256 || rotoHoldoutDigestV1(await readRotoHoldoutFileV1(labelsPath, 4 * 1024 * 1024)) !== rotoHoldoutDigestV1(labelBytes)
      || rotoHoldoutDigestV1(await readRotoHoldoutFileV1(labels.reviewPath, 4 * 1024 * 1024)) !== labels.reviewSha256) throw Error("ROTO_HOLDOUT_LABEL_EVIDENCE_CHANGED");
    const manifest = { schema: "editkin.roto-quality-holdout/v1", frozenAt: kit.frozenAt, candidateEngine: kit.candidate.engine,
      candidateImplementationSha256: kit.candidate.implementationSha256, algorithmFrozenBeforeGroundTruthReveal: evidence.algorithmFrozenBeforeGroundTruthReveal,
      evaluatorIndependent: evidence.evaluatorIndependent, datasetVisibility: evidence.datasetVisibility, rightsReceipt: evidence.rightsReceipt,
      correctionJournal: evidence.correctionJournal, performanceReceipt: evidence.performanceReceipt, clips };
    await output.write("label-provenance.json", JSON.stringify({ kitPath: frozen.path, kitSha256: frozen.sha256, reviewSha256: labels.reviewSha256,
      reviewerIdHash: labels.reviewerIdHash, labelsSha256: rotoHoldoutDigestV1(labelBytes), qualityAcceptanceReady: false,
      policy: "Independent gate still required; no human, rights, performance, quality or blind-holdout assertion is created by this adapter" }, null, 2) + "\n");
    await output.write("holdout.json", JSON.stringify(manifest, null, 2) + "\n");
    return { manifestPath: join(output.path, "holdout.json"), frames: kit.clips.reduce((n, c) => n + c.frameCount, 0),
      truthBytes: expectedBytes, writtenBytes: output.writtenBytes, status: "GATE_INPUT_PREPARED_NOT_EVALUATED" as const, qualityAcceptanceReady: false as const };
  } catch (error) {
    try { await writeFile(join(output.path, "INCOMPLETE.json"), JSON.stringify({ status: "INCOMPLETE", error: String(error) }) + "\n", { flag: "wx" }); } catch { /* Original failure wins. */ }
    throw error;
  }
}

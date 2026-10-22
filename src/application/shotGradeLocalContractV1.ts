import * as z from "zod/v4";
import { shotGradeRegionSchemaV1 } from "./shotGradeDecisionV1";

const id = z.string().trim().min(1).max(160), label = z.string().trim().min(1).max(120);
const sample = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), time: z.number().finite().nonnegative() });
export const shotGradeLocalSourceV1Schema = z.strictObject({
  clipId: id, samples: z.array(sample).min(1).max(4), regions: z.array(shotGradeRegionSchemaV1).max(32).default([]),
}).superRefine((source, ctx) => {
  const names = new Set(source.samples.map(s => s.id));
  if (names.size !== source.samples.length || source.samples.some((s, i) => i > 0 && s.time <= source.samples[i - 1].time)) ctx.addIssue({ code: "custom", message: "LOCAL_GRADE_SAMPLES_UNIQUE_INCREASING" });
  if (source.regions.some(r => !names.has(r.sampleId))) ctx.addIssue({ code: "custom", message: "LOCAL_GRADE_REGION_SAMPLE_REQUIRED" });
});
const destination = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("append"), label }), z.strictObject({ kind: z.literal("replace"), nodeId: id, label })]);
const common = { schema: z.literal("editkin.shot-grade-local-request/v1"), expectedRevision: z.number().int().nonnegative(),
  target: shotGradeLocalSourceV1Schema, destination, roiBasis: z.literal("local-layer-raster-normalized"),
  reason: z.string().trim().min(1).max(500), highBitDepth: z.boolean().default(false), maximumTimeMs: z.number().finite().positive().max(60000).default(20000) };
export const shotGradeLocalRequestV1Schema = z.discriminatedUnion("mode", [
  z.strictObject({ ...common, mode: z.literal("shot_match"), reference: shotGradeLocalSourceV1Schema }),
  z.strictObject({ ...common, mode: z.literal("auto_balance") }),
]).superRefine((request, ctx) => {
  if (request.mode === "shot_match" && request.target.clipId === request.reference.clipId) ctx.addIssue({ code: "custom", message: "LOCAL_GRADE_DISTINCT_REFERENCE_REQUIRED" });
});
export type ShotGradeLocalRequestV1 = z.input<typeof shotGradeLocalRequestV1Schema>;
export type ParsedShotGradeLocalRequestV1 = z.output<typeof shotGradeLocalRequestV1Schema>;
export type ShotGradeLocalSourceV1 = z.output<typeof shotGradeLocalSourceV1Schema>;
export class ShotGradeLocalRefusalV1 extends Error {
  constructor(readonly code: string) { super(`SHOT_GRADE_LOCAL_${code}`); this.name = "ShotGradeLocalRefusalV1"; }
}
export function refuseShotGradeLocalV1(code: string): never { throw new ShotGradeLocalRefusalV1(code); }

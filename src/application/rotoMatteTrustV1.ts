import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { rotoV2DigestSchema } from "./autoRotoV2Contract";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const rotoMatteIdentitySchemaV1 = z.strictObject({ schema: z.literal("editkin.roto-matte-identity/v1"),
  sourceSha256: rotoV2DigestSchema, cutoutSha256: rotoV2DigestSchema, alphaSha256: rotoV2DigestSchema,
  analysisSha256: rotoV2DigestSchema, nativeCoreSha256: rotoV2DigestSchema, sourceStart: z.number().finite().nonnegative(),
  width: z.number().int().min(16).max(8192), height: z.number().int().min(16).max(8192), frameCount: z.number().int().min(1).max(1440),
  fps: z.number().finite().min(1).max(60), qualityState: z.literal("diagnostic") });
export type RotoMatteIdentityV1 = z.infer<typeof rotoMatteIdentitySchemaV1>;
const confirmation = z.strictObject({ schema: z.literal("editkin.roto-subject-confirmation/v1"),
  identity: rotoMatteIdentitySchemaV1, identitySha256: rotoV2DigestSchema, subjectCorrect: z.literal(true),
  reviewerId: rotoV2DigestSchema, reviewedAt: z.string(), fromFrame: z.literal(0), toFrame: z.number().int().nonnegative(),
  scope: z.literal("subject-placement-only"), qualityState: z.literal("diagnostic"), benchmarkAccepted: z.literal(false) });
export type RotoMatteTrustV1 = z.infer<typeof confirmation>;

/** Called only for an explicit subject-correct action. It never runs as part of analysis/bake. */
export function confirmRotoSubjectV1(input: unknown, action: { subjectCorrect: boolean; reviewerId: string; reviewedAt: string }, now = Date.now()): RotoMatteTrustV1 {
  const identity = rotoMatteIdentitySchemaV1.parse(input);
  if (action.subjectCorrect !== true) throw Error("ROTO_TRUST_EXPLICIT_SUBJECT_CONFIRMATION_REQUIRED");
  const date = Date.parse(action.reviewedAt);
  if (!Number.isFinite(date) || new Date(date).toISOString() !== action.reviewedAt || date > now + 300000 || now - date > 86400000) throw Error("ROTO_TRUST_REVIEW_TIME_INVALID");
  return confirmation.parse({ schema: "editkin.roto-subject-confirmation/v1", identity, identitySha256: digest(identity), subjectCorrect: true,
    reviewerId: action.reviewerId, reviewedAt: action.reviewedAt, fromFrame: 0, toFrame: identity.frameCount - 1,
    scope: "subject-placement-only", qualityState: "diagnostic", benchmarkAccepted: false });
}
/** A changed source, matte, window, implementation or cutout invalidates subject trust. */
export function verifyRotoMatteTrustV1(input: unknown, expected: unknown) {
  const value = confirmation.parse(input), identity = rotoMatteIdentitySchemaV1.parse(expected);
  const reviewed = Date.parse(value.reviewedAt);
  if (!Number.isFinite(reviewed) || new Date(reviewed).toISOString() !== value.reviewedAt || reviewed > Date.now() + 300000
    || value.toFrame !== identity.frameCount - 1 || value.identitySha256 !== digest(value.identity)
    || value.identitySha256 !== digest(identity)) throw Error("ROTO_TRUST_STALE_OR_DIFFERENT_MATTE");
  return value;
}

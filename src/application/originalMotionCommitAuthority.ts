import { timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { sha256Canonical, verifyAuthenticatedOriginalMotionCommit } from "./autopilotInvocationIdentity";
import { prepareUserCommitSigningKey, signUserCommitDigest } from "../security/userCommitSigningKey";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const protection = z.enum(["windows_dpapi_current_user", "posix_owner_only"]);
const keyIdentitySchema = z.strictObject({ keyId: digest, protection });
const proofSchema = keyIdentitySchema.extend({ issuerProof: digest });
const persistentSealSchema = z.strictObject({
  schema: z.literal("editkin.original-motion-commit-seal/v2"),
  scope: z.literal("protected_user"),
  keyId: digest,
  protection,
  receiptSha256: digest,
  issuerProof: digest,
});

export type OriginalMotionCommitAuthorityKey = Readonly<z.infer<typeof keyIdentitySchema>>;

/** Prepare only before a verified atomic apply consumes its one-use audit.
 * The fixed OS-user store is owned by the product, never by a project/caller.
 * Audit issuance stays process-local; its secret is not persisted here. */
export async function prepareOriginalMotionCommitAuthority(): Promise<OriginalMotionCommitAuthorityKey> {
  return Object.freeze(keyIdentitySchema.parse(await prepareUserCommitSigningKey()));
}

function committedBase(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Original Motion commit receipt missing");
  const value = input as Record<string, unknown>;
  if (value.schema !== "hao.video-autopilot.execution-receipt/v1" || value.state !== "committed"
    || value.planSchema !== "hao.video-autopilot.edit-plan/v4" || !value.originalMotionBinding) {
    throw new Error("Original Motion persistent seal requires a committed v4 source-bound receipt");
  }
  return value;
}

/** Seal exactly the new authenticated apply result. This never upgrades old
 * same-process receipts and never creates/replaces a missing signing key. */
export async function sealPersistentOriginalMotionCommit(
  input: Record<string, unknown>,
  preparedKey: OriginalMotionCommitAuthorityKey,
): Promise<Record<string, unknown>> {
  const base = committedBase(input);
  if (Object.hasOwn(base, "issuerSeal")) throw new Error("Original Motion persistent seal cannot reseal an existing receipt");
  const expectedKey = keyIdentitySchema.parse(preparedKey), receiptSha256 = sha256Canonical(base);
  const proof = proofSchema.parse(await signUserCommitDigest(receiptSha256, expectedKey.keyId));
  if (proof.keyId !== expectedKey.keyId || proof.protection !== expectedKey.protection) throw new Error("Original Motion commit signing authority changed after preparation");
  if (sha256Canonical(base) !== receiptSha256) throw new Error("Original Motion commit changed during signing");
  return { ...base, issuerSeal: {
    schema: "editkin.original-motion-commit-seal/v2", scope: "protected_user",
    keyId: proof.keyId, protection: proof.protection, receiptSha256, issuerProof: proof.issuerProof,
  } };
}

/** The owned receipt reader calls this before exposing a saved commit to the
 * renderer. Legacy v1 can still verify in its original process only; it is
 * never promoted to v2. Verification does not initialize a trust store. */
export async function verifyOriginalMotionCommitAuthority(input: unknown): Promise<Record<string, unknown>> {
  const value = committedBase(input), issuerSeal = value.issuerSeal;
  if (issuerSeal && typeof issuerSeal === "object" && !Array.isArray(issuerSeal)
    && (issuerSeal as Record<string, unknown>).schema === "editkin.original-motion-commit-seal/v1") {
    return verifyAuthenticatedOriginalMotionCommit(value);
  }
  const seal = persistentSealSchema.parse(issuerSeal);
  const { issuerSeal: _seal, ...base } = value;
  if (sha256Canonical(base) !== seal.receiptSha256) throw new Error("Original Motion persistent committed receipt changed");
  const proof = proofSchema.parse(await signUserCommitDigest(seal.receiptSha256, seal.keyId));
  if (proof.keyId !== seal.keyId || proof.protection !== seal.protection) throw new Error("Original Motion persistent signing authority differs");
  const expected = Buffer.from(proof.issuerProof, "hex"), provided = Buffer.from(seal.issuerProof, "hex");
  if (!timingSafeEqual(provided, expected)) throw new Error("Original Motion persistent committed receipt is not authenticated");
  const { issuerSeal: currentSeal, ...currentBase } = value;
  if (sha256Canonical(currentBase) !== seal.receiptSha256 || sha256Canonical(currentSeal) !== sha256Canonical(seal)) {
    throw new Error("Original Motion persistent receipt changed during authentication");
  }
  return value;
}

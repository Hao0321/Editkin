import { beforeEach, describe, expect, it, vi } from "vitest";
import { sealAuthenticatedOriginalMotionCommit, sha256Canonical } from "./autopilotInvocationIdentity";
import { prepareOriginalMotionCommitAuthority, sealPersistentOriginalMotionCommit, verifyOriginalMotionCommitAuthority } from "./originalMotionCommitAuthority";

const backend = vi.hoisted(() => ({ missing: false, prepares: 0, signs: 0, pending: undefined as undefined | (() => Promise<void>) }));
vi.mock("../security/userCommitSigningKey", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const syntheticKey = Buffer.alloc(32, 52), keyId = createHash("sha256").update(syntheticKey).digest("hex");
  return {
    prepareUserCommitSigningKey: async () => { backend.prepares++; if (backend.missing) throw new Error("Controlled key missing"); return { keyId, protection: "posix_owner_only" }; },
    signUserCommitDigest: async (digest: string, expectedKeyId: string) => {
      backend.signs++; if (backend.pending) await backend.pending();
      if (backend.missing || expectedKeyId !== keyId) throw new Error("Controlled key missing or identity mismatch");
      return { keyId, protection: "posix_owner_only", issuerProof: createHmac("sha256", syntheticKey).update(`original-motion-commit:v2:${digest}`).digest("hex") };
    },
  };
});

beforeEach(() => { backend.missing = false; backend.prepares = 0; backend.signs = 0; backend.pending = undefined; });
function receipt() { return { schema: "hao.video-autopilot.execution-receipt/v1", state: "committed",
  planSchema: "hao.video-autopilot.edit-plan/v4", receiptId: "controlled-authenticated-commit",
  originalMotionBinding: { originalSourceEvidenceSha256: "a".repeat(64) }, quality: { certified: false }, projectRevisionAfter: 1 }; }

describe("persistent original Motion authority (controlled OS backend, real digest/proof parsing)", () => {
  it("seals exact committed bytes and verifies a disk-style reopened object without preparing a key", async () => {
    const base = receipt(), key = await prepareOriginalMotionCommitAuthority();
    const sealed = await sealPersistentOriginalMotionCommit(base, key);
    const opened = JSON.parse(JSON.stringify(sealed));
    expect(Object.isFrozen(key)).toBe(true);
    expect(sealed).toHaveProperty("issuerSeal.scope", "protected_user");
    expect(sealed).toHaveProperty("issuerSeal.receiptSha256", sha256Canonical(base));
    await expect(verifyOriginalMotionCommitAuthority(opened)).resolves.toBe(opened);
    expect(backend.prepares).toBe(1); expect(backend.signs).toBe(2);
  });

  it("rejects content drift before accessing the signing authority and rejects a forged proof", async () => {
    const sealed = await sealPersistentOriginalMotionCommit(receipt(), await prepareOriginalMotionCommitAuthority());
    const signs = backend.signs;
    await expect(verifyOriginalMotionCommitAuthority({ ...sealed, projectRevisionAfter: 2 })).rejects.toThrow(/receipt changed/);
    expect(backend.signs).toBe(signs);
    await expect(verifyOriginalMotionCommitAuthority({ ...sealed, issuerSeal: { ...(sealed.issuerSeal as object), issuerProof: "0".repeat(64) } })).rejects.toThrow(/not authenticated/);
  });

  it("cannot replace a missing/changed key during verify or turn an existing seal into a new seal", async () => {
    const key = await prepareOriginalMotionCommitAuthority(), sealed = await sealPersistentOriginalMotionCommit(receipt(), key);
    backend.missing = true;
    await expect(verifyOriginalMotionCommitAuthority(sealed)).rejects.toThrow(/key missing/);
    expect(backend.prepares).toBe(1);
    backend.missing = false;
    await expect(verifyOriginalMotionCommitAuthority({ ...sealed, issuerSeal: { ...(sealed.issuerSeal as object), keyId: "0".repeat(64) } })).rejects.toThrow(/identity mismatch/);
    await expect(sealPersistentOriginalMotionCommit(sealed, key)).rejects.toThrow(/cannot reseal/);
  });

  it("rejects changed bytes while the signing backend is pending", async () => {
    const base = receipt(), key = await prepareOriginalMotionCommitAuthority();
    let finish!: () => void; backend.pending = () => new Promise<void>(resolve => { finish = resolve; });
    const signing = sealPersistentOriginalMotionCommit(base, key);
    base.projectRevisionAfter = 2; finish();
    await expect(signing).rejects.toThrow(/changed during signing/);
  });

  it("preserves v1 same-process verification without upgrading it or accessing persistent keys", async () => {
    const legacy = sealAuthenticatedOriginalMotionCommit(receipt());
    await expect(verifyOriginalMotionCommitAuthority(legacy)).resolves.toBe(legacy);
    expect(backend.prepares).toBe(0); expect(backend.signs).toBe(0);
    await expect(sealPersistentOriginalMotionCommit(legacy, { keyId: "a".repeat(64), protection: "posix_owner_only" })).rejects.toThrow(/cannot reseal/);
  });

  it("rejects top-level receipt changes while persistent authentication is pending", async () => {
    const sealed = await sealPersistentOriginalMotionCommit(receipt(), await prepareOriginalMotionCommitAuthority());
    let finish!: () => void; backend.pending = () => new Promise<void>(resolve => { finish = resolve; });
    const checking = verifyOriginalMotionCommitAuthority(sealed);
    sealed.projectRevisionAfter = 2; finish();
    await expect(checking).rejects.toThrow(/changed during authentication/);
  });

  it("fails closed for unknown scope/version, extra proof fields and unsigned/pending receipts", async () => {
    const sealed = await sealPersistentOriginalMotionCommit(receipt(), await prepareOriginalMotionCommitAuthority());
    const signs = backend.signs;
    for (const value of [receipt(), { ...sealed, state: "pending" },
      ...[{ scope: "workspace" }, { schema: "editkin.original-motion-commit-seal/v3" }, { extraKeyPath: "caller.key" }].map(patch => ({ ...sealed, issuerSeal: { ...(sealed.issuerSeal as object), ...patch } }))]) {
      await expect(verifyOriginalMotionCommitAuthority(value)).rejects.toThrow();
    }
    expect(backend.signs).toBe(signs);
  });
});

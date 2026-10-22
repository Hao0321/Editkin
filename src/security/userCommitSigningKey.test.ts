import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ownedParent = join(app, ".rd", "benchmarks", "native-paint-preview-output-20261004", "user-commit-key-tests");
let root: string, entry: string;
const digest = "a".repeat(64);
type Metadata = { keyId: string; protection: string; issuerProof?: string };

beforeAll(async () => {
  await mkdir(ownedParent, { recursive: true });
  root = await mkdtemp(join(ownedParent, "isolated-"));
  entry = join(root, "private-entry.ts");
  const source = await readFile(new URL("./userCommitSigningKey.ts", import.meta.url), "utf8");
  // The production module has no public or ENV path override. Append an entry
  // inside an exact source copy so only this isolated process can call the
  // module-private factory. No I/O reaches the default userStore.
  await writeFile(entry, `${source}\nconst r = JSON.parse(process.argv[2]);\nconst isolatedStore = createUserCommitSigningKeyStore(r.root);\ntry { console.log(JSON.stringify(await (r.op === "prepare" ? isolatedStore.prepare() : isolatedStore.sign(r.digest, r.expected)))); } catch { process.stderr.write("isolated-key-operation-rejected\\n"); process.exitCode = 1; }\n`);
  await writeFile(join(root, "SOURCE_SHA256.txt"), createHash("sha256").update(source).digest("hex"));
});

afterAll(async () => {
  // Precise test ownership, not a shared store or general Temp cleanup.
  const within = relative(ownedParent, root);
  if (!within || within.startsWith("..") || resolve(ownedParent, within) !== root) throw new Error("Test cleanup ownership rejected");
  await rm(root, { recursive: true, force: true });
});

async function child(trustRoot: string, op: "prepare" | "sign", expected?: string, value = digest): Promise<Metadata> {
  const loader = pathToFileURL(join(app, "node_modules", "tsx", "dist", "loader.mjs")).href;
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, ["--import", loader, entry, JSON.stringify({ root: trustRoot, op, digest: value, expected })], {
      cwd: app, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let result = "", total = 0;
    const timer = setTimeout(() => { processChild.kill(); reject(new Error("Isolated key child timed out")); }, 25_000);
    processChild.stdout.on("data", (bytes: Buffer) => { total += bytes.length; if (total > 8192) processChild.kill(); else result += bytes.toString("utf8"); });
    processChild.stderr.resume();
    processChild.on("error", (error) => { clearTimeout(timer); reject(error); });
    processChild.on("close", (code) => { clearTimeout(timer); if (code !== 0 || total > 8192) reject(new Error("Isolated key operation rejected")); else { try { done(JSON.parse(result)); } catch { reject(new Error("Invalid key metadata")); } } });
  });
}

describe("OS-user original Motion commit signing key", () => {
  it("keeps one key across concurrent prepare and actual restarted signing processes", async () => {
    const trust = join(root, "concurrent");
    const attempts = await Promise.allSettled([child(trust, "prepare"), child(trust, "prepare"), child(trust, "prepare")]);
    const identities = attempts.map((item) => { if (item.status === "rejected") throw item.reason; return item.value; });
    expect(new Set(identities.map((item) => item.keyId)).size).toBe(1);
    expect(identities[0].keyId).toMatch(/^[a-f0-9]{64}$/);
    expect(identities[0].protection).toBe(process.platform === "win32" ? "windows_dpapi_current_user" : "posix_owner_only");
    const id = identities[0].keyId;
    const first = await child(trust, "sign", id);
    const restarted = await child(trust, "sign", id);
    expect(restarted).toEqual(first);
    expect(first.issuerProof).toMatch(/^[a-f0-9]{64}$/);
    expect((await child(trust, "sign", id, "b".repeat(64))).issuerProof).not.toEqual(first.issuerProof);
    const blobBefore = createHash("sha256").update(await readFile(join(trust, "signing-key.v2"))).digest("hex");
    await expect(child(trust, "sign", "0".repeat(64))).rejects.toThrow("rejected");
    expect(createHash("sha256").update(await readFile(join(trust, "signing-key.v2"))).digest("hex")).toBe(blobBefore);
  }, 90_000);

  it("never creates a missing key or store during sign", async () => {
    const trust = join(root, "missing");
    await expect(child(trust, "sign")).rejects.toThrow("rejected");
    await expect(lstat(trust)).rejects.toMatchObject({ code: "ENOENT" });
    const identity = await child(trust, "prepare");
    await unlink(join(trust, "signing-key.v2"));
    await expect(child(trust, "sign", identity.keyId)).rejects.toThrow("rejected");
    await expect(lstat(join(trust, "signing-key.v2"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it("rejects a damaged existing key without replacing its bytes", async () => {
    const trust = join(root, "damaged");
    const identity = await child(trust, "prepare");
    const keyPath = join(trust, "signing-key.v2");
    const handle = await open(keyPath, "r+");
    try {
      if (process.platform === "win32") {
        // Preserve a valid-size DPAPI blob, but corrupt its authenticated
        // ciphertext. This exercises Unprotect rather than only a size guard.
        const bytes = await readFile(keyPath);
        bytes[bytes.length - 1] ^= 1;
        await handle.write(bytes, 0, bytes.length, 0);
      } else await handle.truncate(17);
      await handle.sync();
    } finally { await handle.close(); }
    const damagedHash = createHash("sha256").update(await readFile(keyPath)).digest("hex");
    await expect(child(trust, "prepare")).rejects.toThrow("rejected");
    await expect(child(trust, "sign", identity.keyId)).rejects.toThrow("rejected");
    expect(createHash("sha256").update(await readFile(keyPath)).digest("hex")).toBe(damagedHash);
  }, 45_000);

  it("rejects directory reparse/symlink and hard-linked key paths", async () => {
    const target = join(root, "link-target"), alias = join(root, "link-alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(child(alias, "prepare")).rejects.toThrow("rejected");
    await expect(lstat(join(target, "signing-key.v2"))).rejects.toMatchObject({ code: "ENOENT" });
    const trust = join(root, "hardlink");
    const identity = await child(trust, "prepare");
    const keyPath = join(trust, "signing-key.v2"), extra = join(root, "extra-key-link");
    await link(keyPath, extra);
    await expect(child(trust, "sign", identity.keyId)).rejects.toThrow("rejected");
    await unlink(extra);
    expect((await child(trust, "sign", identity.keyId)).keyId).toBe(identity.keyId);
  }, 60_000);
});

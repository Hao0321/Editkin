import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpsServer } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { assertUpdateManifestUrl, createUpdateTransaction, markUpdateHealthy, parseUpdateManifest, readUpdateTransaction, recordUpdateLaunch, rollbackInstaller, signerIdentityMatches, stageUpdate } from "./updateManager";

const workspaces: string[] = [];
afterEach(async () => Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function manifest(bytes: Uint8Array) {
  return {
    schemaVersion: 1 as const, version: "0.3.0", publishedAt: "2026-08-21T00:00:00.000Z", minimumProjectSchema: 3,
    windowsX64: { url: "https://updates.example/hao-0.3.0.exe", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

describe("secure updater", () => {
  it("stages a newer HTTPS artifact, verifies sha256 and then hits cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "hao-update-test-"));
    workspaces.push(root);
    const bytes = new TextEncoder().encode("signed-installer-fixture");
    const options = { currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root, fetcher: async () => new Response(bytes) };
    const first = await stageUpdate(manifest(bytes), options);
    expect(first?.cacheHit).toBe(false);
    const second = await stageUpdate(manifest(bytes), { ...options, fetcher: async () => { throw new Error("cache should avoid network"); } });
    expect(second?.cacheHit).toBe(true);
  });

  it("streams an HTTPS artifact through the native transport without Fetch or Undici", async () => {
    const root = await mkdtemp(join(tmpdir(), "hao-update-native-https-"));
    workspaces.push(root);
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const certificate = await readFile(join(process.cwd(), "tests/fixtures/update-localhost-cert.pem"));
    const key = await readFile(join(process.cwd(), "tests/fixtures/update-localhost-key.pem"));
    const server = createHttpsServer({ cert: certificate, key }, (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength, connection: "close" });
      response.end(bytes);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTPS fixture did not bind a TCP port");
      const input = manifest(bytes);
      input.windowsX64.url = `https://127.0.0.1:${address.port}/update.exe`;
      const staged = await stageUpdate(input, { currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root, httpsCa: certificate });
      expect(staged?.cacheHit).toBe(false);
      const artifact = await readFile(staged!.artifactPath);
      expect(artifact.equals(bytes)).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 15_000);

  it("rejects non-HTTPS and corrupted artifacts", async () => {
    const bytes = new TextEncoder().encode("expected");
    expect(() => parseUpdateManifest({ ...manifest(bytes), windowsX64: { ...manifest(bytes).windowsX64, url: "http://unsafe.example/update.exe" } })).toThrow(/HTTPS/);
    const root = await mkdtemp(join(tmpdir(), "hao-update-test-"));
    workspaces.push(root);
    await expect(stageUpdate(manifest(bytes), { currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root, fetcher: async () => new Response("tampered") })).rejects.toThrow(/SHA-256/);
  });

  it("requires an exact signer subject and SHA-256 certificate identity", () => {
    const expected = { subject: "CN=Editkin Studio, O=Hao", certificateSha256: "a".repeat(64) };
    expect(signerIdentityMatches({ subject: " cn=editkin studio, o=hao ", certificateSha256: "A".repeat(64) }, expected)).toBe(true);
    expect(signerIdentityMatches({ subject: "CN=Editkin Studio Evil, O=Hao", certificateSha256: "a".repeat(64) }, expected)).toBe(false);
    expect(signerIdentityMatches({ subject: expected.subject, certificateSha256: "b".repeat(64) }, expected)).toBe(false);
  });

  it("rejects unsafe manifest metadata and bounded-download overflow", async () => {
    const bytes = new TextEncoder().encode("expected");
    expect(() => assertUpdateManifestUrl("http://updates.example/stable.json")).toThrow(/HTTPS/);
    expect(() => assertUpdateManifestUrl("https://user:secret@updates.example/stable.json")).toThrow(/帳號密碼/);
    expect(() => parseUpdateManifest({ ...manifest(bytes), publishedAt: "not-a-date" })).toThrow(/publishedAt/);
    expect(() => parseUpdateManifest({ ...manifest(bytes), minimumProjectSchema: 3.5 })).toThrow(/欄位/);
    expect(() => parseUpdateManifest({ ...manifest(bytes), windowsX64: { ...manifest(bytes).windowsX64, signatureSubject: "" } })).toThrow(/欄位/);
    expect(() => parseUpdateManifest({ ...manifest(bytes), windowsX64: { ...manifest(bytes).windowsX64, signatureSubject: "CN=Editkin" } })).toThrow(/欄位/);
    expect(() => parseUpdateManifest({ ...manifest(bytes), windowsX64: { ...manifest(bytes).windowsX64, signatureSha256: "a".repeat(64) } })).toThrow(/欄位/);
    expect(parseUpdateManifest({ ...manifest(bytes), windowsX64: { ...manifest(bytes).windowsX64, signatureSubject: " CN=Editkin ", signatureSha256: "A".repeat(64) } }).windowsX64).toMatchObject({ signatureSubject: "CN=Editkin", signatureSha256: "a".repeat(64) });
    const root = await mkdtemp(join(tmpdir(), "hao-update-overflow-"));
    workspaces.push(root);
    await expect(stageUpdate(manifest(bytes), {
      currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root,
      fetcher: async () => new Response("expected-plus-unbounded-tail"),
    })).rejects.toThrow(/超過 manifest/);
  });

  it("promotes healthy updates and exposes rollback only after two failed launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "hao-update-state-"));
    workspaces.push(root);
    const previous = join(root, "previous.exe");
    await writeFile(previous, "previous");
    const statePath = join(root, "transaction.json");
    await createUpdateTransaction(statePath, { fromVersion: "0.2.0", toVersion: "0.3.0", stagedArtifact: join(root, "next.exe"), previousInstaller: previous });
    expect((await recordUpdateLaunch(statePath)).status).toBe("applying");
    expect(await rollbackInstaller(statePath)).toBeUndefined();
    expect((await recordUpdateLaunch(statePath)).status).toBe("rollback_required");
    expect(await rollbackInstaller(statePath)).toBe(previous);
    expect((await markUpdateHealthy(statePath, "0.3.0")).status).toBe("healthy");
    expect(JSON.parse(await readFile(statePath, "utf8")).status).toBe("healthy");
  });

  it("recovers a corrupted transaction from the previous durable state and remains idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hao-update-recovery-"));
    workspaces.push(root);
    const statePath = join(root, "transaction.json");
    await createUpdateTransaction(statePath, { fromVersion: "0.2.0", toVersion: "0.3.0", stagedArtifact: join(root, "next.exe") });
    await recordUpdateLaunch(statePath);
    await writeFile(statePath, "{partial");
    expect((await readUpdateTransaction(statePath))?.status).toBe("staged");
    expect((await recordUpdateLaunch(statePath)).status).toBe("applying");
    expect((await markUpdateHealthy(statePath, "0.3.0")).status).toBe("healthy");
    expect((await markUpdateHealthy(statePath, "0.3.0")).status).toBe("healthy");
    expect((await readUpdateTransaction(statePath))?.launchAttempts).toBe(1);
  });

  it("fails closed when both transaction copies are corrupt and never invents a rollback installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hao-update-corrupt-"));
    workspaces.push(root);
    const statePath = join(root, "transaction.json");
    await writeFile(statePath, "{broken");
    await writeFile(`${statePath}.previous`, JSON.stringify({ schemaVersion: 1, status: "healthy" }));
    await expect(readUpdateTransaction(statePath)).rejects.toThrow();
    await expect(rollbackInstaller(statePath)).rejects.toThrow();
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadUpdateManifest,
  MAX_UPDATE_MANIFEST_BYTES,
  parseUpdateManifest,
  parseUpdatePublisherPin,
  stageUpdate,
  type UpdatePublisherPin,
} from "./updateManager";

const workspaces: string[] = [];
afterEach(async () => Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const pin: UpdatePublisherPin = {
  manifestUrl: "https://updates.example/stable.json",
  signatureSubject: "CN=Editkin Studio, O=Hao",
  signatureSha256: "a".repeat(64),
};
const bytes = new TextEncoder().encode("signed-installer-fixture");

function manifest(signer: { signatureSubject?: string; signatureSha256?: string } = {
  signatureSubject: pin.signatureSubject, signatureSha256: pin.signatureSha256,
}) {
  return {
    schemaVersion: 1 as const, version: "0.3.0", publishedAt: "2026-08-21T00:00:00.000Z", minimumProjectSchema: 3,
    windowsX64: { url: "https://updates.example/editkin-0.3.0.exe", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), ...signer },
  };
}

const pinDocument = { schema: "editkin.update-publisher-pin/v1", ...pin };

describe("update publisher pin", () => {
  it("treats an all-null pin as no update channel and rejects half-configured pins", () => {
    expect(parseUpdatePublisherPin({ schema: pinDocument.schema, manifestUrl: null, signatureSubject: null, signatureSha256: null })).toBeUndefined();
    for (const field of ["manifestUrl", "signatureSubject", "signatureSha256"] as const) {
      expect(() => parseUpdatePublisherPin({ ...pinDocument, [field]: null })).toThrow(/同時設定/u);
    }
  });

  it("normalizes a complete pin and rejects unsafe or non-canonical values", () => {
    expect(parseUpdatePublisherPin({ ...pinDocument, signatureSubject: ` ${pin.signatureSubject} ` })).toEqual(pin);
    expect(() => parseUpdatePublisherPin({ ...pinDocument, manifestUrl: "http://updates.example/stable.json" })).toThrow(/HTTPS/u);
    expect(() => parseUpdatePublisherPin({ ...pinDocument, signatureSha256: "A".repeat(64) })).toThrow(/小寫 SHA-256/u);
    expect(() => parseUpdatePublisherPin({ ...pinDocument, signatureSubject: "  " })).toThrow(/signatureSubject/u);
    expect(() => parseUpdatePublisherPin({ ...pinDocument, extra: true })).toThrow(/封閉集合/u);
    expect(() => parseUpdatePublisherPin({ ...pinDocument, schema: "editkin.update-publisher-pin/v2" })).toThrow(/schema/u);
  });
});

describe("manifest signer must equal the pinned publisher", () => {
  it("accepts the pinned identity regardless of subject case and fingerprint case", () => {
    const parsed = parseUpdateManifest(manifest({ signatureSubject: " cn=editkin studio, o=hao ", signatureSha256: "A".repeat(64) }), pin);
    expect(parsed.windowsX64.signatureSha256).toBe("a".repeat(64));
  });

  it.each([
    ["another subject", { signatureSubject: "CN=Attacker", signatureSha256: pin.signatureSha256 }],
    ["another certificate", { signatureSubject: pin.signatureSubject, signatureSha256: "b".repeat(64) }],
    ["an unsigned manifest", {}],
  ])("rejects %s", (_name, signer) => {
    expect(() => parseUpdateManifest(manifest(signer), pin)).toThrow(/發布者身分不符合內建釘選/u);
  });

  it("refuses to download an installer for a manifest signed by anyone else", async () => {
    // The update cache refuses non-canonical roots, and macOS tmpdir() sits behind a symlink.
    const root = await realpath(await mkdtemp(join(tmpdir(), "editkin-pin-stage-")));
    workspaces.push(root);
    const fetcher = vi.fn(async () => new Response(bytes));
    const attacker = manifest({ signatureSubject: "CN=Attacker", signatureSha256: "b".repeat(64) });
    await expect(stageUpdate(attacker, { currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root, fetcher, publisher: pin }))
      .rejects.toThrow(/發布者身分不符合內建釘選/u);
    expect(fetcher).not.toHaveBeenCalled();
    const staged = await stageUpdate(manifest(), { currentVersion: "0.2.0", currentProjectSchema: 3, cacheRoot: root, fetcher, publisher: pin });
    expect(staged).toMatchObject({ version: "0.3.0", signatureSubject: pin.signatureSubject, signatureSha256: pin.signatureSha256 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("bounded update manifest download", () => {
  const json = (body: unknown = manifest()) => new Response(JSON.stringify(body));
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it("requests without following redirects automatically and validates the result against the pin", async () => {
    const fetcher = vi.fn(async () => json());
    const loaded = await loadUpdateManifest(pin.manifestUrl, { publisher: pin, fetcher });
    expect(loaded.version).toBe("0.3.0");
    expect(fetcher).toHaveBeenCalledWith(pin.manifestUrl, expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
    await expect(loadUpdateManifest(pin.manifestUrl, { publisher: pin, fetcher: async () => json(manifest({})) })).rejects.toThrow(/發布者身分/u);
  });

  it("follows HTTPS redirects but never requests a redirect target that is not HTTPS", async () => {
    const fetcher = vi.fn(async (url: string) => url === pin.manifestUrl ? redirect("https://cdn.example/stable.json") : json());
    expect((await loadUpdateManifest(pin.manifestUrl, { fetcher })).version).toBe("0.3.0");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([pin.manifestUrl, "https://cdn.example/stable.json"]);

    const downgrade = vi.fn(async () => redirect("http://cdn.example/stable.json"));
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher: downgrade })).rejects.toThrow(/HTTPS/u);
    expect(downgrade).toHaveBeenCalledTimes(1);
  });

  it("stops redirect loops", async () => {
    const fetcher = vi.fn(async () => redirect("https://updates.example/again.json"));
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher })).rejects.toThrow(/重新導向過多/u);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized manifests whether the size is declared or streamed", async () => {
    const declared = new Response("{}", { headers: { "content-length": String(MAX_UPDATE_MANIFEST_BYTES + 1) } });
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher: async () => declared })).rejects.toThrow(/超過/u);
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const endless = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); },
    }));
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher: async () => endless })).rejects.toThrow(/超過/u);
    expect(sent).toBeLessThanOrEqual(MAX_UPDATE_MANIFEST_BYTES + 3 * chunk.byteLength);
  });

  it("reports HTTP failures and malformed JSON without leaking a parser exception", async () => {
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher: async () => new Response("no", { status: 503 }) })).rejects.toThrow(/HTTP 503/u);
    await expect(loadUpdateManifest(pin.manifestUrl, { fetcher: async () => new Response("{not json") })).rejects.toThrow(/不是有效 JSON/u);
  });
});

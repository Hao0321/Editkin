import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listCreativeLibrary, resolveCreativeLibraryAsset } from "./creativeLibrary";
import { validatePublicAssetRights, validatePublicGrant } from "../shared/visualAssetRights.mjs";

async function communityFixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-community-pack-"));
  const bytes = Buffer.from("community source fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "sample.mp4"), bytes);
  const asset = {
    id: "sample", name: "Sample", category: "broll", role: "broll", domains: ["test"],
    mediaKind: "video", path: "sample.mp4", bytes: bytes.length, sha256,
    license: "CC0-1.0", provenance: "synthetic community test", renderer: "media-asset",
  };
  const manifest = {
    schemaVersion: 1, id: "editkin.community.test", name: "Community test", version: "1.0.0", attribution: "Editkin",
    source: { privateImagesEmbedded: false }, assetCount: 1, assetBytes: bytes.length,
    portability: { relativePathsOnly: true, privateWorkspaceEmbedded: false, originalPrivateReferencesEmbedded: false },
    assets: [asset],
  };
  const save = () => writeFile(join(root, "editkin-pack.json"), JSON.stringify(manifest));
  await save();
  return { root, asset, manifest, save };
}

describe("community Creative Library", () => {
  it("lists metadata without exposing a local path and verifies selected bytes", async () => {
    const { root, asset } = await communityFixture();
    const listed = await listCreativeLibrary(root);
    expect(listed.assets).toHaveLength(1);
    expect(listed.assets[0]).not.toHaveProperty("path");
    expect(listed.assets[0]).not.toHaveProperty("sha256");
    const resolved = await resolveCreativeLibraryAsset(root, asset.id);
    expect(resolved.sha256).toBe(asset.sha256);
    expect(resolved.absolutePath).toBe(join(root, "sample.mp4"));
  });

  it("rejects private sources and paths that escape the pack", async () => {
    const sample = await communityFixture();
    sample.manifest.portability.privateWorkspaceEmbedded = true;
    await sample.save();
    await expect(listCreativeLibrary(sample.root)).rejects.toThrow(/私人來源/);
    sample.manifest.portability.privateWorkspaceEmbedded = false;
    sample.manifest.assets[0].path = "../outside.mp4";
    await sample.save();
    await expect(resolveCreativeLibraryAsset(sample.root, "sample")).rejects.toThrow(/路徑不安全/);
  });

  it("accepts standard rights and rejects owner grant claims absent from this edition", () => {
    expect(validatePublicAssetRights({ id: "sample", license: "CC0-1.0" })).toEqual({ kind: "standard" });
    expect(() => validatePublicAssetRights({ id: "owner-visual:test", license: "MIT" })).toThrow(/not included/);
    expect(() => validatePublicGrant({ ownerVisualGrant: {}, assets: [] })).toThrow(/absent/);
  });
});

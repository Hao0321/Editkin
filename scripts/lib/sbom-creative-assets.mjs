import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  OWNER_VISUAL_LICENSE,
  validatePublicGrant,
  validatePublicAssetRights,
} from "../../src/shared/visualAssetRights.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function collectCreativeAssetSbom(packRoot) {
  const boundary = await realpath(packRoot);
  async function file(path) {
    if (
      typeof path !== "string" ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.includes(":")
    )
      throw new Error("unsafe-sbom-asset-path");
    const absolute = resolve(boundary, path);
    if (!absolute.startsWith(boundary + sep))
      throw new Error("unsafe-sbom-asset-path");
    let current = boundary;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("linked-sbom-asset-path");
    }
    const info = await lstat(absolute);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("nonregular-sbom-asset");
    return { absolute, info };
  }
  const manifestFile = await file("editkin-pack.json");
  const bytes = await readFile(manifestFile.absolute);
  const manifest = JSON.parse(bytes);
  let docBytes;
  if (manifest.ownerVisualGrant)
    docBytes = await readFile(
      (await file(manifest.ownerVisualGrant.document.path)).absolute,
    );
  const validated = validatePublicGrant(manifest, {
    documentSha256: docBytes ? sha(docBytes) : undefined,
  });
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== manifest.assetCount
  )
    throw new Error("sbom-asset-count");
  const assetPackages = [];
  const seen = new Set();
  const paths = new Set();
  for (const asset of manifest.assets) {
    validatePublicAssetRights(asset, validated?.grant);
    if (seen.has(asset.id) || paths.has(asset.path))
      throw new Error("duplicate-sbom-asset");
    seen.add(asset.id);
    paths.add(asset.path);
    const actual = await file(asset.path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(actual.absolute))
      hash.update(chunk);
    if (actual.info.size !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error("sbom-asset-byte-mismatch");
    assetPackages.push({
      name: `creative-${asset.id}`,
      version: manifest.version,
      license: asset.license,
      scope: "bundled-creative-original",
      checksum: { algorithm: "SHA256", value: asset.sha256 },
    });
  }
  // The pack inventory is not CC0 merely because the SPDX document is CC0.
  assetPackages.push({
    name: "editkin-creator-pack-manifest",
    version: manifest.version,
    license: [...new Set(manifest.assets.map((item) => item.license))]
      .sort()
      .join(" AND "),
    scope: "bundled-creative-inventory",
    checksum: { algorithm: "SHA256", value: sha(bytes) },
  });
  const extractedLicenses = [];
  if (validated) {
    assetPackages.push({
      name: "editkin-owner-visual-grant-document",
      version: validated.grant.id,
      license: OWNER_VISUAL_LICENSE,
      scope: "bundled-owner-visual-grant",
      checksum: { algorithm: "SHA256", value: sha(docBytes) },
    });
    assetPackages.push({
      name: "editkin-owner-visual-grant-manifest",
      version: validated.grant.id,
      license: OWNER_VISUAL_LICENSE,
      scope: "embedded-owner-visual-grant-json",
      checksum: {
        algorithm: "SHA256",
        value: sha(JSON.stringify(validated.grant)),
      },
    });
    extractedLicenses.push({
      licenseId: OWNER_VISUAL_LICENSE,
      name: "Editkin owner visual bundle grant",
      extractedText: docBytes.toString("utf8"),
    });
  }
  return { assetPackages, extractedLicenses, identity: sha(bytes) };
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collectCreativeAssetSbom } from "./lib/sbom-creative-assets.mjs";
import { buildSpdx, validateSpdx } from "./lib/sbom.mjs";
import {
  OWNER_VISUAL_GRANT,
  OWNER_VISUAL_LICENSE,
  OWNER_VISUAL_GRANT_ID,
  validatePublicGrant,
} from "../src/shared/visualAssetRights.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await mkdtemp(join(tmpdir(), "editkin-sbom-creative-"));
await mkdir(join(root, "assets"));
const bytes = Buffer.from("synthetic public original");
await writeFile(join(root, "assets/fixture.mp4"), bytes);
const manifest = {
  version: "1",
  assetCount: 1,
  assets: [
    {
      id: "fixture",
      path: "assets/fixture.mp4",
      license: "CC-BY-4.0",
      bytes: bytes.length,
      sha256: sha(bytes),
    },
  ],
};
const save = async (value) =>
  writeFile(join(root, "editkin-pack.json"), JSON.stringify(value));
await save(manifest);
const result = await collectCreativeAssetSbom(root);
assert.equal(result.assetPackages.length, 2);
assert.equal(result.extractedLicenses.length, 0);
assert.equal(result.assetPackages[0].checksum.value, sha(bytes));
const controls = ["actual standard asset bytes and manifest checksums"];
for (const [name, mutate] of [
  [
    "private license",
    (m) => {
      m.assets[0].license = "PRIVATE-OWNER-ONLY";
    },
  ],
  [
    "private id",
    (m) => {
      m.assets[0].id = "private-visual:renamed";
    },
  ],
  [
    "unknown license",
    (m) => {
      m.assets[0].license = "UNREVIEWED";
    },
  ],
  [
    "traversal",
    (m) => {
      m.assets[0].path = "../fixture.mp4";
    },
  ],
  [
    "wrong hash",
    (m) => {
      m.assets[0].sha256 = "a".repeat(64);
    },
  ],
  [
    "wrong size",
    (m) => {
      m.assets[0].bytes++;
    },
  ],
  [
    "duplicate id",
    (m) => {
      m.assets.push({ ...m.assets[0] });
      m.assetCount++;
    },
  ],
]) {
  const bad = structuredClone(manifest);
  mutate(bad);
  await save(bad);
  await assert.rejects(() => collectCreativeAssetSbom(root));
  controls.push(name + " rejected");
}
// True canonical permission/membership/doc validation, without pretending fabricated bytes are authorized media.
const doc = await readFile(
  new URL(
    "../../../community/hao-motion-kit/OWNER_VISUAL_BUNDLE_GRANT.md",
    import.meta.url,
  ),
);
const ownerManifest = {
  version: "1",
  assetCount: OWNER_VISUAL_GRANT.assets.length,
  ownerVisualGrant: OWNER_VISUAL_GRANT,
  assets: OWNER_VISUAL_GRANT.assets.map((a) => ({
    ...a,
    path: `assets/${a.id.replace(":", "-")}.mp4`,
    mediaKind: "video",
    license: OWNER_VISUAL_LICENSE,
    rightsBasis: OWNER_VISUAL_GRANT_ID,
    distributionScope: "bundled-redistributable",
    redistributable: true,
  })),
};
assert(validatePublicGrant(ownerManifest, { documentSha256: sha(doc) }));
const sbom = buildSpdx({
  productName: "Editkin",
  productVersion: "1",
  lockIdentity: "a".repeat(64),
  npmPackages: [],
  cargoPackages: [],
  runtimePackages: [],
  assetPackages: [
    {
      name: "owner-grant",
      version: "1",
      license: OWNER_VISUAL_LICENSE,
      checksum: { algorithm: "SHA256", value: sha(doc) },
    },
  ],
  extractedLicenses: [
    { licenseId: OWNER_VISUAL_LICENSE, extractedText: doc.toString("utf8") },
  ],
});
assert.equal(
  validateSpdx(sbom, { productVersion: "1", minimumPackages: 2 }).status,
  "GREEN",
);
await mkdir(join(root, "licenses"));
await writeFile(
  join(root, OWNER_VISUAL_GRANT.document.path),
  Buffer.from("tampered grant"),
);
await save(ownerManifest);
await assert.rejects(
  () => collectCreativeAssetSbom(root),
  /grant document SHA/,
);
controls.push(
  "actual grant document tampering rejected before media inventory",
);
console.log(
  JSON.stringify({
    status: "GREEN",
    controls,
    root,
    scope:
      "isolated collector + canonical grant text/membership; full new owner pack original-byte collection not yet run",
  }),
);

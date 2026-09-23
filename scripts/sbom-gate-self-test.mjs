import { strict as assert } from "node:assert";
import { buildSpdx, validateSpdx } from "./lib/sbom.mjs";

const fixture = {
  productName: "Editkin",
  productVersion: "1.2.3",
  lockIdentity: "a".repeat(64),
  npmPackages: [
    {
      name: "react",
      version: "1",
      source: "https://registry.npmjs.org/react",
      license: "MIT",
      checksum: { algorithm: "SHA512", value: "b".repeat(128) },
    },
  ],
  cargoPackages: [
    {
      name: "serde",
      version: "1",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      license: "MIT OR Apache-2.0",
    },
  ],
  runtimePackages: [
    {
      name: "ffmpeg",
      version: "8",
      source: "https://ffmpeg.org",
      license: "GPL-3.0-or-later",
      checksum: { algorithm: "SHA256", value: "c".repeat(64) },
    },
  ],
};
const positive = buildSpdx(fixture);
assert.equal(
  validateSpdx(positive, { productVersion: "1.2.3", minimumPackages: 4 })
    .status,
  "GREEN",
);
const missingLicense = structuredClone(positive);
missingLicense.packages[1].licenseDeclared = "NOASSERTION";
assert(
  validateSpdx(missingLicense, {
    productVersion: "1.2.3",
    minimumPackages: 4,
  }).findings.some((item) => item.code === "missing-declared-license"),
);
const duplicate = structuredClone(positive);
duplicate.packages.push(duplicate.packages[1]);
assert(
  validateSpdx(duplicate, {
    productVersion: "1.2.3",
    minimumPackages: 4,
  }).findings.some((item) => item.code === "duplicate-or-missing-id"),
);
const stale = structuredClone(positive);
assert(
  validateSpdx(stale, {
    productVersion: "1.2.4",
    minimumPackages: 4,
  }).findings.some((item) => item.code === "product-version"),
);
const dangling = structuredClone(positive);
dangling.relationships[0].relatedSpdxElement = "SPDXRef-Missing";
assert(
  validateSpdx(dangling, {
    productVersion: "1.2.3",
    minimumPackages: 4,
  }).findings.some((item) => item.code === "dangling-relationship"),
);
const ownerLicense = "LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0";
const owner = buildSpdx({
  ...fixture,
  assetPackages: [
    {
      name: "creator-owned-original",
      version: "1",
      license: ownerLicense,
      checksum: { algorithm: "SHA256", value: "d".repeat(64) },
    },
  ],
  extractedLicenses: [
    {
      licenseId: ownerLicense,
      name: "Owner audiovisual grant",
      extractedText:
        "Bundle and audiovisual creation only; not CC0 or independent signing.",
    },
  ],
});
assert.equal(
  validateSpdx(owner, { productVersion: "1.2.3", minimumPackages: 5 }).status,
  "GREEN",
);
assert.equal(
  owner.packages.find((p) => p.name === "creator-owned-original")
    .licenseDeclared,
  ownerLicense,
);
assert.equal(owner.dataLicense, "CC0-1.0");
delete owner.hasExtractedLicensingInfos;
assert(
  validateSpdx(owner, {
    productVersion: "1.2.3",
    minimumPackages: 5,
  }).findings.some((f) => f.code === "missing-owner-visual-license-text"),
);
process.stdout.write(
  `${JSON.stringify({ status: "GREEN", detected: ["missing-declared-license", "duplicate-or-missing-id", "product-version", "dangling-relationship"] })}\n`,
);

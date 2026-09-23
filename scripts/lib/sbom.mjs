import { createHash } from "node:crypto";

function spdxId(ecosystem, name, version, source = "") {
  const slug =
    String(name)
      .replace(/[^A-Za-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "package";
  const digest = createHash("sha256")
    .update(`${ecosystem}\0${name}\0${version}\0${source}`)
    .digest("hex")
    .slice(0, 12);
  return `SPDXRef-${ecosystem}-${slug}-${digest}`;
}

export function normalizeLicense(value) {
  const raw = Array.isArray(value)
    ? value
        .map((item) => item?.type ?? item)
        .filter(Boolean)
        .join(" OR ")
    : value;
  if (!raw || typeof raw !== "string") return "NOASSERTION";
  if (raw === "BSD") return "BSD-3-Clause";
  if (/^SEE LICEN[CS]E IN /i.test(raw)) return "LicenseRef-See-Package-License";
  return raw.trim().replace(/\s*\/\s*/g, " OR ");
}

function checksum(entry) {
  if (!entry.checksum?.algorithm || !entry.checksum?.value) return undefined;
  return [
    {
      algorithm: entry.checksum.algorithm,
      checksumValue: entry.checksum.value.toUpperCase(),
    },
  ];
}

export function buildSpdx({
  productName,
  productVersion,
  lockIdentity,
  npmPackages,
  cargoPackages,
  runtimePackages,
  assetPackages = [],
  extractedLicenses = [],
}) {
  const rootId = "SPDXRef-Editkin";
  const inputs = [
    ...npmPackages.map((item) => ({ ...item, ecosystem: "npm" })),
    ...cargoPackages.map((item) => ({ ...item, ecosystem: "cargo" })),
    ...runtimePackages.map((item) => ({ ...item, ecosystem: "runtime" })),
    ...assetPackages.map((item) => ({ ...item, ecosystem: "asset" })),
  ];
  const unique = new Map();
  for (const item of inputs)
    unique.set(
      `${item.ecosystem}\0${item.name}\0${item.version}\0${item.source ?? ""}`,
      item,
    );
  const packages = [...unique.values()]
    .sort((left, right) =>
      `${left.ecosystem}:${left.name}:${left.version}`.localeCompare(
        `${right.ecosystem}:${right.name}:${right.version}`,
        "en",
      ),
    )
    .map((item) => {
      const id = spdxId(item.ecosystem, item.name, item.version, item.source);
      return {
        SPDXID: id,
        name: item.name,
        versionInfo: item.version,
        downloadLocation: item.source || "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: normalizeLicense(item.license),
        licenseDeclared: normalizeLicense(item.license),
        copyrightText: "NOASSERTION",
        ...(checksum(item) ? { checksums: checksum(item) } : {}),
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:${["runtime", "asset"].includes(item.ecosystem) ? "generic" : item.ecosystem}/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
          },
        ],
        ...(item.scope
          ? { comment: `Editkin inventory scope: ${item.scope}` }
          : {}),
      };
    });
  const product = {
    SPDXID: rootId,
    name: productName,
    versionInfo: productVersion,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "Copyright Hao0321 Studio",
  };
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${productName}-${productVersion}-dependency-inventory`,
    documentNamespace: `https://editkin.studio/spdx/${productName.toLowerCase()}-${productVersion}-${lockIdentity}`,
    creationInfo: {
      created: "1970-01-01T00:00:00.000Z",
      creators: ["Tool: Editkin deterministic SBOM generator"],
    },
    documentDescribes: [rootId],
    ...(extractedLicenses.length
      ? {
          hasExtractedLicensingInfos: extractedLicenses
            .map((item) => ({ ...item }))
            .sort((a, b) => a.licenseId.localeCompare(b.licenseId)),
        }
      : {}),
    packages: [product, ...packages],
    relationships: packages.map((item) => ({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: item.SPDXID,
    })),
  };
}

export function validateSpdx(
  document,
  { productVersion, minimumPackages = 100 } = {},
) {
  const findings = [];
  if (
    document?.spdxVersion !== "SPDX-2.3" ||
    document?.dataLicense !== "CC0-1.0"
  )
    findings.push({ code: "document-contract" });
  const packages = Array.isArray(document?.packages) ? document.packages : [];
  if (packages.length < minimumPackages)
    findings.push({
      code: "package-coverage",
      actual: packages.length,
      minimum: minimumPackages,
    });
  const root = packages.find((item) => item.SPDXID === "SPDXRef-Editkin");
  if (!root || root.versionInfo !== productVersion)
    findings.push({
      code: "product-version",
      expected: productVersion,
      actual: root?.versionInfo,
    });
  const seen = new Set();
  const licenseIds = new Set();
  for (const license of document?.hasExtractedLicensingInfos ?? []) {
    if (
      !/^LicenseRef-[A-Za-z0-9.-]+$/.test(license.licenseId) ||
      licenseIds.has(license.licenseId) ||
      typeof license.extractedText !== "string" ||
      !license.extractedText.trim()
    )
      findings.push({
        code: "invalid-extracted-license",
        licenseId: license.licenseId,
      });
    licenseIds.add(license.licenseId);
  }
  for (const item of packages) {
    if (!item.SPDXID || seen.has(item.SPDXID))
      findings.push({ code: "duplicate-or-missing-id", id: item.SPDXID });
    seen.add(item.SPDXID);
    if (
      item.SPDXID !== "SPDXRef-Editkin" &&
      (!item.licenseDeclared || item.licenseDeclared === "NOASSERTION")
    )
      findings.push({
        code: "missing-declared-license",
        package: item.name,
        version: item.versionInfo,
      });
    const ownerLicense = "LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0";
    if (
      String(item.licenseDeclared).split(/\s+/).includes(ownerLicense) &&
      !licenseIds.has(ownerLicense)
    )
      findings.push({
        code: "missing-owner-visual-license-text",
        package: item.name,
      });
  }
  for (const relationship of document?.relationships ?? []) {
    if (
      !seen.has(relationship.spdxElementId) ||
      !seen.has(relationship.relatedSpdxElement)
    )
      findings.push({ code: "dangling-relationship", relationship });
  }
  return {
    status: findings.length ? "BLOCK" : "GREEN",
    packages: packages.length,
    findings,
  };
}

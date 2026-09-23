import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildSpdx, normalizeLicense, validateSpdx } from "./lib/sbom.mjs";
import { collectCreativeAssetSbom } from "./lib/sbom-creative-assets.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const packageLockBytes = await readFile(resolve(root, "package-lock.json"));
const cargoLockPaths = [
  resolve(root, "src-tauri/Cargo.lock"),
  resolve(root, "native/hao-core/Cargo.lock"),
];
const cargoLockBytes = await Promise.all(
  cargoLockPaths.map((path) => readFile(path)),
);
const lockIdentity = createHash("sha256")
  .update(packageLockBytes)
  .update(cargoLockBytes[0])
  .update(cargoLockBytes[1])
  .digest("hex");
const packageLock = JSON.parse(packageLockBytes);

function npmName(path, entry) {
  if (entry.name) return entry.name;
  const tail = path
    .slice(path.lastIndexOf("node_modules/") + "node_modules/".length)
    .split("/");
  return tail[0].startsWith("@") ? `${tail[0]}/${tail[1]}` : tail[0];
}

const npmPackages = [];
for (const [path, entry] of Object.entries(packageLock.packages ?? {})) {
  if (!path || entry.link || !entry.version) continue;
  let license = entry.license;
  if (!license) {
    try {
      const installed = JSON.parse(
        await readFile(resolve(root, path, "package.json"), "utf8"),
      );
      license = installed.license ?? installed.licenses;
    } catch {
      /* The lock remains authoritative for packages not installed on this platform. */
    }
  }
  const integrity =
    typeof entry.integrity === "string"
      ? entry.integrity.match(/^sha(256|384|512)-(.+)$/i)
      : undefined;
  npmPackages.push({
    name: npmName(path, entry),
    version: entry.version,
    source: entry.resolved,
    license: normalizeLicense(license),
    scope: entry.dev ? "build" : "runtime",
    checksum: integrity
      ? {
          algorithm: `SHA${integrity[1]}`,
          value: Buffer.from(integrity[2], "base64").toString("hex"),
        }
      : undefined,
  });
}

const cargoExecutable =
  process.env.CARGO ||
  join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
const cargoCommand = existsSync(cargoExecutable) ? cargoExecutable : "cargo";
const cargoPackages = [];
for (const manifest of ["src-tauri/Cargo.toml", "native/hao-core/Cargo.toml"]) {
  const result = spawnSync(
    cargoCommand,
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      manifest,
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `cargo metadata failed for ${manifest}: ${result.stderr || result.error?.message || result.status}`,
    );
  const metadata = JSON.parse(result.stdout);
  for (const item of metadata.packages) {
    if (!item.source) continue;
    cargoPackages.push({
      name: item.name,
      version: item.version,
      source: item.source,
      license: item.license,
      scope: "runtime",
    });
  }
}

const sha256File = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const nodeManifest = JSON.parse(
  await readFile(resolve(root, "vendor/node/win32-x64/manifest.json"), "utf8"),
);
const ffmpegManifest = JSON.parse(
  await readFile(
    resolve(root, "vendor/ffmpeg/win32-x64/manifest.json"),
    "utf8",
  ),
);
const whisperManifest = JSON.parse(
  await readFile(
    resolve(root, "vendor/whisper/win32-x64/manifest.json"),
    "utf8",
  ),
);
const fontManifest = JSON.parse(
  await readFile(resolve(root, "public/fonts/editkin-open-fonts.json"), "utf8"),
);
const runtimePackages =
  process.platform === "win32"
    ? [
        {
          name: "node",
          version: nodeManifest.version,
          source: nodeManifest.source,
          license: "MIT",
          scope: "bundled-runtime",
          checksum: { algorithm: "SHA256", value: nodeManifest.nodeExeSha256 },
        },
        {
          name: "ffmpeg",
          version: ffmpegManifest.ffmpeg.version,
          source: ffmpegManifest.source,
          license: "GPL-3.0-or-later",
          scope: "bundled-runtime",
          checksum: {
            algorithm: "SHA256",
            value: await sha256File(
              resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
            ),
          },
        },
        {
          name: "ffprobe",
          version: ffmpegManifest.ffprobe.version,
          source: ffmpegManifest.source,
          license: "GPL-3.0-or-later",
          scope: "bundled-runtime",
          checksum: {
            algorithm: "SHA256",
            value: await sha256File(
              resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
            ),
          },
        },
        {
          name: "whisper.cpp",
          version: whisperManifest.version,
          source: whisperManifest.source,
          license: "MIT",
          scope: "bundled-runtime",
          checksum: {
            algorithm: "SHA256",
            value: await sha256File(
              resolve(root, "vendor/whisper/win32-x64/whisper-cli.exe"),
            ),
          },
        },
        {
          name: "hao-core",
          version: "0.4.0",
          source: "NOASSERTION",
          license: "MIT",
          scope: "bundled-runtime",
          checksum: {
            algorithm: "SHA256",
            value: await sha256File(
              resolve(root, "native/bin/win32-x64/hao-core.exe"),
            ),
          },
        },
      ]
    : [];
for (const font of fontManifest.fonts)
  runtimePackages.push({
    name: `font-${font.id}`,
    version: fontManifest.sourceCommit,
    source: font.source,
    license: font.license,
    scope: "bundled-open-font",
    checksum: { algorithm: "SHA256", value: font.sha256 },
  });

const creative = await collectCreativeAssetSbom(
  resolve(root, ".creative-packs/hao-creator-library"),
);
const inventoryIdentity = createHash("sha256")
  .update(lockIdentity)
  .update(creative.identity)
  .digest("hex");
const document = buildSpdx({
  productName: packageJson.productName,
  productVersion: packageJson.version,
  lockIdentity: inventoryIdentity,
  npmPackages,
  cargoPackages,
  runtimePackages,
  ...creative,
});
const report = validateSpdx(document, { productVersion: packageJson.version });
if (report.status !== "GREEN")
  throw new Error(
    `SBOM validation failed: ${JSON.stringify(report.findings.slice(0, 20))}`,
  );
const outputRoot = resolve(root, "release");
await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "editkin.spdx.json"),
  `${JSON.stringify(document, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(outputRoot, "THIRD_PARTY_NOTICES.md"),
  await readFile(resolve(root, "THIRD_PARTY_NOTICES.md")),
  { flag: "w" },
);
process.stdout.write(
  `${JSON.stringify({ status: "GREEN", outputRoot, packages: report.packages, lockIdentity })}\n`,
);

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectExtractedPayload } from "./lib/security-hardening.mjs";

const root = await mkdtemp(join(tmpdir(), "editkin-security-music-"));
const prefix = "personal-packs/hao-music-library/";
await mkdir(join(root, prefix, "assets"), { recursive: true });
const music = Buffer.from("owned synthetic audio identity");
const license = Buffer.from("synthetic license fixture");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const path = "assets/12345678901234567890.m4a";
const manifest = {
  schemaVersion: 2,
  id: "studio.hao.personal-music-library",
  distributionScope: "community-redistributable",
  redistributable: true,
  provenanceAudit: {
    status: "owner_attested_ai_generated",
    publicExportAllowed: true,
    attestationId: "owner-attestation-2026-08-22",
  },
  licenseFile: "COMMUNITY-ASSET-GRANT.md",
  licenseSha256: sha(license),
  assetCount: 1,
  assetBytes: music.length,
  assets: [
    {
      id: "music:12345678901234567890",
      path,
      mediaKind: "audio",
      bytes: music.length,
      sha256: sha(music),
      license: "HAO-COMMUNITY-ASSET-GRANT-1.0",
      rightsBasis: "owner-attestation-2026-08-22",
      redistributable: true,
    },
  ],
};
const exe = Buffer.alloc(512);
exe.writeUInt16LE(0x5a4d);
exe.writeUInt32LE(0x80, 0x3c);
exe.writeUInt32LE(0x4550, 0x80);
exe.writeUInt16LE(0x8664, 0x84);
exe.writeUInt16LE(0x20b, 0x98);
exe.writeUInt16LE(0x160, 0x98 + 70);
await writeFile(join(root, "editkin.exe"), exe);
await writeFile(join(root, prefix, path), music);
await writeFile(join(root, prefix, "COMMUNITY-ASSET-GRANT.md"), license);
await writeFile(
  join(root, prefix, "editkin-personal-music.json"),
  JSON.stringify(manifest),
);
const args = {
  root,
  entries: [
    "editkin.exe",
    prefix + path,
    prefix + "COMMUNITY-ASSET-GRANT.md",
    prefix + "editkin-personal-music.json",
  ],
  executablePath: join(root, "editkin.exe"),
  authenticode: { Status: "Valid" },
  profile: "public",
};
const controls = [];
assert.equal((await inspectExtractedPayload(args)).status, "GREEN");
controls.push("exact listed actual byte set accepted");
await writeFile(join(root, prefix, path), Buffer.alloc(music.length, 123));
assert.equal((await inspectExtractedPayload(args)).status, "BLOCK");
controls.push("same-name same-size replaced bytes rejected");
await writeFile(join(root, prefix, path), music);
await writeFile(
  join(root, prefix, "renamed-private.jpg"),
  Buffer.from("private derivative"),
);
assert.equal((await inspectExtractedPayload(args)).status, "BLOCK");
controls.push(
  "undeclared actual extracted file rejected even omitted from caller entries",
);
assert.equal(
  sha(await readFile(join(root, prefix, path))),
  manifest.assets[0].sha256,
);
console.log(
  JSON.stringify({
    status: "GREEN",
    scope: "isolated extracted synthetic payload, not installer acceptance",
    controls,
    root,
  }),
);

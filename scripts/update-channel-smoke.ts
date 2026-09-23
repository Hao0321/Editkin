import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseUpdateManifest, stageUpdate } from "../src/application/updateManager";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string };
const version = packageJson.version;
const workspace = await mkdtemp(join(tmpdir(), "editkin-update-channel-"));
try {
  const artifact = join(workspace, `Editkin_${version}_x64-setup.exe`);
  const outputA = join(workspace, "stable-a.json");
  const outputB = join(workspace, "stable-b.json");
  const bytes = Buffer.from("deterministic-unsigned-installer-fixture");
  await writeFile(artifact, bytes);
  const common = [
    resolve(root, "scripts/update-channel.mjs"), "--artifact", artifact,
    "--artifact-url", `https://updates.editkin.example/stable/Editkin_${version}_x64-setup.exe`,
    "--published-at", "2026-08-21T13:00:00.000Z", "--version", version,
  ];
  const first = JSON.parse((await execute(process.execPath, [...common, "--output", outputA], { cwd: root })).stdout);
  await execute(process.execPath, [...common, "--output", outputB], { cwd: root });
  assert.equal(first.status, "INTERNAL_ONLY_UNSIGNED");
  assert.equal(await readFile(outputA, "utf8"), await readFile(outputB, "utf8"));
  const manifest = parseUpdateManifest(JSON.parse(await readFile(outputA, "utf8")));
  const staged = await stageUpdate(manifest, {
    currentVersion: "0.3.0", currentProjectSchema: 3, cacheRoot: join(workspace, "cache"),
    fetcher: async () => new Response(bytes),
  });
  assert.equal(staged?.version, version);
  assert.equal(staged?.cacheHit, false);
  await assert.rejects(execute(process.execPath, [...common, "--output", join(workspace, "public.json"), "--public"], { cwd: root }), /Authenticode/);
  const unsafe = common.map((value) => value.replace("https://updates.editkin.example", "http://updates.editkin.example"));
  await assert.rejects(execute(process.execPath, [...unsafe, "--output", join(workspace, "unsafe.json")], { cwd: root }), /HTTPS/);
  await assert.rejects(stageUpdate({ ...manifest, windowsX64: { ...manifest.windowsX64, sha256: "0".repeat(64) } }, {
    currentVersion: "0.3.0", currentProjectSchema: 3, cacheRoot: join(workspace, "tampered"), fetcher: async () => new Response(bytes),
  }), /SHA-256/);
  process.stdout.write(`${JSON.stringify({ status: "GREEN", deterministic: true, publicUnsignedRejected: true, unsafeUrlRejected: true, tamperRejected: true, stagedVersion: staged?.version })}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

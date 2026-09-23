import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inspectAuthenticode } from "./lib/authenticode.mjs";
import { parseUpdateVersion } from "../src/shared/updateVersion.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = option("--version", packageJson.version);
parseUpdateVersion(version, "--version");
parseUpdateVersion(packageJson.version, "package version");
const artifact = resolve(root, option("--artifact", `src-tauri/target/release/bundle/nsis/Editkin_${packageJson.version}_x64-setup.exe`));
const artifactUrlInput = option("--artifact-url");
const publishedAt = option("--published-at");
const minimumProjectSchema = Number(option("--minimum-project-schema", "3"));
const expectedSubject = option("--signature-subject");
const publicMode = process.argv.includes("--public");
const output = resolve(root, option("--output", `../../.rd/artifacts/editkin-${version}-stable-update.json`));

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

if (!artifactUrlInput || !publishedAt) throw new Error("--artifact-url 與 --published-at 為必要參數");
if (!Number.isInteger(minimumProjectSchema) || minimumProjectSchema < 1) throw new Error("--minimum-project-schema 必須是正整數");
if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("--published-at 必須是有效 ISO timestamp");
const artifactUrl = new URL(artifactUrlInput);
if (artifactUrl.protocol !== "https:" || artifactUrl.username || artifactUrl.password || artifactUrl.hash) {
  throw new Error("artifact URL 必須是無 credentials／fragment 的 HTTPS URL");
}

const artifactStat = await stat(artifact);
const signature = inspectAuthenticode(artifact);
if (expectedSubject && (signature.Status !== "Valid" || !String(signature.SignerSubject ?? "").toLowerCase().includes(expectedSubject.toLowerCase()))) {
  throw new Error(`artifact Authenticode subject 不符：${signature.Status} / ${signature.SignerSubject ?? "none"}`);
}
if (publicMode && signature.Status !== "Valid") throw new Error(`public update artifact 必須有有效 Authenticode：${signature.Status}`);
const signatureSubject = signature.Status === "Valid" ? String(signature.SignerSubject) : undefined;
const signatureSha256 = signature.Status === "Valid" ? String(signature.CertificateSha256 ?? "").toLowerCase() : undefined;
if (signatureSubject && !/^[a-f0-9]{64}$/.test(signatureSha256 ?? "")) throw new Error("無法取得 signer certificate SHA-256 fingerprint");
const manifest = {
  schemaVersion: 1,
  version,
  publishedAt: new Date(publishedAt).toISOString(),
  minimumProjectSchema,
  windowsX64: {
    url: artifactUrl.href,
    sha256: await hashFile(artifact),
    size: artifactStat.size,
    ...(signatureSubject ? { signatureSubject, signatureSha256 } : {}),
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: publicMode ? "PUBLIC_CHANNEL_GREEN" : signatureSubject ? "SIGNED_INTERNAL_MANIFEST" : "INTERNAL_ONLY_UNSIGNED", output, artifact, signature, manifest })}\n`);

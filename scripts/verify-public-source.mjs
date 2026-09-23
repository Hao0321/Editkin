import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignoredGeneratedDirs = new Set([".git", ".rd", "node_modules", "dist", "desktop-dist", ".web-public", "out", "release", "reports", "target"]);
const forbiddenDirs = new Set([".personal-packs", ".creative-packs", "vendor", "desktop-deliveries", ".desktop-resources", ".desktop-product-release-candidates"]);
const forbiddenRootFiles = new Set(["audit.config.json", "autopilot-capabilities.json", "market-parity-contract.json", "model-capability-contract.json", "product-capabilities.json", "video-autopilot-rule-coverage.json"]);
const forbiddenExt = new Set([".exe", ".dll", ".pdb", ".zip", ".dmg", ".p12", ".pfx", ".pem", ".key"]);
const binaryExt = new Set([".mp4", ".mov", ".mp3", ".wav", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".ico", ".icns"]);
const keyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const sensitive = [
  new RegExp(keyMarker),
  /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b(?:C:[/\\]Users[/\\][^/\\\s]+|D:[/\\]Hao0321[^\s"']*)/i,
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const slash = path => path.split(sep).join("/");

function safeRelative(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || isAbsolute(path)) return false;
  const full = resolve(root, path);
  const rel = relative(root, full);
  return slash(rel) === path && !rel.startsWith(`..${sep}`) && rel !== ".." && !path.split("/").includes("..");
}
function allowedBinary(path, rights) {
  const ext = extname(path).toLowerCase();
  if (forbiddenExt.has(ext)) return false;
  if (!binaryExt.has(ext)) return true;
  if (path.startsWith("src-tauri/icons/") && /Editkin visual identity/.test(rights)) return true;
  if (path.startsWith("public/fonts/") && ext === ".ttf" && /SIL-OFL-1\.1/.test(rights)) return true;
  if (path.startsWith("public/") && ext === ".mp4" && /synthetic FFmpeg lavfi fixture/.test(rights)) return true;
  return false;
}
function sensitivePattern(text) { return sensitive.some(pattern => pattern.test(text)); }

async function* walk(rel = "") {
  const full = resolve(root, rel);
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) { yield { path: slash(rel), kind: "symlink" }; return; }
  if (stat.isFile()) { yield { path: slash(rel), kind: "file" }; return; }
  if (!stat.isDirectory()) { yield { path: slash(rel), kind: "special" }; return; }
  for (const name of (await readdir(full)).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    const childStat = await lstat(resolve(root, child));
    if (childStat.isDirectory() && (ignoredGeneratedDirs.has(name) || name.startsWith(".web-public-") || name.startsWith("target-") || name.startsWith("product-"))) continue;
    yield* walk(child);
  }
}

if (process.argv.includes("--self-test")) {
  let negativeControls = 0;
  for (const bad of ["../escape", "/absolute", "src/../escape", "C:/absolute", ""]) {
    if (safeRelative(bad)) throw new Error(`Path negative control accepted: ${bad}`);
    negativeControls++;
  }
  for (const bad of ["ghp_" + "A".repeat(36), keyMarker, ["C:", "Users", "owner", "secret"].join("\\"), ["C:", "Users", "owner", "secret"].join("/"), ["D:", "Hao0321_YT_Claude", "private"].join("/")]) {
    if (!sensitivePattern(bad)) throw new Error("Sensitive-text negative control accepted");
    negativeControls++;
  }
  for (const [path, rights] of [["public/unknown.exe", "GPL-3.0-or-later"], ["public/new.mp4", ""], ["src-tauri/icons/new.png", ""]]) {
    if (allowedBinary(path, rights)) throw new Error("Binary-rights negative control accepted");
    negativeControls++;
  }
  if (!forbiddenRootFiles.has("audit.config.json")) throw new Error("Internal-root negative control accepted");
  negativeControls++;
  process.stdout.write(`${JSON.stringify({ status: "GREEN", negativeControls })}\n`);
  process.exit(0);
}

const manifest = JSON.parse(await readFile(resolve(root, "PUBLIC_SOURCE_MANIFEST.json"), "utf8"));
if (manifest.schema !== "editkin.public-source-manifest/v1" || !Array.isArray(manifest.files)) throw new Error("Invalid source manifest");
const expected = new Map();
for (const row of manifest.files) {
  if (!safeRelative(row.path) || expected.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !row.rights) {
    throw new Error(`Unsafe manifest entry: ${row.path}`);
  }
  if (!allowedBinary(row.path, row.rights)) throw new Error(`Unapproved binary: ${row.path}`);
  if (forbiddenRootFiles.has(row.path)) throw new Error(`Owner-only internal document: ${row.path}`);
  expected.set(row.path, row);
}
const seen = new Set();
for await (const entry of walk()) {
  if (entry.path === "PUBLIC_SOURCE_MANIFEST.json") continue;
  if (entry.kind !== "file") throw new Error(`Unsafe filesystem entry: ${entry.path}`);
  if (entry.path.split("/").some(part => forbiddenDirs.has(part))) throw new Error(`Private directory: ${entry.path}`);
  const row = expected.get(entry.path);
  if (!row) throw new Error(`Unmanifested file: ${entry.path}`);
  const bytes = await readFile(join(root, entry.path));
  if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Changed file: ${entry.path}`);
  if (!binaryExt.has(extname(entry.path).toLowerCase()) && sensitivePattern(bytes.toString("utf8"))) {
    throw new Error(`Sensitive text in ${entry.path}`);
  }
  seen.add(entry.path);
}
for (const path of expected.keys()) if (!seen.has(path)) throw new Error(`Missing file: ${path}`);
const defaults = JSON.parse(await readFile(join(root, "src/creative/haoCorePack.json"), "utf8"));
if (defaults.source?.compiler !== "editkin-public-defaults/v1" || defaults.source?.referenceCount !== 0 || defaults.source?.privateImagesEmbedded !== false) {
  throw new Error("Public creative defaults replaced or invalid");
}
const workflow = await readFile(join(root, ".github/workflows/source-ci.yml"), "utf8");
if (!/permissions:\s*\n\s*contents:\s*read/.test(workflow) || /pull_request_target|secrets\.|id-token:\s*write/.test(workflow)) {
  throw new Error("Source CI permission boundary changed");
}
process.stdout.write(`${JSON.stringify({ status: "GREEN", files: seen.size, manifestSha256: hash(await readFile(join(root, "PUBLIC_SOURCE_MANIFEST.json"))) })}\n`);

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Generated output is skipped only where the root .gitignore ignores it (each entry must stay a .gitignore line); the same names elsewhere are committable and scanned.
const ignoredGeneratedDirs = ["/.rd/", "/node_modules/", "/dist/", "/desktop-dist/", "/.web-public/", "/.web-public-*/", "/out/", "/release/", "/reports/", "/native/**/target/", "/spikes/**/target/", "/src-tauri/target/", "/src-tauri/target-*/", "/src-tauri/product-*/"];
const ignoredGeneratedPatterns = ignoredGeneratedDirs.map(gitignoreDirectory);
const forbiddenDirs = new Set([".personal-packs", ".creative-packs", "vendor", "desktop-deliveries", ".desktop-resources", ".desktop-product-release-candidates"]);
const forbiddenRootFiles = new Set(["audit.config.json", "autopilot-capabilities.json", "market-parity-contract.json", "model-capability-contract.json", "product-capabilities.json", "video-autopilot-rule-coverage.json"]);
const forbiddenExt = new Set([".exe", ".dll", ".pdb", ".zip", ".dmg", ".p12", ".pfx", ".pem", ".key"]);
const binaryExt = new Set([".mp4", ".mov", ".mp3", ".wav", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".ico", ".icns"]);
const keyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const sensitive = [
  new RegExp(["-----BEGIN(?: [A-Z0-9]+)*", "PRIVATE KEY(?: BLOCK)?-----"].join(" ")),
  /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[0-9A-Za-z-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b(?:C:[/\\]Users[/\\][^/\\\s]+|D:[/\\]Hao0321[^\s"']*)/i,
  /(?:file:\/\/|(?<![\w.~/-]))\/(?:Users|home)\/(?!(?:someone|name|user|username|example|runner)\/)[\w.-]+\//,
];
const bidiControl = /[\u202A-\u202E\u2066-\u2069]/;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const slash = path => path.split(sep).join("/");
const scanOnly = process.argv.includes("--scan");

function safeRelative(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:\//.test(path)) return false;
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
function gitignoreDirectory(line) {
  const parts = line.slice(1, -1).split("/").map(part => part === "**" ? "(?:[^/]+/)*" : `${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}/`);
  return new RegExp(`^${parts.join("").slice(0, -1)}$`);
}
function skippedGenerated(path, directory) { return path === ".git" || (directory && ignoredGeneratedPatterns.some(pattern => pattern.test(path))); }
function unignoredSkips(gitignore) {
  const lines = new Set(gitignore.split(/\r?\n/).map(line => line.trimEnd()));
  return ignoredGeneratedDirs.filter(line => !lines.has(line));
}
function privateDirectory(path) { return path.split("/").some(part => forbiddenDirs.has(part.toLowerCase())); }
function ownerOnlyRootFile(path) { return forbiddenRootFiles.has(path.toLowerCase()); }
function workflowViolation(text) {
  if (/\b(?:pull_request_target|workflow_run)\b/.test(text)) return "pull_request_target or workflow_run trigger";
  if (/\$\{\{[^}]*\bsecrets\b/.test(text) || /^[ \t-]*secrets[ \t]*:/m.test(text)) return "secrets reference";
  if (/\bwrite-all\b|\bcontents["']?[ \t]*:[ \t]*["']?write\b/.test(text)) return "write-all or contents: write permission";
  for (const [, value] of text.matchAll(/\buses["']?[ \t]*:[ \t]*([^\n#,}]*)/g)) {
    const action = value.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!action.startsWith("./") && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(action)) return `action not pinned to a full commit SHA: ${action || "(empty)"}`;
  }
  return "";
}
function relativeModuleWithinRoot(sourcePath, specifier) {
  const target = resolve(root, dirname(sourcePath), specifier);
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function assertStaticModuleBoundary(sourcePath, content) {
  for (const match of content.matchAll(/\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.\.?\/[^"']+)["']/g)) {
    if (!relativeModuleWithinRoot(sourcePath, match[1])) throw new Error(`Module import leaves source root: ${sourcePath}`);
  }
}

async function* walk(rel = "") {
  const full = resolve(root, rel);
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) { yield { path: slash(rel), kind: "symlink" }; return; }
  if (stat.isFile()) { yield { path: slash(rel), kind: "file" }; return; }
  if (!stat.isDirectory()) { yield { path: slash(rel), kind: "special" }; return; }
  for (const name of (await readdir(full)).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    const childStat = await lstat(resolve(root, child));
    if (skippedGenerated(child, childStat.isDirectory())) continue;
    yield* walk(child);
  }
}

if (process.argv.includes("--self-test")) {
  let negativeControls = 0;
  let positiveControls = 0;
  for (const bad of ["../escape", "/absolute", "src/../escape", "C:/absolute", ""]) {
    if (safeRelative(bad)) throw new Error(`Path negative control accepted: ${bad}`);
    negativeControls++;
  }
  const pem = (...words) => `${["-----BEGIN", ...words].join(" ")}-----`;
  const home = (...parts) => ["", ...parts].join("/");
  for (const bad of [
    "ghp_" + "A".repeat(36), keyMarker, ["C:", "Users", "owner", "secret"].join("\\"), ["C:", "Users", "owner", "secret"].join("/"), ["D:", "Hao0321_YT_Claude", "private"].join("/"),
    ...["RSA", "EC", "DSA", "OPENSSH", "ENCRYPTED"].map(kind => pem(kind, "PRIVATE", "KEY")), pem("PGP", "PRIVATE", "KEY", "BLOCK"),
    "AKIA" + "Z".repeat(16), "ASIA" + "7".repeat(16), ["xoxb", "1".repeat(12), "a".repeat(24)].join("-"), "xoxp-" + "9".repeat(10), "AIza" + "x".repeat(35),
    home("Users", "realname", "project"), home("home", "realname", "project"), "file://" + home("Users", "realname", "x"), home("home", "username2", "x"),
  ]) {
    if (!sensitivePattern(bad)) throw new Error("Sensitive-text negative control accepted");
    negativeControls++;
  }
  for (const good of [pem("PUBLIC", "KEY"), pem("CERTIFICATE"), home("Users", "someone", "clip.mp4"), home("Users", "name", "x"), home("home", "name", "x"), home("home", "runner", "work"), "https://example.com" + home("home", "docs", "page")]) {
    if (sensitivePattern(good)) throw new Error(`Sensitive-text positive control rejected: ${good}`);
    positiveControls++;
  }
  for (const codePoint of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    if (!bidiControl.test(`const ok = 1; // ${String.fromCodePoint(codePoint)}`)) throw new Error("Bidi negative control accepted");
    negativeControls++;
  }
  for (const codePoint of [0x200e, 0x200f]) {
    if (bidiControl.test(`label ${String.fromCodePoint(codePoint)} text`)) throw new Error("Bidi positive control rejected");
    positiveControls++;
  }
  for (const [path, rights] of [["public/unknown.exe", "GPL-3.0-or-later"], ["public/new.mp4", ""], ["src-tauri/icons/new.png", ""]]) {
    if (allowedBinary(path, rights)) throw new Error("Binary-rights negative control accepted");
    negativeControls++;
  }
  for (const bad of ["audit.config.json", "Audit.Config.JSON"]) {
    if (!ownerOnlyRootFile(bad)) throw new Error("Internal-root negative control accepted");
    negativeControls++;
  }
  for (const bad of ["vendor/x.txt", "Vendor/x.txt", "src/VENDOR/x.txt", ".Personal-Packs/a.json"]) {
    if (!privateDirectory(bad)) throw new Error(`Private-directory negative control accepted: ${bad}`);
    negativeControls++;
  }
  if (relativeModuleWithinRoot("src/creative/wave2Registry.ts", "../../../../community/private.json")) throw new Error("External module import accepted");
  negativeControls++;
  for (const [path, directory] of [["src/release", true], ["src/out", true], ["scripts/dist", true], ["docs/node_modules", true], ["src/.rd", true], ["src/.git", true], ["public/.web-public", true], ["src/target-x", true], ["src/product-x", true], ["scripts/target", true], ["src-tauri/src/target", true], ["dist", false]]) {
    if (skippedGenerated(path, directory)) throw new Error(`Generated-directory negative control skipped: ${path}`);
    negativeControls++;
  }
  for (const [path, directory] of [[".git", true], [".git", false], ["node_modules", true], [".web-public-x", true], ["native/hao-core/target", true], ["spikes/gpu-compositor/target", true], ["src-tauri/target-release", true], ["src-tauri/product-x", true]]) {
    if (!skippedGenerated(path, directory)) throw new Error(`Generated-directory positive control scanned: ${path}`);
    positiveControls++;
  }
  if (!unignoredSkips(ignoredGeneratedDirs.join("\n").replace("/out/", "/src/out/")).includes("/out/")) throw new Error("Unignored-skip negative control accepted");
  negativeControls++;
  if (unignoredSkips(`# generated\r\n${ignoredGeneratedDirs.join("\r\n")}\r\n`).length) throw new Error("Unignored-skip positive control rejected");
  positiveControls++;
  const pin = "f".repeat(40);
  for (const bad of [
    "on: pull_request_target\n", "on:\n  workflow_run:\n", "env:\n  T: ${{ secrets.T }}\n", "env:\n  T: ${{ secrets['T'] }}\n", "jobs:\n  x:\n    secrets: inherit\n", "env:\n  ALL: ${{ toJSON(secrets) }}\n",
    "permissions: write-all\n", "permissions:\n  contents: write\n", "steps:\n  - uses: actions/checkout@v4\n", `steps:\n  - uses: actions/checkout@${pin.slice(1)}\n`,
    "steps:\n  - uses: docker://alpine:3\n", "steps:\n  - {uses: actions/checkout@v4}\n", "steps:\n  - uses:\n      actions/checkout@v4\n",
  ]) {
    if (!workflowViolation(bad)) throw new Error(`Workflow negative control accepted: ${JSON.stringify(bad)}`);
    negativeControls++;
  }
  for (const good of [`steps:\n  - uses: actions/checkout@${pin} # v4.3.1\n`, `steps:\n  - name: x\n    uses: 'actions/setup-node@${pin}'\n`, "steps:\n  - uses: ./.github/actions/local\n", "# This workflow reads no secrets.\npermissions:\n  contents: read\n", "permissions:\n  contents: read\n  pages: write\n  id-token: write\n  security-events: write\n"]) {
    if (workflowViolation(good)) throw new Error(`Workflow positive control rejected: ${JSON.stringify(good)}`);
    positiveControls++;
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", negativeControls, positiveControls })}\n`);
  process.exit(0);
}

const manifestText = await readFile(resolve(root, "PUBLIC_SOURCE_MANIFEST.json"), "utf8");
if (sensitivePattern(manifestText)) throw new Error("Sensitive text in public source manifest");
if (bidiControl.test(manifestText)) throw new Error("Bidirectional control character in public source manifest");
const manifest = JSON.parse(manifestText);
if (manifest.schema !== "editkin.public-source-manifest/v1" || !Array.isArray(manifest.files)) throw new Error("Invalid source manifest");
const expected = new Map();
for (const row of manifest.files) {
  if (!safeRelative(row.path) || expected.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !row.rights) {
    throw new Error(`Unsafe manifest entry: ${row.path}`);
  }
  if (!allowedBinary(row.path, row.rights)) throw new Error(`Unapproved binary: ${row.path}`);
  if (ownerOnlyRootFile(row.path)) throw new Error(`Owner-only internal document: ${row.path}`);
  expected.set(row.path, row);
}
const unignored = unignoredSkips(await readFile(join(root, ".gitignore"), "utf8"));
if (unignored.length) throw new Error(`Skipped directory is not ignored by .gitignore: ${unignored.join(", ")}`);
const seen = new Set();
for await (const entry of walk()) {
  if (entry.path === "PUBLIC_SOURCE_MANIFEST.json") continue;
  if (!safeRelative(entry.path) || bidiControl.test(entry.path)) throw new Error(`Unsafe path: ${entry.path}`);
  if (entry.kind !== "file") throw new Error(`Unsafe filesystem entry: ${entry.path}`);
  if (privateDirectory(entry.path)) throw new Error(`Private directory: ${entry.path}`);
  if (ownerOnlyRootFile(entry.path)) throw new Error(`Owner-only internal document: ${entry.path}`);
  const extension = extname(entry.path).toLowerCase();
  if (forbiddenExt.has(extension)) throw new Error(`Forbidden binary: ${entry.path}`);
  const row = expected.get(entry.path);
  const bytes = await readFile(join(root, entry.path));
  if (!scanOnly && !row) throw new Error(`Unmanifested file: ${entry.path}`);
  if (!scanOnly && (bytes.length !== row.bytes || hash(bytes) !== row.sha256)) throw new Error(`Changed file: ${entry.path}`);
  if (binaryExt.has(extension)) {
    if (!row || !allowedBinary(entry.path, row.rights) || bytes.length !== row.bytes || hash(bytes) !== row.sha256) {
      throw new Error(`Unreviewed binary: ${entry.path}`);
    }
  } else {
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Non-text file: ${entry.path}`); }
    if (bytes.includes(0) || sensitivePattern(content)) throw new Error(`Sensitive or binary text in ${entry.path}`);
    if (bidiControl.test(content)) throw new Error(`Bidirectional control character in ${entry.path}`);
    if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)) assertStaticModuleBoundary(entry.path, content);
    const violation = entry.path.toLowerCase().startsWith(".github/workflows/") ? workflowViolation(content) : "";
    if (violation) throw new Error(`Workflow permission boundary changed: ${entry.path} (${violation})`);
  }
  seen.add(entry.path);
}
if (!scanOnly) for (const path of expected.keys()) if (!seen.has(path)) throw new Error(`Missing file: ${path}`);
const defaults = JSON.parse(await readFile(join(root, "src/creative/haoCorePack.json"), "utf8"));
if (defaults.source?.compiler !== "editkin-public-defaults/v1" || defaults.source?.referenceCount !== 0 || defaults.source?.privateImagesEmbedded !== false) {
  throw new Error("Public creative defaults replaced or invalid");
}
const workflow = await readFile(join(root, ".github/workflows/source-ci.yml"), "utf8");
if (!/permissions:\s*\n\s*contents:\s*read/.test(workflow) || /pull_request_target|secrets\.|id-token:\s*write/.test(workflow) || !/run: npm run source:scan/.test(workflow) || !/run: npm test/.test(workflow) || !/run: npm run build/.test(workflow)) {
  throw new Error("Source CI permission boundary changed");
}
process.stdout.write(`${JSON.stringify({ status: "GREEN", mode: scanOnly ? "scan" : "snapshot", files: seen.size, manifestSha256: hash(await readFile(join(root, "PUBLIC_SOURCE_MANIFEST.json"))) })}\n`);

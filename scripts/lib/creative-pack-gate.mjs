import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { OWNER_VISUAL_GRANT, validatePublicAssetRights, validatePublicGrant } from "../../src/shared/visualAssetRights.mjs";

const RENDERERS = new Set([
  "ffmpeg-eq", "ffmpeg-film-grain", "ffmpeg-bloom", "ffmpeg-crisp", "ffmpeg-monochrome",
  "transition-fade", "transition-zoom", "transition-whip", "transition-flash",
  "ass-text", "hao-motion-composition/v1", "media-asset",
]);

const PRIVATE_PATTERN = /(?:[a-z]:\\|\\\\|\/Users\/|\/home\/|Hao0321_YT_Claude|\.claude[\\/]skills|\.codex[\\/]skills|(?:api[_-]?key|token|secret|password)\s*[:=])/i;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function issue(findings, code, message, path) {
  findings.push({ status: "FAIL", code, message, ...(path ? { path } : {}) });
}

function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\\") && !path.includes(":")
    && path.split("/").every(part => part && part !== "." && part !== "..");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function checkPayload(root, manifest, expected, findings) {
  const actual = new Map();
  try {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase()) throw new Error("pack root is an alias");
    const visit = (folder, relative = "") => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = resolve(folder, entry.name), info = lstatSync(absolute);
        if (info.isSymbolicLink()) throw new Error(`symlink/junction: ${path}`);
        if (!realpathSync(absolute).startsWith(`${root}${sep}`)) throw new Error(`escaped root: ${path}`);
        if (info.isDirectory()) {
          if (![...expected.keys()].some(key => key.startsWith(`${path.toLowerCase()}/`))) issue(findings, "unexpected-payload", "公開包含未宣告的目錄", path);
          visit(absolute, path); continue;
        }
        if (!info.isFile()) throw new Error(`non-regular file: ${path}`);
        const key = path.toLowerCase();
        if (actual.has(key)) throw new Error(`case-insensitive duplicate: ${path}`);
        actual.set(key, { path, absolute, bytes: info.size });
      }
    };
    visit(root);
  } catch (error) { issue(findings, "unsafe-payload", String(error)); return; }
  for (const row of actual.values()) if (!expected.has(row.path.toLowerCase())) issue(findings, "unexpected-payload", "公開包含未列出的檔案", row.path);
  for (const [key, declared] of expected) {
    const row = actual.get(key);
    if (!row || row.path !== declared.path) { issue(findings, "missing-asset", "公開包缺少精確宣告的檔案", declared.path); continue; }
    try {
      if (declared.bytes !== undefined && (row.bytes !== declared.bytes || sha256(row.absolute) !== declared.sha256)) issue(findings, "hash-mismatch", "檔案大小或 SHA-256 不符", row.path);
    } catch (error) { issue(findings, "unreadable-payload", `驗證期间無法讀取宣告檔案：${String(error)}`, row.path); }
  }
  const manifestFile = actual.get("editkin-pack.json");
  if (manifestFile) {
    try { if (canonical(JSON.parse(readFileSync(manifestFile.absolute, "utf8"))) !== canonical(manifest)) issue(findings, "manifest-file-mismatch", "磁碟 manifest 與受驗物件不一致"); }
    catch { issue(findings, "manifest-file-mismatch", "磁碟 manifest 不是合法 JSON"); }
  }
}

export function evaluateCreativePack(manifest, options = {}) {
  const findings = [];
  const root = options.root ? resolve(options.root) : undefined;
  const minimums = options.minimums ?? { looks: 8, effects: 4, transitions: 4, textStyles: 4, templates: 8, assets: 400 };
  const raw = JSON.stringify(manifest);
  if (PRIVATE_PATTERN.test(raw)) issue(findings, "private-path", "manifest 含本機路徑、私人 workspace 名稱或 secret-shaped 欄位");
  if (manifest?.schemaVersion !== 1) issue(findings, "schema-version", "schemaVersion 必須是 1");
  for (const field of ["id", "name", "version", "license", "attribution"]) {
    if (typeof manifest?.[field] !== "string" || !manifest[field].trim()) issue(findings, "required-field", `缺少 ${field}`);
  }
  if (manifest?.source?.privateImagesEmbedded !== false) issue(findings, "private-reference-embedded", "公開包不得內嵌私人參考圖");
  if (!Number.isInteger(manifest?.source?.referenceCount) || manifest.source.referenceCount < 1) issue(findings, "design-dna", "缺少匿名 design DNA reference count");

  let documentSha256;
  if (manifest?.ownerVisualGrant && root) {
    const path = OWNER_VISUAL_GRANT.document.path;
    try {
      const absolute = resolve(root, path), info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink() || !realpathSync(absolute).startsWith(`${root}${sep}`)) throw new Error("grant document is not a regular owned file");
      documentSha256 = sha256(absolute);
    } catch (error) { issue(findings, "grant-document", String(error), path); }
  }
  let verifiedGrant;
  try { verifiedGrant = validatePublicGrant(manifest, { documentSha256 }); }
  catch (error) { issue(findings, "public-asset-rights", error.message); }

  const groups = manifest?.presets ?? {};
  const ids = new Set();
  for (const [group, minimum] of Object.entries(minimums)) {
    const items = group === "assets" ? manifest?.assets : groups[group];
    if (!Array.isArray(items) || items.length < minimum) {
      issue(findings, "minimum-coverage", `${group} 至少需要 ${minimum} 個，實際 ${Array.isArray(items) ? items.length : 0}`);
      continue;
    }
    for (const [index, item] of items.entries()) {
      const itemPath = `${group}[${index}]`;
      if (typeof item?.id !== "string" || !item.id.trim()) issue(findings, "item-id", "項目缺少 id", itemPath);
      else if (ids.has(item.id)) issue(findings, "duplicate-id", `重複 id：${item.id}`, itemPath);
      else ids.add(item.id);
      if (typeof item?.license !== "string" || !item.license.trim()) issue(findings, "missing-license", "項目缺少 license", itemPath);
      try {
        const rights = validatePublicAssetRights(item, verifiedGrant?.grant);
        if (group !== "assets" && rights.kind !== "standard") throw new Error("preset 不得借用影片素材 grant");
      } catch (error) { issue(findings, "public-asset-rights", error.message, itemPath); }
      if (typeof item?.provenance !== "string" || !item.provenance.trim()) issue(findings, "missing-provenance", "項目缺少 provenance", itemPath);
      if (typeof item?.renderer !== "string" || !RENDERERS.has(item.renderer)) issue(findings, "unsupported-renderer", `不支援 renderer：${String(item?.renderer)}`, itemPath);
    }
  }

  const expected = new Map();
  const addExpected = (file, context) => {
    if (!safeRelative(file?.path)) { issue(findings, "unsafe-asset-path", "path 必須是安全的精確相對路徑", context); return; }
    const key = file.path.toLowerCase();
    if (expected.has(key)) { issue(findings, "duplicate-payload-path", "多個項目使用相同／大小寫衝突的 path", file.path); return; }
    expected.set(key, file);
  };
  for (const path of ["editkin-pack.json", "NOTICE.md", "licenses/CC-BY-4.0.md", "preview-build-evidence.json"]) addExpected({ path }, path);
  if (manifest?.ownerVisualGrant) addExpected(OWNER_VISUAL_GRANT.document, "owner grant document");
  for (const [index, asset] of (Array.isArray(manifest?.assets) ? manifest.assets : []).entries()) {
    const itemPath = `assets[${index}]`;
    const relative = asset?.path;
    if (!safeRelative(relative)) {
      issue(findings, "unsafe-asset-path", "素材 path 必須是無 traversal 的相對路徑", itemPath);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(asset?.sha256 ?? "")) issue(findings, "asset-sha256", "素材缺少合法 SHA-256", itemPath);
    if (!Number.isSafeInteger(asset?.bytes) || asset.bytes <= 0) issue(findings, "asset-bytes", "素材 bytes 必須是正整數", itemPath);
    addExpected(asset, itemPath);
    const derivatives = asset?.derivatives;
    if (asset.mediaKind === "video" && (!derivatives?.poster || !derivatives?.media)) issue(findings, "missing-video-preview", "每個影片必須有 poster 及 motion preview", itemPath);
    if (derivatives) {
      if (derivatives.sourceSha256 !== asset.sha256 || !/^[a-f0-9]{64}$/.test(derivatives.revision ?? "")) issue(findings, "preview-source-binding", "preview 必須綁定原檔 SHA 和有效 revision", itemPath);
      for (const kind of ["poster", "media"]) {
        const file = derivatives[kind];
        if (!file) continue;
        if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) issue(findings, "preview-file-identity", "preview 缺少有效 bytes/SHA", `${itemPath}.${kind}`);
        addExpected(file, `${itemPath}.${kind}`);
      }
    }
  }
  if (root) checkPayload(root, manifest, expected, findings);

  const status = findings.length === 0 ? "GREEN" : "BLOCK";
  return {
    schemaVersion: 1,
    status,
    counts: {
      looks: groups.looks?.length ?? 0,
      effects: groups.effects?.length ?? 0,
      transitions: groups.transitions?.length ?? 0,
      textStyles: groups.textStyles?.length ?? 0,
      templates: groups.templates?.length ?? 0,
      assets: manifest?.assets?.length ?? 0,
    },
    findings: findings.length ? findings : [{ status: "PASS", code: "creative-pack-contract", message: "可攜性、授權、renderer、coverage 與逐檔 hash 通過" }],
  };
}

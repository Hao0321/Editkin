import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES,
  EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS,
  INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES,
  RETIRED_EDITOR_HISTORY_MARKER,
} from "./lib/community-knowledge-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(root, "..", "..", "video-autopilot-kit", "knowledge");
const canonicalSkillPath = path.join(homedir(), ".codex", "skills", "video-autopilot", "SKILL.md");
const packPath = path.join(root, "src", "knowledge", "editkinCommunityKnowledge.json");
const summaryPath = path.join(root, "src", "knowledge", "editkinCommunityKnowledgeSummary.json");
const DERIVATION_POLICY = "personal-data-sanitized; retired-editor-history-omitted-never-renamed";
const SECURE_REVIEW_POLICY_REQUIRED = {
  M157: [
    "URL fragment",
    "10 分鐘",
    "HttpOnly; SameSite=Strict",
    "60 分鐘",
    "15 分鐘",
    "session 撤銷",
    "SECURE_REVIEW_RUNTIME_REQUIRED",
  ],
  M158: [
    "Origin",
    "Content-Type: application/json",
    "Sec-Fetch-Site: same-origin",
    "已認證 session",
    "受信任本機 UI",
  ],
  M159: [
    "M157 認證 HTTPS session",
    "session fingerprint",
    "完整 capability URL",
    "SECURE_REVIEW_RUNTIME_REQUIRED",
    "TTL／閒置自動停止",
  ],
};
const INSECURE_REVIEW_POLICY_PHRASES = [
  "建立帶隨機秘密路徑的臨時 HTTPS Quick Tunnel",
  "啟動秘密 HTTPS Quick Tunnel",
  "再只交付 HTTPS 網址",
  "最終回覆先給手機網址",
];

class KnowledgeGateFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KnowledgeGateFailure";
    this.code = code;
    this.details = details;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, message, details = {}) => {
  throw new KnowledgeGateFailure(code, message, details);
};
const ensure = (condition, code, message, details = {}) => {
  if (!condition) fail(code, message, details);
};
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sanitizePersonalData(text) {
  return text
    .replaceAll("hao-aesthetic-standard", "editkin-community-aesthetic-standard")
    .replace(/Hao0321(?:\s*Studio)?|Hao\b|駱君昊|自由工坊/gi, "建立者")
    .replace(/(?:[A-Z]:[\\/](?:[^\s`"'<>|]+[\\/])*[^\s`"'<>|]*)/gi, "[LOCAL_PATH]")
    .replace(/\/(?:Users|home)\/[^/\s]+/gi, "/[USER_HOME]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/@[a-z0-9_]{2,32}/gi, "@[ACCOUNT]")
    .replace(/(?:github\.com|youtube\.com\/(?:@|c\/)|instagram\.com|threads\.net\/@)[/]*建立者[a-z0-9_-]*/gi, "$1/[ACCOUNT]");
}

function omitRetiredEditorHistory(markdown, source) {
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  let omittedFragments = 0;
  const retained = paragraphs.flatMap((paragraph) => {
    if (!RETIRED_EDITOR_HISTORY_MARKER.test(paragraph)) return [paragraph];
    const fragments = paragraph.split(/(?<=[。！？!?])\s*/u);
    const safeFragments = fragments.filter((fragment) => {
      if (!RETIRED_EDITOR_HISTORY_MARKER.test(fragment)) return true;
      omittedFragments += 1;
      return false;
    });
    return safeFragments.length > 0 ? [safeFragments.join(" ").trim()] : [];
  });
  const content = retained.join("\n\n").trimEnd();
  ensure(
    !RETIRED_EDITOR_HISTORY_MARKER.test(content),
    "retired-editor-history-derivation-failed",
    `retired editor history was not fully omitted from ${source}`,
    { source },
  );
  return { content, omittedFragments };
}

function tagsFor(name) {
  const tags = new Set();
  for (const tag of ["aesthetic", "algorithm", "audio", "beyblade", "caption", "color", "compliance", "filter", "interview", "motion", "packaging", "quality", "retention", "shorts", "storage", "template", "tracking", "viral", "youtube"]) {
    if (name.toLowerCase().includes(tag)) tags.add(tag);
  }
  if (tags.size === 0) tags.add("editorial");
  return [...tags];
}

function moduleIdFor(source) {
  return path.basename(source)
    .replace(/\.(?:json|md)$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function extractStableRules(skillText) {
  const skillLines = skillText.split(/\r?\n/);
  const ids = [...new Set([...skillText.matchAll(/\bM\d{1,3}(?:-[A-Z]+)?(?:A)?\b/g)].map((match) => match[0]))].sort();
  return ids.map((id) => {
    const boundary = new RegExp(`\\b${escapeRegex(id)}\\b`);
    const line = skillLines.find((candidate) => boundary.test(candidate)) ?? id;
    return { id, text: sanitizePersonalData(line.replace(/^\s*(?:-\s+|\d+\.\s+)?/, "")) };
  });
}

function ensureSecureReviewPolicy(stableRules) {
  const byId = new Map(stableRules.map((row) => [row.id, row.text]));
  for (const [id, terms] of Object.entries(SECURE_REVIEW_POLICY_REQUIRED)) {
    const text = byId.get(id);
    ensure(typeof text === "string", "secure-review-policy-rule-missing", `secure review policy rule is missing: ${id}`, { id });
    const missing = terms.filter((term) => !text.includes(term));
    ensure(missing.length === 0, "secure-review-policy-term-missing", `secure review policy is incomplete: ${id}`, { id, missing });
  }
  const combined = ["M157", "M158", "M159"].map((id) => byId.get(id) ?? "").join("\n");
  const insecure = INSECURE_REVIEW_POLICY_PHRASES.filter((phrase) => combined.includes(phrase));
  ensure(insecure.length === 0, "insecure-review-policy-returned", "secret-path or raw-link review delivery returned to stable policy", { insecure });
}

async function readLiveSourceTree(knowledgeRoot) {
  const records = [];
  const invalidEntries = [];
  const topEntries = await readdir(knowledgeRoot, { withFileTypes: true });
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) {
      invalidEntries.push({ path: entry.name, reason: "symlink-not-allowed" });
      continue;
    }
    if (entry.isFile()) {
      records.push({ source: entry.name, raw: await readFile(path.join(knowledgeRoot, entry.name), "utf8") });
      continue;
    }
    if (!entry.isDirectory() || entry.name !== "runtime") {
      invalidEntries.push({ path: entry.name, reason: "unexpected-top-level-entry" });
      continue;
    }
    const runtimeEntries = await readdir(path.join(knowledgeRoot, "runtime"), { withFileTypes: true });
    for (const runtimeEntry of runtimeEntries) {
      const source = `runtime/${runtimeEntry.name}`;
      if (runtimeEntry.isSymbolicLink()) {
        invalidEntries.push({ path: source, reason: "symlink-not-allowed" });
      } else if (runtimeEntry.isDirectory()) {
        invalidEntries.push({ path: source, reason: "third-level-nesting" });
      } else if (runtimeEntry.isFile()) {
        records.push({ source, raw: await readFile(path.join(knowledgeRoot, "runtime", runtimeEntry.name), "utf8") });
      } else {
        invalidEntries.push({ path: source, reason: "unsupported-runtime-entry" });
      }
    }
  }
  records.sort((left, right) => left.source.localeCompare(right.source));
  invalidEntries.sort((left, right) => left.path.localeCompare(right.path));
  return { records, invalidEntries };
}

async function loadLiveSnapshot() {
  const [{ records, invalidEntries }, skillText, packText, summaryText] = await Promise.all([
    readLiveSourceTree(sourceRoot),
    readFile(canonicalSkillPath, "utf8"),
    readFile(packPath, "utf8"),
    readFile(summaryPath, "utf8"),
  ]);
  return {
    sourceRecords: records,
    invalidEntries,
    skillText,
    packText,
    pack: JSON.parse(packText),
    summary: JSON.parse(summaryText),
  };
}

function evaluateSnapshot(snapshot) {
  const { sourceRecords, invalidEntries, skillText, pack, packText, summary } = snapshot;
  const expectedClassified = [...INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES, ...Object.keys(EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES)];
  const expectedClassifiedSorted = sorted(expectedClassified);
  const discoveredSources = sourceRecords.map((row) => row.source);
  const discoveredSorted = sorted(discoveredSources);

  const thirdLevel = invalidEntries.filter((row) => row.reason === "third-level-nesting");
  ensure(thirdLevel.length === 0, "third-level-nesting", "knowledge/runtime only permits files, not another directory layer", { entries: thirdLevel });
  ensure(invalidEntries.length === 0, "invalid-source-tree-entry", "knowledge closed world contains unsupported entries", { entries: invalidEntries });

  const caseFolded = discoveredSources.map((source) => source.toLowerCase());
  ensure(new Set(caseFolded).size === caseFolded.length, "case-insensitive-source-duplicate", "knowledge source paths collide case-insensitively");
  const unclassified = discoveredSorted.filter((source) => !expectedClassifiedSorted.includes(source));
  const missing = expectedClassifiedSorted.filter((source) => !discoveredSorted.includes(source));
  ensure(unclassified.length === 0, "unclassified-live-source", "live knowledge contains an unclassified source", { unclassified });
  ensure(missing.length === 0, "missing-live-source", "classified knowledge source is missing from the live tree", { missing });
  ensure(
    discoveredSources.length === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.sourceFiles,
    "live-source-cardinality-drift",
    "live knowledge source cardinality drifted",
    { expected: EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.sourceFiles, actual: discoveredSources.length },
  );

  ensure(pack.schema === "editkin.community-knowledge/v1", "pack-schema-drift", "community knowledge pack schema drifted");
  ensure(pack.sourceFileCount === pack.includedModuleCount + pack.excludedSourceCount, "pack-not-closed-world", "generated knowledge inventory is not closed-world");
  ensure(pack.sourceFileCount === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.sourceFiles, "pack-source-count-drift", "generated source count drifted");
  ensure(pack.includedModuleCount === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.includedModules, "pack-module-count-drift", "generated included module count drifted");
  ensure(pack.excludedSourceCount === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.excludedSources, "pack-exclusion-count-drift", "generated exclusion count drifted");
  ensure(Array.isArray(pack.modules) && pack.modules.length === pack.includedModuleCount, "pack-module-array-drift", "generated module array does not match its declared count");
  ensure(Array.isArray(pack.excluded) && pack.excluded.length === pack.excludedSourceCount, "pack-exclusion-array-drift", "generated exclusion array does not match its declared count");
  ensure(Array.isArray(pack.stableRules) && pack.stableRules.length === pack.stableRuleCount, "pack-stable-rule-array-drift", "generated stable rule array does not match its declared count");

  ensure(
    isDeepStrictEqual(pack.modules.map((row) => row.source), INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES),
    "pack-included-source-set-drift",
    "generated included source paths differ from the closed-world allowlist",
  );
  ensure(
    isDeepStrictEqual(pack.excluded.map((row) => row.source), Object.keys(EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES)),
    "pack-excluded-source-set-drift",
    "generated excluded source paths differ from the reasoned denylist",
  );
  ensure(new Set(pack.modules.map((row) => row.id)).size === pack.modules.length, "duplicate-module-id", "generated knowledge module id is duplicated");
  ensure(new Set(pack.stableRules.map((row) => row.id)).size === pack.stableRules.length, "duplicate-stable-rule-id", "generated stable rule id is duplicated");

  const emittedKnowledge = JSON.stringify({ modules: pack.modules, stableRules: pack.stableRules });
  ensure(
    !RETIRED_EDITOR_HISTORY_MARKER.test(emittedKnowledge),
    "retired-editor-history-marker",
    "retired editor history returned to the generated runtime knowledge",
  );
  ensure(
    !/(?:Hao0321|\bHao\b|駱君昊|自由工坊|\b[A-Z]:\\\\|\/(?:Users|home)\/[^/\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(packText),
    "personal-data-marker",
    "generated anonymous knowledge contains a personal identity, account, email, or local path",
  );

  const sourceByPath = new Map(sourceRecords.map((row) => [row.source, row.raw]));
  let omittedHistoryFragments = 0;
  for (const row of pack.modules) {
    const raw = sourceByPath.get(row.source);
    ensure(typeof raw === "string", "pack-source-not-live", `generated module source is not present live: ${row.source}`, { source: row.source });
    ensure(row.sourceSha256 === sha256(raw), "source-sha-drift", `generated source hash is stale: ${row.source}`, { source: row.source, expected: sha256(raw), actual: row.sourceSha256 });
    const format = row.source.endsWith(".json") ? "json" : "markdown";
    ensure(row.format === format, "module-format-drift", `generated module format drifted: ${row.source}`, { source: row.source });
    ensure(row.id === moduleIdFor(row.source), "module-id-drift", `generated module id drifted: ${row.source}`, { source: row.source });
    ensure(isDeepStrictEqual(row.tags, tagsFor(path.basename(row.source))), "module-tag-drift", `generated module tags drifted: ${row.source}`, { source: row.source });
    if (format === "json") {
      ensure(!RETIRED_EDITOR_HISTORY_MARKER.test(raw), "retired-editor-history-json-source", `included JSON source contains retired editor history: ${row.source}`, { source: row.source });
    }
    const derived = format === "markdown" ? omitRetiredEditorHistory(raw, row.source) : { content: raw, omittedFragments: 0 };
    const sanitized = sanitizePersonalData(derived.content);
    const expectedContent = format === "json" ? JSON.parse(sanitized) : sanitized;
    ensure(row.contentSha256 === sha256(sanitized), "derived-content-sha-drift", `generated content hash is stale: ${row.source}`, { source: row.source });
    ensure(isDeepStrictEqual(row.content, expectedContent), "derived-content-drift", `generated content differs from the live-source derivation: ${row.source}`, { source: row.source });
    ensure(row.derivation?.policy === DERIVATION_POLICY, "derivation-policy-drift", `generated derivation policy drifted: ${row.source}`, { source: row.source });
    ensure(row.derivation?.retiredEditorHistoryFragmentsOmitted === derived.omittedFragments, "retired-history-omission-count-drift", `retired history omission count drifted: ${row.source}`, { source: row.source });
    omittedHistoryFragments += derived.omittedFragments;
  }
  for (const row of pack.excluded) {
    const raw = sourceByPath.get(row.source);
    ensure(typeof raw === "string", "excluded-source-not-live", `generated exclusion source is not present live: ${row.source}`, { source: row.source });
    ensure(row.sourceSha256 === sha256(raw), "source-sha-drift", `generated excluded source hash is stale: ${row.source}`, { source: row.source, expected: sha256(raw), actual: row.sourceSha256 });
    ensure(row.reason === EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES[row.source], "exclusion-reason-drift", `generated exclusion reason drifted: ${row.source}`, { source: row.source });
  }

  const requiredModules = new Set([
    "ai-content-compliance", "genre-editing-craft", "premium-motion-fx", "script-retention-craft",
    "shorts-mastery-2026", "video-craft-playbook", "viral-playbook-framework", "youtube-algorithm-mastery",
  ]);
  const includedModuleIds = new Set(pack.modules.map((row) => row.id));
  const missingRequiredModules = [...requiredModules].filter((id) => !includedModuleIds.has(id));
  ensure(missingRequiredModules.length === 0, "required-module-missing", "anonymous knowledge is missing required core modules", { missing: missingRequiredModules });

  const expectedStableRules = extractStableRules(skillText);
  ensureSecureReviewPolicy(expectedStableRules);
  ensure(
    expectedStableRules.length === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.stableRules,
    "live-stable-rule-cardinality-drift",
    "canonical Video Autopilot stable rule cardinality drifted",
    { expected: EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.stableRules, actual: expectedStableRules.length },
  );
  ensure(pack.stableRuleCount === EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.stableRules, "pack-stable-rule-count-drift", "generated stable rule count drifted");
  ensureSecureReviewPolicy(pack.stableRules);
  ensure(isDeepStrictEqual(pack.stableRules, expectedStableRules), "stable-rule-live-drift", "generated stable rules differ from the canonical Video Autopilot Skill");
  const stableRulesSha256 = sha256(JSON.stringify(expectedStableRules));
  ensure(pack.stableRulesSha256 === stableRulesSha256, "stable-rule-sha-drift", "generated stable rule hash differs from the canonical Video Autopilot Skill");

  const packSha256 = sha256(packText);
  const expectedSummary = {
    schema: pack.schema,
    privacy: pack.privacy,
    sourceFileCount: pack.sourceFileCount,
    includedModuleCount: pack.includedModuleCount,
    excludedSourceCount: pack.excludedSourceCount,
    stableRuleCount: pack.stableRuleCount,
    stableRulesSha256: pack.stableRulesSha256,
    packSha256,
  };
  ensure(isDeepStrictEqual(summary, expectedSummary), "summary-pack-drift", "bounded UI summary differs from the full generated pack");

  const sourceInventorySha256 = sha256(sourceRecords
    .map((row) => `${row.source}\0${sha256(row.raw)}`)
    .sort()
    .join("\n"));
  return {
    status: "GREEN",
    sourceFiles: discoveredSources.length,
    modules: pack.includedModuleCount,
    stableRules: pack.stableRuleCount,
    excludedWithReason: pack.excludedSourceCount,
    omittedRetiredHistoryFragments: omittedHistoryFragments,
    sourceInventorySha256,
    canonicalSkillSha256: sha256(skillText),
    stableRulesSha256,
    bytes: Buffer.byteLength(packText),
    sha256: packSha256,
    uiSummaryBytes: Buffer.byteLength(`${JSON.stringify(summary, null, 2)}\n`),
  };
}

function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function refreshPackText(snapshot) {
  snapshot.packText = `${JSON.stringify(snapshot.pack, null, 2)}\n`;
}

function expectNegative(base, id, expectedCode, mutate) {
  const snapshot = cloneSnapshot(base);
  mutate(snapshot);
  refreshPackText(snapshot);
  try {
    evaluateSnapshot(snapshot);
  } catch (error) {
    ensure(error instanceof KnowledgeGateFailure, "self-test-unexpected-error", `negative control ${id} raised an unexpected error`, { name: error?.name, message: error?.message });
    ensure(error.code === expectedCode, "self-test-wrong-failure", `negative control ${id} failed for the wrong reason`, { expectedCode, actualCode: error.code });
    return { id, detected: error.code };
  }
  fail("self-test-false-green", `negative control ${id} was not detected`, { expectedCode });
}

function expectSecureReviewPolicyNegative(baseRules, id, expectedCode, mutate) {
  const rules = structuredClone(baseRules);
  mutate(rules);
  try {
    ensureSecureReviewPolicy(rules);
  } catch (error) {
    ensure(error instanceof KnowledgeGateFailure, "self-test-unexpected-error", `negative control ${id} raised an unexpected error`, { name: error?.name, message: error?.message });
    ensure(error.code === expectedCode, "self-test-wrong-failure", `negative control ${id} failed for the wrong reason`, { expectedCode, actualCode: error.code });
    return { id, detected: error.code };
  }
  fail("self-test-false-green", `negative control ${id} was not detected`, { expectedCode });
}

async function runSelfTest() {
  const base = await loadLiveSnapshot();
  const positive = evaluateSnapshot(base);
  const firstIncludedSource = INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES[0];
  const liveStableRules = extractStableRules(base.skillText);
  const firstRule = liveStableRules[0];
  const negativeControls = [
    expectNegative(base, "new-unclassified-file", "unclassified-live-source", (snapshot) => {
      snapshot.sourceRecords.push({ source: "unclassified-new-source.md", raw: "# unclassified" });
    }),
    expectNegative(base, "missing-classified-file", "missing-live-source", (snapshot) => {
      snapshot.sourceRecords = snapshot.sourceRecords.filter((row) => row.source !== firstIncludedSource);
    }),
    expectNegative(base, "third-level-runtime-nesting", "third-level-nesting", (snapshot) => {
      snapshot.invalidEntries.push({ path: "runtime/nested/source.md", reason: "third-level-nesting" });
    }),
    expectNegative(base, "live-source-hash-drift", "source-sha-drift", (snapshot) => {
      const row = snapshot.sourceRecords.find((candidate) => candidate.source === firstIncludedSource);
      row.raw += "\nnegative drift fixture";
    }),
    expectNegative(base, "retired-editor-history-return", "retired-editor-history-marker", (snapshot) => {
      snapshot.pack.modules[0].content += "\ncapcut-agent-ops retired history must never return.";
    }),
    expectNegative(base, "canonical-stable-rule-drift", "stable-rule-live-drift", (snapshot) => {
      const boundary = new RegExp(`(^.*\\b${escapeRegex(firstRule.id)}\\b.*$)`, "m");
      snapshot.skillText = snapshot.skillText.replace(boundary, "$1 [negative stable-rule drift]");
    }),
    expectNegative(base, "bounded-summary-drift", "summary-pack-drift", (snapshot) => {
      snapshot.summary.packSha256 = "0".repeat(64);
    }),
    expectSecureReviewPolicyNegative(liveStableRules, "review-mutation-controls-removed", "secure-review-policy-term-missing", (rules) => {
      const rule = rules.find((row) => row.id === "M158");
      rule.text = rule.text.replace("Sec-Fetch-Site: same-origin", "Fetch metadata omitted");
    }),
    expectSecureReviewPolicyNegative(liveStableRules, "secret-path-review-return", "insecure-review-policy-returned", (rules) => {
      const rule = rules.find((row) => row.id === "M159");
      rule.text += " 啟動秘密 HTTPS Quick Tunnel";
    }),
  ];
  return { status: "GREEN", selfTest: true, positive, negativeControls };
}

try {
  const result = process.argv.includes("--self-test")
    ? await runSelfTest()
    : evaluateSnapshot(await loadLiveSnapshot());
  console.log(JSON.stringify(result));
} catch (error) {
  const payload = error instanceof KnowledgeGateFailure
    ? { status: "BLOCK", code: error.code, message: error.message, details: error.details }
    : { status: "BLOCK", code: "unexpected-error", message: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
}

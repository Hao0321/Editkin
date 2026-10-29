import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCommunityPolicySnapshot, assertCommunityPolicyCurrent, extractCommunityStableRules, communityRuleSourceIdentities } from "./lib/community-stable-rules.mjs";
import {
  EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES,
  EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS,
  INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES,
  RETIRED_EDITOR_HISTORY_MARKER,
} from "./lib/community-knowledge-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(root, "..", "..", "video-autopilot-kit", "knowledge");
const outputPath = path.join(root, "src", "knowledge", "editkinCommunityKnowledge.json");
const summaryPath = path.join(root, "src", "knowledge", "editkinCommunityKnowledgeSummary.json");

const includedSources = new Set(INCLUDED_COMMUNITY_KNOWLEDGE_SOURCES);
const excludedSources = new Map(Object.entries(EXCLUDED_COMMUNITY_KNOWLEDGE_SOURCES));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
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
  if (RETIRED_EDITOR_HISTORY_MARKER.test(content)) {
    throw new Error(`retired editor history was not fully omitted from ${source}`);
  }
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

const sourceLayers = [
  { root: sourceRoot, prefix: "" },
  { root: path.join(sourceRoot, "runtime"), prefix: "runtime" },
];
const sourceEntries = [];
for (const layer of sourceLayers) {
  const entries = (await readdir(layer.root, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
  sourceEntries.push(...entries.map((entry) => ({ ...entry, root: layer.root, prefix: layer.prefix })));
}
sourceEntries.sort((a, b) => `${a.prefix}/${a.name}`.localeCompare(`${b.prefix}/${b.name}`));
const discoveredSources = sourceEntries.map((entry) => entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name);
const classifiedSources = new Set([...includedSources, ...excludedSources.keys()]);
const unclassifiedSources = discoveredSources.filter((source) => !classifiedSources.has(source));
const missingSources = [...classifiedSources].filter((source) => !discoveredSources.includes(source));
if (unclassifiedSources.length > 0 || missingSources.length > 0) {
  throw new Error(`community knowledge inventory drifted: unclassified=${JSON.stringify(unclassifiedSources)} missing=${JSON.stringify(missingSources)}`);
}
if (discoveredSources.length !== EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.sourceFiles) {
  throw new Error(`community knowledge source cardinality drifted: expected ${EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.sourceFiles}, received ${discoveredSources.length}`);
}
const modules = [];
const excluded = [];
for (const entry of sourceEntries) {
  const absolute = path.join(entry.root, entry.name);
  const source = entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name;
  const raw = await readFile(absolute, "utf8");
  if (excludedSources.has(source)) {
    excluded.push({ source, sourceSha256: sha256(raw), reason: excludedSources.get(source) });
    continue;
  }
  if (!includedSources.has(source)) throw new Error(`unclassified community knowledge source: ${source}`);
  const format = entry.name.endsWith(".json") ? "json" : "markdown";
  if (format === "json" && RETIRED_EDITOR_HISTORY_MARKER.test(raw)) {
    throw new Error(`included JSON knowledge contains retired editor history and must be curated at source: ${source}`);
  }
  const derived = format === "markdown" ? omitRetiredEditorHistory(raw, source) : { content: raw, omittedFragments: 0 };
  const sanitized = sanitizePersonalData(derived.content);
  modules.push({
    id: entry.name.replace(/\.(?:json|md)$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(),
    source,
    sourceSha256: sha256(raw),
    contentSha256: sha256(sanitized),
    format,
    tags: tagsFor(entry.name),
    derivation: {
      policy: "personal-data-sanitized; retired-editor-history-omitted-never-renamed",
      retiredEditorHistoryFragmentsOmitted: derived.omittedFragments,
    },
    content: format === "json" ? JSON.parse(sanitized) : sanitized,
  });
}

if (modules.length !== EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.includedModules || excluded.length !== EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.excludedSources) {
  throw new Error(`community knowledge classification cardinality drifted: included=${modules.length} excluded=${excluded.length}`);
}

const policy = await readCommunityPolicySnapshot();
const stableRules = extractCommunityStableRules(policy.records, sanitizePersonalData);
const stableRuleSources = communityRuleSourceIdentities(policy.records);
if (stableRules.length !== EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.stableRules) {
  throw new Error(`stable rule cardinality drifted: expected ${EXPECTED_COMMUNITY_KNOWLEDGE_COUNTS.stableRules}, received ${stableRules.length}`);
}
const pack = {
  schema: "editkin.community-knowledge/v1",
  generatedFrom: "video-autopilot current stable knowledge",
  privacy: "anonymous generalized editing knowledge; no personal names, accounts, local paths, raw outcomes, original reference artwork or private state",
  sourceFileCount: sourceEntries.length,
  includedModuleCount: modules.length,
  excludedSourceCount: excluded.length,
  stableRuleCount: stableRules.length,
  stableRulesSha256: sha256(JSON.stringify(stableRules)),
  stableRuleSources,
  stableRuleSourcesSha256: sha256(JSON.stringify(stableRuleSources)),
  modules,
  stableRules,
  excluded,
};
const payload = `${JSON.stringify(pack, null, 2)}\n`;
const summary = {
  schema: pack.schema,
  privacy: pack.privacy,
  sourceFileCount: pack.sourceFileCount,
  includedModuleCount: pack.includedModuleCount,
  excludedSourceCount: pack.excludedSourceCount,
  stableRuleCount: pack.stableRuleCount,
  stableRulesSha256: pack.stableRulesSha256,
  stableRuleSourcesSha256: pack.stableRuleSourcesSha256,
  packSha256: sha256(payload),
};
await assertCommunityPolicyCurrent(policy);
await mkdir(path.dirname(outputPath), { recursive: true });
await Promise.all([
  writeFile(outputPath, payload, "utf8"),
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
]);
console.log(JSON.stringify({ status: "GREEN", outputPath, summaryPath, modules: modules.length, stableRules: stableRules.length, excluded: excluded.length, bytes: Buffer.byteLength(payload), sha256: summary.packSha256 }));

import knowledgePackJson from "../knowledge/editkinCommunityKnowledge.json";
import { createHash } from "node:crypto";
import { communityKnowledgeSummary } from "./communityKnowledgeSummary";
import {
  KNOWLEDGE_PAGE_DEFAULT_TOKENS,
  KNOWLEDGE_PAGE_MAX_TOKENS,
  paginateAgentRows,
  sliceTextToAgentBudget,
} from "./agentContextBudget";

interface KnowledgeModule {
  id: string;
  source: string;
  sourceSha256: string;
  contentSha256: string;
  format: "json" | "markdown";
  tags: string[];
  derivation: {
    policy: "personal-data-sanitized; retired-editor-history-omitted-never-renamed";
    retiredEditorHistoryFragmentsOmitted: number;
  };
  content: unknown;
}

interface KnowledgePack {
  schema: "editkin.community-knowledge/v1";
  privacy: string;
  sourceFileCount: number;
  includedModuleCount: number;
  excludedSourceCount: number;
  stableRuleCount: number;
  stableRulesSha256: string;
  modules: KnowledgeModule[];
  stableRules: Array<{ id: string; text: string }>;
}

export const EDITKIN_COMMUNITY_KNOWLEDGE = knowledgePackJson as KnowledgePack;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Recomputes the two shipped knowledge identities from the actual in-memory pack.
 * This prevents the small UI summary from becoming an unchecked source of truth.
 */
export function communityKnowledgeIdentity() {
  const summary = communityKnowledgeSummary();
  const packSha256 = sha256(`${JSON.stringify(knowledgePackJson, null, 2)}\n`);
  const stableRulesSha256 = sha256(JSON.stringify(EDITKIN_COMMUNITY_KNOWLEDGE.stableRules));
  if (packSha256 !== summary.packSha256) throw new Error("匿名知識包與摘要 SHA-256 不一致");
  if (stableRulesSha256 !== summary.stableRulesSha256) throw new Error("匿名知識 stable rules SHA-256 不一致");
  if (EDITKIN_COMMUNITY_KNOWLEDGE.includedModuleCount !== summary.includedModuleCount
    || EDITKIN_COMMUNITY_KNOWLEDGE.stableRuleCount !== summary.stableRuleCount) {
    throw new Error("匿名知識包與摘要數量不一致");
  }
  return {
    schema: summary.schema,
    revision: summary.stableRuleCount,
    packSha256,
    stableRulesSha256,
    includedModuleCount: summary.includedModuleCount,
    stableRuleCount: summary.stableRuleCount,
  } as const;
}

export function listCommunityKnowledge(filter: {
  tags?: string[];
  query?: string;
  offset?: number;
  limit?: number;
} = {}) {
  const tags = new Set((filter.tags ?? []).map((tag) => tag.toLowerCase()));
  const query = filter.query?.trim().toLowerCase();
  const rows = EDITKIN_COMMUNITY_KNOWLEDGE.modules
    .filter((module) => tags.size === 0 || [...tags].some((tag) => module.tags.includes(tag)))
    .filter((module) => !query || `${module.id} ${module.source} ${module.tags.join(" ")}`.toLowerCase().includes(query))
    .map(({ id, source, sourceSha256, contentSha256, format, tags: moduleTags, content }) => ({
      id, source, sourceSha256, contentSha256, format, tags: moduleTags,
      characters: typeof content === "string" ? content.length : JSON.stringify(content).length,
    }));
  const paginated = paginateAgentRows(rows, filter.offset ?? 0, Math.min(16, filter.limit ?? 16));
  return {
    modules: paginated.page,
    totalModules: paginated.total,
    offset: paginated.offset,
    limit: paginated.limit,
    nextOffset: paginated.nextOffset,
  };
}

export function readCommunityKnowledge(
  moduleId: string,
  offset = 0,
  maxChars = 4_000,
  maxTokens = KNOWLEDGE_PAGE_DEFAULT_TOKENS,
) {
  const module = EDITKIN_COMMUNITY_KNOWLEDGE.modules.find((row) => row.id === moduleId);
  if (!module) throw new Error(`找不到匿名知識模組：${moduleId}`);
  const content = typeof module.content === "string" ? module.content : JSON.stringify(module.content, null, 2);
  const size = Math.max(500, Math.min(6_000, Math.floor(maxChars)));
  const tokenLimit = Math.max(200, Math.min(KNOWLEDGE_PAGE_MAX_TOKENS, Math.floor(maxTokens)));
  const safeOffset = Math.max(0, Math.min(content.length, Math.floor(offset)));
  const page = sliceTextToAgentBudget(content, safeOffset, size, tokenLimit);
  return {
    id: module.id,
    format: module.format,
    tags: module.tags,
    contentSha256: module.contentSha256,
    offset: safeOffset,
    text: page.text,
    nextOffset: page.nextOffset,
    totalCharacters: content.length,
    maxTokens: tokenLimit,
    estimatedTokens: page.estimatedTokens,
  };
}

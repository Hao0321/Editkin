export const AGENT_CONTEXT_MAX_TOKENS = 1_100;
export const MATERIAL_CONTEXT_DEFAULT_TOKENS = 600;
export const KNOWLEDGE_PAGE_DEFAULT_TOKENS = 700;
export const KNOWLEDGE_PAGE_MAX_TOKENS = 900;
export const MATERIAL_KEYFRAME_MAX_IMAGES = 4;
export const MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES = 1_000_000;

/**
 * A conservative, provider-neutral estimate used as a fail-closed payload gate.
 * ASCII is charged at one token per four code points; every non-ASCII code point
 * is charged as one token. Provider billing remains authoritative.
 */
export function estimateAgentContextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function sliceTextToAgentBudget(
  content: string,
  offset: number,
  maxChars: number,
  maxTokens: number,
) {
  const safeOffset = Math.max(0, Math.min(content.length, Math.floor(offset)));
  const characterLimit = Math.max(1, Math.floor(maxChars));
  const tokenLimit = Math.max(1, Math.floor(maxTokens));
  let cursor = safeOffset;
  let characters = 0;
  let tokenQuarterUnits = 0;
  while (cursor < content.length && characters < characterLimit) {
    const codePoint = content.codePointAt(cursor)!;
    const character = String.fromCodePoint(codePoint);
    const units = codePoint <= 0x7f ? 1 : 4;
    if (tokenQuarterUnits + units > tokenLimit * 4) break;
    cursor += character.length;
    characters += 1;
    tokenQuarterUnits += units;
  }
  const text = content.slice(safeOffset, cursor);
  return {
    text,
    nextOffset: cursor < content.length ? cursor : undefined,
    estimatedTokens: Math.ceil(tokenQuarterUnits / 4),
  };
}

export function paginateAgentRows<T>(rows: readonly T[], offset: number, limit: number) {
  const safeOffset = Math.max(0, Math.min(rows.length, Math.floor(offset)));
  const safeLimit = Math.max(1, Math.floor(limit));
  const page = rows.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length < rows.length ? safeOffset + page.length : undefined;
  return { page, total: rows.length, offset: safeOffset, limit: safeLimit, nextOffset };
}

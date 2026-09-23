import summaryJson from "../knowledge/editkinCommunityKnowledgeSummary.json";

interface KnowledgeSummary {
  schema: "editkin.community-knowledge/v1";
  privacy: string;
  sourceFileCount: number;
  includedModuleCount: number;
  excludedSourceCount: number;
  stableRuleCount: number;
  stableRulesSha256: string;
  packSha256: string;
}

const summary = summaryJson as KnowledgeSummary;

export function communityKnowledgeSummary(): KnowledgeSummary {
  return { ...summary };
}

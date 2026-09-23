import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AUTOPILOT_MAX_PLAN_BYTES,
  compactAutopilotContract,
  parseAutopilotPlan,
} from "../src/application/autopilotPlan";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import {
  AGENT_CONTEXT_MAX_TOKENS,
  KNOWLEDGE_PAGE_DEFAULT_TOKENS,
  KNOWLEDGE_PAGE_MAX_TOKENS,
  MATERIAL_CONTEXT_DEFAULT_TOKENS,
  MATERIAL_KEYFRAME_MAX_IMAGES,
  MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES,
} from "../src/application/agentContextBudget";
import { listCommunityKnowledge, readCommunityKnowledge } from "../src/application/communityKnowledge";
import {
  MATERIAL_INTELLIGENCE_SCHEMA,
  compactMaterialContext,
  type MaterialIntelligencePacket,
} from "../src/application/materialIntelligence";
import agentSetupContract from "../src/shared/agentSetupContract.json";

const root = resolve(import.meta.dirname, "..");
const outputPath = resolve(root, "../../.rd/benchmarks/editkin-agent-context-budget.json");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Conservative cross-model estimate: non-ASCII code points count as one token;
// ASCII text counts as one token per four characters.
function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function packetFixture(): MaterialIntelligencePacket {
  const cues = Array.from({ length: 2_000 }, (_, index) => ({
    start: index * 0.5,
    end: index * 0.5 + 0.45,
    text: `第${index + 1}段：${"這是需要保持有界的逐字稿內容".repeat(12)}`,
  }));
  const cuts = Array.from({ length: 500 }, (_, index) => ({ time: index * 2, frame: index * 60, score: 70 }));
  return {
    schema: MATERIAL_INTELLIGENCE_SCHEMA,
    materialId: "a".repeat(64),
    source: {
      assetId: "asset-long",
      clipId: "clip-long",
      sourceSha256: "b".repeat(64),
      sourceStart: 0,
      duration: 1_000,
      kind: "video",
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
    },
    analysis: {
      scene: { state: "ready", engine: "fixture", cuts },
      transcript: { state: "ready", engine: "fixture", language: "zh", cueCount: cues.length, cues },
    },
    keyframes: Array.from({ length: 12 }, (_, index) => ({
      id: `kf-${index + 1}`,
      time: index * 80,
      sceneIndex: index * 40,
      sha256: `${(index % 10).toString()}`.repeat(64),
      bytes: 80_000,
      mimeType: "image/jpeg" as const,
      fileName: `frame-${String(index + 1).padStart(2, "0")}.jpg`,
    })),
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function evaluate(report: {
  material: { bytes: number; estimatedTokens: number; cueCount: number; cutCount: number; hasCursor: boolean };
  knowledgeList: { bytes: number; rowCount: number; hasPagination: boolean };
  knowledgePage: { estimatedTokens: number; hasPagination: boolean };
  plan: { rawTranscriptRejected: boolean; rawFramesRejected: boolean; mismatchedBudgetRejected: boolean; oversizedPlanRejected: boolean };
  boundary: {
    starterPromptEditkinOnly: boolean;
    boundedMaterialWorkflow: boolean;
    rawContextForbidden: boolean;
    evidenceFirst: boolean;
    localExecutionContract: boolean;
  };
}) {
  const failures: string[] = [];
  if (report.material.bytes > 16_384) failures.push(`material-context-bytes:${report.material.bytes}`);
  if (report.material.estimatedTokens > 1_100) failures.push(`material-context-tokens:${report.material.estimatedTokens}`);
  if (report.material.cueCount > 80) failures.push(`material-context-cues:${report.material.cueCount}`);
  if (report.material.cutCount > 100) failures.push(`material-context-cuts:${report.material.cutCount}`);
  if (!report.material.hasCursor) failures.push("material-context-missing-cursor");
  if (report.knowledgeList.bytes > 16_384) failures.push(`knowledge-list-bytes:${report.knowledgeList.bytes}`);
  if (report.knowledgeList.rowCount > 16) failures.push(`knowledge-list-rows:${report.knowledgeList.rowCount}`);
  if (!report.knowledgeList.hasPagination) failures.push("knowledge-list-missing-pagination");
  if (report.knowledgePage.estimatedTokens > 900) failures.push(`knowledge-page-tokens:${report.knowledgePage.estimatedTokens}`);
  if (!report.knowledgePage.hasPagination) failures.push("knowledge-page-missing-pagination");
  if (!report.plan.rawTranscriptRejected) failures.push("plan-raw-transcript-accepted");
  if (!report.plan.rawFramesRejected) failures.push("plan-raw-frames-accepted");
  if (!report.plan.mismatchedBudgetRejected) failures.push("plan-mismatched-budget-accepted");
  if (!report.plan.oversizedPlanRejected) failures.push("oversized-plan-accepted");
  if (!report.boundary.starterPromptEditkinOnly) failures.push("starter-prompt-external-editor-boundary-missing");
  if (!report.boundary.boundedMaterialWorkflow) failures.push("starter-prompt-bounded-material-workflow-missing");
  if (!report.boundary.rawContextForbidden) failures.push("starter-prompt-raw-context-prohibition-missing");
  if (!report.boundary.evidenceFirst) failures.push("starter-prompt-evidence-flow-missing");
  if (!report.boundary.localExecutionContract) failures.push("local-execution-contract-missing");
  return { status: failures.length ? "BLOCK" : "GREEN", failures } as const;
}

async function run() {
  const packet = packetFixture();
  const fullTranscriptJson = JSON.stringify(packet.analysis.transcript.cues);
  const allKeyframeJpegBytes = packet.keyframes.reduce((sum, frame) => sum + frame.bytes, 0);
  const materialContext = (compactMaterialContext as unknown as (
    packet: MaterialIntelligencePacket,
    start: number,
    end: number,
    maxCues: number,
    options: { afterCueIndex: number; maxTokens: number },
  ) => ReturnType<typeof compactMaterialContext>)(packet, 0, 1_000, 200, { afterCueIndex: -1, maxTokens: 600 });
  const materialJson = JSON.stringify(materialContext);

  const knowledgeList = (listCommunityKnowledge as unknown as (filter: {
    offset: number;
    limit: number;
  }) => unknown)({ offset: 0, limit: 16 }) as { modules?: unknown[]; nextOffset?: number } | unknown[];
  const knowledgeRows = Array.isArray(knowledgeList) ? knowledgeList : knowledgeList.modules ?? [];
  const knowledgePage = (readCommunityKnowledge as unknown as (
    moduleId: string,
    offset: number,
    maxChars: number,
    maxTokens: number,
  ) => ReturnType<typeof readCommunityKnowledge>)(String((knowledgeRows[0] as { id?: string })?.id), 0, 6_000, 700);

  const plan = createAutopilotV4Fixture();
  const contract = compactAutopilotContract();
  const starterPrompt = agentSetupContract.starterPrompt;
  const rejects = (candidate: unknown) => {
    try { parseAutopilotPlan(candidate); return false; } catch { return true; }
  };
  const report = {
    schema: "editkin.agent-context-budget-benchmark/v1",
    capturedAt: new Date().toISOString(),
    mode: baseline ? "baseline" : selfTest ? "self_test" : "candidate",
    estimator: "ceil(ascii-codepoints/4)+non-ascii-codepoints",
    limits: {
      materialResponseBytes: 16_384,
      materialEstimatedTokens: 1_100,
      materialCueCount: 80,
      materialCutCount: 100,
      knowledgeListBytes: 16_384,
      knowledgeListRows: 16,
      knowledgePageEstimatedTokens: 900,
      defaultMaterialTokens: MATERIAL_CONTEXT_DEFAULT_TOKENS,
      maxAgentTextTokens: AGENT_CONTEXT_MAX_TOKENS,
      defaultKnowledgeTokens: KNOWLEDGE_PAGE_DEFAULT_TOKENS,
      maxKnowledgeTokens: KNOWLEDGE_PAGE_MAX_TOKENS,
      maxKeyframesPerCall: MATERIAL_KEYFRAME_MAX_IMAGES,
      maxKeyframeResponseBytes: MATERIAL_KEYFRAME_MAX_RESPONSE_BYTES,
      maxPlanBytes: AUTOPILOT_MAX_PLAN_BYTES,
    },
    theoreticalUnbounded: {
      fullTranscriptBytes: Buffer.byteLength(fullTranscriptJson, "utf8"),
      fullTranscriptEstimatedTokens: estimateTokens(fullTranscriptJson),
      allKeyframes: packet.keyframes.length,
      allKeyframeJpegBytes,
      allKeyframeBase64TransportBytes: Math.ceil(allKeyframeJpegBytes / 3) * 4,
    },
    material: {
      bytes: jsonBytes(materialContext),
      estimatedTokens: estimateTokens(materialJson),
      cueCount: materialContext.transcript.cues.length,
      cutCount: materialContext.cuts.length,
      hasCursor: "nextCueIndex" in materialContext.transcript,
    },
    knowledgeList: {
      bytes: jsonBytes(knowledgeList),
      rowCount: knowledgeRows.length,
      hasPagination: !Array.isArray(knowledgeList) && "totalModules" in knowledgeList,
    },
    knowledgePage: {
      bytes: jsonBytes(knowledgePage),
      estimatedTokens: estimateTokens(knowledgePage.text),
      hasPagination: "estimatedTokens" in knowledgePage && "maxTokens" in knowledgePage,
    },
    contract: { bytes: jsonBytes(contract), estimatedTokens: estimateTokens(JSON.stringify(contract)) },
    plan: {
      fixtureBytes: jsonBytes(plan),
      declaredContextTokens: plan.budget.contextTokens,
      rawTranscriptRejected: rejects({ ...plan, rawTranscript: packet.analysis.transcript.cues }),
      rawFramesRejected: rejects({ ...plan, rawFrames: ["base64-frame"] }),
      oversizedPlanRejected: rejects({ ...plan, oversizedPadding: "x".repeat(AUTOPILOT_MAX_PLAN_BYTES + 1) }),
      mismatchedBudgetRejected: rejects({
        ...plan,
        inference: { ...plan.inference, context: { ...plan.inference.context, packetTokens: plan.budget.contextTokens - 1 } },
      }),
    },
    executionBoundary: {
      rawSourceBytesInAgentContext: false,
      selectedJpegKeyframesInAgentContext: true,
      boundedTranscriptTextInAgentContext: true,
      editExecutionOwner: "Editkin local EditGraph/Rust/FFmpeg",
    },
    boundary: {
      starterPromptEditkinOnly: starterPrompt.includes("全程只使用 Editkin MCP、EditGraph") && starterPrompt.includes("不得把計畫或素材交給任何外部剪輯器"),
      boundedMaterialWorkflow: starterPrompt.includes("prepare_ai_material")
        && starterPrompt.includes("get_material_context(afterCueIndex,maxTokens)")
        && starterPrompt.includes("view_material_keyframes")
        && starterPrompt.includes("record_material_semantics")
        && starterPrompt.includes("每次最多四張"),
      rawContextForbidden: starterPrompt.includes("原始影片、整份逐字稿與整批關鍵幀不得送進 Agent context"),
      evidenceFirst: starterPrompt.includes("start_ai_editing_session") && starterPrompt.includes("prepare_ai_material")
        && starterPrompt.includes("record_material_semantics") && starterPrompt.includes("audit_autopilot_plan")
        && starterPrompt.includes("apply_autopilot_plan"),
      localExecutionContract: contract.planes.some((plane) => plane.id === "execution" && plane.integration === "native")
        && contract.boundary.includes("Editkin validates and executes"),
    },
  };
  const decision = evaluate(report);
  const envelope = { ...report, decision };
  if (selfTest) {
    const oversized = structuredClone(report);
    oversized.material.bytes = oversized.limits.materialResponseBytes + 1;
    const missingCursor = structuredClone(report);
    missingCursor.material.hasCursor = false;
    const controls = {
      positive: decision.status,
      oversizedPayload: evaluate(oversized).status,
      missingPagination: evaluate(missingCursor).status,
    };
    const status = controls.positive === "GREEN" && controls.oversizedPayload === "BLOCK" && controls.missingPagination === "BLOCK" ? "GREEN" : "BLOCK";
    console.log(JSON.stringify({ schema: "editkin.agent-context-budget-benchmark-self-test/v1", status, controls }));
    if (status !== "GREEN") process.exitCode = 1;
    return;
  }
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(envelope));
  if (!baseline && decision.status !== "GREEN") process.exitCode = 1;
}

await run();

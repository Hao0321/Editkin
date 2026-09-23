import { AUTOPILOT_PLAN_SCHEMA, AUTOPILOT_PLAN_SCHEMA_V2, AUTOPILOT_PLAN_SCHEMA_V3 } from "./autopilotPlan";
import {
  AUTOPILOT_CONTEXT_PROTOCOL,
  AUTOPILOT_INFERENCE_SCHEMA,
  inferenceRouterSha256,
  renderInferenceRouterMarkdown,
} from "./inferencePolicy";
import { resolveAestheticSystemForDomain } from "./editkinAesthetic";
import type { AutopilotPlanLiveSource } from "./autopilotInvocationIdentity";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";

const fixtureSource: AutopilotPlanLiveSource = {
  skillId: "video-autopilot",
  revision: 183,
  skillSha256: "a".repeat(64),
  workflowContractRevision: 2,
  workflowContractSha256: "b".repeat(64),
  knowledgeRevision: 77,
  knowledgeSha256: "c".repeat(64),
  stableRulesSha256: "d".repeat(64),
  pluginRegistrySha256: "e".repeat(64),
  invocationBindingSha256: "f".repeat(64),
};

export function createAutopilotV4Fixture(source: AutopilotPlanLiveSource = fixtureSource) {
  const markdown = renderInferenceRouterMarkdown("editorial_plan", "balanced");
  const route = { mode: "build", format: "longform", domain: "technology" } as const;
  const aesthetic = resolveAestheticSystemForDomain(route.domain, route.format);
  return {
    schema: AUTOPILOT_PLAN_SCHEMA,
    source,
    route,
    budget: { contextTokens: 800, selectedMemoryRuleIds: ["M117", "K-03fb82e28066"], trimmedMemoryRuleCount: 2, assetCandidateCount: 0 },
    assurances: {
      originalAssetsReadOnly: true,
      structuredCommandsOnly: true,
      semanticAssetsOnly: true,
      licenseFailClosed: true,
      captionsSeparateFromGraphics: true,
      reviewDoesNotEqualCertification: true,
    },
    quality: { state: "review_required" },
    inference: {
      schema: AUTOPILOT_INFERENCE_SCHEMA,
      provider: "codex",
      modelId: "gpt-5.6-sol",
      modelTier: "frontier",
      reasoningEffort: "medium",
      taskClass: "editorial_plan",
      priority: "balanced",
      context: {
        protocol: AUTOPILOT_CONTEXT_PROTOCOL,
        markdownRouterSha256: inferenceRouterSha256(markdown),
        packetTokens: 800,
        progressiveDisclosure: true,
        structuredExecutionTruth: true,
      },
      evaluation: { state: "unmeasured" },
      safeguards: {
        semanticAuditRequired: true,
        automaticEscalationOnBlock: true,
        executionMode: "audit_then_apply",
        secondPassRequired: true,
        humanReviewRequired: true,
      },
    },
    materialEvidence: {
      schema: "hao.editkin.material-intelligence/v1",
      receipts: [{
        materialId: "c".repeat(64),
        sourceSha256: "d".repeat(64),
        assetId: "asset-source-1",
        clipId: "clip-source-1",
        semanticReceiptSha256: "e".repeat(64),
      }],
    },
    extensions: {
      skillSelection: createEmptyEditkinSkillSelectionReceipt(source.pluginRegistrySha256, { format: "longform", domain: route.domain, semanticRoles: [] }),
      pluginApplications: [],
    },
    aesthetic,
    editorial: {
      brief: {
        audience: "想快速理解產品成果的一般觀眾",
        premise: "從混亂素材建立一支清楚的科技影片",
        promise: "開場立即看見自動剪輯前後差異",
        stakes: "如果資訊順序不清楚，觀眾會錯過核心價值",
        payoff: "用真實輸出與 receipt 證明成片可重做",
        firstFramePromise: "先顯示最終成片與原始素材對照",
      },
      narrative: {
        backbone: "先看結果，再理解方法，最後驗證結果",
        beats: [
          { id: "promise", range: { startFrame: 0, endFrame: 30 }, role: "promise", summary: "展示結果", energy: 0.8, primaryFocus: "成片差異", evidenceRefs: ["project:preview-final"] },
          { id: "setup", range: { startFrame: 30, endFrame: 60 }, role: "setup", summary: "交代素材問題", energy: 0.45, primaryFocus: "原始素材", evidenceRefs: ["asset:source-1"] },
          { id: "payoff", range: { startFrame: 60, endFrame: 90 }, role: "payoff", summary: "用 receipt 驗證", energy: 0.95, primaryFocus: "可重做證據", evidenceRefs: ["receipt:render-1"] },
        ],
        setupPayoffs: [{ setupBeatId: "setup", payoffBeatId: "payoff" }],
      },
      packaging: {
        hypotheses: [{ id: "package-a", title: "自動剪輯真的能一次完成嗎？", thumbnailPromise: "原始素材與成片對照", openingFulfillment: "第一秒顯示前後差異", distinctFromIds: [] }],
        evaluationMetric: "watch_time_share",
        introMustFulfillPackagingPromise: true,
      },
      captions: { mode: "semantic", maxCharsPerLine: 18, maxLines: 2, minimumOnScreenFrames: 24, semanticEmphasisOnly: true, separateFromGraphics: true },
      graphics: [],
      transitions: [{ id: "cut-1", atFrame: 30, kind: "clean_cut", motivation: "continuity", evidenceRefs: ["beat:promise-to-setup"] }],
      audio: {
        dialoguePriority: true,
        blanketWhooshEveryCut: false,
        layers: [{ id: "dialogue", role: "dialogue", purpose: "保留核心解說", evidenceRefs: ["asset:source-1:audio"] }],
        impactFrames: [60],
        breathFrames: [30],
      },
      color: { primaryLookId: "hao-blue-clean", onePrimaryLook: true, shotMatchRequired: true, graphicsAfterGrade: true, exceptions: [] },
      assets: {
        truthSourceFirst: true,
        semanticSelectionOnly: true,
        candidateIds: [],
        resolutionOrder: ["truth_source", "semantic_broll", "motion", "card", "clean_hold"],
      },
      delivery: {
        currentArtifactOnly: true,
        platforms: ["youtube"],
        variants: [{ id: "youtube-main", aspectRatio: "16:9", purpose: "YouTube 長片" }],
        outcomeCheckpoints: ["D2", "D7", "D28"],
      },
    },
    commands: [{ type: "set_aesthetic_system", aestheticSystem: aesthetic }, { type: "rename_project", name: "Autopilot Edited" }],
  } as const;
}

export function createAutopilotV3Fixture() {
  const current = createAutopilotV4Fixture();
  const { materialEvidence: _materialEvidence, extensions: _extensions, aesthetic: _aesthetic, ...legacy } = current;
  return {
    ...legacy,
    schema: AUTOPILOT_PLAN_SCHEMA_V3,
    source: {
      skillId: current.source.skillId,
      revision: current.source.revision,
      skillSha256: current.source.skillSha256,
      knowledgeRevision: current.source.knowledgeRevision,
      knowledgeSha256: current.source.knowledgeSha256,
    },
  } as const;
}

export function createAutopilotV2Fixture() {
  const current = createAutopilotV3Fixture();
  const { inference: _inference, ...legacy } = current;
  return { ...legacy, schema: AUTOPILOT_PLAN_SCHEMA_V2 } as const;
}

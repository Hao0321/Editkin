import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginRegistrySummary } from "../desktop/types";
import {
  createDefaultWorkflowProfile,
  pluginAutomationCapabilityIdentities,
  saveWorkflowProfile,
  setPluginAutomationEnabled,
  setWorkflowSkillEnabled,
  workflowSkillIdentities,
  type WorkflowProfileStorage,
} from "../plugins/workflowProfileStore";
import PluginBrowser from "./PluginBrowser";

const registry: PluginRegistrySummary = {
  schema: "editkin.plugin-registry/v1",
  plugins: [{
    id: "studio.fixture",
    name: "Creator Tools",
    version: "1.2.3",
    publisher: "Fixture Studio",
    manifestSha256: "a".repeat(64),
    permissions: ["project.write"],
    capabilities: [{
      id: "punch",
      name: "重點強化",
      description: "只在有動機的重點節拍使用。",
      kind: "workflow_tool",
      automation: "full",
      automationReady: true,
      planningReady: false,
      readiness: "AUTOMATION_READY",
      readinessDetail: "可 Undo",
      semanticRoles: ["hook", "payoff"],
      formats: ["shorts"],
      requires: ["一個明確重點"],
      avoidWhen: ["每個剪點都套用"],
      runtimeType: "editgraph_commands",
      commandScopes: ["clip"],
      parameters: [{ id: "scale", name: "縮放", type: "number", default: 1.04, min: 1, max: 1.2, step: 0.01 }],
    }],
  }],
  diagnostics: [],
};

function skillRegistry(): PluginRegistrySummary {
  const result = structuredClone(registry);
  result.plugins[0].id = "studio.fixture";
  result.plugins[0].manifestSha256 = "a".repeat(64);
  result.plugins[0].permissions = ["workflow.read"];
  result.plugins[0].capabilities[0] = {
    ...result.plugins[0].capabilities[0],
    id: "creator-workflow",
    name: "創作者工作流",
    kind: "workflow_skill",
    runtimeType: "skill_pack",
    packSha256: "b".repeat(64),
    automationReady: false,
    planningReady: true,
    readiness: "RUNTIME_READY",
    readinessDetail: "純資料規劃能力",
    commandScopes: [],
  };
  return result;
}

function memoryStorage(): WorkflowProfileStorage & { value: string | null } {
  return {
    value: null,
    read() { return this.value; },
    write(value) { this.value = value; },
  };
}

describe("PluginBrowser", () => {
  it("shows compact creator-facing capabilities and selection guidance", () => {
    const html = renderToStaticMarkup(<PluginBrowser registry={registry} hasSelectedClip={false} />);
    expect(html).toContain("Creator Tools");
    expect(html).toContain("重點強化");
    expect(html).toContain("外掛資料夾");
    expect(html).toContain("重新掃描");
    expect(html).toContain("片段工具需先選取片段");
    expect(html).toContain("設定與使用時機");
    expect(html).toContain("一個明確重點");
    expect(html).toContain("type=\"range\"");
    expect(html).toContain("disabled");
    expect(html).not.toContain("manifestSha256");
  });

  it("allows a project-scoped tool without pretending project scope means full-program duration", () => {
    const projectRegistry = structuredClone(registry);
    projectRegistry.plugins[0].capabilities[0] = {
      ...projectRegistry.plugins[0].capabilities[0],
      id: "particle-overlay",
      name: "節拍粒子 VFX",
      commandScopes: ["project"],
    };
    const html = renderToStaticMarkup(<PluginBrowser registry={projectRegistry} hasSelectedClip={false} />);
    expect(html).toContain("節拍粒子 VFX");
    expect(html).toContain("<small>專案</small>");
    expect(html).toContain("實際作用時間由工具參數決定");
    expect(html).toContain(">套用</button>");
  });

  it("enables automation-ready tools after selecting a clip", () => {
    const html = renderToStaticMarkup(<PluginBrowser registry={registry} hasSelectedClip />);
    expect(html).toContain(">套用</button>");
    expect(html).toContain("允許自動套用");
    expect(html).not.toContain("disabled");
  });

  it("reflects a host-persisted plugin automation grant without replacing manual apply", () => {
    const identity = pluginAutomationCapabilityIdentities(registry)[0];
    const profile = setPluginAutomationEnabled(createDefaultWorkflowProfile(), identity, [identity], true);
    const html = renderToStaticMarkup(<PluginBrowser registry={registry} hasSelectedClip workflowProfile={profile} />);
    expect(html).toContain(">套用</button>");
    expect(html).toContain("停用自動套用");
    expect(html).toContain('aria-pressed="true"');
  });

  it("lets a human apply a runtime-ready native effect without exposing it to automation", () => {
    const nativeRegistry = structuredClone(registry);
    nativeRegistry.plugins[0].capabilities[0] = {
      ...nativeRegistry.plugins[0].capabilities[0], kind: "effect", automation: "manual",
      automationReady: false, readiness: "RUNTIME_READY", readinessDetail: "輸出 adapter 已驗證",
      planningReady: false,
    };
    const html = renderToStaticMarkup(<PluginBrowser registry={nativeRegistry} hasSelectedClip />);
    expect(html).toContain(">套用</button>");
    expect(html).not.toContain("disabled");
  });

  it("shows a planning-only Skill Pack without offering a direct project mutation", () => {
    const html = renderToStaticMarkup(<PluginBrowser registry={skillRegistry()} hasSelectedClip />);
    expect(html).toContain("工作流 Skill");
    expect(html).toContain("只讀規劃");
    expect(html).toContain("啟用給自動剪輯");
    expect(html).toContain("不能執行程式或直接修改專案");
    expect(html).toContain("僅 workflow.read");
    expect(html).not.toContain(">套用</button>");
  });

  it("shows a persisted hash-bound authorization and its deterministic priority", () => {
    const installed = skillRegistry();
    const candidate = workflowSkillIdentities(installed)[0];
    const profile = setWorkflowSkillEnabled(createDefaultWorkflowProfile(), candidate, true);
    const storage = memoryStorage();
    saveWorkflowProfile(storage, profile);
    const html = renderToStaticMarkup(<PluginBrowser registry={installed} hasSelectedClip workflowProfileStorage={storage} />);
    expect(html).toContain("停用自動剪輯");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("優先 1");
    expect(html).toContain("manifest aaaaaaaa… / pack bbbbbbbb…");
    expect(html).toContain("版本或 hash 改變時自動失效");
  });

  it("requires an explicit reauthorization after a pack hash changes", () => {
    const installed = skillRegistry();
    const oldCandidate = workflowSkillIdentities(installed)[0];
    const storage = memoryStorage();
    saveWorkflowProfile(storage, setWorkflowSkillEnabled(createDefaultWorkflowProfile(), oldCandidate, true));
    installed.plugins[0].capabilities[0].packSha256 = "c".repeat(64);
    const html = renderToStaticMarkup(<PluginBrowser registry={installed} hasSelectedClip workflowProfileStorage={storage} />);
    expect(html).toContain("重新授權新版");
    expect(html).toContain('aria-pressed="false"');
  });

  it("offers an install folder and rescan without requiring a restart when empty", () => {
    const html = renderToStaticMarkup(<PluginBrowser registry={{ ...registry, plugins: [] }} hasSelectedClip={false} />);
    expect(html).toContain("開啟外掛資料夾");
    expect(html).toContain("重新掃描");
    expect(html).toContain("不必修改安裝檔或重開 Editkin");
  });
});

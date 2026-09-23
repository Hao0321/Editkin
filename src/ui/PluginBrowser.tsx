import { useEffect, useMemo, useState } from "react";
import type { PluginRegistrySummary } from "../desktop/types";
import type { EditkinWorkflowProfile } from "../plugins/skillPack";
import {
  browserWorkflowProfileStorage,
  loadWorkflowProfile,
  moveWorkflowSkillPriority,
  pluginAutomationAuthorizationStatus,
  pluginAutomationCapabilityIdentities,
  saveWorkflowProfile,
  setPluginAutomationEnabled,
  setWorkflowSkillEnabled,
  workflowSkillAuthorizationStatus,
  workflowSkillIdentities,
  type WorkflowProfileStorage,
} from "../plugins/workflowProfileStore";
import "./pluginBrowser.css";

interface PluginBrowserProps {
  registry?: PluginRegistrySummary;
  loading?: boolean;
  busyId?: string;
  hasSelectedClip: boolean;
  onApply?: (pluginId: string, capabilityId: string, parameters?: Record<string, unknown>) => void;
  onOpenFolder?: () => void;
  onRefresh?: () => void;
  workflowProfileStorage?: WorkflowProfileStorage;
  workflowProfile?: EditkinWorkflowProfile;
  onWorkflowProfileChange?: (profile: EditkinWorkflowProfile) => Promise<void> | void;
}

const KIND_LABEL: Record<string, string> = {
  effect: "特效",
  transition: "轉場",
  generator: "生成",
  analysis: "分析",
  workflow_tool: "工具",
  importer: "匯入",
  exporter: "輸出",
  asset_pack: "素材包",
  knowledge_pack: "知識包",
  workflow_skill: "工作流 Skill",
};

export default function PluginBrowser({ registry, loading, busyId, hasSelectedClip, onApply, onOpenFolder, onRefresh, workflowProfileStorage, workflowProfile: hostWorkflowProfile, onWorkflowProfileChange }: PluginBrowserProps) {
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const profileStorage = useMemo(() => workflowProfileStorage ?? browserWorkflowProfileStorage(), [workflowProfileStorage]);
  const initialProfile = useMemo(() => loadWorkflowProfile(profileStorage), [profileStorage]);
  const [localWorkflowProfile, setLocalWorkflowProfile] = useState(initialProfile.profile);
  const [profileNotice, setProfileNotice] = useState(initialProfile.recoveredFromInvalidState ? "舊設定不合法，已安全停用所有 Workflow Skill。" : "");
  useEffect(() => { if (hostWorkflowProfile) setLocalWorkflowProfile(hostWorkflowProfile); }, [hostWorkflowProfile]);
  const workflowProfile = hostWorkflowProfile ?? localWorkflowProfile;
  const workflowSkills = workflowSkillIdentities(registry);
  const pluginAutomationIdentities = pluginAutomationCapabilityIdentities(registry);
  const commitWorkflowProfile = async (next: EditkinWorkflowProfile) => {
    if (onWorkflowProfileChange) {
      try {
        await onWorkflowProfileChange(next);
        setLocalWorkflowProfile(next);
        setProfileNotice(`已由 Editkin 原子保存 Workflow Profile r${next.revision}。`);
      } catch {
        setProfileNotice("Workflow Profile 原生儲存失敗；這次授權沒有生效。");
      }
      return;
    }
    if (!profileStorage) {
      setLocalWorkflowProfile(next);
      setProfileNotice("這次設定只保留在目前視窗；原生 Profile 儲存尚未連接。");
      return;
    }
    try {
      saveWorkflowProfile(profileStorage, next);
      setLocalWorkflowProfile(next);
      setProfileNotice(`已保存 Workflow Profile r${next.revision}。`);
    } catch {
      setProfileNotice("Workflow Profile 儲存失敗；這次授權沒有生效。");
    }
  };
  const setDraft = (capabilityId: string, parameterId: string, value: unknown) => {
    setDrafts((current) => ({ ...current, [capabilityId]: { ...current[capabilityId], [parameterId]: value } }));
  };
  if (loading) return <div className="plugin-browser-state">正在讀取已安裝工具…</div>;
  if (!registry?.plugins.length) return (
    <div className="plugin-browser-state">
      <b>還沒有安裝外掛</b>
      <span>把符合 editkin.plugin/v1 的工具放進你的外掛資料夾，再重新掃描；不必修改安裝檔或重開 Editkin。</span>
      <div className="plugin-browser-actions">
        <button type="button" onClick={onOpenFolder}>開啟外掛資料夾</button>
        <button type="button" className="secondary" onClick={onRefresh}>重新掃描</button>
      </div>
    </div>
  );

  return (
    <div className="plugin-browser" data-testid="plugin-browser">
      <div className="plugin-browser-intro">
        <div><b>創作者工具</b><span>一般工具由你手動套用；Workflow Skill 只提供規劃偏好，需明確授權後才會交給自動剪輯。</span></div>
        <div className="plugin-browser-actions">
          <button type="button" onClick={onOpenFolder}>外掛資料夾</button>
          <button type="button" className="secondary" onClick={onRefresh}>重新掃描</button>
        </div>
      </div>
      {profileNotice && <div className="workflow-profile-notice" role="status">{profileNotice}</div>}
      {!hasSelectedClip && <div className="plugin-selection-tip">片段工具需先選取片段；標示「專案」的工具可直接套用，實際作用時間由工具參數決定</div>}
      {registry.plugins.map((plugin) => (
        <section className="plugin-group" key={plugin.id}>
          <header>
            <span><strong>{plugin.name}</strong><small>{plugin.publisher} · v{plugin.version}</small></span>
            <b>{plugin.capabilities.length}</b>
          </header>
          <div className="plugin-capability-list">
            {plugin.capabilities.map((capability) => {
              const id = `${plugin.id}/${capability.id}`;
              const planningOnly = capability.runtimeType === "skill_pack";
              const workflowSkill = workflowSkills.find((skill) => skill.skillId === id);
              const workflowStatus = workflowSkill ? workflowSkillAuthorizationStatus(workflowProfile, workflowSkill) : "unavailable";
              const workflowPriority = workflowProfile.priority.indexOf(id);
              const pluginAutomationIdentity = pluginAutomationIdentities.find((identity) => identity.pluginId === plugin.id && identity.capabilityId === capability.id);
              const pluginAutomationStatus = pluginAutomationIdentity ? pluginAutomationAuthorizationStatus(workflowProfile, pluginAutomationIdentity) : "unavailable";
              const applicationReady = capability.automationReady || (capability.kind === "effect" && capability.readiness === "RUNTIME_READY");
              const projectOnly = capability.runtimeType === "editgraph_commands"
                && capability.commandScopes.length > 0
                && capability.commandScopes.every((scope) => scope === "project");
              const disabled = planningOnly || !applicationReady || (!projectOnly && !hasSelectedClip) || Boolean(busyId);
              const draft = drafts[id] ?? {};
              return (
                <article className="plugin-capability" key={capability.id}>
                  <div className="plugin-capability-copy">
                    <span className="plugin-kind">{KIND_LABEL[capability.kind] ?? capability.kind}</span>
                    <strong>{capability.name}</strong>
                    <p>{capability.description}</p>
                    {planningOnly && <p className="workflow-skill-safety"><b>只讀規劃</b>：不能執行程式或直接修改專案；實際剪輯仍須通過同一份 v4 plan audit。</p>}
                    <div className="plugin-role-list">
                      {projectOnly && <small>專案</small>}
                      {capability.semanticRoles.slice(0, 3).map((role) => <small key={role}>{role}</small>)}
                    </div>
                  </div>
                  {planningOnly ? <div className="workflow-skill-controls">
                    <button
                      className="workflow-skill-toggle"
                      type="button"
                      disabled={!workflowSkill || workflowStatus === "unavailable"}
                      aria-pressed={workflowStatus === "enabled"}
                      title="只授權讀取目前 manifest/pack hash 綁定的規劃資料，不會直接執行 Skill"
                      onClick={() => workflowSkill && void commitWorkflowProfile(setWorkflowSkillEnabled(workflowProfile, workflowSkill, workflowStatus !== "enabled"))}
                    >
                      {workflowStatus === "enabled" ? "停用自動剪輯" : workflowStatus === "needs_reauthorization" ? "重新授權新版" : workflowStatus === "disabled" ? "啟用給自動剪輯" : "驗證未通過"}
                    </button>
                    {workflowStatus === "enabled" && <div className="workflow-skill-priority" aria-label={`${capability.name} 的固定優先順序`}>
                      <span>優先 {workflowPriority + 1}</span>
                      <button type="button" aria-label={`提高 ${capability.name} 優先順序`} disabled={workflowPriority <= 0} onClick={() => void commitWorkflowProfile(moveWorkflowSkillPriority(workflowProfile, id, -1))}>↑</button>
                      <button type="button" aria-label={`降低 ${capability.name} 優先順序`} disabled={workflowPriority < 0 || workflowPriority >= workflowProfile.priority.length - 1} onClick={() => void commitWorkflowProfile(moveWorkflowSkillPriority(workflowProfile, id, 1))}>↓</button>
                    </div>}
                  </div> : <div className="plugin-application-controls">
                    <button
                      className="plugin-apply"
                      type="button"
                      disabled={disabled}
                      title={applicationReady ? capability.readinessDetail : `目前不能直接套用：${capability.readinessDetail}`}
                      onClick={() => onApply?.(plugin.id, capability.id, draft)}
                    >
                      {busyId === id ? "套用中…" : applicationReady ? "套用" : "僅手動"}
                    </button>
                    {pluginAutomationIdentity && <button
                      className="plugin-automation-toggle"
                      type="button"
                      aria-pressed={pluginAutomationStatus === "enabled"}
                      title="只授權這個 manifest hash 下的指定 capability；實際動作仍須放進同一份 v4 plan 並通過 audit"
                      onClick={() => void commitWorkflowProfile(setPluginAutomationEnabled(workflowProfile, pluginAutomationIdentity, pluginAutomationIdentities, pluginAutomationStatus !== "enabled"))}
                    >
                      {pluginAutomationStatus === "enabled" ? "停用自動套用" : pluginAutomationStatus === "needs_reauthorization" ? "重新授權新版" : "允許自動套用"}
                    </button>}
                  </div>}
                  {(planningOnly || capability.parameters.length > 0 || capability.requires.length > 0 || capability.avoidWhen.length > 0) && (
                    <details className="plugin-settings">
                      <summary>設定與使用時機</summary>
                      {planningOnly && workflowSkill && <div className="workflow-skill-contract">
                        <p><b>授權：</b>僅 workflow.read</p>
                        <p><b>版本綁定：</b>manifest {workflowSkill.manifestSha256.slice(0, 8)}… / pack {workflowSkill.packSha256.slice(0, 8)}…</p>
                        <p><b>衝突規則：</b>依你上方設定的固定順序決定；版本或 hash 改變時自動失效。</p>
                      </div>}
                      {capability.parameters.length > 0 && <div className="plugin-parameter-list">
                        {capability.parameters.map((parameter) => {
                          const value = draft[parameter.id] ?? parameter.default;
                          if (parameter.type === "number") return (
                            <label className="plugin-parameter" key={parameter.id} title={parameter.description}>
                              <span>{parameter.name}<output>{Number(value).toFixed(parameter.step && parameter.step < 1 ? 2 : 0)}</output></span>
                              <input
                                type={parameter.min === undefined || parameter.max === undefined ? "number" : "range"}
                                min={parameter.min}
                                max={parameter.max}
                                step={parameter.step ?? "any"}
                                value={Number(value)}
                                onChange={(event) => setDraft(id, parameter.id, Number(event.target.value))}
                              />
                            </label>
                          );
                          if (parameter.type === "boolean") return (
                            <label className="plugin-parameter plugin-parameter-toggle" key={parameter.id} title={parameter.description}>
                              <span>{parameter.name}</span>
                              <input type="checkbox" checked={Boolean(value)} onChange={(event) => setDraft(id, parameter.id, event.target.checked)} />
                            </label>
                          );
                          if (parameter.type === "enum") return (
                            <label className="plugin-parameter" key={parameter.id} title={parameter.description}>
                              <span>{parameter.name}</span>
                              <select value={String(value)} onChange={(event) => setDraft(id, parameter.id, event.target.value)}>
                                {parameter.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                              </select>
                            </label>
                          );
                          return (
                            <label className="plugin-parameter" key={parameter.id} title={parameter.description}>
                              <span>{parameter.name}</span>
                              <input
                                type={parameter.type === "color" ? "color" : "text"}
                                maxLength={parameter.type === "string" ? parameter.maxLength : undefined}
                                value={String(value)}
                                onChange={(event) => setDraft(id, parameter.id, event.target.value)}
                              />
                            </label>
                          );
                        })}
                        {Object.keys(draft).length > 0 && <button className="plugin-reset" type="button" onClick={() => setDrafts((current) => ({ ...current, [id]: {} }))}>恢復預設</button>}
                      </div>}
                      {(capability.requires.length > 0 || capability.avoidWhen.length > 0) && <div className="plugin-usage-notes">
                        {capability.requires.length > 0 && <p><b>適合：</b>{capability.requires.join("、")}</p>}
                        {capability.avoidWhen.length > 0 && <p><b>避免：</b>{capability.avoidWhen.join("、")}</p>}
                      </div>}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {registry.diagnostics.length > 0 && <details className="plugin-diagnostics"><summary>{registry.diagnostics.length} 個外掛未載入</summary><p>為了安全已阻擋，請檢查版本、權限或檔案完整性。</p></details>}
    </div>
  );
}

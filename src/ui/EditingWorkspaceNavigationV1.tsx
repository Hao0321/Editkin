import { useI18n } from "./i18n/interfacePreferences";
import { EDITING_WORKSPACES_V1, type EditingWorkspaceV1 } from "./editingWorkspaceV1";
import "./editingWorkspaceV1.css";

export function EditingWorkspaceNavigationV1({ active, onChange }: {
  active: EditingWorkspaceV1; onChange: (workspace: EditingWorkspaceV1) => void;
}) {
  const { t } = useI18n();
  return <nav className="editing-workspaces" role="tablist" aria-label={t("工作區")}>
    {EDITING_WORKSPACES_V1.map((workspace, index) => <button type="button" role="tab" key={workspace.id}
      id={`editing-workspace-tab-${workspace.id}`} aria-selected={active === workspace.id}
      aria-controls="editing-workspace-panel" tabIndex={active === workspace.id ? 0 : -1}
      onClick={() => onChange(workspace.id)} onKeyDown={event => {
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        const next = event.key === "Home" ? 0 : event.key === "End" ? EDITING_WORKSPACES_V1.length - 1
          : delta ? (index + delta + EDITING_WORKSPACES_V1.length) % EDITING_WORKSPACES_V1.length : undefined;
        if (next === undefined) return;
        event.preventDefault();
        onChange(EDITING_WORKSPACES_V1[next].id);
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]");
        tabs?.[next]?.focus();
      }} data-testid={`workspace-${workspace.id}`}>{t(workspace.label)}</button>)}
  </nav>;
}

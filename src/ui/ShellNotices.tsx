import { useState } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import type { MediaAsset } from "../domain/types";
import type { ProjectFileChange } from "../desktop/useProjectFileWatch";
import "./problemNotice.css";
import "./shellNotices.css";

/** Desktop: media the project needs is no longer where it was. Each file can be found again (same file only). */
export function MissingMediaNotice({ assets, onRelink }: { assets: readonly MediaAsset[]; onRelink: (assetId: string) => Promise<unknown> }) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string>();
  if (!assets.length) return null;
  return <section className="plain-problem-notice shell-notice-warning" role="status" aria-labelledby="missing-media-title" data-testid="desktop-missing-media">
    <span className="plain-problem-icon" aria-hidden="true">?</span>
    <div className="plain-problem-copy">
      <strong className="plain-problem-title" id="missing-media-title">{t("有 {count} 個素材找不到了", { count: assets.length })}</strong>
      <p className="plain-problem-what">{t("它們可能被移動、改名或刪除了。剪輯內容都還在。")}</p>
      <p className="plain-problem-todo">{t("找到原本的檔案後，按「重新找檔案」把它接回來。")}</p>
      <ul className="shell-notice-list">
        {assets.map(asset => <li key={asset.id}>
          <span title={asset.uri}><b>{asset.name}</b><small>{asset.uri}</small></span>
          <button type="button" disabled={Boolean(busyId)} data-testid={`desktop-relink-${asset.id}`} aria-label={t("重新找「{name}」的檔案", { name: asset.name })}
            onClick={() => {
              setBusyId(asset.id);
              void onRelink(asset.id).finally(() => setBusyId(undefined));
            }}>{busyId === asset.id ? t("正在核對檔案…") : t("重新找檔案")}</button>
        </li>)}
      </ul>
    </div>
  </section>;
}

/** The open project file was changed (or removed) by another program, such as an AI assistant. */
export function ProjectChangedNotice({ change, dirty, onReload, onSaveCopy, onDismiss }: {
  change: ProjectFileChange; dirty: boolean;
  onReload: () => Promise<unknown>; onSaveCopy: () => Promise<unknown>; onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"reload" | "copy">();
  const run = (kind: "reload" | "copy", action: () => Promise<unknown>) => {
    setBusy(kind);
    void action().catch(() => undefined).finally(() => setBusy(undefined));
  };
  const missing = change.kind === "missing";
  return <section className="plain-problem-notice shell-notice-info" role="alert" aria-labelledby="project-changed-title" data-testid="project-file-changed" data-change={change.kind}>
    <span className="plain-problem-icon" aria-hidden="true">↻</span>
    <div className="plain-problem-copy">
      <strong className="plain-problem-title" id="project-changed-title">{t(missing ? "找不到這個專案檔了" : "專案檔被其他程式改過了")}</strong>
      <p className="plain-problem-what">{t(missing ? "專案檔可能被移動、改名或刪除了。畫面上的內容都還在。" : "可能是 AI 助手剛幫你修改了這個專案。")}</p>
      <p className="plain-problem-todo">{t(missing ? "請用「另存新檔」把目前的內容存起來。"
        : dirty ? "你也有還沒存的修改。可以先把你的版本另存一份，再載入新的版本。" : "載入新的版本，就能看到這些修改。")}</p>
    </div>
    <div className="plain-problem-actions">
      {!missing && <button type="button" className="plain-problem-primary" disabled={Boolean(busy)} onClick={() => run("reload", onReload)} data-testid="project-changed-reload">
        {busy === "reload" ? t("處理中…") : t("載入新的版本")}</button>}
      {(missing || dirty) && <button type="button" className={missing ? "plain-problem-primary" : undefined} disabled={Boolean(busy)} onClick={() => run("copy", onSaveCopy)} data-testid="project-changed-save-copy">
        {busy === "copy" ? t("處理中…") : t(missing ? "另存新檔" : "把我的版本另存新檔")}</button>}
      <button type="button" disabled={Boolean(busy)} onClick={onDismiss} data-testid="project-changed-dismiss">{t("先不要")}</button>
    </div>
  </section>;
}

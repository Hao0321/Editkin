import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { EditorShellProps } from "./editorShellTypes";
import { AppProblemNotices, useAppProblems } from "./ProblemNotice";
import { MissingMediaNotice, ProjectChangedNotice } from "./ShellNotices";
import { useTemplateUpdateNotice } from "./TemplateUpdateNotice";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import { ExportPanel, useRenderJob } from "./export/ExportPanel";
import { useWindowCloseGuard } from "../desktop/useWindowCloseGuard";
import { relinkDesktopAsset, useDesktopMissingMedia } from "../desktop/useDesktopMissingMedia";
import { useProjectFileWatch } from "../desktop/useProjectFileWatch";
import { forgetRecentProject, listRecentProjects, rememberRecentProject, subscribeRecentProjects, type RecentProject } from "../desktop/recentProjects";
import { openProjectAtPath } from "../application/projectPathActions";
import { clearAppProblem, reportAppProblem, type AppProblemNotice } from "../application/appProblemStore";

export interface ShellSafety {
  hasNotices: boolean;
  notices: ReactNode;
  overlays: ReactNode;
  toolbar: { onSaveAs?: () => void; recentProjects?: readonly RecentProject[]; onOpenRecent?: (path: string) => void };
}

/**
 * The editor's safety net (usable-v1 ROADMAP 2.9–2.11): plain problem notices, the export panel, asking before
 * the window closes, finding moved media again, noticing that another program changed the project file, and the
 * visible Save As / recent projects. Desktop-only parts stay off in the browser build.
 */
export function useShellSafety(props: EditorShellProps, options: { showWelcome: boolean; translate: (key: string) => string }): ShellSafety {
  const { isDesktop, projectSession: session, project, setStatus } = props;
  const api = isDesktop ? window.haoDesktop : undefined;
  const snapshot = session.getSnapshot();
  const problems = useAppProblems();
  const job = useRenderJob();
  const exporting = job?.phase === "choosing" || job?.phase === "running";
  const recentProjects = useSyncExternalStore(subscribeRecentProjects, listRecentProjects, listRecentProjects);

  // Every opened or saved project file becomes the newest recent project.
  useEffect(() => {
    if (api && snapshot.projectPath) rememberRecentProject(snapshot.projectPath, project.name);
  }, [api, snapshot.projectPath, project.name]);

  const closeGuard = useWindowCloseGuard({ api, dirty: props.recovery.dirty, exporting,
    save: () => props.saveProject(), isDirty: () => session.getSnapshot().dirty });

  const missing = useDesktopMissingMedia(api, project, Boolean(api) && !options.showWelcome);
  const relink = useCallback(async (assetId: string) => {
    if (!api) return;
    try {
      if (await relinkDesktopAsset({ api, getProject: () => session.getSnapshot().history.present, runCommand: props.runCommand,
        mergeRuntimeUrls: props.mergeRuntimeUrls, rebuildPreview: assetId => props.creativeLibrary.repairPreview(assetId) }, assetId)) clearAppProblem("relink");
    } catch (error) {
      reportAppProblem("relink", error, [{ label: "重新找檔案", run: () => relink(assetId), primary: true }]);
    }
  }, [api, props.creativeLibrary, props.mergeRuntimeUrls, props.runCommand, session]);

  const fileWatch = useProjectFileWatch(api, session, Boolean(api));
  // Titles an Editkin update left behind: one calm line with 「把標題更新到新版」 when such a project is opened.
  const titleUpdate = useTemplateUpdateNotice({ session, enabled: !options.showWelcome, runCommand: props.runCommand, setStatus,
    pausePlayback: props.pausePlayback });
  const pathInput = {
    api, session, loadOpenedProject: props.loadOpenedProject, setStatus, pausePlayback: props.pausePlayback,
    confirmDiscard: (message: string) => window.confirm(options.translate(message)),
  };
  // A recent project that is gone can be taken off the list right from its notice.
  const openRecent = (path: string) => openProjectAtPath({ ...pathInput, failureActions: cause => cause === "notFound"
    ? [{ label: "從最近的作品移除", run: () => { forgetRecentProject(path); clearAppProblem("open"); }, primary: true }] : [] }, path, "open");

  const hasFileChange = Boolean(fileWatch.change);
  // A save refused because another program changed the file says the same as the changed-file notice: show one.
  const duplicate = (problem: AppProblemNotice) => fileWatch.change?.kind === "changed" && problem.key === "save" && problem.cause === "changedElsewhere";
  const visibleProblems = problems.filter(problem => !duplicate(problem));
  return {
    hasNotices: visibleProblems.length > 0 || missing.length > 0 || hasFileChange || titleUpdate.visible,
    notices: <>
      <AppProblemNotices hide={duplicate} />
      {titleUpdate.notice}
      {fileWatch.change && <ProjectChangedNotice change={fileWatch.change} dirty={snapshot.dirty}
        onReload={async () => { if (await openProjectAtPath(pathInput, fileWatch.change!.path, "reload")) fileWatch.dismiss(); }}
        onSaveCopy={async () => { await props.saveProject(true); if (session.getSnapshot().projectPath !== fileWatch.change?.path) fileWatch.dismiss(); }}
        onDismiss={fileWatch.dismiss} />}
      {missing.length > 0 && <MissingMediaNotice assets={missing} onRelink={relink} />}
    </>,
    overlays: <>
      {api && <ExportPanel api={api} />}
      {closeGuard.asking && <CloseConfirmDialog guard={closeGuard} />}
    </>,
    toolbar: {
      onSaveAs: api ? () => void props.saveProject(true) : undefined,
      recentProjects: api ? recentProjects : undefined,
      onOpenRecent: api?.openProjectPath && props.loadOpenedProject ? path => void openRecent(path) : undefined,
    },
  };
}

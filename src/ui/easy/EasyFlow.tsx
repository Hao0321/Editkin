import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n/interfacePreferences";
import { createEasyFlowController } from "./easyFlowController";
import { createDemoEasyFlowHost, type EasyDemoSwitch, type EasyFlowHost } from "./easyFlowHost";
import type { EasySaveJob } from "./easyFlowModel";
import { EasyScreen } from "./EasyScreens";
import { useEasyRecentProjects } from "./useEasyRecentProjects";
import "./easyFlow.css";

const noSaveJobSubscription = () => () => undefined;
const noSaveJob = (): EasySaveJob | undefined => undefined;

/**
 * The simple-mode start: 「放影片進來，我幫你剪好」 and the five screens after it.
 * The host decides what is real; this component only shows the current screen.
 */
export function EasyFlow({ host, onConnectAgent }: { host: EasyFlowHost; onConnectAgent?: () => void }) {
  useI18n();
  const state = useSyncExternalStore(host.store.subscribe, host.store.getState, host.store.getState);
  const controller = useMemo(() => createEasyFlowController(host), [host]);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Recent projects on the first screen (desktop only; the host has none in the plain browser build).
  const recent = useEasyRecentProjects(host.recent, state.screen === "home");
  // 存成影片 is the desktop export job: its measured step, percentage, remaining time and 「停止存檔」.
  const saveJob = useSyncExternalStore(host.saveJob?.subscribe ?? noSaveJobSubscription, host.saveJob?.current ?? noSaveJob, host.saveJob?.current ?? noSaveJob);
  const [confirmingStop, setConfirmingStop] = useState(false);
  useEffect(() => { if (state.screen !== "saving") setConfirmingStop(false); }, [state.screen]);
  const waiting = state.screen === "working" || state.screen === "saving";
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  // A new screen is a new page: move focus to its title so keyboard and screen-reader users start at the top.
  const firstScreen = useRef(true);
  useEffect(() => {
    if (firstScreen.current) { firstScreen.current = false; return; }
    heading.current?.focus({ preventScroll: true });
    window.scrollTo?.({ top: 0 });
  }, [state.screen]);
  // Leaving for the editor (我想自己剪, a recent project, the finished edit): the editor opens at the top of the window,
  // not where a short window had the start page scrolled to.
  useEffect(() => () => { window.scrollTo?.({ top: 0 }); }, []);
  // The inline 先寫一句大標題 / 至少寫兩個重點 message sends the cursor straight back to the field to fill.
  useEffect(() => { if (state.titleError || state.pointsError) titleInput.current?.focus(); }, [state.titleError, state.pointsError]);

  const onChooseVideo = () => {
    if (!controller.canChooseVideo()) return;
    if (host.picker === "file-input") fileInput.current?.click();
    else void controller.chooseVideo();
  };
  const onPlaySaved = () => {
    const video = preview.current;
    if (!video) return;
    video.focus();
    void video.play().catch(() => undefined);
  };
  const onSeekPreview = (second: number) => {
    const video = preview.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, second);
    video.focus();
  };
  return <section className="easy-flow" data-testid="easy-flow" data-easy-screen={state.screen} data-easy-format={state.format ?? "none"}
    data-shortcuts-blocked="true" aria-labelledby="easy-flow-title">
    <EasyScreen state={state} controller={controller} formatStatus={host.engine.formatStatus} canReveal={controller.canReveal()}
      videoUrls={state.video ? host.videoUrls?.(state.video) ?? { previewUrl: state.video.previewUrl, thumbnailUrl: state.video.thumbnailUrl } : {}}
      picker={host.picker} onChooseVideo={onChooseVideo} onFilesChosen={files => void controller.chooseVideo(files)} onSeekPreview={onSeekPreview}
      now={now} headingRef={heading} fileInputRef={fileInput} previewRef={preview} titleInputRef={titleInput} recent={recent} onConnectAgent={onConnectAgent}
      save={state.screen === "saving" ? { job: saveJob, confirmingStop, askStop: () => setConfirmingStop(true), keepSaving: () => setConfirmingStop(false),
        stop: () => { setConfirmingStop(false); void host.saveJob?.cancel(); } } : undefined}
      onPlaySaved={onPlaySaved} />
  </section>;
}

/** Dev-only: the same screens driven by the simulated engine (`?easyDemo=1`), for screenshots and review. */
export function EasyFlowDemo({ demo, onWorkspace, onOpenProject }: { demo: EasyDemoSwitch; onWorkspace: () => void; onOpenProject: () => void }) {
  const actions = useRef({ onWorkspace, onOpenProject });
  actions.current = { onWorkspace, onOpenProject };
  const [host] = useState(() => createDemoEasyFlowHost({
    demo, onWorkspace: () => actions.current.onWorkspace(), onOpenProject: () => actions.current.onOpenProject(),
  }));
  return <EasyFlow host={host} />;
}

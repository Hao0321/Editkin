import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { AgentTarget } from "../application/agentSetup";
import type { AgentSetupResult } from "../desktop/types";
import { createAgentConnectFlowV1, type AgentConnectFlowV1 } from "./agentConnect/agentConnectFlowV1";
import { AGENT_CONNECT_TITLE_ID, AgentConnectScreen } from "./agentConnect/AgentConnectScreensV1";
import { desktopAgentConnectBridgeV1, type AgentConnectBridgeV1, type AgentConnectRequestV1 } from "./agentConnect/agentConnectTypesV1";
import { agentRuntimeRepairV1 } from "./agentConnect/agentRuntimeRepairV1";
import "./easy/easyFlow.css";
import "./agentConnectModal.css";

interface AgentConnectModalProps {
  onClose: () => void;
  /**
   * The desktop setup. The dialog passes the folder chosen in step 2 as a native token (never a path) and a live progress
   * callback; a handler that ignores them still works (the native command then shows its own folder picker).
   */
  onConnect: (target: AgentTarget, request?: AgentConnectRequestV1) => Promise<AgentSetupResult | undefined>;
  musicMvMode?: boolean;
  /** Detection, browser pages, folders, clipboard: window.haoDesktop by default (tests and previews pass their own). */
  bridge?: AgentConnectBridgeV1;
  /** Previews and screenshots: a flow already at the step to show (the app never passes one). */
  flow?: AgentConnectFlowV1;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * 「讓 AI 幫我剪片」 (2026-10-29, Hao: 傻瓜化連老人、小孩都會用): pick the AI → the work folder → connecting, then
 * 「連好了！」 with the sentence to paste, or a plain-words problem with 再試一次 / 我自己貼指令 / 複製問題報告.
 */
export function AgentConnectModal({ onClose, onConnect, musicMvMode = false, bridge, flow: givenFlow }: AgentConnectModalProps) {
  useI18n();
  const connectRef = useRef(onConnect);
  connectRef.current = onConnect;
  const [flow] = useState(() => givenFlow ?? createAgentConnectFlowV1({ bridge: bridge ?? desktopAgentConnectBridgeV1(),
    connect: (target, request) => connectRef.current(target, request), musicMvMode, onConnected: agentRuntimeRepairV1.markConnected }));
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  const dialog = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Detection starts when the dialog opens (a second start under StrictMode only supersedes the first).
  useEffect(() => { flow.start(); }, [flow]);

  // Focus starts at the title and returns to the button that opened the dialog when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  // Every step is a new page: focus its heading so keyboard and screen-reader users start at the top.
  useEffect(() => {
    if (dialog.current) dialog.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [state.screen]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && !flow.busy()) closeRef.current(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [flow]);

  // Tab stays inside the dialog.
  const keepFocusInside = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="modal-backdrop agent-easy-backdrop" role="presentation">
    <section ref={dialog} className="agent-connect-modal agent-easy" role="dialog" aria-modal="true" aria-labelledby={AGENT_CONNECT_TITLE_ID}
      data-testid="agent-connect-modal" data-agent-screen={state.screen} onKeyDown={keepFocusInside}>
      <button type="button" className="modal-close agent-easy-close" onClick={onClose} disabled={flow.busy()} aria-label={uiText("關閉")}
        data-testid="agent-connect-close"><span aria-hidden="true">×</span></button>
      <AgentConnectScreen state={state} flow={flow} onClose={onClose} headingRef={heading} />
    </section>
  </div>;
}

import type { AgentConnectionsResult } from "../../application/remoteOnboarding";
import type { AgentTarget } from "../../application/agentSetup";
import type {
  AppBuildInfo, AgentSetupFailure, AgentSetupFailureCode, AgentSetupProgress, AgentSetupRequest, AgentSetupResult, AgentSetupStep,
  AgentWorkspaceChoice, AgentWorkspacePick, AgentWorkspaceSuggestion, HaoDesktopApi,
} from "../../desktop/types";
import { agentRuntimeRepairV1 } from "./agentRuntimeRepairV1";

/**
 * UI-side names for 「讓 AI 幫我剪片」 (2026-10-29). Every shape comes from the native contract in desktop/mediaTypes.ts
 * (structured failure, Video Autopilot Skill report, fallback command, workspace tokens, live progress).
 */
export type AgentSetupStepV1 = AgentSetupStep;
export type AgentSetupFailureCodeV1 = AgentSetupFailureCode;
export type AgentSetupFailureV1 = AgentSetupFailure;
export type AgentSetupResultV1 = AgentSetupResult;
export type AgentSetupProgressV1 = AgentSetupProgress;
export type AgentConnectRequestV1 = AgentSetupRequest;
export type AgentWorkspaceChoiceV1 = AgentWorkspaceChoice;
export type AgentWorkspaceSuggestionV1 = AgentWorkspaceSuggestion;
export type AgentWorkspacePickV1 = AgentWorkspacePick;
export type AgentRuntimeRepairV1 = NonNullable<AgentConnectionsResult["agentRuntimeRepair"]>;

export const AGENT_SETUP_FAILURE_CODES_V1: readonly AgentSetupFailureCodeV1[] = [
  "AGENT_APP_NOT_FOUND", "RUNTIME_FILES_MISSING", "RUNTIME_PROBE_FAILED", "WORKSPACE_NOT_WRITABLE", "WORKSPACE_CHOICE_EXPIRED", "WORKSPACE_UNSAFE",
  "CONFIG_WRITE_REFUSED", "CONFIG_ALREADY_EXISTS_DIFFERENT", "HEALTH_CHECK_FAILED", "UNKNOWN",
];

/** The desktop setup: a workspace token (never a path) and a live progress callback; an older handler ignores both. */
export type AgentConnectHandlerV1 = (target: AgentTarget, request?: AgentConnectRequestV1) => Promise<AgentSetupResult | undefined>;

export interface AgentDetectionV1 {
  claude: boolean;
  codex: boolean;
  /** The start-up refresh after an Editkin update; `failed` asks for one reconnect. */
  repair?: AgentRuntimeRepairV1;
}

/** Everything the dialog needs from the app. All optional: a browser build or an older desktop still works. */
export interface AgentConnectBridgeV1 {
  detect?: () => Promise<AgentDetectionV1>;
  /** One of the four allow-listed official pages, opened in the system browser. */
  openUrl?: (url: string) => Promise<void>;
  /** A token for the last connected folder, else Documents\Editkin 作品 (created only by the setup). */
  suggestWorkspace?: () => Promise<AgentWorkspaceSuggestionV1>;
  /** Only the native folder picker: a token, a refusal for an unsafe folder, or canceled. */
  pickWorkspace?: (startPath?: string) => Promise<AgentWorkspacePickV1>;
  buildInfo?: () => Promise<Pick<AppBuildInfo, "version"> & Partial<AppBuildInfo>>;
  copyText: (text: string) => Promise<boolean>;
}

/** Clipboard with the textarea fallback the old dialog used (some webviews refuse the async clipboard). */
export async function copyTextV1(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/** The bridge over window.haoDesktop (detection also refreshes the shared 「重新連一次」 state for the entry points). */
export function desktopAgentConnectBridgeV1(api: HaoDesktopApi | undefined = typeof window === "undefined" ? undefined : window.haoDesktop): AgentConnectBridgeV1 {
  const inspect = api?.inspectAgentConnections;
  return {
    detect: inspect ? async () => {
      const connections = await inspect();
      agentRuntimeRepairV1.publish(connections.agentRuntimeRepair);
      return { claude: connections.claude?.available === true, codex: connections.codex?.available === true, repair: connections.agentRuntimeRepair };
    } : undefined,
    openUrl: api?.openExternalUrl ? url => api.openExternalUrl!(url) : undefined,
    suggestWorkspace: api?.suggestAgentWorkspace ? () => api.suggestAgentWorkspace!() : undefined,
    pickWorkspace: api?.pickAgentWorkspace ? startPath => api.pickAgentWorkspace!(startPath) : undefined,
    buildInfo: api?.appBuildInfo ? () => api.appBuildInfo!() : undefined,
    copyText: copyTextV1,
  };
}

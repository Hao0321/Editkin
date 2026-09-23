import agentSetupContractJson from "../shared/agentSetupContract.json";

export type AgentTarget = "codex" | "claude";

export interface AgentSetupContract {
  readonly schemaVersion: number;
  readonly contractVersion: string;
  readonly serverId: string;
  readonly launcher: {
    readonly schemaVersion: number;
    readonly entrypointMode: "stable_generation_launcher";
    readonly resourceRelativePath: string;
    readonly embeddedContractRelativePath: string;
    readonly stateEnvKey: string;
    readonly stateDirectoryName: string;
    readonly args: readonly string[];
  };
  readonly starterPrompt: string;
  readonly envKeys: readonly string[];
}

export interface AgentSetupOptions {
  executablePath: string;
  launcherPath: string;
  agentStateRoot: string;
  workspacePath: string;
  videoAutopilotSkillPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  whisperCliPath: string;
  nativeCorePath: string;
  creativePackRoot: string;
  personalMusicRoot: string;
  personalVisualRoot: string;
  pluginRoot: string;
  workflowProfilePath: string;
  modelRoot: string;
  cacheRoot: string;
}

export interface AgentSetupInvocation {
  command: AgentTarget;
  args: string[];
  environment: Record<string, string>;
}

export interface AgentInspectionInput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentInspection {
  configured: boolean;
  exactConfiguration: boolean;
  health: "connected" | "configured" | "failed";
  detail: string;
}

export const EDITKIN_AGENT_SETUP_CONTRACT: AgentSetupContract = Object.freeze({
  ...agentSetupContractJson,
  launcher: Object.freeze({
    ...agentSetupContractJson.launcher,
    entrypointMode: "stable_generation_launcher" as const,
    args: Object.freeze([...agentSetupContractJson.launcher.args]),
  }),
  envKeys: Object.freeze([...agentSetupContractJson.envKeys]),
});

export const EDITKIN_AGENT_STARTER_PROMPT = EDITKIN_AGENT_SETUP_CONTRACT.starterPrompt;

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function setupEnvironment(options: AgentSetupOptions): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    EDITKIN_AGENT_STATE_ROOT: options.agentStateRoot,
    EDITKIN_WORKSPACE: options.workspacePath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: options.videoAutopilotSkillPath,
    HAO_FFMPEG_PATH: options.ffmpegPath,
    HAO_FFPROBE_PATH: options.ffprobePath,
    EDITKIN_WHISPER_CLI_PATH: options.whisperCliPath,
    HAO_NATIVE_CORE_PATH: options.nativeCorePath,
    EDITKIN_CREATIVE_PACK_ROOT: options.creativePackRoot,
    EDITKIN_PERSONAL_MUSIC_ROOT: options.personalMusicRoot,
    EDITKIN_PERSONAL_VISUAL_ROOT: options.personalVisualRoot,
    EDITKIN_PLUGIN_ROOTS: options.pluginRoot,
    EDITKIN_WORKFLOW_PROFILE_PATH: options.workflowProfilePath,
    EDITKIN_MODEL_ROOT: options.modelRoot,
    EDITKIN_CACHE_ROOT: options.cacheRoot,
  };
}

function environmentFlags(options: AgentSetupOptions): string {
  const environment = setupEnvironment(options);
  return Object.entries(environment)
    .map(([key, value]) => `--env ${powerShellQuote(`${key}=${value}`)}`)
    .join(" ");
}

export function buildAgentSetupInvocation(target: AgentTarget, options: AgentSetupOptions): AgentSetupInvocation {
  const environment = setupEnvironment(options);
  const environmentArgs = Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const server = [options.executablePath, options.launcherPath];
  const args = target === "codex"
    ? ["mcp", "add", "editkin", ...environmentArgs, "--", ...server]
    : ["mcp", "add-json", "--scope", "user", "editkin", JSON.stringify({ type: "stdio", command: options.executablePath, args: [options.launcherPath], env: environment })];
  return { command: target, args, environment };
}

export function buildAgentInspectionArgs(): string[] {
  return ["mcp", "get", "editkin"];
}

export function inspectAgentConnection(target: AgentTarget, result: AgentInspectionInput, options: AgentSetupOptions): AgentInspection {
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  const configured = result.code === 0 && /editkin/i.test(detail);
  const normalized = detail.toLocaleLowerCase().replaceAll("\\\\", "\\").replaceAll("/", "\\");
  const expectedLauncher = options.launcherPath.toLocaleLowerCase().replaceAll("/", "\\");
  const expectedExecutable = options.executablePath.toLocaleLowerCase().replaceAll("/", "\\");
  const expectedStateRoot = options.agentStateRoot.toLocaleLowerCase().replaceAll("/", "\\");
  const exactConfiguration = configured
    && normalized.includes(expectedLauncher)
    && normalized.includes(expectedExecutable)
    && normalized.includes(expectedStateRoot)
    && normalized.includes("editkin_agent_state_root")
    && !/(?:^|[\\/])mcp\.mjs(?:\s|$|["'])/i.test(detail);
  const failed = result.code !== 0 || /(?:failed to connect|not connected|rejected|no mcp server|not found|✘)/i.test(detail);
  const connected = target === "claude" && /(?:connected|✓|✔)/i.test(detail) && !failed;
  return {
    configured,
    exactConfiguration,
    health: failed ? "failed" : connected ? "connected" : "configured",
    detail: detail.slice(-1_000),
  };
}

export function buildAgentSetupCommand(target: AgentTarget, options: AgentSetupOptions): string {
  const server = `${powerShellQuote(options.executablePath)} ${powerShellQuote(options.launcherPath)}`;
  const env = environmentFlags(options);
  if (target === "codex") return `codex mcp add editkin ${env} -- ${server}`;
  const config = JSON.stringify({ type: "stdio", command: options.executablePath, args: [options.launcherPath], env: setupEnvironment(options) });
  return `claude mcp add-json --scope user editkin ${powerShellQuote(config)}`;
}

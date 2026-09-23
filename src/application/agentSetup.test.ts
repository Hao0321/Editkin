import { describe, expect, it } from "vitest";
import {
  buildAgentInspectionArgs,
  buildAgentSetupCommand,
  buildAgentSetupInvocation,
  EDITKIN_AGENT_SETUP_CONTRACT,
  EDITKIN_AGENT_STARTER_PROMPT,
  inspectAgentConnection,
} from "./agentSetup";

const options = {
  executablePath: "C:\\Program Files\\Editkin\\Editkin.exe",
  launcherPath: "C:\\Program Files\\Editkin\\resources\\agent-runtime-v3\\launcher.mjs",
  agentStateRoot: "C:\\Users\\Hao\\AppData\\Roaming\\studio.hao.editkin\\agent-runtime-v3",
  workspacePath: "C:\\Users\\Hao\\Videos\\Hao's Projects",
  videoAutopilotSkillPath: "C:\\Users\\Hao\\.codex\\skills\\video-autopilot\\SKILL.md",
  ffmpegPath: "C:\\Program Files\\Editkin\\resources\\runtime\\ffmpeg.exe",
  ffprobePath: "C:\\Program Files\\Editkin\\resources\\runtime\\ffprobe.exe",
  whisperCliPath: "C:\\Program Files\\Editkin\\resources\\runtime\\whisper-cli.exe",
  nativeCorePath: "C:\\Program Files\\Editkin\\resources\\runtime\\hao-core.exe",
  creativePackRoot: "C:\\Program Files\\Editkin\\resources\\creative-packs\\hao-creator-library",
  personalMusicRoot: "C:\\Program Files\\Editkin\\resources\\personal-packs\\hao-music-library",
  personalVisualRoot: "C:\\Program Files\\Editkin\\resources\\personal-packs\\hao-visual-library",
  pluginRoot: "C:\\Program Files\\Editkin\\resources\\plugins",
  workflowProfilePath: "C:\\Users\\Hao\\AppData\\Roaming\\Editkin\\workflow\\workflow-profile.json",
  modelRoot: "C:\\Users\\Hao\\AppData\\Roaming\\Editkin\\models",
  cacheRoot: "C:\\Users\\Hao\\AppData\\Roaming\\Editkin\\media-cache",
};

describe("Agent setup command", () => {
  it("exports the versioned shared setup contract as the only starter-prompt source", () => {
    expect(EDITKIN_AGENT_SETUP_CONTRACT).toMatchObject({
      schemaVersion: 2,
      contractVersion: "editkin.agent-setup/v2",
      serverId: "editkin",
      launcher: {
        schemaVersion: 3,
        entrypointMode: "stable_generation_launcher",
        resourceRelativePath: "agent-runtime-v3/launcher.mjs",
        embeddedContractRelativePath: "agent-runtime-v3/agent-setup-contract.json",
        stateEnvKey: "EDITKIN_AGENT_STATE_ROOT",
        stateDirectoryName: "agent-runtime-v3",
        args: [],
      },
    });
    expect(EDITKIN_AGENT_STARTER_PROMPT).toBe(EDITKIN_AGENT_SETUP_CONTRACT.starterPrompt);
    expect(new Set(EDITKIN_AGENT_SETUP_CONTRACT.envKeys).size).toBe(EDITKIN_AGENT_SETUP_CONTRACT.envKeys.length);
    expect(EDITKIN_AGENT_SETUP_CONTRACT.envKeys).toContain("EDITKIN_WORKSPACE");
    expect(EDITKIN_AGENT_SETUP_CONTRACT.envKeys).toContain("EDITKIN_AGENT_STATE_ROOT");
    expect(Object.isFrozen(EDITKIN_AGENT_SETUP_CONTRACT)).toBe(true);
    expect(Object.isFrozen(EDITKIN_AGENT_SETUP_CONTRACT.envKeys)).toBe(true);
  });

  it("keeps plugin discovery read-only until the accepted v4 audit receipt is applied atomically", () => {
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("requiredPlanSource");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("compile_plugin_application 做唯讀編譯");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("resolve_editkin_skill_workflow");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("accepted audit receipt");
  });

  it("forces local preprocessing and bounded evidence retrieval before semantic planning", () => {
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("prepare_ai_material");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("get_material_context(afterCueIndex,maxTokens)");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("view_material_keyframes");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("每次最多四張");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("每個相關視覺素材都必須呼叫 view_material_keyframes");
    expect(EDITKIN_AGENT_STARTER_PROMPT).not.toContain("只有遇到不確定片段才呼叫");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("對白與訪談保留逐字稿");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("record_material_semantics");
    expect(EDITKIN_AGENT_STARTER_PROMPT).toContain("原始影片、整份逐字稿與整批關鍵幀不得送進 Agent context");
  });

  it("builds the official Codex stdio add shape and escapes PowerShell values", () => {
    const command = buildAgentSetupCommand("codex", options);
    expect(command).toContain("codex mcp add editkin");
    expect(command).toContain("--env 'ELECTRON_RUN_AS_NODE=1'");
    expect(command).toContain("Hao''s Projects");
    expect(command).toContain("--env 'EDITKIN_WORKSPACE=");
    expect(command).toContain("--env 'EDITKIN_VIDEO_AUTOPILOT_SKILL=");
    expect(command).toContain("--env 'EDITKIN_CREATIVE_PACK_ROOT=");
    expect(command).toContain("--env 'EDITKIN_PERSONAL_MUSIC_ROOT=");
    expect(command).toContain("--env 'EDITKIN_PERSONAL_VISUAL_ROOT=");
    expect(command).toContain("--env 'EDITKIN_PLUGIN_ROOTS=");
    expect(command).toContain("--env 'EDITKIN_WORKFLOW_PROFILE_PATH=");
    expect(command).toContain("--env 'EDITKIN_MODEL_ROOT=");
    expect(command).toContain("--env 'EDITKIN_WHISPER_CLI_PATH=");
    expect(command).toContain("--env 'EDITKIN_CACHE_ROOT=");
    expect(command).toContain("--env 'EDITKIN_AGENT_STATE_ROOT=");
    expect(command).toContain("-- 'C:\\Program Files\\Editkin\\Editkin.exe'");
    expect(command).toContain("'C:\\Program Files\\Editkin\\resources\\agent-runtime-v3\\launcher.mjs'");
    expect(command).not.toContain("desktop-dist\\mcp.mjs");
  });

  it("builds argument arrays without shell interpolation or AI secrets", () => {
    const invocation = buildAgentSetupInvocation("codex", options);
    expect(invocation.command).toBe("codex");
    expect(Object.keys(invocation.environment).sort()).toEqual([...EDITKIN_AGENT_SETUP_CONTRACT.envKeys].sort());
    expect(invocation.args.slice(0, 4)).toEqual(["mcp", "add", "editkin", "--env"]);
    expect(invocation.args).toContain("EDITKIN_WORKSPACE=C:\\Users\\Hao\\Videos\\Hao's Projects");
    expect(invocation.args.at(-1)).toBe(options.launcherPath);
    expect(invocation.args).not.toContain("C:\\Program Files\\Editkin\\resources\\app.asar\\desktop-dist\\mcp.mjs");
    expect(JSON.stringify(invocation)).not.toMatch(/API_KEY|AUTH_TOKEN|OPENAI_API|ANTHROPIC_API/);
  });

  it("builds the official Claude Code user-scoped stdio add shape", () => {
    const command = buildAgentSetupCommand("claude", options);
    expect(command).toContain("claude mcp add-json --scope user editkin");
    expect(command).toContain('"type":"stdio"');
    expect(command).toContain('"EDITKIN_WORKSPACE"');
    expect(command).toContain('"EDITKIN_AGENT_STATE_ROOT"');
    expect(command).toContain("agent-runtime-v3\\\\launcher.mjs");
    expect(command).not.toContain("desktop-dist\\\\mcp.mjs");
  });

  it("reads the installed MCP back and distinguishes configured from connected", () => {
    expect(buildAgentInspectionArgs()).toEqual(["mcp", "get", "editkin"]);
    const codex = inspectAgentConnection("codex", {
      code: 0,
      stdout: `editkin\ncommand: ${options.executablePath}\nargs: ${options.launcherPath}\nenv: EDITKIN_AGENT_STATE_ROOT=${options.agentStateRoot}`,
      stderr: "",
    }, options);
    expect(codex).toMatchObject({ configured: true, exactConfiguration: true, health: "configured" });

    const claude = inspectAgentConnection("claude", {
      code: 0,
      stdout: `editkin: ✔ Connected\nCommand: ${options.executablePath}\nArgs: ${options.launcherPath}\nEnv: EDITKIN_AGENT_STATE_ROOT=${options.agentStateRoot}`,
      stderr: "",
    }, options);
    expect(claude).toMatchObject({ configured: true, exactConfiguration: true, health: "connected" });
  });

  it("does not call a written config healthy when the client reports a connection failure", () => {
    const failed = inspectAgentConnection("claude", {
      code: 0,
      stdout: `editkin: ✘ Failed to connect\nCommand: ${options.executablePath}\nArgs: ${options.launcherPath}\nEnv: EDITKIN_AGENT_STATE_ROOT=${options.agentStateRoot}`,
      stderr: "",
    }, options);
    expect(failed.health).toBe("failed");
  });

  it("never accepts the retired direct MCP entrypoint as an exact configuration", () => {
    const legacy = inspectAgentConnection("codex", {
      code: 0,
      stdout: `editkin\ncommand: ${options.executablePath}\nargs: C:\\Program Files\\Editkin\\resources\\runtime\\mcp.mjs`,
      stderr: "",
    }, options);
    expect(legacy.configured).toBe(true);
    expect(legacy.exactConfiguration).toBe(false);
  });

  it("rejects a stable launcher config that points at a different generation state root", () => {
    const wrongState = inspectAgentConnection("codex", {
      code: 0,
      stdout: `editkin\ncommand: ${options.executablePath}\nargs: ${options.launcherPath}\nenv: EDITKIN_AGENT_STATE_ROOT=C:\\Users\\Hao\\AppData\\Roaming\\attacker\\agent-runtime-v3`,
      stderr: "",
    }, options);
    expect(wrongState.configured).toBe(true);
    expect(wrongState.exactConfiguration).toBe(false);
  });
});

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildAgentInspectionArgs, buildAgentSetupInvocation, inspectAgentConnection } from "../src/application/agentSetup";

const exec = promisify(execFile);
const targets = ["codex", "claude"] as const;
type AgentTarget = (typeof targets)[number];

interface TestCli { command: string; prefixArgs: string[] }

interface ContractProbeResult {
  toolNames: string[];
  liveInvocation: "PASS";
  requiredPlanSource: "PASS";
  auditSchema: "PASS";
  applySchema: "PASS";
}

async function locate(target: AgentTarget): Promise<TestCli | undefined> {
  try {
    const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", [target], { windowsHide: true });
    const candidates = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform !== "win32") return candidates[0] ? { command: candidates[0], prefixArgs: [] } : undefined;
    const shim = candidates.find((path) => /\.cmd$/i.test(path));
    if (shim) {
      const executable = target === "claude"
        ? join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        : join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
      try {
        await access(executable);
        if (target === "claude") return { command: executable, prefixArgs: [] };
        const { stdout: nodeOutput } = await exec("where.exe", ["node.exe"], { windowsHide: true });
        const node = nodeOutput.split(/\r?\n/).map((line) => line.trim()).find((path) => /\.exe$/i.test(path));
        if (node) return { command: node, prefixArgs: [executable] };
      } catch { /* try native executable */ }
    }
    const native = candidates.find((path) => /\.exe$/i.test(path));
    return native ? { command: native, prefixArgs: [] } : undefined;
  } catch { return undefined; }
}

async function runCli(cli: TestCli, args: string[], environment: NodeJS.ProcessEnv) {
  return exec(cli.command, [...cli.prefixArgs, ...args], { env: environment, windowsHide: true, timeout: 30_000 });
}

async function allTextFiles(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await allTextFiles(path));
    else {
      try { chunks.push(await readFile(path, "utf8")); } catch { /* non-text state is irrelevant */ }
    }
  }
  return chunks.join("\n");
}

function fixtureSource(kind: "current" | "old"): string {
  const current = kind === "current";
  const tools = [
    { name: "get_autopilot_contract", description: "Live Editkin autopilot contract", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "inspect_roto_keyer_capabilities", description: "Inspect bounded Roto/Keyer capabilities", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, materialId: { type: "string" }, semanticReceiptSha256: { type: "string" } }, required: ["projectPath", "materialId", "semanticReceiptSha256"], additionalProperties: false } },
    { name: "record_roto_keyer_evidence", description: "Record Roto/Keyer evidence", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, evidence: { type: "object" } }, required: ["projectPath", "evidence"], additionalProperties: false } },
    { name: "build_autopilot_roto_keyer_decision", description: "Bind no-op/manual/keyer route", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, materialId: { type: "string" }, evidenceReceiptSha256: { type: "string" }, route: { type: "string" }, decisionContextTokens: { type: "number" } }, required: ["projectPath", "materialId", "evidenceReceiptSha256", "route", "decisionContextTokens"], additionalProperties: false } },
    { name: "prepare_autopilot_auto_roto", description: "Prepare self-authored Auto Roto route", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, materialId: { type: "string" }, evidenceReceiptSha256: { type: "string" }, maskId: { type: "string" }, initialTime: { type: "number" }, initialRect: { type: "object" }, decisionContextTokens: { type: "number" }, computeBudget: { type: "object" } }, required: ["projectPath", "materialId", "evidenceReceiptSha256", "maskId", "initialTime", "initialRect", "decisionContextTokens", "computeBudget"], additionalProperties: false } },
    {
      name: "audit_autopilot_plan",
      description: "Audit a bound v4 plan",
      inputSchema: {
        type: "object",
        properties: { projectPath: { type: "string" }, plan: { type: "object" } },
        required: current ? ["projectPath", "plan"] : ["plan"],
        additionalProperties: false,
      },
    },
    {
      name: "apply_autopilot_plan",
      description: "Atomically apply an accepted plan",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          plan: { type: "object" },
          ...(current ? { auditReceipt: { type: "object" } } : {}),
        },
        required: current ? ["projectPath", "plan", "auditReceipt"] : ["projectPath", "plan"],
        additionalProperties: false,
      },
    },
  ];
  const contract = current
    ? {
        status: "GREEN",
        liveInvocation: { bindingSha256: "a".repeat(64), skill: { id: "video-autopilot" } },
        requiredPlanSource: { invocationBindingSha256: "a".repeat(64) },
      }
    : { status: "GREEN", planVersion: "v3" };
  return `import readline from "node:readline";
const tools = ${JSON.stringify(tools)};
const contract = ${JSON.stringify(contract)};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "editkin-${kind}-contract-fixture", version: "1.0.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }) + "\\n");
  } else if (message.method === "tools/call") {
    const payload = message.params?.name === "get_autopilot_contract" ? contract : { status: "ACCEPTED" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
`;
}

function requiredFields(tool: { inputSchema?: unknown }, name: string): Set<string> {
  const schema = tool.inputSchema as { type?: unknown; required?: unknown } | undefined;
  assert.equal(schema?.type, "object", `${name} inputSchema must be an object`);
  assert.ok(Array.isArray(schema?.required), `${name} inputSchema must declare required fields`);
  return new Set(schema.required.filter((value): value is string => typeof value === "string"));
}

async function probeCurrentMcpContract(command: string, args: string[], environment: Record<string, string>, cwd?: string): Promise<ContractProbeResult> {
  const client = new Client({ name: "editkin-agent-session-contract-probe", version: "0.15.0" });
  const transport = new StdioClientTransport({ command, args, env: environment, cwd, stderr: "pipe" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const requiredToolNames = ["get_autopilot_contract", "inspect_roto_keyer_capabilities", "record_roto_keyer_evidence", "build_autopilot_roto_keyer_decision", "prepare_autopilot_auto_roto", "audit_autopilot_plan", "apply_autopilot_plan"];
    for (const name of requiredToolNames) assert.ok(byName.has(name), `MCP tools/list is missing ${name}`);

    const auditRequired = requiredFields(byName.get("audit_autopilot_plan")!, "audit_autopilot_plan");
    assert.ok(auditRequired.has("projectPath"), "audit_autopilot_plan must require projectPath");
    assert.ok(auditRequired.has("plan"), "audit_autopilot_plan must require plan");
    const applyRequired = requiredFields(byName.get("apply_autopilot_plan")!, "apply_autopilot_plan");
    assert.ok(applyRequired.has("projectPath"), "apply_autopilot_plan must require projectPath");
    assert.ok(applyRequired.has("plan"), "apply_autopilot_plan must require plan");
    assert.ok(applyRequired.has("auditReceipt"), "apply_autopilot_plan must require auditReceipt");

    const response = await client.callTool({ name: "get_autopilot_contract", arguments: {} });
    assert.notEqual(response.isError, true, "get_autopilot_contract returned an MCP error");
    const text = (response.content[0] as { text?: unknown } | undefined)?.text;
    assert.equal(typeof text, "string", "get_autopilot_contract must return text JSON");
    const payload = JSON.parse(text as string) as { liveInvocation?: { bindingSha256?: unknown }; requiredPlanSource?: { invocationBindingSha256?: unknown } };
    assert.equal(typeof payload.liveInvocation?.bindingSha256, "string", "contract is missing liveInvocation.bindingSha256");
    assert.equal(typeof payload.requiredPlanSource?.invocationBindingSha256, "string", "contract is missing requiredPlanSource.invocationBindingSha256");
    assert.equal(payload.requiredPlanSource?.invocationBindingSha256, payload.liveInvocation?.bindingSha256, "requiredPlanSource is not bound to liveInvocation");
    return {
      toolNames: [...byName.keys()].sort(),
      liveInvocation: "PASS",
      requiredPlanSource: "PASS",
      auditSchema: "PASS",
      applySchema: "PASS",
    };
  } finally {
    await client.close();
  }
}

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !/(?:OPENAI|ANTHROPIC).*(?:KEY|TOKEN)|(?:KEY|TOKEN).*(?:OPENAI|ANTHROPIC)/i.test(entry[0])),
  );
}

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "editkin-agent-session-"));
try {
  const workspace = join(temporary, "Editkin Projects");
  const codexHome = join(temporary, "codex-home");
  const codexUserHome = join(temporary, "codex-user-home");
  const claudeHome = join(temporary, "claude-home");
  const claudeUserHome = join(temporary, "claude-user-home");
  await Promise.all([workspace, codexHome, codexUserHome, claudeHome, claudeUserHome].map((path) => mkdir(path)));

  const currentMcp = join(temporary, "current-editkin-mcp.mjs");
  const oldMcp = join(temporary, "old-editkin-mcp.mjs");
  await Promise.all([
    writeFile(currentMcp, fixtureSource("current"), "utf8"),
    writeFile(oldMcp, fixtureSource("old"), "utf8"),
  ]);
  const options = {
    executablePath: process.execPath,
    launcherPath: currentMcp,
    agentStateRoot: join(temporary, "agent-runtime-v3"),
    workspacePath: workspace,
    videoAutopilotSkillPath: join(homedir(), ".codex", "skills", "video-autopilot", "SKILL.md"),
    ffmpegPath: join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobePath: join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
    whisperCliPath: join(root, "vendor/whisper/win32-x64/whisper-cli.exe"),
    nativeCorePath: join(root, "native/bin/win32-x64/hao-core.exe"),
    creativePackRoot: join(root, ".creative-packs/hao-creator-library"),
    personalMusicRoot: join(root, ".personal-packs/hao-music-library"),
    personalVisualRoot: join(root, ".personal-packs/hao-visual-library"),
    pluginRoot: join(root, "plugins"),
    workflowProfilePath: join(temporary, "workflow", "workflow-profile.json"),
    modelRoot: join(temporary, "models"),
    cacheRoot: join(temporary, "media-cache"),
  };
  const baseEnvironment = cleanEnvironment();
  const contractEnvironment = { ...baseEnvironment, ...buildAgentSetupInvocation("codex", options).environment };
  const configuredTransportContract = await probeCurrentMcpContract(process.execPath, [currentMcp], contractEnvironment);
  const actualSourceContract = await probeCurrentMcpContract(
    process.execPath,
    [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "src/mcp/server.ts")],
    contractEnvironment,
    root,
  );
  await assert.rejects(
    () => probeCurrentMcpContract(process.execPath, [oldMcp], contractEnvironment),
    /audit_autopilot_plan must require projectPath|apply_autopilot_plan must require auditReceipt|missing liveInvocation/i,
    "retired MCP contract fixture must fail closed",
  );

  const located = new Map<AgentTarget, TestCli>();
  for (const target of targets) {
    const cli = await locate(target);
    if (cli) located.set(target, cli);
  }
  assert.ok(located.size > 0, "This host has neither Codex nor Claude Code CLI to exercise");

  const results: Record<AgentTarget, string> = { codex: "NOT_INSTALLED", claude: "NOT_INSTALLED" };
  for (const target of targets) {
    const cli = located.get(target);
    if (!cli) continue;
    const invocation = buildAgentSetupInvocation(target, options);
    const userHome = target === "codex" ? codexUserHome : claudeUserHome;
    const environment = {
      ...baseEnvironment,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      HOME: userHome,
      USERPROFILE: userHome,
    };
    await runCli(cli, invocation.args, environment);
    const inspectionRun = await runCli(cli, buildAgentInspectionArgs(), environment);
    const inspection = inspectAgentConnection(target, { code: 0, stdout: inspectionRun.stdout, stderr: inspectionRun.stderr }, options);
    assert.equal(inspection.configured, true, `${target} did not read back the editkin MCP configuration`);
    assert.equal(inspection.exactConfiguration, true, `${target} read back a different executable or MCP entry`);
    assert.notEqual(inspection.health, "failed", `${target} MCP health check failed: ${inspection.detail}`);

    const stateRoots = target === "codex" ? [codexHome, codexUserHome] : [claudeHome, claudeUserHome];
    const state = (await Promise.all(stateRoots.map((path) => allTextFiles(path)))).join("\n");
    const normalizedState = state.replaceAll("\\\\", "\\");
    assert.match(normalizedState, /editkin/i);
    assert.ok(normalizedState.includes(currentMcp), `${target} persisted a different MCP entry`);
    assert.ok(normalizedState.includes(process.execPath), `${target} persisted a different MCP executable`);
    assert.ok(normalizedState.includes("EDITKIN_WORKSPACE") && normalizedState.includes("Editkin Projects"), normalizedState.slice(0, 4_000));
    assert.equal(/OPENAI_API_KEY|ANTHROPIC_API_KEY|AUTH_TOKEN/.test(normalizedState), false);
    results[target] = inspection.health === "connected" ? "PASS_CONNECTED" : "PASS_CONFIGURED";
  }

  const installedTargets = targets.filter((target) => located.has(target));
  const passedTargets = installedTargets.filter((target) => results[target].startsWith("PASS_"));
  assert.deepEqual(passedTargets, installedTargets, "every installed agent client must independently pass isolated exact configuration");
  if (located.has("codex") && located.has("claude")) {
    assert.ok(results.codex.startsWith("PASS_") && results.claude.startsWith("PASS_"), "Codex and Claude Code are installed, so both must pass");
  }

  process.stdout.write(`${JSON.stringify({
    status: "GREEN",
    transport: "stdio",
    apiKeyRequiredByEditkin: false,
    isolatedExactConfig: "PASS",
    allInstalledTargetsRequired: "PASS",
    currentContractHandshake: actualSourceContract,
    configuredTransportHandshake: configuredTransportContract,
    oldContractRejected: "PASS",
    targets: results,
  })}\n`);
} finally {
  const resolvedTemporary = resolve(temporary);
  const resolvedSystemTemp = resolve(tmpdir());
  if (!resolvedTemporary.startsWith(`${resolvedSystemTemp}\\`) && !resolvedTemporary.startsWith(`${resolvedSystemTemp}/`)) throw new Error("Refusing to clean outside the system temp directory");
  await rm(resolvedTemporary, { recursive: true, force: true });
}

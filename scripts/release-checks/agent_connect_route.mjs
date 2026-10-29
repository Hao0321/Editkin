// Release smoke check for "連接 Claude Code / Codex": proves an extracted installer
// payload can serve MCP through the exact route an Agent host uses.
//
//   1. Writes an Agent generation with the desktop's real activation code
//      (agent-generation-writer compiles src-tauri/src/agent_setup.rs as is).
//   2. Starts <payload>/runtime/node(.exe) <payload>/agent-runtime-v3/launcher.mjs
//      in a clean environment whose home, app-data and temp folders are all
//      inside the sandbox.
//   3. Requires initialize -> tools/list (>= 1 tool) -> get_autopilot_contract GREEN.
//   4. Writes a JSON receipt. Exit code 0 only for status GREEN.
//
// Usage (from apps/hao-editor, with the pinned Node):
//   node scripts/release-checks/agent_connect_route.mjs --payload <extracted installer dir>
//     --sandbox <new or empty dir> [--receipt <file>] [--writer-target <cargo target dir>]
//     [--host-env EDITKIN_KEY=value ...]
//
// --host-env adds a non-path setting the Agent host config carries (for example
// EDITKIN_MCP_PROFILE=va). Path and root keys are refused: the launcher must supply
// every installed-layout root itself. Keep the payload folder short (Windows
// MAX_PATH); the generation is written with the source tree's agent setup
// contract, so the payload must come from the same tree.
//
// The sandbox must not be the user's real app data: never point it at
// %APPDATA%\studio.hao.editkin or an installed Editkin.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_CONNECT_ROUTE_SCHEMA = "editkin.release-check.agent-connect-route/v1";
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WRITER_MANIFEST = resolve(APP_ROOT, "scripts/release-checks/agent-generation-writer/Cargo.toml");
const AGENT_SETUP_SOURCE = resolve(APP_ROOT, "src-tauri/src/agent_setup.rs");
const CONTRACT_SOURCE = resolve(APP_ROOT, "src/shared/agentSetupContract.json");
const EXE = process.platform === "win32" ? ".exe" : "";
// The only crate-level item agent_setup.rs may use; the writer provides a stand-in for it.
const WRITER_CRATE_REFERENCES = new Set(["crate::agent_connect::render_direct_command"]);
const TIMEOUTS = { initialize: 240_000, toolsList: 120_000, contract: 240_000, exit: 20_000 };

class StageFailure extends Error {
  constructor(stage, message, detail = {}) {
    super(message);
    this.stage = stage;
    this.detail = detail;
  }
}

const USAGE = "usage: agent_connect_route.mjs --payload <dir> --sandbox <dir> [--receipt <file>] [--writer-target <dir>] [--host-env EDITKIN_KEY=value ...]";

function parseHostEnvironment(assignment) {
  const match = /^(EDITKIN_[A-Z0-9_]+)=(.*)$/su.exec(assignment);
  if (!match || /(?:_ROOTS?|_PATH|_SKILL)$/u.test(match[1]) || match[1] === "EDITKIN_WORKSPACE"
    || /[\u0000-\u001f]/u.test(match[2])) {
    throw new Error(`--host-env accepts only non-path EDITKIN_* settings: ${assignment}`);
  }
  return [match[1], match[2]];
}

function parseArguments(argv) {
  const options = { hostEnvironment: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!["--payload", "--sandbox", "--receipt", "--writer-target", "--host-env"].includes(flag) || !value || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    if (flag === "--host-env") {
      const [key, setting] = parseHostEnvironment(value);
      options.hostEnvironment[key] = setting;
    } else options[flag.slice(2)] = resolve(value);
  }
  if (!options.payload || !options.sandbox) throw new Error(`--payload and --sandbox are required; ${USAGE}`);
  return {
    payload: options.payload,
    sandbox: options.sandbox,
    receipt: options.receipt ?? join(options.sandbox, "agent-connect-route-receipt.json"),
    writerTarget: options["writer-target"] ?? join(options.sandbox, "writer-target"),
    hostEnvironment: options.hostEnvironment,
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fileIdentity(path) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

async function filesBelow(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  }
  await visit(root);
  return files.sort();
}

function tail(text, limit = 4000) {
  const compact = text.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/gu,
    (match) => `data:text/javascript;base64,<${match.length - 29} base64 chars>`);
  return compact.length > limit ? `...[${compact.length - limit} chars omitted]\n${compact.slice(-limit)}` : compact;
}

async function inspectPayload(payload) {
  const node = join(payload, "runtime", `node${EXE}`);
  const launcher = join(payload, "agent-runtime-v3", "launcher.mjs");
  const entrypoint = join(payload, "runtime", "mcp.mjs");
  for (const [label, path] of [["payload runtime Node", node], ["payload Agent launcher", launcher], ["payload MCP entrypoint", entrypoint]]) {
    if (!existsSync(path)) throw new StageFailure("payload", `${label} is missing: ${path}`);
  }
  // CreateProcess rejects executable paths longer than MAX_PATH with ENOENT, which
  // would read as a product failure. Installs live in short folders; so must the check.
  const longest = join(payload, "runtime", `editkin-gpu-compositor${EXE}`);
  if (process.platform === "win32" && longest.length >= 260) {
    throw new StageFailure("payload", `Payload folder is too deep for Windows executables (${longest.length} >= 260 characters); extract it to a shorter path`);
  }
  return {
    root: payload,
    node: await fileIdentity(node),
    launcher: await fileIdentity(launcher),
    entrypoint: await fileIdentity(entrypoint),
    agentRuntimeInventory: await filesBelow(join(payload, "agent-runtime-v3")),
  };
}

async function prepareSandbox(sandbox) {
  if (existsSync(sandbox) && (await readdir(sandbox)).length) {
    throw new StageFailure("sandbox", `Sandbox must be new or empty: ${sandbox}`);
  }
  const forbidden = [process.env.APPDATA, process.env.LOCALAPPDATA, homedir()].filter(Boolean)
    .map((root) => resolve(root));
  if (forbidden.some((root) => {
    const relation = relative(root, sandbox);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation) && /^(?:studio\.hao\.editkin|Editkin|\.claude|\.codex)(?:[\\/]|$)/iu.test(relation));
  })) throw new StageFailure("sandbox", `Sandbox overlaps a real user profile, app-data or Agent folder: ${sandbox}`);
  const paths = {
    applicationData: join(sandbox, "appdata", "studio.hao.editkin"),
    home: join(sandbox, "home"),
    roaming: join(sandbox, "appdata", "Roaming"),
    local: join(sandbox, "appdata", "Local"),
    temp: join(sandbox, "tmp"),
    workspace: join(sandbox, "workspace"),
    cache: join(sandbox, "cache", "media-cache"),
    skill: join(sandbox, "skill", "video-autopilot", "SKILL.md"),
  };
  for (const path of [paths.applicationData, paths.home, paths.roaming, paths.local, paths.temp, paths.workspace, paths.cache, dirname(paths.skill)]) {
    await mkdir(path, { recursive: true });
  }
  // A public fixture Skill so get_autopilot_contract can bind a live identity.
  await writeFile(paths.skill, "---\nname: video-autopilot\n---\n1. Inspect real frames before cutting.\n2. Audit the edit plan before applying it.\n");
  await writeFile(join(dirname(paths.skill), "workflow_contract.json"), JSON.stringify({
    schema: "hao.video-autopilot.workflow-contract/v1",
    contract_revision: 6,
    plan_schema: "hao.video-autopilot.edit-plan/v4",
    legacy_plan_policy: "reject",
  }));
  return paths;
}

async function buildWriter(writerTarget) {
  const agentSetup = await readFile(AGENT_SETUP_SOURCE, "utf8");
  const references = [...new Set([...agentSetup.matchAll(/\bcrate(?:::[A-Za-z_][A-Za-z0-9_]*)+/gu)].map((match) => match[0]))];
  const unsupported = references.filter((reference) => !WRITER_CRATE_REFERENCES.has(reference));
  if (unsupported.length) {
    throw new StageFailure("writer", `agent_setup.rs now uses crate items the generation writer does not provide: ${unsupported.join(", ")}`);
  }
  const cargo = process.platform === "win32" ? join(homedir(), ".cargo", "bin", "cargo.exe") : "cargo";
  const build = spawnSync(cargo, ["build", "--offline", "--locked", "--release", "--manifest-path", WRITER_MANIFEST], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: writerTarget },
    timeout: 900_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (build.status !== 0) {
    throw new StageFailure("writer", `Generation writer build failed (exit ${build.status ?? build.error?.message})`, { stderr: tail(build.stderr ?? "") });
  }
  const executable = join(writerTarget, "release", `editkin-agent-generation-writer${EXE}`);
  const version = spawnSync(cargo, ["--version"], { encoding: "utf8", windowsHide: true });
  // Which committed activation code was compiled (null outside a git checkout).
  const git = (args) => spawnSync("git", args, { cwd: APP_ROOT, encoding: "utf8", windowsHide: true });
  const head = git(["rev-parse", "HEAD"]);
  const drift = head.status === 0
    ? git(["diff", "--quiet", "HEAD", "--", "src-tauri/src/agent_setup.rs", "src/shared/agentSetupContract.json"]).status
    : null;
  return {
    executable: await fileIdentity(executable),
    cargo: version.stdout.trim(),
    gitHead: head.status === 0 ? head.stdout.trim() : null,
    activationSourcesMatchHead: drift === null ? null : drift === 0,
    agentSetupSha256: sha256(agentSetup),
    contractSha256: sha256(await readFile(CONTRACT_SOURCE)),
    crateReferences: references,
  };
}

async function writeGeneration(writer, payload, applicationData) {
  const run = spawnSync(writer.executable.path, [payload, applicationData], { encoding: "utf8", windowsHide: true, timeout: 600_000 });
  let result;
  try { result = JSON.parse(run.stdout.trim()); } catch { result = null; }
  if (run.status !== 0 || result?.status !== "GENERATION_ACTIVATED") {
    throw new StageFailure("generation", `Desktop activation code refused the payload: ${result?.error || run.stderr?.trim() || `exit ${run.status ?? run.error?.message}`}`);
  }
  const pointerBytes = await readFile(join(result.stateRoot, "ACTIVE-GENERATION.json"));
  const pointer = JSON.parse(pointerBytes.toString("utf8"));
  return { stateRoot: result.stateRoot, pointerSha256: sha256(pointerBytes), pointer };
}

function cleanEnvironment(paths, stateRoot) {
  const system = Object.fromEntries(["SystemRoot", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return {
    ...system,
    PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : "/usr/bin:/bin",
    USERPROFILE: paths.home, HOME: paths.home, APPDATA: paths.roaming, LOCALAPPDATA: paths.local,
    TEMP: paths.temp, TMP: paths.temp, TMPDIR: paths.temp,
    // Only the user-data keys an Agent host config carries; every installed-layout
    // root must come from the launcher's generation.
    EDITKIN_AGENT_STATE_ROOT: stateRoot,
    EDITKIN_WORKSPACE: paths.workspace,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: paths.skill,
    EDITKIN_MODEL_ROOT: join(paths.applicationData, "models"),
    EDITKIN_CACHE_ROOT: paths.cache,
    EDITKIN_WORKFLOW_PROFILE_PATH: join(paths.applicationData, "workflow", "workflow-profile.json"),
  };
}

/** Drives one stdio MCP session; resolves with every step's outcome and the process output. */
async function driveMcp(payloadInfo, environment, workspace) {
  const child = spawn(payloadInfo.node.path, [payloadInfo.launcher.path], {
    cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const started = Date.now();
  let buffered = "";
  let stderr = "";
  const pending = new Map();
  const stray = [];
  const exited = new Promise((accept) => child.once("exit", (code, signal) => accept({ code, signal, afterMs: Date.now() - started })));
  child.on("error", (error) => { stderr += `\n[spawn error] ${error.message}`; });
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffered += chunk;
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch { stray.push(line.slice(0, 300)); }
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs) => {
    const id = nextId++;
    const sentAt = Date.now();
    const response = Promise.race([
      new Promise((accept) => pending.set(id, accept)),
      exited.then((exit) => ({ transportClosed: exit })),
      new Promise((accept) => setTimeout(() => accept({ timedOut: true }), timeoutMs)),
    ]).finally(() => pending.delete(id));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response.then((message) => ({ ...message, elapsedMs: Date.now() - sentAt }));
  };
  const steps = {};
  try {
    steps.initialize = await request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "editkin-release-agent-connect-route", version: "1" },
    }, TIMEOUTS.initialize);
    if (steps.initialize.result) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const tools = [];
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const response = await request("tools/list", cursor ? { cursor } : {}, TIMEOUTS.toolsList);
        steps.toolsList = { ...response, result: undefined, pages: page + 1 };
        if (!response.result) break;
        tools.push(...(response.result.tools ?? []));
        cursor = response.result.nextCursor;
        if (!cursor) break;
      }
      steps.toolsList.tools = tools.map((tool) => tool.name);
      if (tools.length) steps.contract = await request("tools/call", { name: "get_autopilot_contract", arguments: {} }, TIMEOUTS.contract);
    }
  } finally {
    child.stdin.end();
    const exit = await Promise.race([exited, new Promise((accept) => setTimeout(() => accept(null), TIMEOUTS.exit))]);
    if (!exit) child.kill();
    steps.exit = exit ?? { ...(await exited), killedAfterStdinClose: true };
  }
  return { steps, stderr, stray };
}

function evaluate({ steps, stderr, stray }) {
  const failure = (stage, message) => { throw new StageFailure(stage, message, { stderr: tail(stderr), strayStdout: stray }); };
  const init = steps.initialize;
  if (!init?.result) {
    failure("initialize", init?.error ? `initialize returned JSON-RPC error ${init.error.code}: ${init.error.message}`
      : init?.transportClosed ? `The launcher exited before answering initialize (exit ${init.transportClosed.code})`
        : "initialize timed out");
  }
  if (!steps.toolsList?.tools?.length) failure("tools/list", steps.toolsList?.error ? `tools/list error: ${steps.toolsList.error.message}` : "tools/list returned no tools");
  const contract = steps.contract;
  if (!contract?.result) failure("get_autopilot_contract", contract?.error ? `JSON-RPC error ${contract.error.code}: ${contract.error.message}` : "get_autopilot_contract gave no result");
  let payload;
  try { payload = JSON.parse(contract.result.content?.[0]?.text ?? "null"); } catch { payload = null; }
  if (contract.result.isError || payload?.status !== "GREEN") {
    failure("get_autopilot_contract", `get_autopilot_contract is not GREEN: ${payload?.status ?? "unparsed"} ${payload?.error ?? ""}`.trim());
  }
  return {
    initialize: { elapsedMs: init.elapsedMs, protocolVersion: init.result.protocolVersion, serverInfo: init.result.serverInfo },
    toolsList: { elapsedMs: steps.toolsList.elapsedMs, pages: steps.toolsList.pages, count: steps.toolsList.tools.length,
      hasGetAutopilotContract: steps.toolsList.tools.includes("get_autopilot_contract") },
    getAutopilotContract: {
      elapsedMs: contract.elapsedMs,
      status: payload.status,
      liveInvocationSchema: payload.liveInvocation?.schema ?? null,
      skill: payload.liveInvocation?.skill ?? null,
      renderer: payload.liveInvocation?.renderer
        ? { executableSha256: payload.liveInvocation.renderer.executableSha256, executableBytes: payload.liveInvocation.renderer.executableBytes }
        : null,
    },
    exit: steps.exit,
    stderr: tail(stderr, 1500),
  };
}

export async function runAgentConnectRoute(options) {
  const receipt = { schema: AGENT_CONNECT_ROUTE_SCHEMA, status: "FAIL", measuredAt: new Date().toISOString(), payload: null, writer: null, generation: null, mcp: null, failure: null };
  try {
    receipt.payload = await inspectPayload(options.payload);
    const paths = await prepareSandbox(options.sandbox);
    receipt.writer = await buildWriter(options.writerTarget);
    receipt.generation = await writeGeneration(receipt.writer, options.payload, paths.applicationData);
    const environment = { ...cleanEnvironment(paths, receipt.generation.stateRoot), ...(options.hostEnvironment ?? {}) };
    receipt.environmentKeys = Object.keys(environment).sort();
    receipt.hostEnvironment = options.hostEnvironment ?? {};
    receipt.mcp = evaluate(await driveMcp(receipt.payload, environment, paths.workspace));
    receipt.status = "GREEN";
  } catch (error) {
    receipt.failure = error instanceof StageFailure
      ? { stage: error.stage, message: error.message, ...error.detail }
      : { stage: "internal", message: error?.stack ?? String(error) };
  }
  await mkdir(dirname(options.receipt), { recursive: true });
  await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const samePath = (left, right) => process.platform === "win32"
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);
const launchedAsMain = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (launchedAsMain) {
  const options = parseArguments(process.argv.slice(2));
  const receipt = await runAgentConnectRoute(options);
  process.stdout.write(`${JSON.stringify({
    status: receipt.status,
    receipt: options.receipt,
    tools: receipt.mcp?.toolsList.count ?? null,
    getAutopilotContract: receipt.mcp?.getAutopilotContract.status ?? null,
    failure: receipt.failure ? { stage: receipt.failure.stage, message: receipt.failure.message } : null,
  })}\n`);
  process.exitCode = receipt.status === "GREEN" ? 0 : 1;
}

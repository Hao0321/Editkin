import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTarget } from "../src/application/agentSetup";

export interface ChildResult { code: number; stdout: string; stderr: string }
export interface AgentCli { command: string; prefixArgs: string[] }

function runChild(command: string, args: string[], timeoutMs = 45_000, shell = false): Promise<ChildResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, shell, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun({ code, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000) });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("Agent 串接逾時")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(undefined, code ?? -1));
  });
}

export async function locateAgentCli(target: AgentTarget): Promise<AgentCli | undefined> {
  try {
    const lookup = await runChild(process.platform === "win32" ? "where.exe" : "which", [target], 8_000);
    if (lookup.code !== 0) return undefined;
    const candidates = lookup.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform !== "win32") return candidates[0] ? { command: candidates[0], prefixArgs: [] } : undefined;
    const shim = candidates.find((path) => /\.cmd$/i.test(path));
    if (shim) {
      const shimRoot = dirname(shim);
      if (target === "claude") {
        const executable = join(shimRoot, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        try { await access(executable); return { command: executable, prefixArgs: [] }; } catch { /* try another candidate */ }
      } else {
        const script = join(shimRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
        try {
          await access(script);
          const nodeLookup = await runChild("where.exe", ["node.exe"], 8_000);
          const node = nodeLookup.stdout.split(/\r?\n/).map((line) => line.trim()).find((path) => /\.exe$/i.test(path));
          if (node) return { command: node, prefixArgs: [script] };
        } catch { /* try native executable */ }
      }
    }
    const executable = candidates.find((path) => /\.exe$/i.test(path));
    return executable ? { command: executable, prefixArgs: [] } : undefined;
  } catch { return undefined; }
}

export async function runAgentCli(cli: AgentCli, args: string[]): Promise<ChildResult> {
  return runChild(cli.command, [...cli.prefixArgs, ...args]);
}

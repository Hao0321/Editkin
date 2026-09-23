import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentConnectModal } from "./AgentConnectModal";

describe("agent workspace UI contract (SSR/source, not native dialog automation)", () => {
  it("explains explicit directory permission and cancellation beside both host choices", () => {
    const html = renderToStaticMarkup(<AgentConnectModal onClose={() => undefined} onConnect={async () => undefined} />);
    expect(html).toContain("connect-codex-button");
    expect(html).toContain("connect-claude-button");
    expect(html).toContain("要授權給 AI 的工作資料夾");
    expect(html).toContain("每次都可重新選擇，取消不會變更設定");
    expect(html).not.toContain("這次沒有連成功");
  });

  it("keeps cancellation out of the failed-result panel and the new note readable", () => {
    const source = readFileSync(new URL("./AgentConnectModal.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("./agentConnectModal.css", import.meta.url), "utf8");
    expect(source).toContain("setResult(nextResult?.canceled ? undefined : nextResult)");
    expect(css).toMatch(/\.agent-workspace-note\s*\{[^}]*font-size:\s*14px/);
  });

  it("native wiring returns cancellation before runtime/probe/host work and has no default folder", () => {
    const source = readFileSync(new URL("../../src-tauri/src/main.rs", import.meta.url), "utf8");
    const command = source.slice(source.indexOf("fn copy_agent_setup("), source.indexOf("fn main()"));
    const cancellation = command.indexOf('"canceled": true');
    expect(command).toContain(".pick_folder()");
    expect(command).toContain("match selected_agent_workspace(selected.as_deref())");
    expect(command).toContain('"status": "failed", "health": "failed"');
    expect(cancellation).toBeGreaterThan(0);
    expect(cancellation).toBeLessThan(command.indexOf("let runtime = runtime_paths(&app)?"));
    expect(cancellation).toBeLessThan(command.indexOf("probe_current_editkin_mcp("));
    expect(cancellation).toBeLessThan(command.indexOf("locate_agent_cli("));
    expect(command).not.toContain(".video_dir()");
    expect(command).not.toContain('join("Editkin Projects")');
    expect(command).not.toContain("create_dir_all(&workspace)");
  });
});

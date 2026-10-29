import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentConnectModal } from "./AgentConnectModal";

describe("agent workspace UI contract (SSR/source, not native dialog automation)", () => {
  it("opens on step 1 of 3 (finding the AI apps), labelled by its heading, with a labelled close and no failure", () => {
    const html = renderToStaticMarkup(<AgentConnectModal onClose={() => undefined} onConnect={async () => undefined}
      bridge={{ detect: async () => ({ claude: true, codex: false }), copyText: async () => true }} />);
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="agent-connect-title"');
    expect(html).toContain('<h2 id="agent-connect-title" class="easy-title" tabindex="-1">正在找電腦裡的 AI…</h2>');
    expect(html).toContain("第 1 步，共 3 步");
    expect(html).toMatch(/aria-label="關閉" data-testid="agent-connect-close"/);
    expect(html).not.toContain("沒連上");
    expect(html).not.toContain("這次沒有連成功");
  });

  it("passes the chosen folder to the setup, keeps focus inside, and its text and targets stay large at every size", () => {
    const source = readFileSync(new URL("./AgentConnectModal.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("./agentConnectModal.css", import.meta.url), "utf8");
    expect(source).toContain("connect: (target, request) => connectRef.current(target, request)");
    expect(source).toContain("heading.current?.focus({ preventScroll: true })");
    expect(source).toContain('if (event.key === "Escape" && !flow.busy()) closeRef.current()');
    expect(source).toContain("const keepFocusInside");
    expect(css).toMatch(/--easy-small:\s*max\(16px,/);
    expect(css).toMatch(/--easy-body:\s*max\(17px,/);
    expect(css).toMatch(/\.agent-easy \.agent-easy-close \{[^}]*width: max\(48px,/);
    expect(css).toMatch(/details > summary \{[^}]*min-height: 48px/);
    expect(css).toMatch(/@media \(max-width: 560px\)/);
  });

  it("native wiring returns cancellation before runtime/probe/host work and has no default folder", () => {
    const source = readFileSync(new URL("../../src-tauri/src/main.rs", import.meta.url), "utf8");
    // Only this command's own body (it ends at its column-0 brace); later commands may legitimately use the Videos folder.
    // The definition at column 0 (main.rs's own Rust tests mention the name inside strings).
    const start = source.search(/^fn copy_agent_setup\(/m);
    expect(start).toBeGreaterThan(0);
    const end = /\r?\n\}\r?\n/g;
    end.lastIndex = start;
    const command = source.slice(start, end.exec(source)!.index);
    const cancellation = command.indexOf('"canceled": true');
    expect(command).toContain(".pick_folder()");
    expect(command).toContain("match selected_agent_workspace(selected.as_deref())");
    expect(cancellation).toBeGreaterThan(0);
    // 2026-10-29: the read-only app detection runs before the picker (a missing app is reported first, #102–#106); the
    // runtime, probe and configuration work (now inside agent_connect's attempt.run) still comes only after a folder.
    const work = ["attempt.run(", "runtime_paths(&app)", "probe_current_editkin_mcp("].map(text => command.indexOf(text)).filter(index => index >= 0);
    expect(work.length).toBeGreaterThan(0);
    for (const index of work) expect(cancellation).toBeLessThan(index);
    expect(command).not.toContain(".video_dir()");
    expect(command).not.toContain('join("Editkin Projects")');
    expect(command).not.toContain("create_dir_all(&workspace)");
  });
});

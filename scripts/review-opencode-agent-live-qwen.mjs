// One bounded desktop acceptance run against the user's saved private LAN Qwen.
// Usage: node scripts/review-opencode-agent-live-qwen.mjs <portable-preview.exe> [--edit-demo]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe", "Pass the portable community preview EXE");
const editDemo = process.argv.includes("--edit-demo");
const savedOriginPath = join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json");
const saved = JSON.parse(await readFile(savedOriginPath, "utf8"));
const origin = new URL(saved.origin);
assert.equal(origin.protocol, "http:", "Saved model origin must use the private LAN HTTP endpoint");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname), "Saved model origin is not a private LAN address");
assert(origin.port && origin.pathname === "/", "Saved model origin must be an IP and port");

const outputRoot = resolve("../artifacts/autopilot-desk");
await mkdir(outputRoot, { recursive: true });
const reportRoot = await mkdtemp(resolve(outputRoot, editDemo ? "native-agent-live-qwen-edit-" : "native-agent-live-qwen-"));
const stateRoot = await mkdtemp(join(tmpdir(), "editkin-live-qwen-"));
await mkdir(join(stateRoot, "data/local-story"), { recursive: true });
await writeFile(join(stateRoot, "data/local-story/origin.json"), JSON.stringify({ origin: origin.origin }));
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});
const child = spawn(executable, [], {
  cwd: dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
    WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.stdout.resume();
child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
const report = { status: "BLOCK", model: "pny/qwen3.8-27b-nvfp4", isolated: true, readOnly: !editDemo, checks: {} };
let page;
let promptStartedAt = 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inspect = () => harness.evaluate(page.webSocketDebuggerUrl, `(async()=>{
  if (!window.haoDesktop) return JSON.stringify({connected:false,busy:false,model:'',projectReady:false,events:[],error:false});
  const snapshot=await window.haoDesktop.statusOpenCodeAgent(0);
  const model=document.querySelector('.opencode-dock-compose-model select');
  const answers=[...document.querySelectorAll('.opencode-dock-entry.kind-message .opencode-dock-markdown')].map(node=>node.textContent||'');
  const toolTitles=new Set(['尋找剪輯工具','查看剪輯工具說明','讀取專案摘要','查看時間軸','修改時間軸','讀取自動剪輯規則','執行自動剪輯流程','套用自動剪輯計畫','輸出影片']);
  return JSON.stringify({connected:snapshot.connected,busy:snapshot.busy,model:model?.value||'',
    domBusy:!!document.querySelector('.opencode-dock-stop'),answerHasProjectName:answers.some(value=>value.includes('我的第一支影片')),
    answerHasVolume65:answers.some(value=>value.includes('65%')||value.includes('0.65')),
    answerLeaksInternals:answers.some(value=>/clip-demo|apply_edit_commands|\bGREEN\b/.test(value)),
    undoEnabled:!document.querySelector('[data-testid="undo-button"]')?.disabled,
    selectedClipVisible:!!document.querySelector('[data-testid="timeline-clip-clip-demo"].selected'),
    selectionChecked:!!document.querySelector('.opencode-dock-selection input')?.checked,
    reloadNeeded:!!document.querySelector('.opencode-dock-reload'),
    projectReady:!!snapshot.projectPath,events:snapshot.events.map(event=>({kind:event.kind,
      text:event.kind==='tool'?(toolTitles.has(event.text)?event.text:'其他 OpenCode 工具'):undefined,
      toolKind:event.kind==='tool'?event.toolKind:undefined,status:event.status,projectChanged:event.projectChanged,
      requestedAction:event.kind==='tool'?event.requestedAction:undefined,
      green:event.kind==='tool'?(event.details||[]).some(detail=>detail.type==='text'&&detail.text.includes('GREEN')):undefined})),
    error:!!document.querySelector('.opencode-dock-error')?.textContent?.trim()});
})()`, 10_000);
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (predicate(last)) return last;
    await delay(750);
  }
  throw new Error(`${label} timed out; connected=${last?.connected}; busy=${last?.busy}; eventKinds=${last?.events?.map((event) => event.kind).join(",")}`);
}
async function click(selector) {
  const box = await harness.evaluate(page.webSocketDebuggerUrl, `(()=>{const node=document.querySelector(${JSON.stringify(selector)});const r=node?.getBoundingClientRect();const x=r?r.left+r.width/2:0,y=r?r.top+r.height/2:0;const hit=document.elementFromPoint(x,y);return JSON.stringify({x,y,ready:!!r&&r.width>0&&r.height>0&&!node.disabled&&(node===hit||node.contains(hit))})})()`);
  assert(box.ready, `Control unavailable: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"])
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, 10_000);
}
try {
  page = await harness.target();
  report.checks.ready = await waitFor((state) => state.connected && state.projectReady && state.model, 60_000, "Embedded Agent readiness");
  assert.equal(report.checks.ready.model, report.model, "OpenCode selected a different model");
  assert(!report.checks.ready.error, "Agent startup reported an error");
  if (editDemo) assert(report.checks.ready.selectedClipVisible && report.checks.ready.selectionChecked,
    "The real-model edit would not include the selected clip context");
  const projectDirectory = join(stateRoot, "data/agent-working-projects");
  const names = (await readdir(projectDirectory)).filter((name) => name.endsWith(".editkin.json"));
  assert.equal(names.length, 1, "Expected one isolated Agent working project");
  const projectPath = join(projectDirectory, names[0]);
  const beforeBytes = await readFile(projectPath);
  const before = digest(beforeBytes);
  process.stdout.write('{"stage":"model_ready"}\n');
  promptStartedAt = Date.now();
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", {
    text: editDemo
      ? "請把這個片段的音量設為 65%，完成後用繁體中文簡短告訴我結果。"
      : "請用 editkin MCP 的 get_project_summary 讀取目前專案，然後用繁體中文簡短回覆專案名稱與片段數量。需要時可先用 discover_editkin_tools 或 inspect_editkin_tool 查詢工具。這是唯讀檢查，不要修改專案或建立 workflow run。",
  }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  report.checks.turn = await waitFor((state) => state.events.some((event) => event.kind === "turn") && !state.busy, 300_000,
    editDemo ? "Real Qwen clip edit turn" : "Real Qwen read-only Agent turn");
  const tools = report.checks.turn.events.filter((event) => event.kind === "tool");
  const changed = report.checks.turn.events.some((event) => event.kind === "turn" && event.projectChanged);
  assert(report.checks.turn.events.some((event) => event.kind === "message"), "Qwen did not produce a user-visible answer");
  assert(!report.checks.turn.events.some((event) => event.kind === "error"), "Agent emitted an error");
  if (editDemo) {
    assert(!tools.some((event) => event.status === "failed"), "An ordinary timeline edit failed before the model retried");
    const write = tools.find((event) => event.text === "修改時間軸" && event.status === "completed" && event.green);
    assert(write, `Qwen did not complete apply_edit_commands; tools=${tools.map((event) => `${event.text}:${event.status}`).join(",")}`);
    assert.equal(tools.filter((event) => event.text === "修改時間軸").length, 1,
      "The model repeated an ordinary timeline edit");
    assert.equal(write.requestedAction, "片段音量設為 65%", "Tool card did not summarize the volume request");
    assert(!tools.some((event) => ["執行自動剪輯流程", "套用自動剪輯計畫", "輸出影片"].includes(event.text)),
      "Qwen entered the full-film workflow for a single clip edit");
    assert(changed, "Agent did not mark the edit turn as changed");
    const afterBytes = await readFile(projectPath);
    assert.notEqual(digest(afterBytes), before, "Qwen did not change the working project");
    const original = JSON.parse(beforeBytes.toString("utf8"));
    const edited = JSON.parse(afterBytes.toString("utf8"));
    const clip = edited.tracks.flatMap((track) => track.clips).find((item) => item.id === "clip-demo");
    assert.equal(clip?.volume, 0.65, "Qwen did not set the selected clip volume to 65%");
    clip.volume = original.tracks.flatMap((track) => track.clips).find((item) => item.id === "clip-demo").volume;
    edited.revision = original.revision;
    edited.updatedAt = original.updatedAt;
    assert.deepEqual(edited, original, "Qwen changed project fields beyond the selected clip volume");
    report.checks.visible = await waitFor((state) => !state.domBusy && state.answerHasVolume65 && state.undoEnabled
      && !state.answerLeaksInternals && state.selectedClipVisible && !state.reloadNeeded && !state.error, 15_000,
      "Agent edit synchronized into the editor with a user-facing answer");
  } else {
    const read = tools.find((event) => event.text === "讀取專案摘要" && event.status === "completed");
    assert(read, `Qwen did not complete get_project_summary; tools=${tools.map((event) => `${event.text}:${event.status}`).join(",")}`);
    assert(read.green, "Editkin did not return a successful project summary");
    assert(tools.every((event) => ["讀取專案摘要", "查看剪輯工具說明", "尋找剪輯工具"].includes(event.text)),
      "Qwen called a tool outside the read-only flow");
    assert(!changed, "Agent marked a read-only turn as a project edit");
    assert.equal(digest(await readFile(projectPath)), before, "The read-only turn changed the project file");
    report.checks.visible = await waitFor((state) => !state.domBusy && state.answerHasProjectName && !state.error, 15_000,
      "Final Qwen answer visible in the Agent dock");
  }
  const screenshot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, 15_000);
  await writeFile(join(reportRoot, editDemo ? "live-qwen-edit.png" : "live-qwen-readonly.png"), Buffer.from(screenshot.data, "base64"), { flag: "wx" });
  report.checks = { modelSelected: true, readOnly: !editDemo, toolSuccess: true,
    projectUnchanged: !editDemo, selectedClipVolume65: editDemo, editorSynchronized: editDemo,
    answerVisible: true, toolTitles: tools.map((event) => event.text), toolCount: tools.length,
    schemaQueryCount: tools.filter((event) => event.text === "查看剪輯工具說明").length,
    kitReadCount: tools.filter((event) => event.text === "讀取自動剪輯規則").length,
    editAttemptCount: tools.filter((event) => event.text === "修改時間軸").length,
    elapsedMs: Date.now() - promptStartedAt };
  report.status = "PASS";
} catch (error) {
  report.error = String(error instanceof Error ? error.message : error).replaceAll(origin.origin, "<private-model-origin>");
} finally {
  harness.closeCdp();
  await harness.stopOwnedApplication();
  await writeFile(join(reportRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, reportRoot, checks: report.checks, error: report.error }) + "\n");
}
if (report.status !== "PASS") process.exitCode = 1;

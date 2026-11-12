// Real packaged ACP startup with delayed IPC replies and project changes during a live turn.
// Usage: node scripts/review-agent-startup-binding.mjs <preview.exe> [--expect-stale|--edit-previous]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
const expectStale = process.argv.includes("--expect-stale");
const editPrevious = process.argv.includes("--edit-previous");
const artifactRoot = resolve("../artifacts/autopilot-desk");
const stateRoot = await mkdtemp(join(artifactRoot, "agent-binding-review-"));
const originalPath = join(artifactRoot, "kit-voiced-prepare-IaRWnn/movie.editkin.json");
const originalBytes = await readFile(originalPath);
const originalHash = createHash("sha256").update(originalBytes).digest("hex");
const copies = {};
for (const key of ["A", "B", "C"]) {
  const project = JSON.parse(originalBytes);
  project.id = `agent-binding-${key}`; project.name = `Agent 綁定驗收 ${key}`;
  project.assets[0].name = `BINDING_${key}_MEDIA`;
  copies[key] = join(stateRoot, `${key}.editkin.json`);
  await writeFile(copies[key], JSON.stringify(project));
}
let holdTurn = false, turnReceived = false, releaseTurn = false;
let previousWorkingPath, editCalls = 0, editResultConfirmed = false;
const previousClipId = JSON.parse(originalBytes).tracks.flatMap(track => track.clips)[0].id;
const modelServer = httpServer(async (request, response) => {
  try {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; assert(size < 8_000_000); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text = JSON.stringify(body.messages || []);
    if (body.tools?.length && text.includes("BINDING_BUSY_PROBE") && holdTurn) {
      turnReceived = true;
      while (!releaseTurn && !response.destroyed) await delay(50);
    }
    if (response.destroyed) return;
    if (editPrevious && body.tools?.length && text.includes("BINDING_BUSY_PROBE")) {
      if (!editCalls) {
        const name = body.tools.find(tool => tool.function?.name.endsWith("call_editkin_tool"))?.function.name;
        assert(name && previousWorkingPath, "Native MCP gateway and previous working path must exist");
        editCalls++;
        response.write(`data: ${JSON.stringify({ id: "binding-edit", object: "chat.completion.chunk", choices: [{ index: 0,
          delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-binding-edit", type: "function", function: { name,
            arguments: JSON.stringify({ name: "apply_edit_commands", arguments: { projectPath: previousWorkingPath,
              commands: [{ type: "set_clip_volume", clipId: previousClipId, volume: 0.37 }] } }) } }] }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ id: "binding-edit", object: "chat.completion.chunk", choices: [{ index: 0,
          delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const toolResult = JSON.stringify([...(body.messages || [])].reverse().find(message => message.role === "tool")?.content || "");
      assert(toolResult.includes("GREEN") && toolResult.includes("appliedCommandCount"), "Previous project edit must succeed through MCP");
      editResultConfirmed = true;
    }
    response.write(`data: ${JSON.stringify({ id: "binding-review", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "BINDING_TURN_COMPLETE" }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: "binding-review", object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch { response.writeHead(500).end("Isolated model fixture failed"); }
});
await new Promise((done, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", done); });
await mkdir(join(stateRoot, "data/local-story"), { recursive: true });
await writeFile(join(stateRoot, "data/local-story/origin.json"), JSON.stringify({ origin: `http://127.0.0.1:${modelServer.address().port}` }));
const port = await new Promise((done, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => done(value)); });
});
const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
    WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
child.stdout.resume(); child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
const report = { status: "BLOCK", mode: editPrevious ? "previous-project-edit" : "read-only", stateRoot, executable, appPid: child.pid, checks: {} };
let page;
const evaluate = code => harness.evaluate(page.webSocketDebuggerUrl, code, 10_000);
const inspect = () => evaluate(`(async()=>{const s=window.haoDesktop?await window.haoDesktop.statusOpenCodeAgent(0):{};const p=window.bindingProbe||{};
  return JSON.stringify({ready:!!document.querySelector('[data-testid=new-project-button]'),connected:s.connected,busy:s.busy,
    projectPath:s.projectPath,sessionId:s.sessionId,selection:document.querySelector('.opencode-dock-selection')?.textContent,
    error:document.querySelector('.opencode-dock-error')?.textContent,waiting:document.querySelector('.opencode-dock-binding-wait')?.textContent,
    previousResult:document.querySelector('.opencode-dock-previous-result')?.textContent,
    model:document.querySelector('.opencode-dock-compose-model select')?.value,
    sendUnavailable:!document.querySelector('button[aria-label="傳送訊息"]')||document.querySelector('button[aria-label="傳送訊息"]').disabled,
    toolbar:document.querySelector('.project-heading strong')?.textContent,
    clipVolume:document.querySelector('[data-testid=clip-volume-input]')?.value,
    completedResults:(()=>{try{return JSON.parse(localStorage.getItem('editkin.agent-completed-projects.v1')||'[]')}catch{return[]}})(),confirmCalls:p.confirmCalls,
    aPath:p.aPath,bPath:p.bPath,cPath:p.cPath,startAHeld:p.startAHeld,createBHeld:p.createBHeld,
    oldTurnCompleted:p.oldTurnCompleted,closeCalls:p.closeCalls,starts:p.starts,
    viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
    waitingVisible:(()=>{const r=document.querySelector('.opencode-dock-binding-wait')?.getBoundingClientRect();
      return !!r&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})(),
    resultVisible:(()=>{const r=document.querySelector('.opencode-dock-previous-result')?.getBoundingClientRect();
      return !!r&&r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})(),
    turns:(s.events||[]).filter(e=>e.kind==='turn').map(e=>e.status)})})()`);
async function waitFor(predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { last = await inspect(); if (predicate(last)) return last; await delay(100); }
  report.lastObserved = last;
  throw Error(`${label} timed out`);
}
const click = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Control unavailable');n.click();return JSON.stringify(true)})()`);
async function openCopy(key) {
  await evaluate(`(()=>{window.haoDesktop.openProject=async()=>({...await window.haoDesktop.reloadProjectFromPath(${JSON.stringify(copies[key])}),path:undefined});
    const menu=document.querySelector('.project-menu');menu.open=true;menu.querySelector('.project-menu-group').open=true;return JSON.stringify(true)})()`);
  await click('[data-testid="open-project-button"]');
}
try {
  page = await harness.target();
  await waitFor(s => s.ready && s.connected && s.selection && s.model, "Initial demo binding");
  await evaluate(`(()=>{const api=window.haoDesktop;const p=window.bindingProbe={releaseA:false,releaseB:false,closeCalls:0,starts:[]};
    const create=api.createAgentWorkingProject.bind(api),start=api.startOpenCodeAgent.bind(api),close=api.closeOpenCodeAgent.bind(api),status=api.statusOpenCodeAgent.bind(api);
    api.createAgentWorkingProject=async project=>{const result=await create(project);const key=project.id?.slice(-1);
      if(['A','B','C'].includes(key))p[key.toLowerCase()+'Path']=result.path;
      if(key==='B'){p.createBHeld=true;while(!p.releaseB)await new Promise(r=>setTimeout(r,30));}return result;};
    api.startOpenCodeAgent=async(...args)=>{p.starts.push(args[0]);const result=await start(...args);
      if(args[0]===p.aPath&&!p.startAHeld){p.startAHeld=true;while(!p.releaseA)await new Promise(r=>setTimeout(r,30));}return result;};
    api.closeOpenCodeAgent=async()=>{p.closeCalls++;return close();};return JSON.stringify(true)})()`);
  await openCopy("A");
  await waitFor(s => s.startAHeld && s.connected && s.projectPath === s.aPath, "Real A startup response held");
  await openCopy("B");
  await delay(300);
  await evaluate("(()=>{window.bindingProbe.releaseA=true;return JSON.stringify(true)})()");
  const held = await waitFor(s => s.createBHeld, "Real B working copy response held");
  assert.equal(held.projectPath, held.aPath);
  await delay(600); // Flush the genuine state transition while B's IPC reply is pending.
  await evaluate("(()=>{window.bindingProbe.releaseB=true;return JSON.stringify(true)})()");
  if (expectStale) {
    await delay(5000);
    const stale = await inspect(); report.lastObserved = stale;
    assert(stale.connected && stale.projectPath === stale.aPath && stale.bPath && !stale.selection,
      "Old package did not reproduce the cancelled latest binding");
    report.expectedFailure = true; report.classification = "REPRODUCED_STALE_BINDING";
    report.error = "B working copy exists, but queued B startup was cancelled; native Agent remains bound to A";
    report.checks.controlledRealStartupReproduced = true;
  } else {
    const bound = await waitFor(s => s.connected && s.projectPath === s.bPath && s.selection?.includes("BINDING_B_MEDIA"), "Latest B binding after delayed replies");
    assert.equal(JSON.parse(await readFile(bound.projectPath, "utf8")).id, "agent-binding-B");
    const beforeTurnHash = createHash("sha256").update(await readFile(bound.projectPath)).digest("hex");
    previousWorkingPath = bound.projectPath;
    report.checks.latestProjectBoundAfterDelayedReplies = true;
    const closesBeforeTurn = bound.closeCalls;
    await evaluate(`(()=>{const api=window.haoDesktop,p=window.bindingProbe,status=api.statusOpenCodeAgent.bind(api);
      api.statusOpenCodeAgent=async(...args)=>{const s=await status(...args);if(s.projectPath===p.bPath&&!s.busy&&s.events?.some(e=>e.kind==='turn'&&e.status==='end_turn'))p.oldTurnCompleted=true;return s;};return JSON.stringify(true)})()`);
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    holdTurn = true;
    await evaluate("(()=>{document.querySelector('textarea[aria-label=\"傳訊息給 Agent\"]').focus();return JSON.stringify(true)})()");
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: editPrevious
      ? "請將目前選取片段的音量調整為 37%。 BINDING_BUSY_PROBE" : "請簡短回覆待命，不修改專案。 BINDING_BUSY_PROBE" });
    await click('button[aria-label="傳送訊息"]');
    await waitFor(s => s.busy && turnReceived, "Real model turn pending");
    await openCopy("C");
    const waiting = await waitFor(s => s.cPath && s.busy && s.waiting?.includes("自動連接") && !s.error, "Visible deferred project binding");
    assert.equal(waiting.projectPath, bound.bPath);
    assert.equal(waiting.closeCalls, closesBeforeTurn, "Project switch must not cancel the live Agent turn");
    assert(waiting.sendUnavailable, "New project must not send to old native binding");
    assert(waiting.waitingVisible && !waiting.horizontalOverflow && waiting.viewport.width === 1280 && waiting.viewport.height === 720,
      "Deferred-binding explanation must fit the small WebView");
    const waitShot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    await writeFile(join(stateRoot, "waiting-1280x720.png"), Buffer.from(waitShot.data, "base64"));
    report.checks.busyTurnPreserved = true; report.checks.newProjectSendDisabledWhileDeferred = true;
    report.checks.waitingVisibleAt1280x720 = true;
    releaseTurn = true;
    const rebound = await waitFor(s => s.connected && !s.busy && s.projectPath === s.cPath && s.selection?.includes("BINDING_C_MEDIA") && !s.error,
      "Automatic C binding after existing turn finishes");
    assert.equal(JSON.parse(await readFile(rebound.projectPath, "utf8")).id, "agent-binding-C");
    assert(rebound.oldTurnCompleted, "Existing B turn must finish normally before rebind");
    if (editPrevious) {
      const edited = JSON.parse(await readFile(bound.projectPath, "utf8"));
      assert.equal(edited.tracks.flatMap(track => track.clips).find(clip => clip.id === previousClipId).volume, 0.37);
      assert.equal(editCalls, 1); assert(editResultConfirmed);
      const current = JSON.parse(await readFile(rebound.projectPath, "utf8"));
      assert.equal(current.tracks.flatMap(track => track.clips).find(clip => clip.id === previousClipId).volume,
        JSON.parse(originalBytes).tracks.flatMap(track => track.clips).find(clip => clip.id === previousClipId).volume);
      report.checks.previousProjectEditedOnce = true; report.checks.currentProjectNotOverwritten = true;
      assert(rebound.previousResult?.includes("Agent 綁定驗收 B"), "Completed previous edit must remain discoverable after rebind");
      assert(rebound.resultVisible && !rebound.horizontalOverflow, "Previous result must fit the small WebView");
      assert(rebound.completedResults.some(result => result.path === bound.bPath && result.workingCopy), "Result pointer must survive a restart in optional local storage");
      report.checks.previousResultRemainsDiscoverable = true;
    } else {
      assert.equal(createHash("sha256").update(await readFile(bound.projectPath)).digest("hex"), beforeTurnHash,
        "The read-only old turn must not change its previous working project");
      report.checks.previousWorkingProjectUnchanged = true;
    }
    report.checks.reboundWithoutManualRetry = true;
    report.checks.previousTurnCompletedNormally = true;
    const finalShot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
    await writeFile(join(stateRoot, "rebound-1280x720.png"), Buffer.from(finalShot.data, "base64"));
    report.finalBinding = { sessionId: rebound.sessionId, projectPath: rebound.projectPath, starts: rebound.starts.length, closeCalls: rebound.closeCalls };
    if (editPrevious) {
      await evaluate(`(()=>{const menu=document.querySelector('.project-menu');menu.open=true;menu.querySelector('.project-menu-group').open=true;
        const label=[...menu.querySelectorAll('label')].find(n=>n.textContent.trim()==='屬性面板');const input=label?.querySelector('input');
        if(!input)throw Error('Workspace inspector control unavailable');if(!input.checked)input.click();menu.open=false;return JSON.stringify(true)})()`);
      await click('[data-testid=toolbar-agent-dock]');
      await waitFor(s => s.clipVolume !== undefined, "Selected C clip inspector");
      await evaluate(`(()=>{document.querySelector('[data-testid=inspector-advanced]').open=true;
        const n=document.querySelector('[data-testid=clip-volume-input]');n.focus();n.select();
        const p=window.bindingProbe;p.confirmCalls=[];p.acceptResult=false;window.confirm=message=>{p.confirmCalls.push(message);return p.acceptResult;};return JSON.stringify(true)})()`);
      await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "91" });
      await waitFor(s => s.clipVolume === "91", "Unsaved C edit before opening previous result");
      await click('[data-testid=toolbar-agent-dock]');
      await click('.opencode-dock-previous-actions button:first-child');
      const declined = await waitFor(s => s.confirmCalls?.length === 1, "Unsaved project result-open confirmation");
      assert.equal(declined.projectPath, rebound.projectPath);
      assert(declined.previousResult?.includes("Agent 綁定驗收 B"));
      await click('[data-testid=toolbar-agent-dock]');
      await waitFor(s => s.clipVolume === "91", "Declined result open retained unsaved C edit");
      await click('[data-testid=toolbar-agent-dock]');
      report.checks.declinedOpenPreservesCurrentEditAndResult = true;
      await evaluate("(()=>{window.bindingProbe.acceptResult=true;return JSON.stringify(true)})()");
      await click('.opencode-dock-previous-actions button:first-child');
      const opened = await waitFor(s => s.projectPath === bound.bPath && s.selection?.includes("BINDING_B_MEDIA")
        && s.toolbar === "Agent 綁定驗收 B" && !s.previousResult && !s.error, "Explicitly reopen completed B working copy");
      assert.equal(opened.confirmCalls.length, 2); assert.equal(editCalls, 1);
      await click('[data-testid=toolbar-agent-dock]');
      await waitFor(s => s.clipVolume === "37", "Completed B edit appears in the actual inspector");
      await click('[data-testid=toolbar-agent-dock]');
      report.checks.completedWorkingCopyReopenedWithoutRepeatedEdit = true;
      const openShot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
      await writeFile(join(stateRoot, "opened-result-1280x720.png"), Buffer.from(openShot.data, "base64"));
    }
    report.status = "PASS";
  }
  assert.equal(createHash("sha256").update(await readFile(originalPath)).digest("hex"), originalHash);
  report.checks.originalProjectUnchanged = true;
} catch (error) {
  report.expectedFailure = false; report.error = error.message;
  if (page) { try { report.lastObserved = await inspect(); } catch { /* Preserve primary failure. */ } }
} finally {
  releaseTurn = true;
  if (page) { try { await evaluate("(async()=>{if(window.bindingProbe){window.bindingProbe.releaseA=true;window.bindingProbe.releaseB=true;}await window.haoDesktop.closeOpenCodeAgent();return JSON.stringify(true)})()"); } catch { /* Owned process cleanup below. */ } }
  harness.closeCdp(); await harness.stopOwnedApplication();
  modelServer.closeAllConnections?.(); await new Promise(done => modelServer.close(done));
  await writeFile(join(stateRoot, "report.json"), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify({ status: report.status, classification: report.classification, stateRoot, error: report.error }) + "\n");
if (report.status !== "PASS" && !report.expectedFailure) process.exitCode = 1;

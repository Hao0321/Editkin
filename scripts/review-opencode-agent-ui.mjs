// Isolated desktop review for the bundled OpenCode dock. Only a loopback model stub receives prompts.
// Usage: node scripts/review-opencode-agent-ui.mjs <portable-preview.exe>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe", "Pass the portable community preview EXE");
const outputRoot = resolve("../artifacts/autopilot-desk");
await mkdir(outputRoot, { recursive: true });
const stateRoot = await mkdtemp(resolve(outputRoot, "native-agent-review-"));
const responseText = `STREAM_START|${"0123456789".repeat(80)}|STREAM_END`;
let modelRequests = 0;
let readToolCalled = false;
let writeToolCalled = false;
let readResultConfirmed = false;
let writeResultConfirmed = false;
let selectionToolCalled = false;
let selectionResultConfirmed = false;
let selectionOmitConfirmed = false;
let probeFailure = "";
const modelAudit = [];
const expectedProjectName = "Agent 工作副本驗證";
let initialProjectName = "";
async function workingProjectPath() {
  const directory = resolve(stateRoot, "data/agent-working-projects");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".editkin.json"));
  assert.equal(names.length, 1, "Expected one isolated Agent working project");
  return resolve(directory, names[0]);
}
function streamChunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: "editkin-stream-review", object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
function finishStream(response, reason = "stop") {
  streamChunk(response, {}, reason);
  response.end("data: [DONE]\n\n");
}
const modelServer = createHttpServer(async (request, response) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes <= 8_000_000) chunks.push(chunk); }
  if (request.method !== "POST") { response.writeHead(404).end(); return; }
  modelRequests++;
  if (bytes > 8_000_000) { response.writeHead(413).end(); return; }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { probeFailure = `Model request JSON failed: ${String(error)}`; response.writeHead(400).end(); return; }
  const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === "user");
  const prompt = JSON.stringify(lastUser?.content || "");
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name || tool.name).filter(Boolean) : [];
  if (prompt.includes("AGENT_DRAFT_RESYNC_PROBE")) {
    const project = JSON.parse(await readFile(await workingProjectPath(), "utf8"));
    if (project.name !== initialProjectName) { probeFailure = "Undo was not synchronized into the Agent working copy"; response.writeHead(500).end(probeFailure); return; }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streamChunk(response, { role: "assistant", content: "DRAFT_RESYNC_OK" });
    finishStream(response);
    return;
  }
  if (prompt.includes("AGENT_SELECTION_OMIT_PROBE")) {
    if (prompt.includes("目前剪輯台選取") || prompt.includes("clip-demo")) {
      probeFailure = "Unchecked clip reference still entered the new user prompt";
      response.writeHead(500).end(probeFailure); return;
    }
    selectionOmitConfirmed = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streamChunk(response, { role: "assistant", content: "SELECTION_OMIT_OK" });
    finishStream(response);
    return;
  }
  const probe = prompt.includes("AGENT_SELECTION_EDIT_PROBE") ? "selection"
    : prompt.includes("AGENT_DRAFT_WRITE_PROBE") ? "write"
      : prompt.includes("AGENT_DRAFT_READ_PROBE") ? "read" : "";
  modelAudit.push({ request: modelRequests, probe, toolCount: tools.length, toolNames: tools,
    hasGateway: tools.some((tool) => tool.endsWith("call_editkin_tool")), messageRoles: (body.messages || []).map((message) => message.role),
    lastUserLength: prompt.length, markerAnywhere: JSON.stringify(body.messages || []).includes("AGENT_DRAFT_") });
  if (probe && tools.length) {
    const called = probe === "selection" ? selectionToolCalled : probe === "write" ? writeToolCalled : readToolCalled;
    if (!called) {
      if (probe === "selection" && (!prompt.includes("目前剪輯台選取") || !prompt.includes('clip-demo') || !prompt.includes("Editkin 示範素材"))) {
        probeFailure = "Selected clip context did not reach the native OpenCode model";
        response.writeHead(500).end(probeFailure); return;
      }
      const suffix = "call_editkin_tool";
      const name = tools.find((tool) => tool.endsWith(suffix));
      if (!name) { probeFailure = `OpenCode did not expose ${suffix} to the model`; response.writeHead(500).end(probeFailure); return; }
      let projectPath;
      try { projectPath = await workingProjectPath(); }
      catch (error) { probeFailure = `Working copy lookup failed: ${String(error)}`; response.writeHead(500).end(probeFailure); return; }
      const args = probe === "selection"
        ? { name: "apply_edit_commands", arguments: { projectPath, commands: [{ type: "set_clip_volume", clipId: "clip-demo", volume: 0.65 }] } }
        : probe === "write"
        ? { name: "apply_edit_commands", arguments: { projectPath, commands: [{ type: "rename_project", name: expectedProjectName }] } }
        : { name: "get_project_summary", arguments: { projectPath } };
      if (probe === "selection") selectionToolCalled = true;
      else if (probe === "write") writeToolCalled = true;
      else readToolCalled = true;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      streamChunk(response, { role: "assistant", tool_calls: [{ index: 0, id: `call-editkin-${probe}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] });
      finishStream(response, "tool_calls");
      return;
    }
    const toolResult = JSON.stringify([...(body.messages || [])].reverse().find((message) => message.role === "tool")?.content || "");
    if (!toolResult.includes("GREEN") || (probe !== "read" && !toolResult.includes("appliedCommandCount"))) {
      probeFailure = `${probe} gateway call did not return a successful Editkin result: ${toolResult.slice(0, 700)}`;
      response.writeHead(500).end(probeFailure); return;
    }
    if (probe === "selection") selectionResultConfirmed = true;
    else if (probe === "write") writeResultConfirmed = true;
    else readResultConfirmed = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streamChunk(response, { role: "assistant", content: probe === "selection" ? "SELECTION_EDIT_OK" : probe === "write" ? "DRAFT_WRITE_OK" : "DRAFT_READ_OK" });
    finishStream(response);
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const slowScrollProbe = prompt.includes("SCROLL_STREAM_PROBE");
  for (let index = 0; index < responseText.length; index++) {
    streamChunk(response, { ...(index === 0 ? { role: "assistant" } : {}), content: responseText[index] });
    if (slowScrollProbe && index % 5 === 0) await delay(25);
  }
  finishStream(response);
});
await new Promise((done, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", done); });
const modelPort = modelServer.address().port;
await mkdir(resolve(stateRoot, "data/local-story"), { recursive: true });
await writeFile(resolve(stateRoot, "data/local-story/origin.json"), JSON.stringify({ origin: `http://127.0.0.1:${modelPort}` }));
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
    WEBVIEW2_USER_DATA_FOLDER: resolve(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.stdout.resume();
child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
let page;
const evaluate = (expression, timeout = 10_000) => harness.evaluate(page.webSocketDebuggerUrl, expression, timeout);
const report = { status: "BLOCK", stateRoot, appPid: child.pid, checks: {} };
async function inspect() {
  return evaluate(`(()=>{
    const root=document.documentElement;
    const dock=document.querySelector('.agent-dock[data-view="home"]');
    const composer=document.querySelector('.opencode-dock-composer');
    const model=composer?.querySelector('.opencode-dock-compose-model select');
    const transcript=document.querySelector('.opencode-dock-transcript');
    const sr=model?.getBoundingClientRect(),dr=dock?.getBoundingClientRect(),cr=composer?.getBoundingClientRect();
    const intro=document.querySelector('.opencode-dock-empty strong')?.getBoundingClientRect(),tr=transcript?.getBoundingClientRect();
    const starterRects=[...document.querySelectorAll('.opencode-dock-starters button')].map(node=>node.getBoundingClientRect());
    const history=document.querySelector('.opencode-dock-status button[title="對話紀錄"]');
    const answer=[...document.querySelectorAll('.opencode-dock-entry.kind-message .opencode-dock-markdown')].map(node=>node.textContent||'').join('');
    const context=document.querySelector('.opencode-dock-project')?.textContent||'';
    const statusText=document.querySelector('.opencode-dock-status strong')?.textContent||'';
    const jump=document.querySelector('.opencode-dock-jump');
    const draft=document.querySelector('.opencode-dock-composer textarea');
    const attention=document.querySelector('.opencode-dock-attention');
    const sourceStatus=document.querySelector('.opencode-dock-source-status');
    const permission=document.querySelector('.opencode-dock-entry.kind-permission');
    const permissionRect=permission?.getBoundingClientRect(),transcriptRect=transcript?.getBoundingClientRect();
    const historyPanel=document.querySelector('.opencode-dock-history');
    const commandPanel=document.querySelector('.opencode-dock-commands');
    const commandRect=commandPanel?.getBoundingClientRect(),composerRect=composer?.getBoundingClientRect();
    return JSON.stringify({desktop:window.haoDesktop?.isDesktop===true,agentDock:!!dock,
      dockHidden:!!dock?.hidden,busy:!!document.querySelector('.opencode-dock-stop'),
      connected:!!document.querySelector('.opencode-dock-status button[title="建立新對話"]'),
      modelVisible:!!sr&&!!dr&&sr.width>40&&sr.height>10&&sr.top>=dr.top&&sr.bottom<=dr.bottom,
      composerVisible:!!cr&&!!dr&&cr.width>150&&cr.bottom<=dr.bottom,
      transcriptVisible:!!transcript&&transcript.getBoundingClientRect().height>80,
      transcriptHeight:tr?.height||0,topChrome:!!tr&&!!dr?tr.top-dr.top:0,composerHeight:cr?.height||0,
      composerInputHeight:document.querySelector('.opencode-dock-composer textarea')?.getBoundingClientRect().height||0,
      draftValue:draft?.value||'',draftDisabled:!!draft?.disabled,draftNote:document.querySelector('.opencode-dock-draft-note')?.textContent||'',
      attentionVisible:!!attention,attentionText:attention?.textContent||'',permissionFocused:document.activeElement?.classList?.contains('kind-permission')||false,
      sourceStatusVisible:!!sourceStatus,sourceStatusText:sourceStatus?.textContent?.trim()||'',
      sourceProgressValue:Number(sourceStatus?.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')||-1),
      permissionInView:!!permissionRect&&!!transcriptRect&&permissionRect.top>=transcriptRect.top-1&&permissionRect.bottom<=transcriptRect.bottom+1,
      activityText:document.querySelector('.opencode-dock-activity')?.textContent?.trim()||'',
      transcriptScrollTop:transcript?.scrollTop||0,transcriptMaxScroll:transcript?transcript.scrollHeight-transcript.clientHeight:0,
      jumpVisible:!!jump&&jump.getBoundingClientRect().height>0,
      moreOpen:!!document.querySelector('.opencode-dock-more[open]'),
      morePanelHeight:document.querySelector('.opencode-dock-more-panel')?.getBoundingClientRect().height||0,
      dockWidth:dr?.width||0,horizontalOverflow:!!dock&&dock.scrollWidth>dock.clientWidth+1,
      emptyActions:document.querySelectorAll('.opencode-dock-starters button').length,
      emptyIntroVisible:!!intro&&!!tr&&intro.top>=tr.top&&intro.bottom<=tr.bottom,
      emptyActionsVisible:!!tr&&starterRects.length===2&&starterRects.every(rect=>rect.top>=tr.top&&rect.bottom<=tr.bottom),
      legacyStartupCopy:/啟動中|未啟動|重新啟動 Agent|結束 Agent/.test(dock?.textContent||''),statusText,
      fakeEditorProgress:!!document.querySelector('.app-shell[data-workspace-mode="editor"] .quick-flow'),
      roughCutLabel:document.querySelector('[data-testid="semantic-edit-button"]')?.textContent?.trim()||'',
      exportLabel:document.querySelector('[data-testid="render-button"]')?.textContent?.trim()||'',
      toolbarOverflow:(()=>{const node=document.querySelector('.toolbar');return !!node&&node.scrollWidth>node.clientWidth+1})(),
      error:document.querySelector('.opencode-dock-error')?.textContent?.trim()||'',
      background:dock?getComputedStyle(dock).backgroundColor:'',
      colorScheme:dock?getComputedStyle(dock).colorScheme:'',
      theme:root?.dataset.theme||'sky',
      rootSurface:root?getComputedStyle(root).getPropertyValue('--surface').trim():'',
      dockSurface:dock?getComputedStyle(dock).getPropertyValue('--surface').trim():'',
      rootAccent:root?getComputedStyle(root).getPropertyValue('--accent').trim():'',
      dockAccent:dock?getComputedStyle(dock).getPropertyValue('--accent').trim():'',
      modeCount:composer?.querySelectorAll('.opencode-dock-compose-select').length||0,
      mcpAttached:context.includes('可剪輯'),draftReady:context.includes('草稿'),
      historyEnabled:!!history&&!history.disabled,historyOpen:!!document.querySelector('.opencode-dock-history'),
      historyOverflow:!!historyPanel&&historyPanel.scrollWidth>historyPanel.clientWidth+1,
      commandCount:commandPanel?.querySelectorAll('button').length||0,
      commandSelected:commandPanel?.querySelector('button[aria-selected=true] strong')?.textContent||'',
      commandAboveComposer:!!commandRect&&!!composerRect&&commandRect.bottom<=composerRect.top+1,
      commandOverflow:!!commandPanel&&commandPanel.scrollWidth>commandPanel.clientWidth+1,
      historyItems:[...document.querySelectorAll('.opencode-dock-history button')].map(node=>({text:node.textContent?.trim().slice(0,80),disabled:node.disabled})),
      sessionId:document.querySelector('.opencode-dock-skills .opencode-dock-session')?.childNodes[0]?.textContent||'',
      answerLength:answer.length,answerStart:answer.includes('STREAM_START|'),answerEnd:answer.includes('|STREAM_END'),
      readAcknowledged:answer.includes('DRAFT_READ_OK'),writeAcknowledged:answer.includes('DRAFT_WRITE_OK'),
      selectionAcknowledged:answer.includes('SELECTION_EDIT_OK'),selectionOmitAcknowledged:answer.includes('SELECTION_OMIT_OK'),
      resyncAcknowledged:answer.includes('DRAFT_RESYNC_OK'),
      selectionLabel:document.querySelector('.opencode-dock-selection')?.textContent?.trim()||'',
      selectionChecked:!!document.querySelector('.opencode-dock-selection input')?.checked,
      selectedClipVisible:!!document.querySelector('[data-testid="timeline-clip-clip-demo"].selected'),
      toolStates:[...document.querySelectorAll('.opencode-dock-entry.kind-tool')].map(node=>(node.querySelector('strong')?.textContent||'')+' · '+(node.querySelector('.opencode-dock-tool-state')?.textContent||'')),
      toolIntents:[...document.querySelectorAll('.opencode-dock-entry.kind-tool .opencode-dock-tool-intent')].map(node=>node.textContent?.trim()||''),
      toolOutcomes:[...document.querySelectorAll('.opencode-dock-entry.kind-tool .opencode-dock-tool-outcome')].map(node=>node.textContent?.trim()||''),
      blockedToolLogOpen:!!document.querySelector('.opencode-dock-entry.kind-tool:has(.opencode-dock-tool-outcome) .opencode-dock-tool-details[open]'),
      previewError:!!document.querySelector('[data-testid="preview-media-error"]'),
      previewReady:(document.querySelector('[data-testid="preview-video"]')?.readyState||0)>=2,
      starterSlateVisible:!!document.querySelector('[data-testid="starter-preview-slate"]'),
      operationStatus:document.querySelector('[data-testid="operation-status-message"]')?.textContent?.trim()||'',
      libraryPackMessage:document.querySelector('[data-testid="creative-library-scroll"]')?.textContent?.trim()||'',
      libraryLoading:document.querySelector('[data-testid="creative-library"]')?.getAttribute('data-library-loading')||'',
      toolbarName:document.querySelector('.project-heading strong')?.textContent||'',
      undoEnabled:!document.querySelector('[data-testid="undo-button"]')?.disabled,
      reloadNeeded:!!document.querySelector('.opencode-dock-reload'),
      turnFinished:!!document.querySelector('.opencode-dock-entry.kind-turn'),
      historyTruncated:!!document.querySelector('.opencode-dock-history-limit')});
  })()`);
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (probeFailure) throw new Error(`${label}: ${probeFailure}; audit=${JSON.stringify(modelAudit)}`);
    if (predicate(last)) return last;
    await delay(400);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
async function click(selector) {
  const box = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node?.scrollIntoView({block:'nearest'});const r=node?.getBoundingClientRect();const x=r? r.left+r.width/2:0,y=r? r.top+r.height/2:0;const hit=document.elementFromPoint(x,y);return JSON.stringify({x,y,ready:!!r&&r.width>0&&r.height>0&&!node.disabled&&(node===hit||node.contains(hit))})})()`);
  assert(box.ready, `Control unavailable: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"])
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, 10_000);
}
async function screenshot(name) {
  const result = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, 15_000);
  await writeFile(resolve(stateRoot, name), Buffer.from(result.data, "base64"), { flag: "wx" });
}
async function pressEscape() {
  for (const type of ["keyDown", "keyUp"])
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, 10_000);
}
async function pressKey(key, windowsVirtualKeyCode) {
  for (const type of ["keyDown", "keyUp"])
    await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode }, 10_000);
}
try {
  page = await harness.target();
  report.checks.initial = await waitFor((state) => state.agentDock, 20_000, "Built-in Agent dock");
  assert(report.checks.initial.composerVisible, "Agent composer is hidden while the built-in runtime is preparing");
  assert.equal(report.checks.initial.legacyStartupCopy, false, "Agent dock shows a separate-service startup control");
  report.checks.ready = await waitFor((state) => state.desktop && state.agentDock && state.connected, 50_000, "Embedded OpenCode startup");
  initialProjectName = report.checks.ready.toolbarName;
  assert(report.checks.ready.mcpAttached && report.checks.ready.draftReady, "Unsaved editor was not bound to an Editkin Agent working copy");
  assert(!report.checks.ready.fakeEditorProgress && report.checks.ready.roughCutLabel === "本機粗剪"
    && report.checks.ready.exportLabel === "輸出影片" && !report.checks.ready.toolbarOverflow,
  "Editor toolbar shows a misleading wizard, duplicate export step or clipped action");
  assert(report.checks.ready.modelVisible, "Native model selector is clipped or absent");
  assert(report.checks.ready.composerVisible && report.checks.ready.transcriptVisible, "Composer/transcript layout is clipped");
  assert(report.checks.ready.topChrome < 105 && report.checks.ready.composerHeight < 150,
    "Agent fixed chrome still crowds the transcript");
  assert.equal(report.checks.ready.emptyActions, 2, "Agent empty state has no editable starter prompts");
  assert(report.checks.ready.emptyIntroVisible, "Agent empty state scrolled its introduction out of view");
  assert(report.checks.ready.emptyActionsVisible, "Agent starter prompts are below the first visible fold");
  assert.equal(report.checks.ready.legacyStartupCopy, false, "Agent dock shows a separate-service control after startup");
  assert.equal(report.checks.ready.error, "", "Agent reported an error at startup");
  assert(report.checks.ready.starterSlateVisible && report.checks.ready.previewReady,
    "Untouched demo should show a calm starter slate over playable media");
  assert(!report.checks.ready.operationStatus.includes("Creator Pack 載入失敗"), "Absent optional Creator Pack is reported as a startup failure");
  await click('[data-testid="asset-library-tab"]');
  report.checks.optionalLibrary = await waitFor((state) => state.libraryLoading === "false" && state.libraryPackMessage.includes("此版本未附內建素材庫"), 5_000, "Optional library empty state");
  await click('button[role="tab"][title="我的素材"]');
  const originalGrid = await evaluate("JSON.stringify(document.querySelector('[data-testid=modular-workspace]').style.gridTemplateColumns)");
  report.checks.dockWidths = {};
  for (const width of [300, 380, 560]) {
    await evaluate(`(()=>{const grid=document.querySelector('[data-testid=modular-workspace]');grid.style.gridTemplateColumns=${JSON.stringify(originalGrid)}.replace(/\\d+px$/,${JSON.stringify(`${width}px`)});return JSON.stringify(true)})()`);
    const state = await inspect();
    assert(Math.abs(state.dockWidth - width) < 2, `${width}px dock width was not applied`);
    assert(!state.horizontalOverflow && state.modelVisible && state.composerVisible, `${width}px Agent controls overflow`);
    report.checks.dockWidths[width] = { actual: state.dockWidth, modelVisible: state.modelVisible, composerVisible: state.composerVisible };
    if (width === 300) await screenshot("agent-compact.png");
  }
  await evaluate(`(()=>{document.querySelector('[data-testid=modular-workspace]').style.gridTemplateColumns=${JSON.stringify(originalGrid)};return JSON.stringify(true)})()`);
  report.checks.themeParity = {};
  for (const theme of ["sky", "candy", "volt"]) {
    await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};return JSON.stringify(true)})()`);
    const state = await inspect();
    assert.equal(state.theme, theme);
    assert.equal(state.dockSurface, state.rootSurface, `${theme} Agent surface differs from the editor theme`);
    assert.equal(state.dockAccent, state.rootAccent, `${theme} Agent accent differs from the editor theme`);
    assert.equal(state.colorScheme, theme === "volt" ? "dark" : "light", `${theme} Agent native controls use the wrong color scheme`);
    assert(state.modelVisible && state.composerVisible && state.transcriptVisible, `${theme} Agent controls are clipped`);
    report.checks.themeParity[theme] = { surface: state.dockSurface, accent: state.dockAccent, background: state.background };
    if (theme === "volt") { await delay(600); await screenshot("agent-volt.png"); }
  }
  await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(report.checks.ready.theme)};return JSON.stringify(true)})()`);
  await delay(600);
  await screenshot("agent-ready.png");
  await click('[data-testid="preview-play"]');
  report.checks.starterPlayback = await waitFor((state) => !state.starterSlateVisible && state.previewReady, 5_000, "Starter video playback");
  await screenshot("starter-preview-playing.png");
  await click('[data-testid="preview-play"]');
  await click('.opencode-dock-more summary');
  report.checks.moreMenu = await inspect();
  assert(report.checks.moreMenu.moreOpen && report.checks.moreMenu.draftReady && report.checks.moreMenu.mcpAttached,
    "Project and Agent details are not available in the More menu");
  assert(report.checks.moreMenu.morePanelHeight < 250, "Agent More menu is too tall before expanding details");
  assert(Math.abs(report.checks.moreMenu.transcriptHeight - report.checks.ready.transcriptHeight) < 2,
    "Opening Agent details reflowed the conversation");
  await screenshot("agent-more.png");
  await click('.opencode-dock-menu-section summary');
  report.checks.modelSettings = await evaluate("(()=>{const node=document.querySelector('.opencode-dock-menu-section input[aria-label=\"區網 Qwen 位址\"]');const rect=node?.getBoundingClientRect();return JSON.stringify({visible:!!rect&&rect.width>40&&rect.height>15})})()");
  assert(report.checks.modelSettings.visible, "Nested local-model setting cannot be opened");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  assert.equal((await inspect()).moreOpen, false, "Clicking outside did not close Agent settings");
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "/" }, 10_000);
  report.checks.commandMenu = await waitFor((state) => state.commandCount > 1 && state.draftValue === "/", 5_000, "Native slash command menu");
  assert(report.checks.commandMenu.commandAboveComposer && !report.checks.commandMenu.commandOverflow,
    "Slash command menu is clipped or horizontally overflowing");
  assert(Math.abs(report.checks.commandMenu.transcriptHeight - report.checks.ready.transcriptHeight) < 2,
    "Slash command suggestions shrink the conversation");
  await evaluate(`(()=>{const grid=document.querySelector('[data-testid=modular-workspace]');grid.style.gridTemplateColumns=${JSON.stringify(originalGrid)}.replace(/\\d+px$/,"300px");return JSON.stringify(true)})()`);
  const compactCommands = await inspect();
  assert(compactCommands.commandAboveComposer && !compactCommands.commandOverflow && !compactCommands.horizontalOverflow,
    "Slash command suggestions do not fit the 300px dock");
  await screenshot("agent-slash-commands.png");
  await evaluate(`(()=>{document.querySelector('[data-testid=modular-workspace]').style.gridTemplateColumns=${JSON.stringify(originalGrid)};return JSON.stringify(true)})()`);
  const firstCommand = report.checks.commandMenu.commandSelected;
  await pressKey("ArrowDown", 40);
  const secondCommand = await inspect();
  assert(secondCommand.commandSelected && secondCommand.commandSelected !== firstCommand, "ArrowDown did not select the next command");
  await pressKey("Enter", 13);
  report.checks.commandChosen = await inspect();
  assert.equal(report.checks.commandChosen.draftValue, `${secondCommand.commandSelected} `, "Enter sent the slash command instead of filling the draft");
  assert.equal(modelRequests, 0, "Choosing a slash command sent a model request");
  await evaluate("(()=>{const input=document.querySelector('.opencode-dock-composer textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()");
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "/" }, 10_000);
  await waitFor((state) => state.commandCount > 1, 5_000, "Slash command menu reopen");
  await pressEscape();
  const dismissedCommand = await inspect();
  assert.equal(dismissedCommand.commandCount, 0, "Escape did not close slash command suggestions");
  assert.equal(dismissedCommand.draftValue, "/", "Escape erased the command draft");
  await evaluate("(()=>{const input=document.querySelector('.opencode-dock-composer textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()");
  await click('.opencode-dock-starters button:first-child');
  report.checks.starterDraft = await evaluate("(()=>{const field=document.querySelector('textarea[aria-label=\"傳訊息給 OpenCode Agent\"]');return JSON.stringify({value:field?.value||'',focused:document.activeElement===field})})()");
  assert(report.checks.starterDraft.value.includes("讀取目前專案") && report.checks.starterDraft.focused,
    "Starter prompt did not fill the editable composer");
  assert.equal(modelRequests, 0, "Clicking a starter prompt sent a model request without user confirmation");
  const compactInputHeight = (await inspect()).composerInputHeight;
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "\n請依序列出素材。\n再檢查每個片段。\n最後提出節奏調整。\n先不要修改。" }, 10_000);
  report.checks.composerGrowth = await inspect();
  assert(report.checks.composerGrowth.composerInputHeight > compactInputHeight + 20 && report.checks.composerGrowth.composerInputHeight <= 160,
    "Long Agent draft did not grow within the composer cap");
  await delay(18_000); // Covers the former 15 s queue-deadline failure.
  report.checks.stable = await inspect();
  assert.equal(report.checks.stable.error, "", "Agent reported an error after startup");
  const priorSessionId = report.checks.stable.sessionId;
  await click('button[aria-label="傳送訊息"]');
  report.checks.stream = await waitFor((state) => state.answerStart && state.answerEnd && !state.busy && !state.error, 60_000, "Native streamed reply");
  assert(modelRequests >= 1 && modelRequests <= 3, "Prompt did not reach the loopback model as expected");
  assert(report.checks.stream.statusText.includes("請先讀取目前專案"), "Agent conversation still has a generic title after the first task");
  assert.equal(report.checks.stream.turnFinished, false, "Successful Agent turns still expose raw protocol status");
  report.checks.modelRequests = modelRequests;
  assert.equal(report.checks.stream.answerLength, responseText.length, "Streamed answer was lost or duplicated");
  assert.equal(report.checks.stream.historyTruncated, false, "A single long reply exhausted the event history");
  assert((await inspect()).composerInputHeight <= compactInputHeight + 2, "Composer did not shrink after sending");
  await screenshot("agent-stream.png");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "SCROLL_STREAM_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  await waitFor((state) => state.busy && state.answerLength > responseText.length + 250 && state.transcriptMaxScroll > 50, 30_000, "Partial Agent stream for scroll review");
  assert.equal((await inspect()).draftDisabled, false, "Composer cannot prepare the next task while Agent works");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "NEXT_TASK_DRAFT_PROBE" }, 10_000);
  report.checks.draftWhileBusy = await waitFor((state) => state.busy && state.draftValue === "NEXT_TASK_DRAFT_PROBE" && state.draftNote.includes("草稿已保留"), 5_000, "Next-task draft during stream");
  await evaluate("(()=>{const node=document.querySelector('.opencode-dock-transcript');node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}));return JSON.stringify(true)})()");
  report.checks.scrolledDuringStream = await waitFor((state) => state.jumpVisible && state.transcriptScrollTop < 20, 5_000, "Scroll-away behavior");
  report.checks.finishedWhileReading = await waitFor((state) => !state.busy && state.answerLength >= responseText.length * 2, 30_000, "Agent stream finished while reading above");
  assert(report.checks.finishedWhileReading.jumpVisible && report.checks.finishedWhileReading.transcriptScrollTop < 20,
    "Agent stream forced the user back to the bottom");
  assert.equal(report.checks.finishedWhileReading.draftValue, "NEXT_TASK_DRAFT_PROBE", "Next-task draft was lost after Agent reply");
  await screenshot("agent-reading-above.png");
  await click('.opencode-dock-jump');
  report.checks.jumpToLatest = await inspect();
  assert(!report.checks.jumpToLatest.jumpVisible && report.checks.jumpToLatest.transcriptMaxScroll - report.checks.jumpToLatest.transcriptScrollTop < 60,
    "Latest-message control did not restore follow mode");
  await evaluate("(()=>{const input=document.querySelector('.opencode-dock-composer textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()");
  assert.equal((await inspect()).draftValue, "", "Review cleanup left a pending draft");
  await click('.agent-dock-tabs button:nth-child(2)');
  report.checks.storyTab = await evaluate("JSON.stringify({view:document.querySelector('.agent-dock')?.dataset.view,agentKept:!!document.querySelector('.opencode-dock'),agentHidden:!!document.querySelector('.agent-dock-agent-content')?.hidden})");
  assert.deepEqual(report.checks.storyTab, { view: "story", agentKept: true, agentHidden: true }, "Story tab unmounted the Agent");
  await click('.agent-dock-tabs button:nth-child(1)');
  const returned = await inspect();
  assert.equal(returned.sessionId, priorSessionId, "Switching editor tabs replaced the OpenCode session");
  assert(returned.answerStart && returned.answerEnd, "Switching editor tabs lost the conversation");
  await click('.opencode-dock-status button[title="建立新對話"]');
  await delay(300);
  report.checks.newConversation = await waitFor((state) => state.connected && state.historyEnabled && state.sessionId && state.sessionId !== priorSessionId && !state.error, 15_000, "New native session");
  assert.equal(report.checks.newConversation.statusText, "新對話", "New session inherited the previous conversation title");
  await click('.opencode-dock-status button[title="對話紀錄"]');
  const history = await waitFor((state) => state.historyOpen || state.error, 15_000, "OpenCode history");
  assert.equal(history.error, "", "OpenCode history returned an error");
  assert(Math.abs(history.transcriptHeight - report.checks.ready.transcriptHeight) < 2,
    "Opening conversation history reflowed the transcript");
  report.checks.history = await evaluate("JSON.stringify({visible:!!document.querySelector('.opencode-dock-history'),entries:document.querySelectorAll('.opencode-dock-history button').length})");
  assert(report.checks.history.visible, "OpenCode history did not open");
  report.checks.historyWidths = {};
  for (const width of [300, 380]) {
    await evaluate(`(()=>{const grid=document.querySelector('[data-testid=modular-workspace]');grid.style.gridTemplateColumns=${JSON.stringify(originalGrid)}.replace(/\\d+px$/,${JSON.stringify(`${width}px`)});return JSON.stringify(true)})()`);
    const state = await inspect();
    assert(!state.historyOverflow, `${width}px history has horizontal overflow`);
    report.checks.historyWidths[width] = { overflow: state.historyOverflow };
  }
  await evaluate(`(()=>{document.querySelector('[data-testid=modular-workspace]').style.gridTemplateColumns=${JSON.stringify(originalGrid)};return JSON.stringify(true)})()`);
  await screenshot("agent-history.png");
  await pressEscape();
  assert.equal((await inspect()).historyOpen, false, "Escape did not close conversation history");
  await click('.opencode-dock-status button[title="對話紀錄"]');
  await waitFor((state) => state.historyOpen, 15_000, "Reopen conversation history");
  await click('.opencode-dock-history button:not([disabled])');
  report.checks.loadedConversation = await waitFor((state) => state.connected && state.sessionId === priorSessionId && !state.historyOpen && state.answerStart && state.answerEnd && !state.busy && !state.error, 60_000, "Load prior native session");
  assert(report.checks.loadedConversation.statusText.includes("請先讀取目前專案"), "Loaded conversation did not restore its readable title");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "請用工具讀取目前專案摘要。AGENT_DRAFT_READ_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  report.checks.readTool = await waitFor((state) => state.readAcknowledged && state.toolStates.some((tool) => tool.includes("完成")) && !state.busy && !state.error, 60_000, "Unsaved project read tool");
  assert(readToolCalled && readResultConfirmed && !probeFailure, probeFailure || "Read tool was not called through OpenCode");
  report.checks.selectionBeforeEdit = await inspect();
  assert(report.checks.selectionBeforeEdit.selectionChecked && report.checks.selectionBeforeEdit.selectionLabel.includes("Editkin 示範素材")
    && report.checks.selectionBeforeEdit.selectedClipVisible, "Selected clip is not legible and bound to the timeline");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "把這個片段音量調到 65%。AGENT_SELECTION_EDIT_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  report.checks.selectionEdit = await waitFor((state) => state.selectionAcknowledged && state.selectedClipVisible && !state.reloadNeeded && !state.busy && !state.error,
    60_000, "Selected-clip edit through native OpenCode and Editkin gateway");
  assert(selectionToolCalled && selectionResultConfirmed && !probeFailure, probeFailure || "Selected clip command did not reach Editkin");
  assert(report.checks.selectionEdit.toolIntents.includes("要求：片段音量設為 65%"),
    "Tool card does not show the selected clip edit request");
  await evaluate(`(()=>{const grid=document.querySelector('[data-testid=modular-workspace]');grid.style.gridTemplateColumns=${JSON.stringify(originalGrid)}.replace(/\\d+px$/,"300px");return JSON.stringify(true)})()`);
  report.checks.compactToolIntent = await inspect();
  assert(!report.checks.compactToolIntent.horizontalOverflow && report.checks.compactToolIntent.toolIntents.includes("要求：片段音量設為 65%"),
    "Selected-clip tool card overflows or loses its action at 300px");
  await screenshot("agent-tool-intent-compact.png");
  await evaluate(`(()=>{document.querySelector('[data-testid=modular-workspace]').style.gridTemplateColumns=${JSON.stringify(originalGrid)};return JSON.stringify(true)})()`);
  const selectionProject = JSON.parse(await readFile(await workingProjectPath(), "utf8"));
  assert.equal(selectionProject.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-demo")?.volume, 0.65,
    "Selected clip volume was not applied to the Agent working project");
  await screenshot("agent-selected-clip-edit.png");
  await click('.opencode-dock-selection input');
  assert.equal((await inspect()).selectionChecked, false, "Selected-clip context could not be turned off");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "只回覆已收到。AGENT_SELECTION_OMIT_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  report.checks.selectionOmitted = await waitFor((state) => state.selectionOmitAcknowledged && !state.busy && !state.error,
    30_000, "Opt-out of selected-clip context");
  assert(selectionOmitConfirmed && !probeFailure, probeFailure || "Unchecked clip context leaked into the new prompt");
  await click('.opencode-dock-selection input');
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "請用工具把目前專案改名。AGENT_DRAFT_WRITE_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  await click('[data-testid="agent-dock-collapse"]');
  report.checks.collapsed = await waitFor((state) => state.dockHidden && state.toolbarName === expectedProjectName && !state.error,
    60_000, "Agent edit synchronizes while dock is collapsed");
  await click('[data-testid="toolbar-agent-dock"]');
  report.checks.writeTool = await waitFor((state) => state.writeAcknowledged && state.toolStates.filter((tool) => tool.includes("完成")).length >= 2
    && state.toolbarName === expectedProjectName && state.undoEnabled && !state.reloadNeeded && !state.dockHidden && !state.error, 60_000, "Unsaved project write and editor reload");
  assert(report.checks.writeTool.toolStates.every((state) => !state.includes("editkin_call_editkin_tool")), "Tool cards expose internal gateway names as their title");
  assert(report.checks.writeTool.toolStates.some((state) => state.startsWith("讀取專案摘要")), "Read tool card does not name the actual Editkin action");
  assert(report.checks.writeTool.toolStates.some((state) => state.startsWith("修改時間軸")), "Write tool card does not name the actual Editkin action");
  assert(report.checks.writeTool.toolIntents.includes("要求：重新命名專案"), "Tool card does not summarize the project edit request");
  report.checks.toolEventShape = await evaluate(`(async()=>{const snapshot=await window.haoDesktop.statusOpenCodeAgent(0);return JSON.stringify(snapshot.events.filter(event=>event.kind==='tool').map(event=>({title:event.text,requestedAction:event.requestedAction,status:event.status,detailTypes:(event.details||[]).map(detail=>detail.type)})))})()`);
  assert(writeToolCalled && writeResultConfirmed && !probeFailure, probeFailure || "Write tool was not called through OpenCode");
  report.checks.workingProject = JSON.parse(await readFile(await workingProjectPath(), "utf8"));
  assert.equal(report.checks.workingProject.name, expectedProjectName, "Agent working file was not changed");
  const stagedDemoSource = (await workingProjectPath()).replace(/\.json$/, ".demo-preview.mp4");
  assert.equal(report.checks.workingProject.assets[0].uri, stagedDemoSource,
    "Agent working copy did not stage the demo source inside its authorized workspace");
  report.checks.previewAfterAgentEdit = await waitFor((state) => state.previewReady && !state.previewError, 15_000,
    "Playable demo preview after Agent working-copy reload");
  report.checks.workingProject = { name: report.checks.workingProject.name, revision: report.checks.workingProject.revision };
  await screenshot("agent-draft-edit.png");
  await click('[data-testid="undo-button"]');
  report.checks.undo = await waitFor((state) => state.toolbarName === initialProjectName && !state.reloadNeeded && !state.error, 15_000, "Undo Agent edit");
  await click('textarea[aria-label="傳訊息給 OpenCode Agent"]');
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text: "確認復原後的工作副本。AGENT_DRAFT_RESYNC_PROBE" }, 10_000);
  await click('button[aria-label="傳送訊息"]');
  report.checks.resync = await waitFor((state) => state.resyncAcknowledged && !state.error, 30_000, "Resync undone editor into Agent working copy");
  assert.equal(JSON.parse(await readFile(await workingProjectPath(), "utf8")).assets[0].uri,
    stagedDemoSource,
    "Undo resync restored the broken relative demo source");
  report.checks.permissionFixture = await evaluate(`(async()=>{const api=window.haoDesktop;const original=api.statusOpenCodeAgent;const base=await original(0);const requestId=987654;let emitted=false;api.statusOpenCodeAgent=async(afterSeq)=>{const next=await original(afterSeq);if(!emitted){emitted=true;return {...next,busy:true,seq:next.seq+1,events:[...next.events,{seq:next.seq+1,kind:'permission',requestId,text:'需要檢查剪輯台工具操作',toolKind:'edit',options:[{optionId:'once',name:'允許一次',kind:'allow_once'}]}],pendingPermissionIds:[requestId]};}return {...next,busy:true,pendingPermissionIds:[requestId]};};window.__restoreAgentPermissionReview=()=>{api.statusOpenCodeAgent=original};return JSON.stringify({installed:true,baseSeq:base.seq})})()`);
  report.checks.permission = await waitFor((state) => state.attentionVisible && state.attentionText.includes("查看授權") && state.activityText.includes("等待你確認"), 5_000, "Persistent permission attention");
  await evaluate("(()=>{const node=document.querySelector('.opencode-dock-transcript');node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}));return JSON.stringify(true)})()");
  assert.equal((await inspect()).permissionInView, false, "Permission card was not outside the viewport for the jump review");
  await screenshot("agent-permission-attention.png");
  await click('.opencode-dock-attention button');
  report.checks.permissionJump = await waitFor((state) => state.permissionFocused && state.permissionInView, 5_000, "Permission attention jumps to approval card");
  await evaluate("(()=>{window.__restoreAgentPermissionReview();return JSON.stringify(true)})()");
  await waitFor((state) => !state.attentionVisible, 5_000, "Permission attention cleared");
  const sourceProject = await workingProjectPath();
  const sourceJobs = resolve(dirname(sourceProject), ".editkin-kit-sources/jobs");
  const sourceJobId = "123e4567-e89b-12d3-a456-426614174000";
  await mkdir(sourceJobs, { recursive: true });
  const sourceJob = { schema: "editkin.kit-source-job/v1", id: sourceJobId, project: sourceProject,
    projectSha256: "0".repeat(64), ownerPid: process.pid, requestKey: "0".repeat(64), sources: [],
    input: { command: "create", runId: "ui-progress-fixture" }, status: "PREPARING",
    progress: { phase: "copying", sourceIndex: 1, sourceCount: 1, bytesDone: 150, bytesTotal: 300 },
    updatedAt: new Date().toISOString() };
  await writeFile(resolve(sourceJobs, `${sourceJobId}.json`), JSON.stringify(sourceJob), { flag: "wx" });
  await writeFile(resolve(sourceJobs, "current.json"), JSON.stringify({ id: sourceJobId }), { flag: "wx" });
  report.checks.sourceProgress = await waitFor((state) => state.sourceStatusText.includes("複製素材 · 50%")
    && state.sourceProgressValue === 50 && !state.horizontalOverflow && !state.busy, 5_000, "Source progress in idle Agent dock");
  await screenshot("agent-source-progress.png");
  await click('.opencode-dock-source-status button');
  report.checks.sourceCancel = await waitFor((state) => state.sourceStatusText.includes("正在停止素材準備"), 5_000, "Source preparation cancel request");
  assert.equal((await readFile(resolve(sourceJobs, `${sourceJobId}.cancel`), "utf8")).trim().length > 0, true);
  sourceJob.status = "CREATING";
  await writeFile(resolve(sourceJobs, `${sourceJobId}.json`), JSON.stringify(sourceJob));
  await rm(resolve(sourceJobs, `${sourceJobId}.cancel`), { force: true });
  report.checks.sourceController = await waitFor((state) => state.sourceStatusText.includes("正在建立流程")
    && !state.sourceStatusText.includes("停止") && !state.horizontalOverflow, 5_000, "Controller phase has no cancel button");
  sourceJob.status = "COMPLETED";
  await writeFile(resolve(sourceJobs, `${sourceJobId}.json`), JSON.stringify(sourceJob));
  report.checks.sourceReady = await waitFor((state) => state.sourceStatusText.includes("素材已準備好，可接著剪輯")
    && state.sourceStatusText.includes("接著剪輯") && !state.horizontalOverflow && !state.busy, 5_000,
  "Completed source preparation offers an explicit continuation");
  await screenshot("agent-source-ready.png");
  await click('.opencode-dock-source-status button');
  report.checks.sourceContinuation = await waitFor((state) => !state.sourceStatusVisible
    && state.draftValue.includes("素材準備好了") && !state.draftValue.includes(sourceJobId)
    && !state.draftValue.includes("run_kit_workflow") && !state.busy, 5_000,
  "Continuation drafts a reviewable Agent request without sending it");
  await evaluate(`(()=>{const api=window.haoDesktop, original=api.promptOpenCodeAgent;
    window.__kitContinuationPrompt=null;let attempts=0;
    api.promptOpenCodeAgent=async(...args)=>{window.__kitContinuationPrompt={context:args[1],message:args[2]};
      if(++attempts===1)throw new Error('continuation retry fixture');return api.statusOpenCodeAgent(0)};
    window.__restoreKitContinuation=()=>{api.promptOpenCodeAgent=original};return JSON.stringify(true)})()`);
  await click('button[aria-label="傳送訊息"]');
  report.checks.sourceContinuationRetry = await waitFor((state) => state.error.includes("continuation retry fixture")
    && state.draftValue.includes("素材準備好了") && !state.busy, 5_000,
  "Failed continuation preserves the natural-language draft");
  await click('button[aria-label="傳送訊息"]');
  let capturedContinuation;
  for (let attempt = 0; attempt < 12; attempt++) {
    capturedContinuation = await evaluate("JSON.stringify(window.__kitContinuationPrompt)");
    if (capturedContinuation && !(await inspect()).draftValue) break;
    await delay(400);
  }
  assert(capturedContinuation?.context.includes(sourceJobId), "Continuation lost the preparation ID in Agent context");
  assert(capturedContinuation.context.includes("source-status"));
  assert(!capturedContinuation.message.includes(sourceJobId), "Technical job ID appeared in the visible user message");
  report.checks.sourceContinuationSent = { contextBoundToJob: true, userMessageNatural: true,
    busy: (await inspect()).busy };
  await evaluate("(()=>{window.__restoreKitContinuation();return JSON.stringify(true)})()");
  await evaluate(`(async()=>{const api=window.haoDesktop, original=api.statusOpenCodeAgent;
    const base=await original(0), seq=base.seq+1;let emitted=false;
    api.statusOpenCodeAgent=async(afterSeq)=>{const next=await original(afterSeq);if(!emitted){emitted=true;return {...next,busy:true,seq,
      events:[{seq,kind:'tool',toolCallId:'blocked-transcript-review',text:'執行自動剪輯流程',status:'failed',
        outcome:'必要逐字稿未完成，流程已停止。請設定本機語音辨識器後建立新流程。',
        details:[{type:'text',text:'{"status":"BLOCKED_REQUIRED_TRANSCRIPT"}'}]}]};}
      return {...next,busy:true,seq,events:[]};};
    window.__restoreBlockedKitReview=()=>{api.statusOpenCodeAgent=original};return JSON.stringify(true)})()`);
  report.checks.blockedWorkflow = await waitFor((state) => state.toolOutcomes.some((value) => value.includes("必要逐字稿未完成"))
    && state.toolStates.some((value) => value === "執行自動剪輯流程 · 失敗")
    && state.activityText.includes("流程已停止，Agent 正在整理原因")
    && !state.blockedToolLogOpen && !state.horizontalOverflow,
  5_000, "Blocked transcript has a clear Agent outcome and activity state");
  await screenshot("agent-blocked-transcript.png");
  await evaluate("(()=>{window.__restoreBlockedKitReview();return JSON.stringify(true)})()");
  report.status = "PASS";
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, stateRoot, connected: true, modelVisible: true,
    composerVisible: true, historyVisible: report.checks.history.visible }) + "\n");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.modelAudit = modelAudit;
  if (page) try { await screenshot("agent-failure.png"); } catch { /* Preserve original error. */ }
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  harness.closeCdp();
  await harness.stopOwnedApplication();
  await new Promise((done) => modelServer.close(done));
}

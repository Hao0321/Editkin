// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
// Packaged native caption targeting. Default: deterministic loopback model; --live: saved private LAN model.
// The loopback gate waits for a real selection change before returning the MCP command.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
const live = process.argv.includes("--live");
const cloudApi = process.argv.includes("--cloud-api");
const omniRoute = process.argv.includes("--omniroute");
const pickerReview = process.argv.includes("--provider-picker");
const profileReview = process.argv.includes("--profile-isolation");
const permissionReview = process.argv.includes("--permission-isolation");
const libraryReview = process.argv.includes("--local-library");
assert([cloudApi, live, omniRoute].filter(Boolean).length <= 1, "Cloud/gateway protocol fixtures and live LAN review are separate modes");
const routeModels = ["cc/fixture-claude", "cx/fixture-codex", "gc/fixture-grok", "gemini/fixture-gemini"];
const cloudModel = omniRoute ? `omniroute/${routeModels[0]}` : "openrouter/editkin-caption-api-fixture";
const artifactRoot = resolve("../artifacts/autopilot-desk");
const originalWorkspace = join(artifactRoot, "kit-voiced-prepare-IaRWnn");
const originalRun = join(originalWorkspace, "videos/_AUTOPILOT/editkin-v4/voiced-prepare");
const workflow = JSON.parse(await readFile(join(originalRun, "workflow-state.json"), "utf8"));
const evidencePaths = [join(originalWorkspace, "movie.editkin.json"), join(originalWorkspace, "voiced-source.mp4"),
  join(originalRun, "workflow-state.json"), ...Object.values(workflow.steps).flatMap(step =>
    step.receipt?.path ? [resolve(originalRun, step.receipt.path)] : [])];
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const evidenceBefore = await Promise.all(evidencePaths.map(digest));
const stateRoot = await mkdtemp(join(artifactRoot, live ? "agent-caption-live-" : "agent-caption-review-"));
const projectPath = join(stateRoot, "caption-selection.editkin.json");
const project = JSON.parse(await readFile(evidencePaths[0], "utf8"));
project.id = "agent-caption-isolated-review";
const first = project.captions[0];
assert(first.text.includes("检好"));
const originalText = first.text, correctedText = originalText.replace("检好", "剪好");
const secondText = JSON.parse(await readFile(join(originalWorkspace, "voiced-evidence-report.json"), "utf8")).transcriptCues[1].text;
const secondId = "agent-caption-second-source-cue";
project.captions.push({ id: secondId, text: secondText, start: first.start + first.duration,
  duration: Math.round(0.66 * project.fps) / project.fps });
await writeFile(projectPath, JSON.stringify(project));
const workingPath = async () => {
  const directory = join(stateRoot, "data/agent-working-projects");
  const names = (await readdir(directory)).filter(name => name.endsWith(".editkin.json"));
  const candidates = await Promise.all(names.map(async name => ({ path: join(directory, name),
    project: JSON.parse(await readFile(join(directory, name), "utf8")) })));
  const match = candidates.find(value => value.project.id === project.id);
  assert(match, "Selected-caption project is not bound to the native Agent");
  return match.path;
};
let endpoint, modelServer, receivedTarget = false, selectionSwitched = false, toolCalled = false;
let toolConfirmed = false, omitConfirmed = false, resyncConfirmed = false, schemaCalled = false, schemaConfirmed = false, envelopeSchemaConfirmed = false, guidanceCalled = false, guidanceConfirmed = false, stubError;
const routedProbes = [];
const wireRequests = [];
const estimateTokens = text => { let ascii=0,other=0;for(const c of text){if(c.codePointAt(0)<=127)ascii++;else other++;}return Math.ceil(ascii/4)+other; };
function stream(response, delta, finish_reason = null) {
  response.write(`data: ${JSON.stringify({ id: "caption-selection-review", object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
}
function done(response, content) { stream(response, { role: "assistant", content }); stream(response, {}, "stop"); response.end("data: [DONE]\n\n"); }
if (live) {
  const saved = JSON.parse(await readFile(join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview/local-story/origin.json"), "utf8"));
  const url = new URL(saved.origin);
  assert(url.protocol === "http:" && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname) && url.port && url.pathname === "/");
  endpoint = url.origin;
} else {
  modelServer = httpServer(async (request, response) => {
    try {
      if (omniRoute && request.method === "GET") {
        if (request.url === "/blocked/v1/models") { response.writeHead(401, {"content-type":"application/json"}); response.end(JSON.stringify({error:"isolated-fixture-private-body"})); return; }
        assert.equal(request.url, "/v1/models"); response.writeHead(200, {"content-type":"application/json"});
        response.end(JSON.stringify({ object: "list", data: [...routeModels.map(id => ({ id, capabilities: {tool_calling:true}, context_length:32000, max_output_tokens:4096 })),
          { id:"chat-only", capabilities:{tool_calling:false} }, { id:"unknown-tools" }] })); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size <= 8_000_000); chunks.push(chunk); }
      assert.equal(request.method, "POST");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert(!JSON.stringify(body.messages || []).includes("urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d"), "Contribution identity entered model context");
      if (JSON.stringify(body.messages || []).includes('PERSONAL_LIBRARY_RULE:')) report.checks.personalRuleReachedSelectedProvider = true;
      const userContent = [...(body.messages || [])].reverse().find(item => item.role === "user")?.content || "";
      const prompt = JSON.stringify(userContent);
      const userText = typeof userContent === "string" ? userContent
        : Array.isArray(userContent) ? userContent.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      if(body.tools?.length)wireRequests.push({latestUserEstimatedTokens:estimateTokens(userText),messagesEstimatedTokens:estimateTokens(JSON.stringify(body.messages||[])),toolSchemasEstimatedTokens:estimateTokens(JSON.stringify(body.tools)),briefingIncluded:userText.includes('editkin.session-briefing/v1'),systemBriefingCount:(JSON.stringify((body.messages||[]).filter(m=>m.role==='system')).match(/editkin.session-briefing\/v1/g)||[]).length,phase:prompt.includes('CAPTION_EDIT_PROBE')?'edit':prompt.includes('CAPTION_RESYNC_PROBE')?'resync':prompt.includes('CAPTION_OMIT_PROBE')?'optout':'other'});
      const toolNames = (body.tools || []).map(item => item.function?.name || item.name).filter(Boolean);
      if (cloudApi && toolNames.length) assert.equal(body.model, "editkin-caption-api-fixture", "Native cloud adapter must send the selected provider model ID");
      if (omniRoute && toolNames.length) assert(routeModels.includes(body.model), "Native gateway adapter lost a nested route prefix");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // OpenCode's title-generation request also includes the user text, but has no MCP tools.
      if (!toolNames.length) { done(response, "字幕校對"); return; }
      assert(toolNames.every(name=>name.startsWith('editkin_')), 'Integrated editing profile exposed unrelated programming tools');
      assert.equal(wireRequests.at(-1).systemBriefingCount,1,'Integrated system briefing must survive every request/session reload');
      assert(!wireRequests.at(-1).briefingIncluded,'Standing briefing duplicated into user conversation history');
      if (omniRoute && prompt.includes("OMNI_WINDOW_PROBE:")) {
        assert(prompt.includes(`OMNI_WINDOW_PROBE:${body.model}`)); routedProbes.push(body.model); done(response, `OMNI_WINDOW_OK:${body.model}`); return;
      }
      const callSchema = body.tools.find(item => item.function?.name.endsWith("call_editkin_tool"))?.function.parameters;
      assert.equal(callSchema?.properties?.arguments?.properties?.projectPath?.type, "string", "Native model tool schema must expose arguments.projectPath");
      assert.equal(callSchema?.properties?.arguments?.additionalProperties, true, "Generic gateway must preserve other native tool arguments");
      envelopeSchemaConfirmed = true;
      if (prompt.includes("CAPTION_OMIT_PROBE")) {
        assert(!prompt.includes("目前剪輯台選取") && !prompt.includes(first.id) && !prompt.includes(secondId), "Unchecked subtitle reference leaked");
        omitConfirmed = true; done(response, "CAPTION_OMIT_OK"); return;
      }
      if (prompt.includes("CAPTION_RESYNC_PROBE")) {
        const value = JSON.parse(await readFile(await workingPath(), "utf8"));
        assert.equal(value.captions.find(cue => cue.id === first.id).text, originalText, "Undo was not synchronized into the Agent copy");
        resyncConfirmed = true; done(response, "CAPTION_RESYNC_OK"); return;
      }
      if (!prompt.includes("CAPTION_EDIT_PROBE")) { done(response, "待命"); return; }
      if (!toolCalled) {
        const path = await workingPath();
        assert(prompt.includes("目前剪輯台選取") && prompt.includes(first.id) && prompt.includes(originalText) && !prompt.includes(secondId), "Caption ID or text missing from submitted selection");
        assert(userText.includes('"projectPath":'+JSON.stringify(path)), "Complete caption envelope must include the exact current working path");
        assert(userText.includes(JSON.stringify({ type: "update_caption", captionId: first.id, patch: { text: correctedText } })),
          "Exact requested correction must preserve all other caption text and punctuation");
        receivedTarget = true;
        const deadline = Date.now() + 20_000;
        while (!selectionSwitched && Date.now() < deadline) await delay(100);
        assert(selectionSwitched, "Review did not switch selection before the model edit");
        if (!guidanceCalled) {
          const name=toolNames.find(name=>name.endsWith('get_editkin_task_guidance'));
          assert(name,'Native task guidance tool missing');guidanceCalled=true;
          stream(response,{role:'assistant',tool_calls:[{index:0,id:'task-guidance-call',type:'function',function:{name,arguments:JSON.stringify({task:'edit'})}}]});
          stream(response,{},'tool_calls');response.end('data: [DONE]\n\n');return;
        }
        if (!schemaCalled) {
          const result=JSON.stringify([...(body.messages||[])].reverse().find(item=>item.role==='tool')?.content||'');
          assert(result.includes('editkin.task-guidance/v1')&&result.includes('submitted captionId/clipId')&&result.length<5000);
          guidanceConfirmed=true;
        }
        if (!schemaCalled) {
          const name = toolNames.find(name => name.endsWith("inspect_editkin_tool"));
          assert(name, "Command-specific native schema tool missing");
          schemaCalled = true;
          stream(response, { role: "assistant", tool_calls: [{ index: 0, id: "caption-schema-call", type: "function",
            function: { name, arguments: JSON.stringify({ name: "apply_edit_commands", commandType: "update_caption" }) } }] });
          stream(response, {}, "tool_calls"); response.end("data: [DONE]\n\n"); return;
        }
        const schemaResult = JSON.stringify([...(body.messages || [])].reverse().find(item => item.role === "tool")?.content || "");
        assert(schemaResult.includes("update_caption") && schemaResult.includes("patch") && schemaResult.includes("commandType")
          && !schemaResult.includes("import_asset") && schemaResult.length < 5000, "Native command-specific query did not return a compact real caption schema");
        schemaConfirmed = true;
        const name = toolNames.find(name => name.endsWith("call_editkin_tool"));
        assert(name, "Native MCP gateway missing");
        toolCalled = true;
        stream(response, { role: "assistant", tool_calls: [{ index: 0, id: "caption-target-call", type: "function",
          function: { name, arguments: JSON.stringify({ name: "apply_edit_commands", arguments: {
            projectPath: await workingPath(), commands: [{ type: "update_caption", captionId: first.id, patch: { text: correctedText } }] } }) } }] });
        stream(response, {}, "tool_calls"); response.end("data: [DONE]\n\n"); return;
      }
      const result = JSON.stringify([...(body.messages || [])].reverse().find(item => item.role === "tool")?.content || "");
      assert(result.includes("GREEN") && result.includes("appliedCommandCount"), "Native caption command failed");
      toolConfirmed = true; done(response, "已把這句字幕的「检好」校對為「剪好」。");
    } catch (error) { stubError = error.message; response.end(); }
  });
  await new Promise((done, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", done); });
  endpoint = `http://127.0.0.1:${modelServer.address().port}`;
}
await mkdir(join(stateRoot, "data/local-story"), { recursive: true });
await writeFile(join(stateRoot, "data/local-story/origin.json"), JSON.stringify({ origin: endpoint }));
const cloudConfig = join(stateRoot, "cloud-api-fixture.json");
if (cloudApi || profileReview || permissionReview) await writeFile(cloudConfig, JSON.stringify({ $schema: "https://opencode.ai/config.json", autoupdate: false,
  ...((profileReview || permissionReview) ? { agent: {
    ...(profileReview ? { "external-fixture": { mode: "primary", description: "Isolated non-editing fixture", permission: { "*": "allow" } } } : {}),
    ...(permissionReview ? Object.fromEntries(['editkin','build','plan'].map(name => [name, { permission: { '*':'allow', bash:'allow', read:'allow', edit:'allow', task:'allow', skill:'allow', webfetch:'allow' } }])) : {}),
  } } : {}),
  ...(cloudApi ? { provider: { openrouter: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${endpoint}/v1`, apiKey: "isolated-fixture-only" },
    models: { "editkin-caption-api-fixture": { name: "OpenRouter protocol fixture", limit: { context: 32000, output: 4096 } } } } } } : {}) }));
const port = await new Promise((done, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
});
const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, EDITKIN_INTEGRATION_SMOKE: "1", EDITKIN_INTEGRATION_STATE_ROOT: stateRoot,
    ...(cloudApi || profileReview || permissionReview ? { OPENCODE_CONFIG: cloudConfig } : {}),
    WEBVIEW2_USER_DATA_FOLDER: join(stateRoot, "webview2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
child.stdout.resume(); child.stderr.resume();
const harness = createTauriCdpHarness({ child, port, startupPollMs: 250, startupInteractiveTimeoutMs: 50_000, startupInteractiveAttempts: 200 });
const report = { status: "BLOCK", live, cloudApi, omniRoute, pickerReview, profileReview, permissionReview, stateRoot, appPid: child.pid, executable, checks: {} };
let page;
const evaluate = code => harness.evaluate(page.webSocketDebuggerUrl, code, 10_000);
const cueSelector = id => `[data-testid="timeline-caption-${id}"]`;
const inspect = () => evaluate(`(async()=>{const s=window.haoDesktop?await window.haoDesktop.statusOpenCodeAgent(0):{};
  return JSON.stringify({ready:!!document.querySelector('[data-testid=new-project-button]'),connected:s.connected,busy:s.busy,sessionId:s.sessionId,
    internalEntry:!!document.querySelector('[data-testid=use-internal-agent]'),externalEntry:!!document.querySelector('[data-testid=connect-codex-button]'),
    projectPath:s.projectPath,model:document.querySelector('.opencode-dock-compose-model select')?.value,
    source:document.querySelector('select[aria-label="Agent 來源"]')?.value,
    sourceLoading:document.querySelector('.opencode-dock-model-menu>summary')?.textContent.includes('確認中'),
    nativeModel:s.configOptions?.find(option=>option.id==='model')?.currentValue,
    modelDisabled:document.querySelector('.opencode-dock-compose-model select')?.disabled,
    sourceDisabled:document.querySelector('select[aria-label="Agent 來源"]')?.disabled,
    sourceNotice:document.querySelector('[aria-label="Agent 來源提示"]')?.textContent,
    label:document.querySelector('.opencode-dock-selection')?.textContent,checked:document.querySelector('.opencode-dock-selection input')?.checked,
    firstText:document.querySelector(${JSON.stringify(cueSelector(first.id))}+' strong')?.textContent,
    secondText:document.querySelector(${JSON.stringify(cueSelector(secondId))}+' strong')?.textContent,
    secondSelected:!!document.querySelector(${JSON.stringify(cueSelector(secondId))}+'.selected'),
    undoEnabled:!document.querySelector('[data-testid=undo-button]')?.disabled,
    dockOpen:!document.querySelector('[data-testid=editor-agent-dock]')?.hidden,
    answer:[...document.querySelectorAll('.opencode-dock-entry.kind-message .opencode-dock-markdown')].map(n=>n.textContent).join(' '),
    error:!!document.querySelector('.opencode-dock-error')?.textContent?.trim(),
    events:(s.events||[]).map(e=>({kind:e.kind,text:e.kind==='tool'?e.text:undefined,status:e.status,projectChanged:e.projectChanged,
      requestedAction:e.requestedAction,details:e.kind==='tool'?(e.details||[]).filter(d=>d.type==='text').map(d=>d.text.slice(0,1800)):undefined,
      green:e.kind==='tool'?(e.details||[]).some(d=>d.type==='text'&&d.text.includes('GREEN')):undefined}))})})()`);
async function waitFor(predicate, label, timeout = 25_000, requireCompletedResult = false) {
  const deadline = Date.now() + timeout; let last, finishedAt;
  while (Date.now() < deadline) {
    last = await inspect(); if (predicate(last)) return last; if (stubError) throw Error(stubError);
    if (requireCompletedResult && !last.busy && last.events?.some(e => e.kind === "turn")) {
      finishedAt ??= Date.now();
      if (Date.now() - finishedAt > 10_000) break; // Allow the genuine asynchronous editor reload, then preserve mismatched results.
    }
    await delay(200);
  }
  report.lastObserved = JSON.parse(JSON.stringify(last).replaceAll(endpoint, "<model-origin>"));
  throw Error(`${label} timed out: busy=${last?.busy}, model=${last?.model}, tool statuses=${last?.events?.filter(e=>e.kind==='tool').map(e=>e.status).join(',')}`);
}
const click = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Control unavailable');n.click();return JSON.stringify(true)})()`);
async function send(text) {
  await evaluate("(()=>{document.querySelector('textarea[aria-label=\"傳訊息給 Agent\"]').focus();return JSON.stringify(true)})()");
  await harness.cdpCommand(page.webSocketDebuggerUrl, "Input.insertText", { text });
  const deadline=Date.now()+8_000;let controls;
  while(Date.now()<deadline){controls=await evaluate(`(()=>{return JSON.stringify({draft:document.querySelector('textarea[aria-label="傳訊息給 Agent"]')?.value,disabled:document.querySelector('button[aria-label="傳送訊息"]')?.disabled,source:document.querySelector('select[aria-label="Agent 來源"]')?.value,model:document.querySelector('select[aria-label="Agent 模型"]')?.value,notice:document.querySelector('[aria-label="Agent 來源提示"]')?.textContent})})()`);if(controls.draft.trim()&&!controls.disabled)break;await delay(100);}
  if(controls.disabled){report.blockedComposer={controls,snapshot:await inspect()};throw Error('Composer did not become ready for explicit selected model');}
  await click('button[aria-label="傳送訊息"]');
}
async function chooseSource(source) {
  await waitFor(s=>!s.sourceDisabled&&!s.busy,'Source control ready after provider discovery');
  await evaluate(`(()=>{document.querySelector('.opencode-dock-model-menu').open=true;return JSON.stringify(true)})()`);
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="Agent 來源"]');if(!select||select.disabled)throw Error('Source control unavailable');select.value=${JSON.stringify(source)};select.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`);
  return waitFor(s=>s.source===source&&!s.sourceLoading,'Source category ready');
}
async function chooseModel(model) {
  await waitFor(s=>!s.busy&&!s.modelDisabled,'Model control unlocked after previous turn');
  await evaluate(`(()=>{document.querySelector('.opencode-dock-model-menu').open=true;return JSON.stringify(true)})()`);
  await evaluate(`(()=>{const select=document.querySelector('.opencode-dock-compose-model select');if(select.disabled||![...select.options].some(option=>option.value===${JSON.stringify(model)}))throw Error('Selected source model unavailable');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`);
  return waitFor(s=>s.model===model&&s.nativeModel===model&&!s.busy&&!s.modelDisabled,'Source model selected and native configuration complete');
}
async function checkAgentLabels() {
  const labels=await evaluate(`(()=>{const root=document.querySelector('.agent-dock');return JSON.stringify({text:root?.innerText||document.querySelector('.opencode-dock')?.innerText||'',labels:[...document.querySelectorAll('.agent-dock [aria-label],.agent-dock [title],.opencode-dock [aria-label],.opencode-dock [title]')].filter(n=>n.getClientRects().length).map(n=>[n.getAttribute('aria-label'),n.getAttribute('title')].filter(Boolean).join(' ')).join(' ')})})()`);
  assert(!/open\s*code/iu.test(labels.text+' '+labels.labels),'Runtime branding remains in visible Agent labels');
}
try {
  page = await harness.target();
  await waitFor(s => s.ready, "Editor ready");
  // Open an unsaved isolated copy so native working-copy synchronization, including Undo, is exercised.
  await evaluate(`(()=>{window.haoDesktop.openProject=async()=>({...await window.haoDesktop.reloadProjectFromPath(${JSON.stringify(projectPath)}),path:undefined});const m=document.querySelector('.project-menu');m.open=true;m.querySelector('.project-menu-group').open=true;return JSON.stringify(true)})()`);
  await click('[data-testid="open-project-button"]');
  await waitFor(s => s.firstText === originalText && s.secondText === secondText, "Two source captions opened");
  await click(cueSelector(first.id));
  await evaluate(`(()=>{document.querySelector('.project-menu').open=true;return JSON.stringify(true)})()`);
  await click('[data-testid="open-agent-connect-button"]');
  await waitFor(s=>s.internalEntry&&!s.externalEntry,'Internal Agent entry loaded');
  const defaultModal=await evaluate(`(()=>{const root=document.querySelector('[data-testid=agent-connect-modal]'),r=root.getBoundingClientRect();return JSON.stringify({internal:!!root.querySelector('[data-testid=use-internal-agent]'),externalChoices:!!root.querySelector('[data-testid=connect-codex-button]'),visible:r.top>=0&&r.bottom<=window.innerHeight&&r.left>=0&&r.right<=window.innerWidth,overflow:root.scrollWidth>root.clientWidth+1})})()`);
  assert(defaultModal.internal&&!defaultModal.externalChoices&&defaultModal.visible&&!defaultModal.overflow);
  await click('[data-testid=advanced-external-agent]');
  await waitFor(s=>s.externalEntry&&!s.internalEntry,'Advanced external entry loaded');
  assert(await evaluate(`(()=>{return JSON.stringify(!!document.querySelector('[data-testid=connect-codex-button]'))})()`));
  await evaluate(`(()=>{[...document.querySelectorAll('.agent-connect-modal button')].find(b=>b.textContent==='返回內建 Agent').click();return JSON.stringify(true)})()`);
  await waitFor(s=>s.internalEntry&&!s.externalEntry,'Internal entry restored');
  await click('[data-testid=use-internal-agent]');
  report.entryChecks={defaultInternal:true,externalOnlyAdvanced:true,sameAgentDock:true,modalVisible:true,noHorizontalOverflow:true};
  let expectedBinding;
  const bindingDeadline = Date.now() + 30_000;
  while (Date.now() < bindingDeadline) {
    try { expectedBinding = await workingPath(); break; }
    catch (error) { if (!['ENOENT', 'ERR_ASSERTION'].includes(error.code)) throw error; await delay(100); }
  }
  assert(expectedBinding, 'Selected project working copy was not created');
  let initial = await waitFor(s => s.connected && s.projectPath === expectedBinding && s.model && s.checked && s.label?.includes("引用字幕"), "Agent bound to selected caption project", 60_000);
  const expectedProvenance = JSON.parse(await readFile(resolve("src/shared/agentProvenance.json"), "utf8"));
  const packagedManifest = JSON.parse(await readFile(join(dirname(executable), "resources/licenses/AGENT-PROVENANCE.json"), "utf8"));
  const nativeProvenance = await evaluate(`(async()=>{return JSON.stringify((await window.haoDesktop.statusOpenCodeAgent(0)).provenance)})()`);
  assert.deepEqual(nativeProvenance, expectedProvenance);
  assert.equal(packagedManifest.sourceDigest, nativeProvenance.sourceDigest);
  for (const name of ["AGPL-3.0-or-later.txt", "GPL-3.0-or-later.txt", "AGENT-NOTICE.md"]) {
    assert((await readFile(join(dirname(executable), "resources/licenses", name), "utf8")).length > 100);
  }
  const provenanceUi = await evaluate(`(()=>{const n=document.querySelector('[data-testid="agent-provenance"]');let closed=0;for(let p=n?.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS'&&!p.open)closed++;return JSON.stringify({present:!!n,hidden:closed>0,closedAncestors:closed,text:n?.textContent})})()`);
  report.provenanceUi = provenanceUi;
  assert(provenanceUi.present && provenanceUi.hidden, "Contribution notice expanded the default composer");
  assert(provenanceUi.text.includes(expectedProvenance.attribution) && provenanceUi.text.includes(expectedProvenance.sourceDigest.slice(0,12)));
  report.provenance = { ...nativeProvenance, packagedNotice: true, hiddenByDefault: true };
  if (profileReview) {
    const profile = await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0),o=s.configOptions.find(o=>o.category==='mode'||o.id==='mode');if(!o?.options.some(v=>v.value==='external-fixture'))throw Error('Synthetic custom profile not loaded');let rejected=false;try{await window.haoDesktop.setOpenCodeAgentConfig(o.id,'external-fixture')}catch{rejected=true}const next=await window.haoDesktop.statusOpenCodeAgent(0);return JSON.stringify({rejected,sameSession:next.sessionId===s.sessionId,mode:next.configOptions.find(v=>v.id===o.id)?.currentValue})})()`);
    report.profileIsolation = profile;
    assert(profile.rejected, 'Integrated Agent accepted a non-editing custom profile');
    assert(profile.sameSession && ['editkin','build','plan'].includes(profile.mode), 'Rejected mode changed the editing session');
  }
  if(pickerReview){
    assert.equal(initial.source,'local');
    const picker=await evaluate(`(()=>{const root=document.querySelector('.opencode-dock-model-picker');return JSON.stringify({sources:[...root.querySelector('select[aria-label="Agent 來源"]').options].map(o=>({id:o.value,name:o.textContent})),models:[...root.querySelector('select[aria-label="Agent 模型"]').options].map(o=>o.value),loginVisible:[...document.querySelectorAll('.opencode-provider-login,input[type=password]')].some(n=>n.getClientRects().length),width:window.innerWidth,height:window.innerHeight})})()`);
    assert.deepEqual(picker.sources.map(s=>s.id),['local','openai','anthropic','google','xai','openrouter','deepseek','omniroute']);
    assert(await evaluate(`(()=>{return JSON.stringify(!document.querySelector('.opencode-dock-model-menu').open)})()`),'Large model form is expanded by default');
    assert(!picker.sources.some(s=>/登入|API/.test(s.name)));assert(!picker.loginVisible);
    assert(picker.models.every(id=>/^(pny|ollama|local|lmstudio|vllm)\//i.test(id)),'Local category contains unrelated cloud models');
    const nativeCatalog=await evaluate(`(async()=>{return JSON.stringify(await window.haoDesktop.openCodeAgentProvider({action:'list'}))})()`);
    const missing=nativeCatalog.providers.find(p=>p.id!=='omniroute'&&!p.configured);
    assert(missing,'Fixture has no unconfigured provider to verify the settings prompt');
    const beforeHash=await digest(await workingPath());
    await evaluate(`(()=>{const api=window.haoDesktop,original=api.promptOpenCodeAgent;window.__pickerAttempts=0;api.promptOpenCodeAgent=(...args)=>{window.__pickerAttempts++;return original(...args)};window.__pickerRestore=()=>{api.promptOpenCodeAgent=original};return JSON.stringify(true)})()`);
    const missingState=await chooseSource(missing.id);
    assert(missingState.modelDisabled&&missingState.sourceNotice.includes('尚未設定'));
    assert.equal(missingState.nativeModel,initial.model);assert.equal(missingState.sessionId,initial.sessionId);
    await evaluate(`(()=>{document.querySelector('textarea[aria-label="傳訊息給 Agent"]').focus();return JSON.stringify(true)})()`);
    await harness.cdpCommand(page.webSocketDebuggerUrl,'Input.insertText',{text:'PROVIDER_PICKER_DO_NOT_SEND'});
    await harness.cdpCommand(page.webSocketDebuggerUrl,'Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await harness.cdpCommand(page.webSocketDebuggerUrl,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await delay(300);
    assert.equal(await evaluate(`(()=>{return JSON.stringify(window.__pickerAttempts)})()`),0,'Selecting an unconfigured source sent to the previous model');
    assert(await evaluate(`(()=>{return JSON.stringify(document.querySelector('button[aria-label="傳送訊息"]').disabled)})()`));
    await evaluate(`(()=>{document.querySelector('[aria-label="Agent 來源提示"] button').click();return JSON.stringify(true)})()`);
    const deadline=Date.now()+20_000;let settings;
    while(Date.now()<deadline){settings=await evaluate(`(()=>{return JSON.stringify({open:document.querySelector('.opencode-dock-more').open,provider:document.querySelector('select[aria-label="Agent 供應商"]')?.value,keyVisible:!!document.querySelector('input[aria-label="Agent API 金鑰"]')?.getClientRects().length})})()`);if(settings.open&&settings.provider===missing.id&&settings.keyVisible)break;await delay(200);}
    assert(settings.open&&settings.provider===missing.id&&settings.keyVisible,'Settings did not open the requested source');
    const missingShot=await harness.cdpCommand(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});await writeFile(join(stateRoot,'agent-source-settings.png'),Buffer.from(missingShot.data,'base64'));
    await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=false;window.__pickerRestore();const n=document.querySelector('textarea[aria-label="傳訊息給 Agent"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'');n.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()`);
    await chooseSource('local');
    await evaluate(`(()=>{document.querySelector('.opencode-dock-model-help button').click();return JSON.stringify(true)})()`);
    assert((await inspect()).sourceNotice.includes('未列入支援大項'));
    await chooseSource('local');assert.equal(await digest(await workingPath()),beforeHash);
    await evaluate(`(()=>{document.querySelector('.opencode-dock-model-menu').open=false;return JSON.stringify(true)})()`);
    await delay(150);
    await harness.cdpCommand(page.webSocketDebuggerUrl,'Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
    await delay(200);
    const layout=await evaluate(`(()=>{const root=document.querySelector('.opencode-dock-model-picker'),r=root.getBoundingClientRect(),compose=document.querySelector('.opencode-dock-compose');return JSON.stringify({visible:r.top>=0&&r.bottom<=window.innerHeight&&r.left>=0&&r.right<=window.innerWidth,overflow:root.scrollWidth>root.clientWidth+1,composerHeight:compose.getBoundingClientRect().height,popoverHidden:!root.querySelector('.opencode-dock-model-popover').getClientRects().length,labels:[...root.querySelectorAll('label')].map(n=>n.firstChild.textContent)})})()`);
    assert(layout.visible&&!layout.overflow);assert.deepEqual(layout.labels,['來源','模型']);
    assert(layout.popoverHidden&&layout.composerHeight<=135,'Model settings still occupy the default conversation layout');
    const shot=await harness.cdpCommand(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});await writeFile(join(stateRoot,'agent-model-picker.png'),Buffer.from(shot.data,'base64'));
    report.pickerChecks={eightMainSources:true,providerFirst:true,sourceScopedModels:true,loginOnlyInSettings:true,missingProvider:missing.id,missingShowsSettings:true,settingsTargetsSelectedSource:true,missingBlocksButtonAndEnter:true,previousNativeModelAndSessionPreserved:true,unlistedSourceHint:true,noProjectChange:true,layoutVisible:true,noHorizontalOverflow:true,compactCollapsedPicker:true,composerHeight:layout.composerHeight,viewport:{width:1280,height:720}};
  }
  if (cloudApi || omniRoute) {
    if (cloudApi) {
      await chooseSource('openrouter');
      initial = await chooseModel(cloudModel);
    }
    const providers = await evaluate(`(async()=>{const result=await window.haoDesktop.openCodeAgentProvider({action:'list'});return JSON.stringify(result)})()`);
    assert.equal(providers.providers.length, 7);
    assert(providers.providers.find(provider => provider.id === "openai").authMethods.some(method => method.type === "oauth" && /(headless|device)/iu.test(method.label)));
    const browserMethod = providers.providers.find(provider => provider.id === "openai").authMethods.find(method => method.type === "oauth").index;
    const pendingLogin = await evaluate(`(async()=>{return JSON.stringify(await window.haoDesktop.openCodeAgentProvider({action:'start-login',providerId:'openai',method:${browserMethod}}))})()`);
    assert.equal(pendingLogin.login.status,"waiting");assert(!JSON.stringify(pendingLogin).includes("auth.openai.com"),"OAuth URL entered renderer state");
    const cancelledLogin = await evaluate(`(async()=>{return JSON.stringify(await window.haoDesktop.openCodeAgentProvider({action:'cancel-login',attemptId:${JSON.stringify(pendingLogin.login.id)}}))})()`);
    assert.equal(cancelledLogin.login.status,"cancelled");
    assert((await inspect()).connected,"Cancelling provider login closed the ACP editing session");
    await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=true;const section=[...document.querySelectorAll('.opencode-dock-menu-section')].find(section=>section.querySelector('summary')?.textContent.includes('模型供應商'));section.open=true;return JSON.stringify(true)})()`);
    await delay(200);
    await evaluate(`(()=>{const select=document.querySelector('select[aria-label="Agent 供應商"]');select.value='openai';select.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`);
    const panelDeadline = Date.now()+20_000; let panel;
    while (Date.now()<panelDeadline) { panel=await evaluate(`(()=>{const root=document.querySelector('.opencode-provider-settings');return JSON.stringify({providers:root?.querySelector('select')?.options.length,password:root?.querySelector('input[aria-label="Agent API 金鑰"]')?.type,keyEmpty:root?.querySelector('input[aria-label="Agent API 金鑰"]')?.value==='',login:[...(root?.querySelectorAll('button')||[])].some(button=>button.textContent==='Continue with ChatGPT')})})()`);if(panel.providers===7&&panel.login)break;await delay(200); }
    assert.equal(panel.providers,7);assert.equal(panel.password,"password");assert(panel.keyEmpty&&panel.login);
    await checkAgentLabels();
    if (omniRoute) {
      const previousSession = initial.sessionId;
      await evaluate(`(()=>{const select=document.querySelector('select[aria-label="Agent 供應商"]');select.value='omniroute';select.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`);
      await delay(200);
      await evaluate(`(()=>{const input=document.querySelector('input[aria-label="OmniRoute 位址"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(endpoint + "/v1/")});input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()`);
      await delay(200); await click('.opencode-gateway-settings button[type=submit]');
      const configuredPath=join(stateRoot,"data/agent-providers/omniroute.opencode.json"); const configDeadline=Date.now()+25_000;
      while(Date.now()<configDeadline){try{await readFile(configuredPath);break;}catch{await delay(200);}}
      const configuredText=await readFile(configuredPath,"utf8"), configured=JSON.parse(configuredText);
      assert.equal(configured.provider.omniroute.options.baseURL,endpoint+"/v1");
      assert.deepEqual(Object.keys(configured.provider.omniroute.models),routeModels);
      assert(!configuredText.includes("apiKey"));
      const gated=await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0);let rejected=false;try{await window.haoDesktop.promptOpenCodeAgent(s.projectPath,'Gateway refresh gate probe')}catch{rejected=true}return JSON.stringify({rejected,requires:s.providerReconnectRequired})})()`);
      assert(gated.rejected&&gated.requires,"Backend accepted a prompt with stale provider config");
      await evaluate(`(()=>{const button=[...document.querySelectorAll('.opencode-provider-settings button')].find(button=>button.textContent==='更新模型清單');if(!button||button.disabled)throw Error('Refresh control not ready');button.click();return JSON.stringify(true)})()`);
      await waitFor(s=>s.connected&&s.sessionId===previousSession&&!s.busy,"Same conversation rebound with gateway models",60_000);
      await chooseSource('omniroute');
      const modelDeadline=Date.now()+10_000;let ids=[];
      while(Date.now()<modelDeadline){ids=await evaluate(`(()=>{return JSON.stringify([...document.querySelector('.opencode-dock-compose-model select').options].map(o=>o.value))})()`);if(routeModels.every(id=>ids.includes('omniroute/'+id)))break;await delay(200);}
      assert(routeModels.every(id=>ids.includes('omniroute/'+id)),"Gateway models absent from the shared selector");
      assert(!ids.includes('omniroute/chat-only')&&!ids.includes('omniroute/unknown-tools'));
      for(const route of routeModels){
        const id='omniroute/'+route;
        await chooseModel(id);
        await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=false;return JSON.stringify(true)})()`);
        await send('只回覆收到，不要剪輯。 OMNI_WINDOW_PROBE:'+route);
        const result=await waitFor(s=>!s.busy&&s.answer.includes('OMNI_WINDOW_OK:'+route),'Same-window route response');
        assert.equal(result.sessionId,previousSession); assert.equal(result.firstText,originalText);
      }
      assert.deepEqual(routedProbes,routeModels);
      const savedHash=await digest(configuredPath);let failed=false;
      try{await evaluate(`(async()=>{return JSON.stringify(await window.haoDesktop.openCodeAgentProvider({action:'connect-gateway',baseURL:${JSON.stringify(endpoint+'/blocked')}}))})()`);}catch{failed=true;}
      assert(failed);assert.equal(await digest(configuredPath),savedHash,"Failed catalog replaced a healthy gateway config");
      initial=await chooseModel(cloudModel);
      report.gatewayChecks={sharedConversationAcrossFourRoutes:true,routes:routeModels,exactModelPrefixes:true,toolCapabilityGate:true,configurationRefreshGate:true,failedCatalogPreservesConfiguration:true,noKeyInConfig:true,realGatewayOrAccountsVerified:false};
    }
    const settingsShot=await harness.cdpCommand(page.webSocketDebuggerUrl,"Page.captureScreenshot",{format:"png"});await writeFile(join(stateRoot,"agent-provider-settings.png"),Buffer.from(settingsShot.data,"base64"));
    await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=false;return JSON.stringify(true)})()`);
    report.cloudProviderChecks={nativeProviderCatalog:true,sixProvidersVisible:true,maskedEmptyKey:true,nativeChatGptDeviceMethod:true,nativeOAuthStartedAndCancelled:true,noAuthUrlInRenderer:true,editingSessionPreserved:true,cloudModelSelected:true,model:cloudModel,realAccountLoginOrBillingTested:false};
  }
  assert(initial.label.includes(originalText.replace(/\s+/gu, " ").slice(0, 48)));
  if (!live && !cloudApi && !omniRoute) {
    const alias = await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0),option=s.configOptions.find(o=>o.category==='mode'||o.id==='mode');if(!option?.options.some(o=>o.value==='build'))throw Error('Legacy build profile missing');const next=await window.haoDesktop.setOpenCodeAgentConfig(option.id,'build');return JSON.stringify({sessionId:next.sessionId,mode:next.configOptions.find(o=>o.id===option.id)?.currentValue})})()`);
    assert.equal(alias.sessionId,initial.sessionId);assert.equal(alias.mode,'build');
    report.legacySessionChecks={buildAvailable:true,sameConversation:true};
  }
  const working = await workingPath(), before = JSON.parse(await readFile(working, "utf8"));
  process.stdout.write(JSON.stringify({ stage: "caption_ready", live, appPid: child.pid }) + "\n");
  const started = Date.now();
  await send(`請把這句字幕的「检好」改成「剪好」，只校對這個字詞，完成後用繁體中文簡短回覆。${live ? "" : " CAPTION_EDIT_PROBE"}`);
  await waitFor(s => live ? s.busy : receivedTarget, "Submitted caption target", 20_000);
  await click(cueSelector(secondId));
  await waitFor(s => s.secondSelected && !s.dockOpen, "Selection switched while Agent pending");
  selectionSwitched = true;
  await click('[data-testid="toolbar-agent-dock"]');
  const edited = await waitFor(s => !s.busy && s.firstText === correctedText && s.answer.includes("剪好") && s.undoEnabled && !s.error,
    "Native Agent corrected the submitted caption", live ? 300_000 : 45_000, true);
  report.diagnostics = { events: JSON.parse(JSON.stringify(edited.events).replaceAll(endpoint, "<model-origin>")) };
  const writes = edited.events.filter(e => e.kind === "tool" && e.text === "修改時間軸");
  report.diagnostics.writeAttempts = writes.length;
  report.diagnostics.successfulWrites = writes.filter(e => e.status === "completed" && e.green).length;
  report.diagnostics.failedWriteAttempts = writes.filter(e => e.status === "failed").length;
  assert.equal(writes.length, 1, "Caption command attempted more than once (including rejected attempts)");
  assert(writes[0].status === "completed" && writes[0].green);
  assert(!edited.events.some(e => e.kind === "tool" && (e.status === "failed" || ["執行自動剪輯流程", "套用自動剪輯計畫", "輸出影片"].includes(e.text))));
  assert.equal(edited.secondText, secondText);
  const after = JSON.parse(await readFile(working, "utf8"));
  assert.equal(after.captions.find(cue => cue.id === first.id).text, correctedText);
  after.captions.find(cue => cue.id === first.id).text = originalText;
  after.revision = before.revision; after.updatedAt = before.updatedAt;
  assert.deepEqual(after, before, "Agent changed fields beyond one submitted caption");
  report.checks = { submittedCaptionOnly: true, switchedSelection: true, oneSuccessfulEdit: true, otherFieldsUnchanged: true,
    userAnswerVisible: true, model: initial.model, elapsedMs: Date.now() - started };
  const shot = await harness.cdpCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  await writeFile(join(stateRoot, "agent-caption.png"), Buffer.from(shot.data, "base64"));
  await click('[data-testid="undo-button"]');
  await waitFor(s => s.firstText === originalText && !s.undoEnabled && s.secondText === secondText, "Single Undo restored original caption");
  report.checks.singleUndo = true;
  if (!live) {
    if (report.legacySessionChecks) {
      await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0),o=s.configOptions.find(o=>o.category==='mode'||o.id==='mode');await window.haoDesktop.setOpenCodeAgentConfig(o.id,'plan');return JSON.stringify(true)})()`);
      report.legacySessionChecks.planAvailable=true;
    }
    await send("請確認目前專案已復原。 CAPTION_RESYNC_PROBE");
    await waitFor(s => !s.busy && s.answer.includes("CAPTION_RESYNC_OK"), "Undo synchronized before next request");
    assert(resyncConfirmed);
    if (report.legacySessionChecks) {
      await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0),o=s.configOptions.find(o=>o.category==='mode'||o.id==='mode');await window.haoDesktop.setOpenCodeAgentConfig(o.id,'editkin');return JSON.stringify(true)})()`);
      report.legacySessionChecks.restoredInternalProfile=true;
    }
    await click('.opencode-dock-selection input');
    assert.equal((await inspect()).checked, false);
    await send("這次不用引用目前選取，只回覆收到。 CAPTION_OMIT_PROBE");
    await waitFor(s => !s.busy && s.answer.includes("CAPTION_OMIT_OK"), "Subtitle reference opt-out");
    assert(toolCalled && toolConfirmed && omitConfirmed && schemaConfirmed && envelopeSchemaConfirmed);
    report.checks.undoResynced = true; report.checks.referenceOptOut = true;
    report.checks.nativeCommandSchemaQuery = true;
    report.checks.nativeModelEnvelopeSchema = true;
    assert(guidanceConfirmed);report.checks.nativeTaskGuidance=true;
  }
  assert.deepEqual(await Promise.all(evidencePaths.map(digest)), evidenceBefore, "Original Kit evidence changed");
  if (cloudApi || omniRoute) {
    const prior = await inspect();
    await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=true;const section=[...document.querySelectorAll('.opencode-dock-menu-section')].find(section=>section.querySelector('summary')?.textContent.includes('模型供應商'));section.open=true;return JSON.stringify(true)})()`);
    const refreshDeadline=Date.now()+20_000;let refreshReady=false;
    while(Date.now()<refreshDeadline){refreshReady=await evaluate(`(()=>{const button=[...document.querySelectorAll('.opencode-provider-settings button')].find(button=>button.textContent==='更新模型清單');if(!button||button.disabled)return JSON.stringify(false);button.click();return JSON.stringify(true)})()`);if(refreshReady)break;await delay(200);}
    assert(refreshReady,'Settings model refresh unavailable');
    const resumed = await waitFor(s => s.connected && s.sessionId === prior.sessionId && s.model === cloudModel, "Cloud session resumed through native host");
    assert.equal(resumed.firstText,originalText);
    await evaluate(`(()=>{document.querySelector('.opencode-dock-more').open=false;return JSON.stringify(true)})()`);
    report.cloudProviderChecks.cloudSessionResumedWithoutRepeatedEdit=true;
  }
  if (libraryReview) {
    const bound = await evaluate(`(async()=>{const s=await window.haoDesktop.statusOpenCodeAgent(0);return JSON.stringify({session:s.sessionId,binding:s.libraryBinding,path:s.projectPath,model:s.configOptions.find(o=>o.id==='model').currentValue,available:s.historyAvailable})})()`);
    assert(bound.available && bound.binding, 'Local library is unavailable in the packaged native host');
    const local = (action, fields = {}) => evaluate(`(async()=>{return JSON.stringify(await window.haoDesktop.agentLibrary(${JSON.stringify({schema:'editkin.agent-library/v1',binding:bound.binding,action,...fields})}))})()`);
    const wireBefore = wireRequests.length, projectBefore = await digest(bound.path);
    const readBefore = await local('read', {sessionId:bound.session});
    assert(readBefore.entries.some(e=>e.kind==='user') && readBefore.entries.some(e=>e.kind==='message'));
    assert((await local('search',{query:'字幕'})).sessions.some(s=>s.sessionId===bound.session));
    assert.equal(wireRequests.length,wireBefore,'Read-only library called the model');
    assert.equal(await digest(bound.path),projectBefore,'Read-only library changed the project');
    for(let n=0;n<80;n++){if(await evaluate(`(()=>{const b=document.querySelector('button[aria-label="對話紀錄"]');return JSON.stringify(!!b&&!b.disabled)})()`))break;await delay(150);}
    await evaluate(`(()=>{document.querySelector('button[aria-label="對話紀錄"]').click();return JSON.stringify(true)})()`);
    for(let n=0;n<80;n++){if(await evaluate(`(()=>{const b=document.querySelector('.agent-library-panel button[type="button"]');return JSON.stringify(!!b&&!b.disabled)})()`))break;await delay(150);}
    assert(await evaluate(`(()=>{return JSON.stringify(!!document.querySelector('input[aria-label="搜尋本機對話"]'))})()`),'History search UI missing');
    await evaluate(`(()=>{document.querySelector('.agent-library-panel button[type="button"]').click();return JSON.stringify(true)})()`);
    for(let n=0;n<80;n++){if(await evaluate(`(()=>{return JSON.stringify(!!document.querySelector('.agent-library-reader'))})()`))break;await delay(150);}
    assert(await evaluate(`(()=>{return JSON.stringify(document.querySelector('.agent-library-panel').textContent.includes('唯讀回看'))})()`));
    const historyShot=await harness.cdpCommand(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});await writeFile(join(stateRoot,'agent-history-reader.png'),Buffer.from(historyShot.data,'base64'));
    await evaluate(`(()=>{[...document.querySelectorAll('.agent-library-panel button')].find(b=>b.textContent==='建立 Skill 草稿').click();return JSON.stringify(true)})()`);
    for(let n=0;n<80;n++){if(await evaluate(`(()=>{return JSON.stringify(!!document.querySelector('textarea[aria-label="個人剪輯規則"]'))})()`))break;await delay(150);}
    assert(await evaluate(`(()=>{const inputs=[...document.querySelectorAll('.agent-library-panel input[type=checkbox]')];return JSON.stringify(inputs.length===2&&!inputs.some(i=>i.checked)&&inputs[0].disabled)})()`),'History-derived skill was activated without review');
    const skillShot=await harness.cdpCommand(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});await writeFile(join(stateRoot,'agent-skill-draft.png'),Buffer.from(skillShot.data,'base64'));
    await evaluate(`(()=>{document.querySelector('button[aria-label="對話紀錄"]').click();return JSON.stringify(true)})()`);
    const draft=(await local('draft',{sessionId:bound.session})).draft;
    assert(!draft.enabled && draft.visibility==='project');
    await local('save-extension',{extension:{...draft,kind:'plugin',name:'Synthetic personal rule',instructions:'PERSONAL_LIBRARY_RULE: confirm subtitles before editing.',enabled:true}});
    await send('這次不用引用目前選取，只回覆收到。 CAPTION_OMIT_PROBE');
    await waitFor(s=>!s.busy&&s.answer.includes('CAPTION_OMIT_OK'),'Personal rule through common provider prompt');
    assert(report.checks.personalRuleReachedSelectedProvider,'Enabled personal plugin did not reach the selected provider');
    assert.equal(await digest(bound.path),projectBefore);
    const beforeReplay=(await local('read',{sessionId:bound.session})).entries.length;
    await evaluate(`(async()=>{await window.haoDesktop.newOpenCodeAgentSession();await window.haoDesktop.loadOpenCodeAgentSession(${JSON.stringify(bound.session)},${JSON.stringify(bound.model)});return JSON.stringify(true)})()`);
    assert.equal((await local('read',{sessionId:bound.session})).entries.length,beforeReplay,'Loading history duplicated archived events');
    await evaluate(`(async()=>{await window.haoDesktop.closeOpenCodeAgent();await window.haoDesktop.startOpenCodeAgent(${JSON.stringify(bound.path)},${JSON.stringify(bound.session)},${JSON.stringify(bound.model)});return JSON.stringify(true)})()`);
    assert((await local('search',{query:'CAPTION_OMIT_PROBE'})).sessions.some(s=>s.sessionId===bound.session),'History did not survive reconnect');
    const secondPath=join(stateRoot,'other-project.editkin.json');await writeFile(secondPath,JSON.stringify({...project,id:'other-project-library-fixture'}));
    await evaluate(`(async()=>{await window.haoDesktop.closeOpenCodeAgent();await window.haoDesktop.startOpenCodeAgent(${JSON.stringify(secondPath)});return JSON.stringify(true)})()`);
    const isolation=await evaluate(`(async()=>{const a=window.haoDesktop,s=await a.statusOpenCodeAgent(0);const result=await a.agentLibrary({schema:'editkin.agent-library/v1',binding:s.libraryBinding,action:'search',query:'CAPTION_OMIT_PROBE'});let foreign=false,stale=false;try{await a.loadOpenCodeAgentSession(${JSON.stringify(bound.session)},${JSON.stringify(bound.model)})}catch{foreign=true}try{await a.agentLibrary({schema:'editkin.agent-library/v1',binding:${JSON.stringify(bound.binding)},action:'search'})}catch{stale=true}const extensions=await a.agentLibrary({schema:'editkin.agent-library/v1',binding:s.libraryBinding,action:'extensions'});return JSON.stringify({foreign,stale,found:result.sessions.length,extensions:extensions.extensions.length,bindingChanged:s.libraryBinding!==${JSON.stringify(bound.binding)}})})()`);
    assert(isolation.foreign&&isolation.stale&&isolation.found===0&&isolation.extensions===0&&isolation.bindingChanged,'Same-folder native project isolation failed');
    await evaluate(`(async()=>{await window.haoDesktop.closeOpenCodeAgent();await window.haoDesktop.startOpenCodeAgent(${JSON.stringify(bound.path)},${JSON.stringify(bound.session)},${JSON.stringify(bound.model)});return JSON.stringify(true)})()`);
    report.libraryChecks={nativeBridge:true,providerNeutral:true,localSearch:true,readWithoutModelOrToolReplay:true,historyUi:true,disabledSkillDraftUi:true,declaredPluginSaved:true,resumeWithoutArchiveDuplication:true,reconnectPersistence:true,sameFolderProjectIsolation:true,staleBindingRejected:true,foreignConversationRejected:true,privateRulesNotSharedByDefault:true,projectHashUnchanged:true};
  }
  report.checks.originalEvidenceUnchanged = true;
  await checkAgentLabels(); report.checks.agentLabelsWithoutRuntimeBranding = true;
  report.status = "PASS";
} catch (error) {
  report.error = String(error.message).replaceAll(endpoint, "<model-origin>");
  if (page && !report.diagnostics) {
    try { report.diagnostics = { events: JSON.parse(JSON.stringify((await inspect()).events).replaceAll(endpoint, "<model-origin>")) }; }
    catch { /* Original failure remains the primary diagnostic. */ }
  }
}
finally {
  report.wireContext = { providerNeutralEstimate: true, billingOrCacheVerified: false, requests: wireRequests };
  harness.closeCdp(); await harness.stopOwnedApplication();
  if (modelServer) { modelServer.closeAllConnections(); await new Promise(done => modelServer.close(done)); }
  await rm(join(stateRoot, "data/local-story/origin.json"), { force: true });
  await writeFile(join(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: report.status, stateRoot, checks: report.checks, error: report.error }) + "\n");
}
if (report.status !== "PASS") process.exitCode = 1;

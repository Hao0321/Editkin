// Packaged subtitle correction: original Kit evidence stays read-only.
// Usage: node scripts/review-caption-correction.mjs <portable.exe> [--legacy]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
const legacy = process.argv.includes("--legacy");
const artifactRoot = resolve("../artifacts/autopilot-desk");
const originalWorkspace = join(artifactRoot, "kit-voiced-prepare-IaRWnn");
const originalRun = join(originalWorkspace, "videos/_AUTOPILOT/editkin-v4/voiced-prepare");
const state = JSON.parse(await readFile(join(originalRun, "workflow-state.json"), "utf8"));
const evidencePaths = [join(originalWorkspace, "movie.editkin.json"), join(originalWorkspace, "voiced-source.mp4"),
  join(originalRun, "workflow-state.json"), ...Object.values(state.steps).flatMap(step =>
    step.receipt?.path ? [resolve(originalRun, step.receipt.path)] : [])];
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const before = await Promise.all(evidencePaths.map(digest));
const stateRoot = await mkdtemp(join(artifactRoot, "caption-correction-review-"));
const projectPath = join(stateRoot, "corrected.editkin.json");
const outputPath = join(stateRoot, "corrected.mp4");
const project = JSON.parse(await readFile(evidencePaths[0], "utf8"));
project.id = "caption-correction-isolated-review";
const first = project.captions[0];
assert(first?.text.includes("检好"), "Known AAC recognition error is missing from fixture");
const originalText = first.text, correctedText = originalText.replace("检好", "剪好");
const secondText = JSON.parse(await readFile(join(originalWorkspace, "voiced-evidence-report.json"), "utf8")).transcriptCues[1].text;
project.captions.push({ id: "review-second-source-cue", text: secondText,
  start: first.start + first.duration, duration: Math.round(0.66 * project.fps) / project.fps });
await writeFile(projectPath, JSON.stringify(project));
const port = await new Promise((done,reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0,"127.0.0.1",()=>{const address=server.address();server.close(()=>done(address.port));});
});
const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true,
  stdio: ["ignore","pipe","pipe"], env: { ...process.env, EDITKIN_INTEGRATION_SMOKE:"1",
    EDITKIN_INTEGRATION_STATE_ROOT:stateRoot, WEBVIEW2_USER_DATA_FOLDER:join(stateRoot,"webview2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}` } });
child.stdout.resume(); child.stderr.resume();
const harness = createTauriCdpHarness({child,port,startupPollMs:250,startupInteractiveTimeoutMs:50_000,startupInteractiveAttempts:200});
let page;
const report = { status:"BLOCK", legacy, executable, stateRoot, appPid:child.pid, checks:{} };
const evaluate=(code,timeout=10000)=>harness.evaluate(page.webSocketDebuggerUrl,code,timeout);
const selector=id=>`[data-testid="timeline-caption-${id}"]`;
const inspect=()=>evaluate(`(()=>{const node=document.querySelector('[data-testid="caption-text-input"]');return JSON.stringify({
  ready:!!document.querySelector('[data-testid="new-project-button"]'),
  text:node?.value, timelineText:document.querySelector(${JSON.stringify(selector(first.id))}+' strong')?.textContent,
  firstSelected:!!document.querySelector(${JSON.stringify(selector(first.id))}+'.selected'),
  secondSelected:!!document.querySelector('[data-testid="timeline-caption-review-second-source-cue"].selected'),
  playing:document.querySelector('.preview-panel')?.dataset.playing==='true',
  playhead:document.querySelector('.transport-readout > span')?.textContent,
  auditioning:document.querySelector('[data-testid="caption-audition"]')?.getAttribute('aria-pressed')==='true',
  applyDisabled:document.querySelector('[data-testid="caption-text-input-apply"]')?.disabled,
  textStatus:document.querySelector('[data-testid="caption-text-input-editor"] [role="status"]')?.textContent,
  undoEnabled:!document.querySelector('[data-testid="undo-button"]')?.disabled,
  renderCalls:window.__captionReviewRenderCalls||0,
  saveState:document.querySelector('[data-testid="save-state"]')?.textContent,
  operationStatus:document.querySelector('[data-testid="operation-status-message"]')?.textContent})})()`);
const waitFor=async(predicate,label,timeout=25000)=>{const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline){last=await inspect();if(predicate(last))return last;await delay(150);}
  throw Error(`${label} timed out: ${JSON.stringify(last)}`);};
const click=async(selector)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('control unavailable');node.click();return JSON.stringify(true)})()`);
const type=async text=>{await evaluate("(()=>{document.querySelector('[data-testid=caption-text-input]').focus();return JSON.stringify(true)})()");
  await harness.cdpCommand(page.webSocketDebuggerUrl,"Input.dispatchKeyEvent",{type:"rawKeyDown",key:"a",code:"KeyA",windowsVirtualKeyCode:65,modifiers:2});
  await harness.cdpCommand(page.webSocketDebuggerUrl,"Input.dispatchKeyEvent",{type:"keyUp",key:"a",code:"KeyA",windowsVirtualKeyCode:65,modifiers:2});
  await harness.cdpCommand(page.webSocketDebuggerUrl,"Input.insertText",{text});
  await waitFor(s=>s.text===text,"Text input");};
const menu=()=>evaluate("(()=>{const menu=document.querySelector('.project-menu');menu.open=true;menu.querySelector('.project-menu-group').open=true;return JSON.stringify(true)})()");
try {
  page=await harness.target();
  await waitFor(s=>s.ready,"Editor startup");
  await evaluate(`(()=>{window.confirm=()=>true;window.haoDesktop.openProject=()=>window.haoDesktop.reloadProjectFromPath(${JSON.stringify(projectPath)});return JSON.stringify(true)})()`);
  await menu(); await click('[data-testid="open-project-button"]');
  await waitFor(s=>s.timelineText===originalText,"Open isolated voiced project");
  await evaluate("(()=>{document.querySelector('[data-testid=agent-dock-collapse]')?.click();return JSON.stringify(true)})()");
  if (legacy) await evaluate("(()=>{const controls=document.querySelector('[data-testid=workspace-controls]');controls.open=true;[...controls.querySelectorAll('.workspace-preset-grid button')].find(node=>node.querySelector('b')?.textContent==='剪輯').click();controls.open=false;return JSON.stringify(true)})()");
  await click(selector(first.id));
  await waitFor(s=>s.text===originalText,"Caption inspector");
  if (!legacy) report.checks.selectionOpensInspector=true;
  await type(originalText.replace("检",""));
  if(!legacy) assert.equal((await inspect()).timelineText,originalText,"Intermediate correction mutated the timeline");
  await type(correctedText);
  if(!legacy) {
    assert.equal((await inspect()).timelineText,originalText);
    await click('[data-testid="caption-text-input-apply"]');
  }
  await waitFor(s=>s.timelineText===correctedText,"Apply corrected subtitle");
  await click('[data-testid="undo-button"]');
  report.checks.afterOneUndo=await inspect();
  if(legacy) {
    assert.notEqual(report.checks.afterOneUndo.timelineText,originalText,"Legacy regression no longer reproduces");
    report.status="REPRODUCED_UNDO_PER_KEYSTROKE";
  } else {
    assert.equal(report.checks.afterOneUndo.timelineText,originalText,"Correction requires more than one undo");
    await click('[data-testid="redo-button"]');
    await waitFor(s=>s.timelineText===correctedText,"Redo correction");
    await type("");
    await evaluate("(()=>{document.querySelector('[data-testid=caption-text-input]').blur();return JSON.stringify(true)})()");
    report.checks.blankDraft=await inspect();
    assert.equal(report.checks.blankDraft.timelineText,correctedText,"Empty scratch erased a subtitle");
    assert(report.checks.blankDraft.textStatus.includes("請輸入文字"));
    await type(correctedText);
    await evaluate("(()=>{const node=document.querySelector('[data-testid=caption-text-input]');node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));return JSON.stringify(true)})()");
    await type(correctedText+"。");
    await evaluate("(()=>{const node=document.querySelector('[data-testid=caption-text-input]');node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));return JSON.stringify(true)})()");
    assert.equal((await inspect()).timelineText,correctedText,"IME committed unfinished composition");
    await evaluate("(()=>{document.querySelector('[data-testid=caption-text-input]').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return JSON.stringify(true)})()");
    await click('[data-testid="caption-text-input-apply"]');
    await waitFor(s=>s.timelineText===correctedText+"。","Composition completion");
    await click('[data-testid="undo-button"]');
    await waitFor(s=>s.timelineText===correctedText,"Single undo for composition");
    report.checks.compositionPreserved=true;
    await type(correctedText+"。");
    await harness.cdpCommand(page.webSocketDebuggerUrl,"Input.dispatchKeyEvent",{type:"rawKeyDown",key:"s",code:"KeyS",windowsVirtualKeyCode:83,modifiers:2});
    await harness.cdpCommand(page.webSocketDebuggerUrl,"Input.dispatchKeyEvent",{type:"keyUp",key:"s",code:"KeyS",windowsVirtualKeyCode:83,modifiers:2});
    await waitFor(s=>s.timelineText===correctedText+"。"&&s.saveState?.includes("專案檔已儲存"),"Ctrl+S flushes pending caption before saving");
    assert.equal(JSON.parse(await readFile(projectPath,"utf8")).captions.find(c=>c.id===first.id).text,correctedText+"。","Ctrl+S saved the old caption");
    report.checks.pendingTextSavedByShortcut=true;
    await click('[data-testid="undo-button"]');
    await waitFor(s=>s.timelineText===correctedText,"Undo saved correction in one step");
    await click('[data-testid="caption-next"]');
    await waitFor(s=>s.secondSelected&&s.text===secondText,"Next source cue");
    await click('[data-testid="caption-previous"]');
    await waitFor(s=>s.firstSelected&&s.text===correctedText,"Previous source cue");
    await click('[data-testid="caption-audition"]');
    await waitFor(s=>s.playing&&s.auditioning,"Cue playback began",10000);
    report.checks.auditionEnded=await waitFor(s=>!s.playing&&!s.auditioning,"Cue playback stopped at end",12000);
    const endParts=report.checks.auditionEnded.playhead.split(":").map(Number);
    const endSeconds=endParts.reduce((total,part)=>total*60+part,0);
    assert(Math.abs(endSeconds-(first.start+first.duration))<=0.5/project.fps+0.01,"Cue playback stopped at the wrong time");
    await harness.cdpCommand(page.webSocketDebuggerUrl,"Emulation.setDeviceMetricsOverride",{width:1280,height:720,deviceScaleFactor:1,mobile:false});
    report.checks.smallLayout=await evaluate("(()=>{const r=document.querySelector('[data-testid=caption-review-controls]').getBoundingClientRect();return JSON.stringify({viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,controlWidth:r.width,textFontSize:getComputedStyle(document.querySelector('[data-testid=caption-text-input]')).fontSize})})()");
    assert.equal(report.checks.smallLayout.documentWidth,1280);
    assert(report.checks.smallLayout.controlWidth>200);
    assert(parseFloat(report.checks.smallLayout.textFontSize)>=12);
    const shot=await harness.cdpCommand(page.webSocketDebuggerUrl,"Page.captureScreenshot",{format:"png"});
    await writeFile(join(stateRoot,"caption-review-1280x720.png"),Buffer.from(shot.data,"base64"));
    await evaluate(`(()=>{const api=window.haoDesktop,save=api.saveProject.bind(api);api.saveProject=(value,path)=>save(value,path||${JSON.stringify(projectPath)},false);return JSON.stringify(true)})()`);
    await menu(); await click('[data-testid="save-project-button"]');
    await waitFor(s=>s.saveState?.includes("專案檔已儲存"),"Save corrected captions");
    const saved=JSON.parse(await readFile(projectPath,"utf8"));
    assert.equal(saved.captions.find(c=>c.id===first.id).text,correctedText);
    await menu(); await click('[data-testid="open-project-button"]');
    await waitFor(s=>s.timelineText===correctedText&&!s.undoEnabled&&s.operationStatus?.includes("已開啟"),"Reopen corrected captions into a fresh session");
    // Exercise the real render engine with an isolated output; native file-dialog interaction is not covered.
    await evaluate(`(()=>{window.__captionReviewRenderCalls=0;window.haoDesktop.renderProject=project=>{window.__captionReviewRenderCalls++;return window.__TAURI_INTERNALS__.invoke('render_project_smoke',{project,outputPath:${JSON.stringify(outputPath)}})};return JSON.stringify(true)})()`);
    await click('[data-testid="render-button"]');
    await waitFor(s=>s.renderCalls===1,"Export reached render bridge exactly once",15000);
    await waitFor(s=>s.operationStatus?.includes("影片輸出完成"),"Render corrected subtitles",120000);
    execFileSync("ffmpeg",["-nostdin","-v","error","-xerror","-i",outputPath,"-map","0:v:0","-map","0:a:0","-f","null","-"],{windowsHide:true,timeout:60000,stdio:"ignore"});
    report.checks.savedReopenedAndDecoded=true;
    report.status="PASS";
  }
  assert.deepEqual(await Promise.all(evidencePaths.map(digest)),before,"Original source or Kit evidence changed");
  report.checks.originalEvidenceUnchanged=true;
  await writeFile(join(stateRoot,"report.json"),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify({status:report.status,stateRoot,checks:report.checks})+"\n");
} catch(error) {
  report.error=error.message;
  await writeFile(join(stateRoot,"report.json"),JSON.stringify(report,null,2));
  throw error;
} finally {harness.closeCdp();await harness.stopOwnedApplication();}

// Usage: node scripts/review-packaged-asr.mjs <portable-preview.exe> <speech-wav>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createTauriCdpHarness, delay } from "./lib/tauri-cdp-harness.mjs";

const executable = resolve(process.argv[2] || "");
const speech = resolve(process.argv[3] || "");
assert.equal(basename(executable).toLowerCase(), "autopilotdesk-community-preview.exe");
const artifactRoot = resolve("../artifacts/autopilot-desk");
await mkdir(artifactRoot, { recursive: true });
const stateRoot = await mkdtemp(resolve(artifactRoot, "packaged-asr-review-"));
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
const report = { status: "BLOCK", stateRoot, executable, appPid: child.pid, checks: {} };
const evaluate = (expression, timeout = 10_000) => harness.evaluate(page.webSocketDebuggerUrl, expression, timeout);
try {
  page = await harness.target();
  let bridgeReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    bridgeReady = await evaluate("JSON.stringify(typeof window.haoDesktop?.automaticCaptionStatus==='function')");
    if (bridgeReady) break;
    await delay(250);
  }
  assert(bridgeReady, "Desktop bridge did not initialize");
  report.checks.capability = await evaluate("window.haoDesktop.automaticCaptionStatus().then(v=>JSON.stringify(v)).catch(e=>JSON.stringify({error:String(e)}))", 30_000);
  assert.equal(report.checks.capability.status, "ready", report.checks.capability.message);
  report.checks.transcription = await evaluate(`window.haoDesktop.automaticCaptionMedia(${JSON.stringify({ sourcePath: speech, sourceStart: 0, duration: 5, language: "zh" })}).then(v=>JSON.stringify(v)).catch(e=>JSON.stringify({error:String(e)}))`, 45_000);
  assert(report.checks.transcription.cues?.some((cue) => /[\u4e00-\u9fff]/u.test(cue.text)), "packaged desktop returned no Chinese speech cue");
  assert.equal(report.checks.transcription.modelDownloaded, false);
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tauri://drag-drop',payload:{paths:[${JSON.stringify(speech)}],position:{x:320,y:240}}}).then(()=>JSON.stringify(true))`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const ready = await evaluate("JSON.stringify(!!document.querySelector('[data-testid=semantic-edit-button]:not([disabled])'))");
    if (ready) break;
    await delay(250);
  }
  await evaluate("(()=>{const button=document.querySelector('[data-testid=semantic-edit-button]');if(!button||button.disabled)throw Error('rough-cut action unavailable');button.click();return JSON.stringify(true)})()");
  for (let attempt = 0; attempt < 40; attempt++) {
    const dialog = await evaluate("JSON.stringify({open:!!document.querySelector('.auto-edit-dialog[open]'),checking:document.querySelector('.auto-edit-capability')?.textContent||'',startDisabled:document.querySelector('.auto-edit-dialog button[type=submit]')?.disabled})");
    if (dialog.open && !dialog.checking.includes("正在檢查")) { report.checks.dialog = dialog; break; }
    await delay(250);
  }
  assert(report.checks.dialog?.open, "rough-cut dialog did not open");
  assert(!report.checks.dialog.checking.includes("不可用"), "rough-cut dialog rejected a ready recognizer");
  report.checks.dialog.canStart = await evaluate("(()=>{document.querySelector('.auto-edit-dialog input[value=longform]')?.click();return JSON.stringify(!document.querySelector('.auto-edit-dialog button[type=submit]')?.disabled)})()");
  assert(report.checks.dialog.canStart, "rough-cut remained blocked after format selection");
  report.status = "PASS";
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ status: report.status, stateRoot, capability: report.checks.capability.status,
    cues: report.checks.transcription.cues, dialog: report.checks.dialog })}\n`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  await writeFile(resolve(stateRoot, "report.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  harness.closeCdp();
  await harness.stopOwnedApplication();
}

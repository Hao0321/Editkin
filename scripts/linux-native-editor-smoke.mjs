// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Drives the actual GTK/WebKit window, not a Vite page or mocked desktop bridge.
// Prerequisites: Node >= 20, tauri-driver, WebKitWebDriver, and an external X display
// (e.g. xvfb-run -a -s '-screen 0 1440x1000x24' node scripts/linux-native-editor-smoke.mjs <binary>).
// Compile embedded frontend assets with Tauri's custom-protocol feature; no app test hooks required.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";

async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory || ".", name);
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); }
    catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  throw new Error(`${name} is required on PATH`);
}
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const { port } = server.address();
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}
async function identity(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, bytes: (await stat(path)).size, sha256: hash.digest("hex") };
}

if (!process.argv[2] || process.argv[2] === "--help") {
  process.stdout.write("Usage: node scripts/linux-native-editor-smoke.mjs <editkin-native-binary>\nRun under xvfb-run on Linux with tauri-driver and WebKitWebDriver on PATH. Uses the shipped public synthetic demo, retains screenshots/JSON/logs in ignored .rd/tmp, and never substitutes browser-only verification. Budget: 120 seconds plus bounded cleanup.\n");
  if (!process.argv[2]) process.exitCode = 2;
} else {
  const started = Date.now();
  const deadline = started + 120000;
  const parent = resolve(root, ".rd/tmp");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(resolve(parent, "linux-native-editor-"));
  const report = {
    schemaVersion: 1, status: "BLOCK", scope: "focused-native-linux-gtk-webkit-editor-smoke",
    startedAt: new Date(started).toISOString(), workspace, steps: [],
    limits: ["Synthetic UI demo only; no private footage or speech models", "No native media preview/playback, media import, codec/GPU pixel parity, render/export, native dialogs or save/reopen claim", "Not official-release artifact, installer/signature or full-product acceptance"],
  };
  const controller = new AbortController();
  let driver, driverError, session, origin, watchdog, stdout = "", stderr = "";
  let baselineClipNames;
  const observedProcesses = new Map();
  const abort = (signal) => controller.abort(new Error(`Interrupted by ${signal}`));
  const onSigint = () => abort("SIGINT"), onSigterm = () => abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const mark = (stage) => { report.stage = stage; report.steps.push({ stage, elapsedMs: Date.now() - started }); process.stderr.write(`[linux-native-smoke] ${stage}\n`); };
  function remaining(maximum = 10000) {
    controller.signal.throwIfAborted();
    if (driverError) throw driverError;
    if (driver && (driver.exitCode !== null || driver.signalCode !== null)) throw new Error(`Owned tauri-driver exited: ${driver.exitCode ?? driver.signalCode}`);
    const timeout = Math.min(maximum, deadline - Date.now());
    assert(timeout > 0, "Native smoke exceeded 120-second budget");
    return timeout;
  }
  async function request(method, path, body, maximum = 10000, cleanup = false) {
    const signal = cleanup ? AbortSignal.timeout(maximum) : AbortSignal.any([controller.signal, AbortSignal.timeout(remaining(maximum))]);
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(payload.value ?? payload)}`);
    return payload.value;
  }
  const command = (method, path, body, maximum) => request(method, `/session/${encodeURIComponent(session)}${path}`, body, maximum);
  const evaluate = (script, args = []) => command("POST", "/execute/sync", { script, args });
  async function evaluateAsync(expression) {
    const value = await command("POST", "/execute/async", {
      script: `const done=arguments[arguments.length-1];Promise.resolve().then(()=>(${expression})).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error?.stack||error)}));`, args: [],
    });
    assert.equal(value?.ok, true, `Native async evaluation failed: ${value?.error}`);
    return value.value;
  }
  async function poll(name, read, accepted, maximum = 15000) {
    const end = Math.min(deadline, Date.now() + maximum);
    let last;
    while (Date.now() < end) {
      remaining();
      last = await read();
      if (accepted(last)) return last;
      await delay(200, undefined, { signal: controller.signal });
    }
    throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
  }
  async function click(selector) {
    report.input = { selector };
    mark(`native-click: ${selector}`);
    const element = await command("POST", "/element", { using: "css selector", value: selector });
    assert(element?.[elementKey], `Missing W3C element: ${selector}`);
    const path = `/element/${encodeURIComponent(element[elementKey])}`;
    assert.equal(await command("GET", `${path}/displayed`), true, `Control hidden: ${selector}`);
    assert.equal(await command("GET", `${path}/enabled`), true, `Control disabled: ${selector}`);
    await command("POST", `${path}/click`, {});
  }
  async function replaceText(selector, text, index = 0) {
    report.input = { selector, index };
    mark(`native-text-input: ${selector} [${index}]`);
    const elements = await command("POST", "/elements", { using: "css selector", value: selector });
    const id = elements[index]?.[elementKey];
    assert(id, `Missing editable W3C element: ${selector} [${index}]`);
    const path = `/element/${encodeURIComponent(id)}`;
    assert.equal(await command("GET", `${path}/displayed`), true, `Editor hidden: ${selector}`);
    assert.equal(await command("GET", `${path}/enabled`), true, `Editor disabled: ${selector}`);
    await command("POST", `${path}/click`, {});
    // Real native key input selects the existing value, then replaces it. Do not
    // assign DOM values or dispatch synthetic React events.
    await command("POST", "/actions", { actions: [{ type: "key", id: "editor-keyboard", actions: [
      { type: "keyDown", value: "\uE009" },
      { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" },
      { type: "keyUp", value: "\uE009" },
      ...Array.from(text).flatMap((value) => [{ type: "keyDown", value }, { type: "keyUp", value }]),
    ] }] });
    await command("DELETE", "/actions");
  }
  async function screenshot(name) {
    const buffer = Buffer.from(await command("GET", "/screenshot"), "base64");
    assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "WebDriver did not return a PNG screenshot");
    const path = resolve(workspace, `${name}.png`);
    await writeFile(path, buffer, { flag: "wx" });
    return { ...await identity(path), width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  const readState = () => evaluate(`
    const visible=n=>{if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(n).visibility!=='hidden';};
    const captions=[...document.querySelectorAll('.timeline-clip.caption')].map(n=>({id:n.dataset.testid?.replace('timeline-caption-',''),text:n.querySelector('strong')?.textContent,start:Number(n.dataset.timelineStart),duration:Number(n.dataset.duration),visible:visible(n)}));
    const undo=document.querySelector('[data-testid="undo-button"]'),redo=document.querySelector('[data-testid="redo-button"]');
    const save=document.querySelector('[data-testid="save-state"]');
    return {url:location.href,ready:document.readyState,desktop:window.haoDesktop?.isDesktop===true,ipc:typeof window.__TAURI_INTERNALS__?.invoke==='function',
      brand:document.querySelector('.brand-copy strong')?.textContent,toolbar:visible(document.querySelector('[data-testid="editor-toolbar"]')),
      welcome:visible(document.querySelector('[data-testid="first-project-start"]')),guide:visible(document.querySelector('[data-testid="guide-skip"]')),workspace:document.querySelector('.app-shell')?.dataset.workspaceMode,
      blocked:document.querySelector('.app-shell')?.dataset.shortcutsBlocked,clipNames:[...document.querySelectorAll('.timeline-clip:not(.caption) strong')].map(n=>n.textContent),
      captions,captionInput:document.querySelector('[data-testid="caption-text-input"]')?.value,undoEnabled:!!undo&&!undo.disabled,redoEnabled:!!redo&&!redo.disabled,saveFailed:!!save?.querySelector('.red'),saveState:save?.textContent,status:document.querySelector('.status-bar')?.textContent};
  `);
  const healthyState = async () => { const state = await readState(); assert(!state.saveFailed, `Autosave failed: ${JSON.stringify(state)}`); return state; };
  function assertCaption(state, expected) {
    assert.equal(state.captions.length, 1, "Exactly one edited caption must be visible on the demo timeline");
    const { id, text, start, duration, visible } = state.captions[0];
    assert.deepEqual({ id, text, start, duration }, expected, "Visible caption must reflect the user's exact text and timing");
    assert.equal(state.captionInput, expected.text, "Visible text editor must agree with the timeline");
    assert.equal(visible, true, "Caption must be on screen");
    assert.deepEqual(state.clipNames, baselineClipNames, "Caption edit must not change the video timeline");
  }
  async function ownedProcessSnapshot() {
    if (!driver?.pid) return [];
    const processes = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const details = await readFile(`/proc/${entry}/stat`, "utf8");
        const end = details.lastIndexOf(")");
        const fields = details.slice(end + 2).split(" ");
        const process = { pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]), startTime: fields[19], state: fields[0], name: details.slice(details.indexOf("(") + 1, end) };
        let marked = false;
        try {
          const environment = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
          marked = report.profile && (environment.includes(`HOME=${report.profile.path}`) || environment.includes(`EDITKIN_PERSONAL_VISUAL_ROOT=${report.profile.personalVisualRoot}`));
        } catch (error) {
          if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
        }
        const observed = observedProcesses.get(process.pid);
        processes.push({ ...process, owned: marked || (observed?.startTime === process.startTime) || (!observed && process.pid === driver.pid) });
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
    let changed;
    do {
      changed = false;
      const parents = new Set(processes.filter((process) => process.owned).map((process) => process.pid));
      for (const process of processes) {
        if (!process.owned && parents.has(process.parent)) { process.owned = true; changed = true; }
      }
    } while (changed);
    const owned = processes.filter((process) => process.owned).map(({ owned, ...process }) => process);
    for (const process of owned) observedProcesses.set(process.pid, process);
    return owned;
  }
  async function verifyOwnedProcessesExited() {
    const end = Date.now() + 3000;
    let remaining;
    do {
      remaining = await ownedProcessSnapshot();
      if (remaining.length === 0) break;
      await delay(100);
    } while (Date.now() < end);
    report.cleanup.remainingProcesses = remaining;
    report.cleanup.observedProcesses = [...observedProcesses.values()];
    report.cleanup.verification = "Linux /proc PID/start-time identities, ancestry and unique isolated HOME/personal-visual-root; includes native-owned groups outside the driver group";
    assert.equal(remaining.length, 0, `Smoke-owned processes remain after cleanup: ${JSON.stringify(remaining)}`);
  }
  async function stopOwnedGroup() {
    if (!driver?.pid) return;
    // This group owns the driver tree, not all application workers: native Node
    // workers create separate groups and rely on normal application shutdown.
    const signalGroup = (signal) => { try { process.kill(-driver.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    signalGroup("SIGTERM");
    await delay(500);
    signalGroup("SIGKILL");
    if (driver.exitCode === null && driver.signalCode === null) {
      await Promise.race([
        new Promise((done) => driver.once("exit", done)),
        delay(3000).then(() => { if (driver.exitCode === null && driver.signalCode === null) throw new Error("Owned driver did not exit after group SIGKILL"); }),
      ]);
    }
    report.cleanup = { sessionDeleteAttempted: Boolean(session), ownedProcessGroup: driver.pid, groupTermination: "SIGTERM then SIGKILL", driverExitCode: driver.exitCode, driverSignal: driver.signalCode };
  }
  try {
    mark("preflight");
    assert.equal(process.platform, "linux", "This harness requires real Linux GTK/WebKit");
    assert(process.env.DISPLAY, "DISPLAY required; run under xvfb-run externally");
    const executable = await realpath(resolve(process.argv[2]));
    await access(executable, constants.X_OK);
    report.executable = await identity(executable);
    report.evaluator = await identity(fileURLToPath(import.meta.url));
    report.automation = { driver: await identity(await executableOnPath("tauri-driver")), nativeDriver: await identity(await executableOnPath("WebKitWebDriver")) };
    const profile = resolve(workspace, "profile");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(EDITKIN_|HAO_EDITOR_|HAO_FFMPEG_PATH$|HAO_FFPROBE_PATH$|HAO_NATIVE_CORE_PATH$|WEBVIEW2_)/i.test(key)) delete env[key];
    // Configure the normal debug runtime with the real installed Node executable;
    // resident service admission deliberately rejects a relative PATH command.
    env.EDITKIN_NODE_PATH = await executableOnPath("node");
    report.serviceRuntime = { node: await identity(env.EDITKIN_NODE_PATH), configuration: "supported EDITKIN_NODE_PATH debug runtime override" };
    Object.assign(env, { HOME: profile, XDG_DATA_HOME: resolve(profile, "data"), XDG_CONFIG_HOME: resolve(profile, "config"), XDG_CACHE_HOME: resolve(profile, "cache"), EDITKIN_PERSONAL_VISUAL_ROOT: resolve(workspace, "personal-visual") });
    for (const path of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.EDITKIN_PERSONAL_VISUAL_ROOT]) await mkdir(path, { recursive: true });
    report.profile = { path: profile, isolation: "standard HOME/XDG directories; no integration-smoke app hooks", personalVisualRoot: env.EDITKIN_PERSONAL_VISUAL_ROOT };
    const port = await freePort();
    let nativePort = await freePort();
    while (nativePort === port) nativePort = await freePort();
    origin = `http://127.0.0.1:${port}`;
    mark("start-owned-native-webdriver");
    driver = spawn(report.automation.driver.path, ["--port", String(port), "--native-port", String(nativePort), "--native-host", "127.0.0.1", "--native-driver", report.automation.nativeDriver.path], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    driver.once("error", (error) => { driverError = error; controller.abort(error); });
    driver.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    driver.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    watchdog = setTimeout(() => controller.abort(new Error("Native smoke exceeded 120-second budget")), Math.max(1, deadline - Date.now()));
    await poll("Native WebDriver server", async () => {
      try { return await request("GET", "/status", undefined, 2000); }
      catch (error) { remaining(); if (error.cause?.code === "ECONNREFUSED" || error.name === "TimeoutError") return null; throw error; }
    }, (value) => value?.ready === true);
    const created = await request("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: executable }, timeouts: { implicit: 0, pageLoad: 30000, script: 10000 } } } }, 45000);
    session = created.sessionId;
    assert(session, "Native driver returned no session ID");
    report.automation.capabilities = created.capabilities;
    report.windowHandles = await command("GET", "/window/handles");
    assert.equal(report.windowHandles.length, 1, "Expected one actual Editkin native window");
    await command("POST", "/window/rect", { width: 1400, height: 950 });
    mark("native-window-and-ipc-ready");
    const ready = await poll("Interactive native editor", healthyState, (value) => value.desktop && value.ipc && value.toolbar
      && value.workspace === "editor" && value.blocked === "false" && !value.welcome && !value.guide, 30000);
    const url = new URL(ready.url);
    assert((url.protocol === "tauri:" && url.hostname === "localhost") || (["http:", "https:"].includes(url.protocol) && url.hostname === "tauri.localhost" && !url.port), `Expected embedded native assets, not browser/dev URL: ${ready.url}`);
    report.initial = ready;
    report.buildManifest = await evaluateAsync("window.__TAURI_INTERNALS__.invoke('release_input_manifest')");
    assert.equal(report.buildManifest.schemaVersion, 1, "Community build must use its separate identity schema");
    assert.equal(report.buildManifest.scope?.id, "editkin.community-desktop-build/v1", "Native smoke requires community build identity");
    assert.equal(report.buildManifest.scope?.officialRelease, false, "Community smoke must never attest an official release");
    const initialRecovery = await evaluateAsync("window.haoDesktop.loadRecovery()");
    assert.equal(initialRecovery.found, false, "Isolated profile must not restore an existing user project");
    assert.equal(initialRecovery.reason, "missing", "Initial native recovery read must succeed with missing state");
    // Desktop starts directly in the editor; browser onboarding remains a
    // separate flow. Exercise the native editor without onboarding clicks.
    for (const selector of [".project-menu", ".project-menu-group", '[data-testid="workspace-controls"]']) {
      if (!await evaluate("return !!document.querySelector(arguments[0])?.open;", [selector])) await click(`${selector} > summary`);
    }
    await click('[data-testid="workspace-controls"] .workspace-preset-grid button:nth-child(2)');
    await click(".project-menu > summary");
    const before = await poll("Shipped demo timeline", healthyState, (state) => state.workspace === "editor" && state.blocked === "false" && state.clipNames.length === 1);
    baselineClipNames = before.clipNames;
    assert.equal(before.captions.length, 0);
    assert.equal(before.undoEnabled, false);
    assert.equal(before.redoEnabled, false);
    report.fixture = { classification: "shipped public synthetic UI demo; not user footage", assetId: "asset-demo", clipId: "clip-demo", mediaUri: "editkin-demo-preview.mp4" };
    report.before = before;
    report.beforeScreenshot = await screenshot("01-native-demo-before");
    mark("user-adds-caption-through-visible-ui");
    await click(".timeline-more > summary");
    await click('[data-testid="add-caption-button"]');
    await click(".timeline-more > summary");
    const createdCaption = await poll("Caption creation", healthyState, (state) => state.captions.length === 1 && state.undoEnabled);
    const captionId = createdCaption.captions[0].id;
    assert(captionId, "Created caption must have a stable application ID");
    await poll("Visible caption text editor", healthyState, (state) => typeof state.captionInput === "string");
    mark("user-enters-distinct-caption-text");
    const userText = "Linux native caption edit";
    await replaceText('[data-testid="caption-text-input"]', userText);
    await poll("Caption draft accepts native keyboard input", healthyState, (state) => state.captionInput === userText);
    await click('[data-testid="caption-text-input-apply"]');
    const textEdited = await poll("User-entered caption appears on the timeline", healthyState, (state) => state.captions[0]?.text === userText && state.captionInput === userText);
    const originalTiming = { id: captionId, text: userText, start: textEdited.captions[0].start, duration: textEdited.captions[0].duration };
    assertCaption(textEdited, originalTiming);
    report.textEdited = textEdited;
    await click('[data-testid="caption-advanced"] > summary');
    mark("user-changes-caption-duration");
    // A single-digit replacement is one native input event/history edit. Capture,
    // rather than pin, the initial timing; undo must restore that observed value.
    const userDuration = originalTiming.duration === 5 ? 6 : 5;
    const expectedCaption = { ...originalTiming, duration: userDuration };
    await replaceText('[data-testid="caption-advanced"] .number-field input', String(userDuration), 1);
    const edited = await poll("User timing edit appears", healthyState, (state) => state.captions[0]?.duration === userDuration);
    assertCaption(edited, expectedCaption);
    report.edited = edited;
    mark("undo-and-redo-user-timing-edit");
    await click('[data-testid="undo-button"]');
    const undone = await poll("Undo restores previous caption timing", healthyState, (state) => state.captions[0]?.duration === originalTiming.duration && state.redoEnabled);
    assertCaption(undone, originalTiming);
    report.undone = undone;
    await click('[data-testid="redo-button"]');
    const redone = await poll("Redo restores user timing", healthyState, (state) => state.captions[0]?.duration === userDuration && state.undoEnabled && !state.redoEnabled);
    assertCaption(redone, expectedCaption);
    report.redone = redone;
    mark("native-autosave-and-event-loop-after-edit");
    const saved = await poll("Real native autosave of the redone edit", () => evaluateAsync("window.haoDesktop.loadRecovery()"), (value) => value.found && value.snapshot?.project?.captions?.some((caption) => caption.id === captionId && caption.text === userText && caption.duration === userDuration), 20000);
    const project = saved.snapshot.project;
    assert.equal(project.id, "editkin-demo");
    assert.equal(project.captions.length, 1);
    assert.deepEqual(project.captions.map(({ id, text, start, duration }) => ({ id, text, start, duration })), [expectedCaption]);
    const clips = project.tracks.flatMap((track) => track.clips);
    assert.deepEqual(clips.map(({ id, assetId, timelineStart, sourceStart, duration }) => ({ id, assetId, timelineStart, sourceStart, duration })), [{ id: "clip-demo", assetId: "asset-demo", timelineStart: 0, sourceStart: 0, duration: 12 }]);
    report.persistence = { route: "normal application autosave -> native load_recovery IPC -> real Node recovery service", savedAt: saved.snapshot.savedAt, projectId: project.id, caption: project.captions[0], unchangedVideoClip: clips[0] };
    await writeFile(resolve(workspace, "autosaved-demo.editkin.json"), json(project), { flag: "wx" });
    const frames = await evaluateAsync("new Promise(resolve=>requestAnimationFrame(first=>requestAnimationFrame(second=>resolve({first,second}))))");
    assert(frames.second > frames.first, "WebKit event loop did not advance after edit");
    assert.deepEqual(await evaluateAsync("window.__TAURI_INTERNALS__.invoke('release_input_manifest')"), report.buildManifest, "Native IPC must remain responsive after edit");
    assertCaption(await healthyState(), expectedCaption);
    report.eventLoop = { animationFrames: frames, nativeIpc: "release_input_manifest responds identically after real edit/undo/redo/autosave" };
    report.afterScreenshot = await screenshot("02-native-demo-redone");
    assert.equal((await identity(executable)).sha256, report.executable.sha256, "Binary changed during native journey");
    report.status = "GREEN";
    mark("focused-native-journey-complete");
  } catch (error) {
    report.failure = { stage: report.stage, input: report.input, message: error.message, stack: error.stack };
    if (session && !controller.signal.aborted) {
      try { report.failure.ui = await readState(); } catch (probeError) { report.failure.uiProbeError = probeError.message; }
      if (report.input) {
        try {
          report.failure.hitTest = await evaluate(`
            const target=document.querySelectorAll(arguments[0])[arguments[1]??0];
            if(!target)return {found:false};
            const r=target.getBoundingClientRect();
            const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
            const hit=document.elementFromPoint(x,y);
            return {found:true,target:{tag:target.tagName,classes:target.className,rect:{x:r.x,y:r.y,width:r.width,height:r.height}},point:{x,y},hit:hit?{tag:hit.tagName,classes:hit.className,testId:hit.dataset.testid}:null,intercepted:!!hit&&!target.contains(hit)};
          `, [report.input.selector, report.input.index ?? 0]);
        } catch (probeError) { report.failure.hitTestError = probeError.message; }
      }
      try { report.failure.screenshot = await screenshot("failure"); } catch (captureError) { report.failure.screenshotError = captureError.message; }
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    try { report.processesBeforeCleanup = await ownedProcessSnapshot(); }
    catch (error) { report.processInventoryError = error.message; report.status = "BLOCK"; process.exitCode = 1; }
    if (session) {
      try { await request("DELETE", `/session/${encodeURIComponent(session)}`, undefined, 5000, true); }
      catch (error) { report.sessionCleanupError = error.message; report.status = "BLOCK"; process.exitCode = 1; }
    }
    try { await stopOwnedGroup(); if (driver?.pid) await verifyOwnedProcessesExited(); }
    catch (error) { report.processCleanupError = error.message; report.status = "BLOCK"; process.exitCode = 1; }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    report.elapsedMs = Date.now() - started;
    await writeFile(resolve(workspace, "driver.stdout.txt"), stdout, { flag: "wx" });
    await writeFile(resolve(workspace, "driver.stderr.txt"), stderr, { flag: "wx" });
    const reportPath = resolve(workspace, "report.json");
    await writeFile(reportPath, json(report), { flag: "wx" });
    process.stdout.write(json({ status: report.status, scope: report.scope, executable: report.executable, reportPath, screenshot: report.afterScreenshot?.path, failure: report.failure, cleanupFailure: report.sessionCleanupError ?? report.processCleanupError }));
  }
}

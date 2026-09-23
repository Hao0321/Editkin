import { StrictMode, act, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createProjectSession, type ProjectSession } from "../../src/application/projectSession";
import type { RecoveryReadResult } from "../../src/application/recoveryFiles";
import { createEmptyProject } from "../../src/domain/editGraph";
import { dispatchCommand } from "../../src/domain/history";
import type { EditProject } from "../../src/domain/types";
import type { HaoDesktopApi } from "../../src/desktop/types";
import { RECOVERY_AUTOSAVE_DELAY_MS, useProjectRecovery } from "../../src/desktop/useProjectRecovery";

// This is a visible, auto-running development fixture, not a production entry point.
// All desktop operations below are intentionally confined to in-memory test doubles.
const reactTestEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; settled: boolean };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const pending: Deferred<T> = {
    promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }),
    resolve: (value) => { if (!pending.settled) { pending.settled = true; resolve(value); } },
    reject: (error) => { if (!pending.settled) { pending.settled = true; reject(error); } },
    settled: false,
  };
  return pending;
}

const FIXTURE_PATH = "fixture-memory://same-project.editkin.json";
const FIXED_TIME = "2026-08-31T00:00:00.000Z";
const missing: RecoveryReadResult = { found: false, reason: "missing" };
function project(name = "Original"): EditProject {
  return { ...createEmptyProject(name, { id: "same-project-id" }), updatedAt: FIXED_TIME };
}
function found(value = project("Recovered draft")): RecoveryReadResult {
  return { found: true, source: "primary", snapshot: {
    schemaVersion: 1, savedAt: FIXED_TIME, cleanUpdatedAt: FIXED_TIME,
    project: value, projectPath: FIXTURE_PATH,
  } };
}

type Write = { project: EditProject; projectPath?: string; cleanUpdatedAt: string; gate: Deferred<void> };
type MemoryRecovery = Omit<Write, "gate">;
type HookState = ReturnType<typeof useProjectRecovery>;
type Trace = { event: string; name?: string };

function createMockDesktop() {
  const loads: Deferred<RecoveryReadResult>[] = [];
  const previews: Deferred<Record<string, string>>[] = [];
  const clears: Deferred<void>[] = [];
  const writes: Write[] = [];
  const trace: Trace[] = [];
  const listeners = new Set<() => void>();
  let disk: MemoryRecovery | undefined;
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const implemented: Pick<HaoDesktopApi, "isDesktop" | "loadRecovery" | "previewUrls" | "clearRecovery" | "saveRecovery" | "integrationSmokeEnabled"> = {
    isDesktop: true,
    loadRecovery: () => { const gate = deferred<RecoveryReadResult>(); loads.push(gate); trace.push({ event: "load-start" }); changed(); return gate.promise; },
    integrationSmokeEnabled: async () => false,
    previewUrls: () => { const gate = deferred<Record<string, string>>(); previews.push(gate); trace.push({ event: "preview-start" }); changed(); return gate.promise; },
    clearRecovery: () => {
      const gate = deferred<void>(); clears.push(gate); trace.push({ event: "clear-start" }); changed();
      return gate.promise.then(() => { disk = undefined; trace.push({ event: "clear-complete" }); changed(); });
    },
    saveRecovery: (value, projectPath, cleanUpdatedAt) => {
      const write = { project: structuredClone(value), projectPath, cleanUpdatedAt, gate: deferred<void>() };
      writes.push(write); trace.push({ event: "write-start", name: value.name }); changed();
      return write.gate.promise.then(() => {
        disk = { project: write.project, projectPath, cleanUpdatedAt };
        trace.push({ event: "write-complete", name: write.project.name }); changed();
      });
    },
  };
  // Fail closed if the hook unexpectedly begins depending on another desktop method.
  const api = new Proxy(implemented, {
    get(target, key) {
      if (!(key in target)) throw new Error(`Unexpected desktop API access in fixture: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as HaoDesktopApi;
  return {
    api, loads, previews, clears, writes, trace,
    disk: () => disk,
    waitFor: (predicate: () => boolean, label: string) => waitForEvent(predicate, listeners, label),
    settleAll: () => {
      for (const gate of loads) gate.resolve(missing);
      for (const gate of previews) gate.resolve({});
      for (const gate of clears) gate.resolve();
      for (const write of writes) write.gate.resolve();
    },
  };
}

function waitForEvent(predicate: () => boolean, listeners: Set<() => void>, label: string): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`Timed out waiting for fixture event: ${label}`));
    }, 5_000);
    const check = () => {
      if (!predicate()) return;
      window.clearTimeout(timeout); listeners.delete(check); resolve();
    };
    listeners.add(check);
    check();
  });
}

async function flush(operation: () => unknown = () => undefined) {
  await act(async () => { operation(); await Promise.resolve(); });
}

function createHarness() {
  const desktop = createMockDesktop();
  const session = createProjectSession(project(), FIXTURE_PATH);
  const statuses: string[] = [];
  const restores: EditProject[] = [];
  const confirmations: string[] = [];
  const commits = new Set<() => void>();
  let state: HookState = { ready: false, dirty: false, recoveryState: "idle" };
  let confirmation: () => boolean = () => true;
  let root: Root | undefined;
  const originalConfirm = window.confirm;
  window.confirm = (message?: string) => { confirmations.push(String(message)); return confirmation(); };

  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const recovery = useProjectRecovery({
      api: desktop.api,
      project: snapshot.history.present,
      projectPath: snapshot.projectPath,
      cleanUpdatedAt: snapshot.cleanUpdatedAt,
      dirty: snapshot.dirty,
      recoveryOwner: snapshot.recoveryOwner,
      isRecoveryOwnerCurrent: session.isRecoveryOwnerCurrent,
      onRestore: (value, path, cleanUpdatedAt) => {
        restores.push(value);
        session.replaceProject(value, path, { dirty: true, cleanUpdatedAt });
      },
      onStatus: (message) => { statuses.push(message); },
    });
    state = recovery;
    useEffect(() => { for (const commit of [...commits]) commit(); });
    return <output data-testid="active-hook-state">{JSON.stringify({
      project: snapshot.history.present.name, sessionId: snapshot.sessionId,
      revision: snapshot.diskRevision, ...recovery,
    })}</output>;
  }

  return {
    desktop, session, statuses, restores, confirmations,
    state: () => state,
    confirmWith: (next: () => boolean) => { confirmation = next; },
    mount: async () => {
      root = createRoot(document.getElementById("active-host")!);
      await flush(() => root!.render(<StrictMode><Harness /></StrictMode>));
    },
    bootMissing: async () => { await flush(() => { for (const gate of desktop.loads) gate.resolve(missing); }); },
    edit: async (name: string) => { await flush(() => session.setHistory((history) => dispatchCommand(history, { type: "rename_project", name }))); },
    waitForState: async (predicate: (value: HookState) => boolean, label: string) => {
      // A browser-timer commit cannot be awaited *inside* async act: act would
      // defer that commit until its own callback (which awaits it) has returned.
      // Let the real browser scheduler commit, then flush any remaining effects.
      reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      try { await waitForEvent(() => predicate(state), commits, label); }
      finally { reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true; }
      await flush();
    },
    waitForWrite: async (count = 1) => {
      await act(async () => { await desktop.waitFor(() => desktop.writes.length >= count, `write ${count} (real ${RECOVERY_AUTOSAVE_DELAY_MS}ms debounce)`); });
      return desktop.writes[count - 1];
    },
    unmount: async () => { if (root) { const mounted = root; root = undefined; await flush(() => mounted.unmount()); } },
    dispose: async () => {
      try {
        if (root) { const mounted = root; root = undefined; await flush(() => mounted.unmount()); }
        await flush(desktop.settleAll);
      } finally { window.confirm = originalConfirm; }
    },
  };
}

type Harness = ReturnType<typeof createHarness>;
type Check = { label: string; passed: boolean; detail?: unknown };
type CaseResult = { id: string; title: string; status: "PASS" | "FAIL"; checks: Check[]; durationMs: number; error?: string; trace: Trace[] };
type Expect = (condition: unknown, label: string, detail?: unknown) => void;
type Case = { id: string; title: string; run: (h: Harness, expect: Expect) => Promise<void> };

function startSave(session: ProjectSession) {
  const request = session.beginSave();
  if (!request) throw new Error("Expected an owned save request");
  return request;
}
function saved(request: ReturnType<typeof startSave>) {
  return { path: FIXTURE_PATH, project: { ...structuredClone(request.project), revision: request.project.revision + 1, updatedAt: FIXED_TIME } };
}

const cases: Case[] = [
  {
    id: "strictmode-stale-startup-load", title: "StrictMode 的兩個舊 load 都不能覆蓋同 ID／同路徑的新專案",
    run: async (h, expect) => {
      expect(h.desktop.loads.length === 2, "React dev StrictMode replays startup effect exactly twice", h.desktop.loads.length);
      await flush(() => h.session.replaceProject(project("New same-id session"), FIXTURE_PATH));
      await flush(() => { for (const load of h.desktop.loads) load.resolve(found()); });
      expect(h.state().ready, "startup finally becomes ready");
      expect(h.session.getSnapshot().history.present.name === "New same-id session", "same-id replacement remains current");
      expect(h.restores.length === 0 && h.confirmations.length === 0 && h.desktop.previews.length === 0, "stale load cannot prompt, preview, or restore");
      expect(h.desktop.clears.length === 0 && h.statuses.length === 0, "stale load cannot clear recovery or publish old status");
    },
  },
  {
    id: "strictmode-positive-restore", title: "有效復原仍會成功；StrictMode 第一個已取消的 load 不會重複提示",
    run: async (h, expect) => {
      await flush(() => h.desktop.loads[0].resolve(found(project("Canceled first load"))));
      expect(h.confirmations.length === 0, "canceled StrictMode effect cannot prompt");
      await flush(() => h.desktop.loads[1].resolve(found()));
      expect(h.confirmations.length === 1 && h.desktop.previews.length === 1, "live startup confirms and previews exactly once");
      await flush(() => h.desktop.previews[0].resolve({}));
      expect(h.restores.length === 1 && h.session.getSnapshot().history.present.name === "Recovered draft", "live recovery is restored, not globally disabled");
      expect(h.state().ready && h.state().dirty, "restored recovery remains dirty even with equal timestamps");
      expect(h.desktop.clears.length === 0, "restored unsaved work is not cleared");
    },
  },
  {
    id: "stale-startup-preview", title: "預覽 URL 尚未完成時切換專案，舊復原結果不能套回來",
    run: async (h, expect) => {
      await flush(() => { h.desktop.loads[0].resolve(missing); h.desktop.loads[1].resolve(found()); });
      expect(h.desktop.previews.length === 1, "startup reached deferred preview");
      await flush(() => h.session.replaceProject(project("Opened same-id project"), FIXTURE_PATH));
      await flush(() => h.desktop.previews[0].resolve({ stale: "fixture-only://preview" }));
      expect(h.restores.length === 0 && h.statuses.length === 0, "stale preview completion cannot restore or publish success");
      expect(h.state().ready && h.session.getSnapshot().history.present.name === "Opened same-id project", "replacement project becomes ready unchanged");
    },
  },
  {
    id: "positive-decline-clear", title: "目前專案拒絕復原時，只清除一次並正常就緒",
    run: async (h, expect) => {
      h.confirmWith(() => false);
      await flush(() => { h.desktop.loads[0].resolve(missing); h.desktop.loads[1].resolve(found()); });
      expect(h.confirmations.length === 1 && h.desktop.clears.length === 1, "current decline performs one guarded clear");
      expect(!h.state().ready, "startup waits for its clear to finish");
      await flush(() => h.desktop.clears[0].resolve());
      expect(h.state().ready && h.restores.length === 0, "declined recovery does not restore");
      expect(h.desktop.clears.length === 1 && h.desktop.writes.length === 0, "initial clean render causes no duplicate clear/write");
    },
  },
  {
    id: "stale-decline-no-clear", title: "確認對話框期間換到新工作，舊的拒絕結果不能清掉新復原資料",
    run: async (h, expect) => {
      h.confirmWith(() => { h.session.replaceProject(project("New during confirm"), FIXTURE_PATH, { dirty: true }); return false; });
      await flush(() => { h.desktop.loads[0].resolve(missing); h.desktop.loads[1].resolve(found()); });
      expect(h.desktop.clears.length === 0 && h.restores.length === 0, "stale decline is rejected before clear IPC");
      const write = await h.waitForWrite();
      expect(write.project.name === "New during confirm", "new session autosaves its own work");
      await flush(() => write.gate.resolve());
      expect(h.desktop.disk()?.project.name === "New during confirm" && h.state().recoveryState === "saved", "new recovery survives stale decline");
    },
  },
  {
    id: "startup-clear-before-new-write", title: "啟動清理已送出後新增修改，先完成清理再寫入新復原快照",
    run: async (h, expect) => {
      await flush(() => { h.desktop.loads[0].resolve(missing); h.desktop.loads[1].resolve({ found: false, reason: "stale" }); });
      expect(h.desktop.clears.length === 1 && !h.state().ready, "startup stale-file clear is in flight");
      await flush(() => h.session.replaceProject(project("Draft after clear began"), FIXTURE_PATH, { dirty: true }));
      await flush(() => h.desktop.clears[0].resolve());
      const write = await h.waitForWrite();
      expect(h.desktop.trace.findIndex((item) => item.event === "clear-complete") < h.desktop.trace.findIndex((item) => item.event === "write-start"), "clear completion precedes new recovery write");
      await flush(() => write.gate.resolve());
      expect(h.desktop.disk()?.project.name === "Draft after clear began", "latest draft is the final memory recovery");
      expect(h.statuses.length === 0, "stale startup cleanup does not publish status into new session");
    },
  },
  {
    id: "queued-clear-invalidated-by-edit", title: "舊 autosave 後面排隊的清理，遇到新修改必須在執行前取消",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Draft A");
      const firstWrite = await h.waitForWrite();
      await flush(() => { const request = startSave(h.session); h.session.completeSave(request, saved(request)); h.session.finishSave(request); });
      expect(!h.session.getSnapshot().dirty && h.desktop.clears.length === 0, "clean-save clear is queued behind in-flight write");
      await h.edit("Draft B");
      await h.waitForState((state) => state.recoveryState === "saving", "new dirty write queued behind first write");
      await flush(() => firstWrite.gate.resolve());
      const secondWrite = await h.waitForWrite(2);
      expect(h.desktop.clears.length === 0, "stale queued clear never reaches desktop API");
      expect(secondWrite.project.name === "Draft B", "next write contains later edit");
      await flush(() => secondWrite.gate.resolve());
      expect(h.desktop.disk()?.project.name === "Draft B" && h.state().dirty, "latest unsaved work remains recoverable and dirty");
    },
  },
  {
    id: "inflight-clear-before-edit-write", title: "手動儲存後清理正在執行，新修改的 autosave 必須排在它後面",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Saved A");
      await flush(() => { const request = startSave(h.session); h.session.completeSave(request, saved(request)); h.session.finishSave(request); });
      expect(h.desktop.clears.length === 1, "manual save starts one current clean clear");
      await h.edit("Unsaved B");
      await h.waitForState((state) => state.recoveryState === "saving", "later edit reaches real debounce boundary");
      expect(h.desktop.writes.length === 0, "new write cannot overtake in-flight clear");
      await flush(() => h.desktop.clears[0].resolve());
      const write = await h.waitForWrite();
      await flush(() => write.gate.resolve());
      expect(h.desktop.disk()?.project.name === "Unsaved B", "new write survives clear completion");
      expect(h.state().dirty && h.state().recoveryState === "saved", "autosave is saved while manual-save dirty flag remains true");
    },
  },
  {
    id: "save-edit-interleave-equal-time", title: "送出 A、繼續改 B、A 儲存完成：保留 B 並同步新磁碟版本",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Submitted A");
      let request!: ReturnType<typeof startSave>;
      await flush(() => { request = startSave(h.session); });
      await h.edit("Later B");
      await flush(() => {
        h.session.setHistory((history) => ({ ...history, present: { ...history.present, updatedAt: FIXED_TIME } }));
        h.session.completeSave(request, saved(request)); h.session.finishSave(request);
      });
      const snapshot = h.session.getSnapshot();
      expect(snapshot.history.present.name === "Later B" && snapshot.dirty, "save acknowledgment cannot replace B or mark it clean");
      expect(snapshot.diskRevision === 1 && snapshot.history.present.revision === 1, "new edit adopts acknowledged disk revision");
      expect(snapshot.cleanUpdatedAt === snapshot.history.present.updatedAt, "control actually uses identical clean and dirty timestamps");
      expect(document.title.startsWith("● Later B"), "real dirty title effect stays enabled");
      const write = await h.waitForWrite();
      expect(write.project.name === "Later B" && write.project.revision === 1 && write.projectPath === FIXTURE_PATH, "recovery uses B with updated disk metadata");
      await flush(() => write.gate.resolve());
      expect(h.desktop.clears.length === 0 && h.desktop.disk()?.project.name === "Later B", "interleaved save never clears newer recovery");
    },
  },
  {
    id: "same-id-save-session-switch", title: "同 ID、同路徑重開後，舊手動儲存回應不能碰新 session",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Old submitted draft");
      let request!: ReturnType<typeof startSave>;
      await flush(() => { request = startSave(h.session); });
      await flush(() => h.session.replaceProject(project("New same-id unsaved draft"), FIXTURE_PATH, { dirty: true }));
      let accepted = true;
      await flush(() => { accepted = h.session.completeSave(request, saved(request)); h.session.finishSave(request); });
      expect(!accepted && h.session.getSnapshot().diskRevision === 0, "old save response is rejected by session identity, not project ID");
      expect(h.session.getSnapshot().dirty && !h.session.getSnapshot().savePending, "new dirty state survives while old operation lock releases");
      const write = await h.waitForWrite();
      await flush(() => write.gate.resolve());
      expect(h.desktop.disk()?.project.name === "New same-id unsaved draft" && h.desktop.clears.length === 0, "new session owns recovery and cannot be cleared by old save");
    },
  },
  {
    id: "write-failure-retry", title: "桌面 API 字串錯誤可見，後續修改仍可 autosave",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Write that fails");
      const firstWrite = await h.waitForWrite();
      await flush(() => firstWrite.gate.reject("fixture disk denied"));
      expect(h.state().recoveryState === "error" && h.statuses.some((message) => message.includes("fixture disk denied")), "current string rejection is visible with original detail");
      await h.edit("Retry succeeds");
      const retry = await h.waitForWrite(2);
      await flush(() => retry.gate.resolve());
      expect(h.state().recoveryState === "saved" && h.desktop.disk()?.project.name === "Retry succeeds", "rejected write cannot poison serialized queue");
    },
  },
  {
    id: "stale-write-error-new-session", title: "舊 autosave 失敗不能在新專案顯示假錯誤，也不能阻塞後續寫入",
    run: async (h, expect) => {
      await h.bootMissing(); await h.edit("Old in-flight write");
      const old = await h.waitForWrite();
      await flush(() => h.session.replaceProject(project("New after old write"), FIXTURE_PATH, { dirty: true }));
      await flush(() => old.gate.reject("stale fixture write failure"));
      expect(!h.statuses.some((message) => message.includes("stale fixture write failure")), "stale failure cannot publish status into new session");
      const next = await h.waitForWrite(2);
      await flush(() => next.gate.resolve());
      expect(h.desktop.disk()?.project.name === "New after old write" && h.state().recoveryState === "saved", "new recovery succeeds after old failure");
    },
  },
  {
    id: "unmounted-preview-no-restore", title: "卸載後的延遲 preview 不會復原或發布狀態",
    run: async (h, expect) => {
      await flush(() => { h.desktop.loads[0].resolve(missing); h.desktop.loads[1].resolve(found()); });
      expect(h.desktop.previews.length === 1, "preview was actually pending before unmount");
      await h.unmount();
      await flush(() => h.desktop.previews[0].resolve({}));
      expect(h.restores.length === 0 && h.statuses.length === 0 && h.desktop.clears.length === 0, "unmounted startup callbacks cannot mutate ownership or recovery");
    },
  },
];

async function run() {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  const summary = document.getElementById("summary")!;
  const report = document.getElementById("result")!;
  const list = document.getElementById("checks")!;
  const originalTitle = document.title;
  for (const test of cases) {
    const row = document.createElement("li");
    row.textContent = `RUNNING · ${test.title}`;
    list.appendChild(row);
    summary.textContent = `RUNNING — ${results.length + 1}/${cases.length} · ${test.id}`;
    const checks: Check[] = [];
    const h = createHarness();
    const start = performance.now();
    let error: string | undefined;
    const expect: Expect = (condition, label, detail) => {
      checks.push({ label, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
      if (!condition) throw new Error(label + (detail === undefined ? "" : `: ${JSON.stringify(detail)}`));
    };
    try { await h.mount(); await test.run(h, expect); }
    catch (failure) { error = failure instanceof Error ? failure.stack ?? failure.message : String(failure); }
    finally {
      try { await h.dispose(); }
      catch (failure) { error = `${error ?? ""}\nFixture cleanup failed: ${String(failure)}`.trim(); }
    }
    const result: CaseResult = {
      id: test.id, title: test.title, status: error ? "FAIL" : "PASS", checks,
      durationMs: Math.round(performance.now() - start), ...(error ? { error } : {}), trace: h.desktop.trace,
    };
    results.push(result);
    row.textContent = `${result.status} · ${test.title} (${checks.filter((check) => check.passed).length}/${checks.length} checks)`;
    row.className = result.status.toLowerCase();
    report.textContent = JSON.stringify({ status: "RUNNING", completed: results.length, total: cases.length, cases: results }, null, 2);
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const status = passed === cases.length ? "PASS" : "FAIL";
  const final = {
    schema: "editkin.save-recovery-react-browser-fixture/v1", status, startedAt,
    finishedAt: new Date().toISOString(), expectedCases: cases.length, passedCases: passed,
    checks: results.reduce((total, result) => total + result.checks.length, 0),
    reactMode: "React 19 development StrictMode; real useSyncExternalStore and effects",
    productionImports: ["src/desktop/useProjectRecovery.ts", "src/application/projectSession.ts"],
    scheduling: { deferredDesktopPromises: true, autosaveDebounce: "real browser timer", debounceMs: RECOVERY_AUTOSAVE_DELAY_MS, eventDeadlineMs: 5_000 },
    evidenceBoundary: { mockDesktopApi: true, mockConfirm: true, inMemoryRecoveryDisk: true, nativeDialogs: false, actualFilesystem: false, packagedExe: false, userDataTouched: false },
    cases: results,
  };
  report.textContent = JSON.stringify(final, null, 2);
  summary.dataset.status = status;
  summary.textContent = `${status} — ${passed}/${cases.length} cases; ${final.checks} assertions · mock desktop API / real React hook integration`;
  document.title = `${status} — ${originalTitle}`;
}

void run().catch((error) => {
  const summary = document.getElementById("summary")!;
  summary.dataset.status = "FAIL";
  summary.textContent = `FAIL — fixture runner failed: ${String(error)}`;
  document.getElementById("result")!.textContent = JSON.stringify({ status: "FAIL", runnerError: String(error) }, null, 2);
});

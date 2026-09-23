import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createDemoProject } from "../domain/demo";
import { readProjectFile, writeProjectFileAtomic } from "./projectFiles";

type Message = { type: string; pid: number; revision?: number; name?: string; message?: string; boundary?: string };
type ProcessRecord = { pid?: number; args: string[]; messages: Message[]; closed: boolean; code?: number | null; signal?: string | null; stderr: string; error?: string };
const records: ProcessRecord[] = [];
const within = async <T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`Owned process deadline: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
};

function writer(path: string, mode: string, revision: number, name: string) {
  const args = ["--import", "tsx", "scripts/fixtures/project-save-process.ts", path, mode, String(revision), name];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: resolve(import.meta.dirname, "../.."), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const record: ProcessRecord = { pid: child.pid, args, messages: [], closed: false, stderr: "" };
  records.push(record);
  child.stdout?.resume();
  child.stderr?.on("data", chunk => { record.stderr = (record.stderr + String(chunk)).slice(-8000); });
  child.on("message", message => record.messages.push(message as Message));
  child.on("error", error => { record.error = error.message; });
  const closed = new Promise<void>(resolveClosed => child.once("close", (code, signal) => {
    record.closed = true; record.code = code; record.signal = signal; resolveClosed();
  }));
  const waitFor = async (type: string) => {
    const prior = record.messages.find(message => message.type === type);
    if (prior) return prior;
    let onMessage: (message: unknown) => void;
    const waiting = new Promise<Message>((resolveMessage, reject) => {
      onMessage = message => { if ((message as Message).type === type) resolveMessage(message as Message); };
      child.on("message", onMessage);
      void closed.then(() => reject(Error(`Child closed before ${type}: ${JSON.stringify(record)}`)));
    });
    try { return await within(waiting, type); }
    finally { child.off("message", onMessage!); }
  };
  return {
    record, waitFor,
    release: () => child.send("release"),
    finish: async () => { await within(closed, "normal close"); expect(record.code).toBe(0); },
    stop: async () => {
      if (!record.closed) child.kill("SIGKILL"); // Exact child we created; never a discovered PID.
      await within(closed, "owned child termination");
    },
  };
}

async function fixture(run: (path: string, start: (mode: string, revision: number, name: string) => ReturnType<typeof writer>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "editkin-project-process-"));
  const path = join(directory, "project.editkin.json");
  const children: ReturnType<typeof writer>[] = [];
  try {
    const base = { ...createDemoProject(), revision: 1, name: "Durable original" };
    await writeFile(path, JSON.stringify(base), "utf8");
    await run(path, (mode, revision, name) => {
      const child = writer(path, mode, revision, name); children.push(child); return child;
    });
  } finally {
    // Failed stop keeps the fixture rather than deleting under an unknown owner.
    await Promise.all(children.map(child => child.stop()));
    await rm(directory, { recursive: true, force: true });
  }
}

afterAll(async () => {
  if (process.env.EDITKIN_PROJECT_LOCK_EVIDENCE) {
    await writeFile(process.env.EDITKIN_PROJECT_LOCK_EVIDENCE, JSON.stringify(records, null, 2), { flag: "wx" });
  }
});

describe("process-owned project save", () => {
  it("excludes a live independent writer without blocking the waiting event loop", async () => fixture(async (path, start) => {
    const owner = start("before-temp", 1, "Owner commit");
    expect((await owner.waitFor("held")).boundary).toBe("before-temp");
    expect(() => process.kill(owner.record.pid!, 0)).not.toThrow();
    const original = await readFile(path, "utf8");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await expect(writeProjectFileAtomic(path, { ...await readProjectFile(path), name: "Contender" }, 1)).rejects.toThrow(/鎖|儲存/);
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(2);
    expect(await readFile(path, "utf8")).toBe(original);
    owner.release();
    expect((await owner.waitFor("saved")).revision).toBe(2);
    await owner.finish();
    expect((await readProjectFile(path)).name).toBe("Owner commit");
  }), 20_000);

  it.each(["before-temp", "before-publish"])("recovers after real writer termination at %s", async mode => fixture(async (path, start) => {
    const owner = start(mode, 1, "Interrupted edit");
    expect((await owner.waitFor("held")).boundary).toBe(mode);
    await owner.stop();
    expect(() => process.kill(owner.record.pid!, 0)).toThrow();
    expect(await readProjectFile(path)).toMatchObject({ revision: 1, name: "Durable original" });
    const recovery = start("save", 1, "Recovered edit");
    expect((await recovery.waitFor("saved")).revision).toBe(2);
    await recovery.finish();
    expect(await readProjectFile(path)).toMatchObject({ revision: 2, name: "Recovered edit" });
  }), 20_000);

  it("preserves a published revision after writer death and rejects stale clients", async () => fixture(async (path, start) => {
    const owner = start("after-publish", 1, "Already committed");
    await owner.waitFor("held");
    await owner.stop();
    expect(await readProjectFile(path)).toMatchObject({ revision: 2, name: "Already committed" });
    const stale = start("save", 1, "Must not overwrite");
    expect((await stale.waitFor("failed")).name).toBe("ProjectRevisionConflictError");
    await stale.finish();
    const current = start("save", 2, "Reloaded then saved");
    expect((await current.waitFor("saved")).revision).toBe(3);
    await current.finish();
    expect(await readProjectFile(path)).toMatchObject({ revision: 3, name: "Reloaded then saved" });
  }), 20_000);

  it("admits exactly one of two real writers with the same expected revision", async () => fixture(async (path, start) => {
    const a = start("save", 1, "Writer A"), b = start("save", 1, "Writer B");
    await Promise.all([a.finish(), b.finish()]);
    const messages = [...a.record.messages, ...b.record.messages];
    expect(messages.filter(message => message.type === "saved")).toHaveLength(1);
    expect(messages.filter(message => message.type === "failed")).toMatchObject([{ name: "ProjectRevisionConflictError" }]);
    expect((await readProjectFile(path)).revision).toBe(2);
  }), 20_000);

  it("releases ownership on cleanup I/O failure while the writer remains alive", async () => fixture(async (path, start) => {
    const owner = start("cleanup-error", 1, "Published before cleanup error");
    expect((await owner.waitFor("failed")).message).toBe("injected temporary cleanup failure");
    expect(() => process.kill(owner.record.pid!, 0)).not.toThrow();
    expect((await readProjectFile(path)).revision).toBe(2);
    const retry = start("save", 2, "Save after error");
    expect((await retry.waitFor("saved")).revision).toBe(3);
    await retry.finish();
    owner.release(); await owner.finish();
    expect((await readProjectFile(path)).name).toBe("Save after error");
  }), 20_000);
});

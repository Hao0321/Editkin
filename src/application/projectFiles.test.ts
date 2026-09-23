import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDemoProject } from "../domain/demo";
import { ProjectRevisionConflictError, readProjectFile, writeProjectFileAtomic } from "./projectFiles";

describe("desktop project files", () => {
  it("atomically saves, overwrites and reopens EditGraph v4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hao-project-files-"));
    const path = join(directory, "project.editkin.json");
    try {
      const first = await writeProjectFileAtomic(path, createDemoProject());
      expect(first.revision).toBe(1);
      const second = await writeProjectFileAtomic(path, { ...first, name: "第二版" });
      expect(second.revision).toBe(2);
      expect(await readProjectFile(path)).toMatchObject({ name: "第二版", revision: 2 });
      expect(JSON.parse(await readFile(`${path}.previous`, "utf8"))).toMatchObject({ revision: 1 });
      expect(await readFile(path, "utf8")).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers the last durable revision when the primary is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hao-project-recovery-"));
    const path = join(directory, "project.editkin.json");
    try {
      const first = await writeProjectFileAtomic(path, createDemoProject());
      await writeProjectFileAtomic(path, { ...first, name: "第二版" });
      await writeFile(path, "{broken", "utf8");
      expect(await readProjectFile(path)).toMatchObject({ revision: 1, name: first.name });
      await writeFile(`${path}.previous`, "{also-broken", "utf8");
      await expect(readProjectFile(path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writers and rejects a lost update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hao-project-conflict-"));
    const path = join(directory, "project.editkin.json");
    try {
      const base = await writeProjectFileAtomic(path, createDemoProject());
      const settled = await Promise.allSettled([
        writeProjectFileAtomic(path, { ...base, name: "Agent A" }, base.revision),
        writeProjectFileAtomic(path, { ...base, name: "Agent B" }, base.revision),
      ]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ProjectRevisionConflictError);
      expect((await readProjectFile(path)).revision).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "fresh live-owner", ageMs: 0, liveOwner: true },
    { label: "backdated live-owner", ageMs: 180_000, liveOwner: true },
    { label: "backdated unidentified-owner", ageMs: 180_000, liveOwner: false },
  ])("preserves a $label lock and rejects the competing save", async ({ ageMs, liveOwner }) => {
    const directory = await mkdtemp(join(tmpdir(), "hao-project-lock-safety-"));
    const path = join(directory, "project.editkin.json");
    try {
      // A pre-existing legacy project/lock must not be produced by the new
      // lock implementation: this fixture stays identical across protocols.
      const base = createDemoProject();
      await writeFile(path, JSON.stringify(base), "utf8");
      const original = await readFile(path, "utf8");
      const token = liveOwner ? `${process.pid}:${randomUUID()}\n` : "unidentified writer\n";
      // This process is the independently live lease owner, not a made-up PID.
      if (liveOwner) expect(() => process.kill(process.pid, 0)).not.toThrow();
      await writeFile(`${path}.lock`, token, { encoding: "utf8", flag: "wx" });
      const timestamp = new Date(Date.now() - ageMs);
      await utimes(`${path}.lock`, timestamp, timestamp);
      const [attempt] = await Promise.allSettled([
        writeProjectFileAtomic(path, { ...base, name: "Competing writer" }, base.revision),
      ]);
      expect.soft(attempt.status).toBe("rejected");
      if (attempt.status === "rejected") expect(attempt.reason.message).toMatch(/儲存|鎖/);
      // Always inspect durable bytes, even if the contender was wrongly admitted.
      expect.soft(await readFile(path, "utf8")).toBe(original);
      expect.soft(await readFile(`${path}.lock`, "utf8").catch(() => null)).toBe(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

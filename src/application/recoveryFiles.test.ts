import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { clearRecoveryFile, parseRecoverySnapshot, readRecoveryFile, writeRecoveryFileAtomic } from "./recoveryFiles";

const now = Date.parse("2026-08-21T12:00:00.000Z");

describe("crash recovery files", () => {
  it("writes and reads a bounded validated snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-recovery-"));
    const path = join(root, "session.json");
    const project = createEmptyProject();
    const snapshot = await writeRecoveryFileAtomic(path, { project, cleanUpdatedAt: project.updatedAt }, { nowMs: now });
    const loaded = await readRecoveryFile(path, { nowMs: now });
    expect(snapshot.savedAt).toBe("2026-08-21T12:00:00.000Z");
    expect(loaded).toMatchObject({ found: true, source: "primary", snapshot: { project: { id: project.id } } });
  });

  it("recovers the previous valid generation when the primary is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-recovery-"));
    const path = join(root, "session.json");
    const first = { ...createEmptyProject(), name: "first" };
    const second = { ...createEmptyProject(), name: "second" };
    await writeRecoveryFileAtomic(path, { project: first, cleanUpdatedAt: first.updatedAt }, { nowMs: now });
    await writeRecoveryFileAtomic(path, { project: second, cleanUpdatedAt: second.updatedAt }, { nowMs: now + 1_000 });
    await writeFile(path, "not json", "utf8");
    const loaded = await readRecoveryFile(path, { nowMs: now + 2_000 });
    expect(loaded).toMatchObject({ found: true, source: "previous", snapshot: { project: { name: "first" } } });
  });

  it("rejects stale, future and oversized snapshots", async () => {
    const project = createEmptyProject();
    expect(() => parseRecoverySnapshot({ schemaVersion: 1, savedAt: "2020-01-01T00:00:00Z", cleanUpdatedAt: project.updatedAt, project }, now)).toThrow("已過期");
    expect(() => parseRecoverySnapshot({ schemaVersion: 1, savedAt: "2026-08-22T00:00:00Z", cleanUpdatedAt: project.updatedAt, project }, now)).toThrow("來自未來");
    const root = await mkdtemp(join(tmpdir(), "editkin-recovery-"));
    await expect(writeRecoveryFileAtomic(join(root, "session.json"), { project, cleanUpdatedAt: project.updatedAt }, { nowMs: now, maxBytes: 32 })).rejects.toThrow("32 MiB");
  });

  it("clears both recovery generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-recovery-"));
    const path = join(root, "session.json");
    const project = createEmptyProject();
    await writeRecoveryFileAtomic(path, { project, cleanUpdatedAt: project.updatedAt }, { nowMs: now });
    await writeRecoveryFileAtomic(path, { project, cleanUpdatedAt: project.updatedAt }, { nowMs: now + 1_000 });
    await clearRecoveryFile(path);
    await expect(readRecoveryFile(path, { nowMs: now + 2_000 })).resolves.toEqual({ found: false, reason: "missing" });
  });
});

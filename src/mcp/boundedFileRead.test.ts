// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBoundedFile, readBoundedFileSync } from "./boundedFileRead";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("reads a bounded opened file and rejects a directory link outside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "editkin-bounded-read-"));
  roots.push(root);
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside);
  const internal = join(workspace, "document.txt");
  await writeFile(internal, "trusted");
  expect(readBoundedFileSync(internal, workspace, 7).toString()).toBe("trusted");
  expect((await readBoundedFile(internal, workspace, 7)).toString()).toBe("trusted");
  expect(() => readBoundedFileSync(internal, workspace, 6)).toThrow();
  await writeFile(join(outside, "document.txt"), "outside");
  await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => readBoundedFileSync(join(workspace, "linked", "document.txt"), workspace, 64)).toThrow();
  await expect(readBoundedFile(join(workspace, "linked", "document.txt"), workspace, 64)).rejects.toThrow();
});

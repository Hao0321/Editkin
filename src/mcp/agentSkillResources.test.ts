// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateAgentContextTokens, AGENT_CONTEXT_MAX_TOKENS } from "../application/agentContextBudget";
import inventory from "../shared/originalAgentSkills.json";
import { listOriginalSkillResources, readOriginalSkillResource } from "./agentSkillResources";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(text: string) {
  const parent = await mkdtemp(join(tmpdir(), "editkin-original-skills-test-")); roots.push(parent);
  const root = join(parent, "kit"); await mkdir(join(root, "references"), { recursive: true });
  const file = join(root, "references/example.md"); await writeFile(file, text);
  const manifest = { ...inventory, files: [{ ...inventory.files[0], resource: "references/example.md",
    bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }] };
  return { root, file, parent, manifest };
}
describe("pinned original Agent skill access", () => {
  it("lists every original resource without flattening all documentation into context", () => {
    const names: string[] = [];
    let offset = 0;
    do {
      const page = listOriginalSkillResources({ offset, limit: 20 });
      expect(estimateAgentContextTokens(JSON.stringify(page))).toBeLessThanOrEqual(AGENT_CONTEXT_MAX_TOKENS);
      expect(page.skills.map((skill) => skill.role)).toEqual(["editing", "maintenance-reference", "editor-skill-pack"]);
      names.push(...page.resources.map((resource) => resource.resource));
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    } while (true);
    expect(names).toEqual(inventory.files.map((file) => file.resource));
    expect(new Set(names).size).toBe(inventory.files.length);
  });
  it("reconstructs long multilingual resources with bounded lossless pages", async () => {
    const text = ('剪輯🎬 guide \\"line\\"\n'.repeat(3_000));
    const f = await fixture(text);
    let offset = 0, reconstructed = "", pages = 0;
    do {
      const page = await readOriginalSkillResource(f.root, "references/example.md", { offset }, f.manifest);
      expect(estimateAgentContextTokens(JSON.stringify(page))).toBeLessThanOrEqual(AGENT_CONTEXT_MAX_TOKENS);
      expect(page.sha256).toBe(f.manifest.files[0].sha256);
      expect(page.text.endsWith("\uD83C")).toBe(false);
      reconstructed += page.text; pages++;
      if (page.complete) { expect(page.nextOffset).toBeUndefined(); break; }
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!;
    } while (true);
    expect(pages).toBeGreaterThan(10); expect(reconstructed).toBe(text);
  });
  it.each(["../.env", "auth.json", "references/../../secrets.md", "SKILL.md/../.env", "C:/private.md"])("rejects unlisted paths before filesystem access: %s", async (name) => {
    await expect(readOriginalSkillResource("nonexistent", name)).rejects.toThrow("Unknown original skill resource");
  });
  it("rejects altered original bytes rather than returning local or injected text", async () => {
    const f = await fixture("trusted original"); await writeFile(f.file, "untrusted secret");
    await expect(readOriginalSkillResource(f.root, "references/example.md", {}, f.manifest)).rejects.toThrow("integrity");
  });
  it("rejects a resource directory link leaving the selected Kit", async () => {
    const f = await fixture("trusted original");
    await rm(join(f.root, "references"), { recursive: true });
    const outside = join(f.parent, "outside"); await mkdir(outside); await writeFile(join(outside, "example.md"), "trusted original");
    await symlink(outside, join(f.root, "references"), process.platform === "win32" ? "junction" : "dir");
    await expect(readOriginalSkillResource(f.root, "references/example.md", {}, f.manifest)).rejects.toThrow("escapes selected Kit");
  });
  it("rejects invalid offsets, split code points and excessive reads", async () => {
    const f = await fixture("🎬caption");
    for (const offset of [-1, 0.5, 1, 99]) await expect(readOriginalSkillResource(f.root, "references/example.md", { offset }, f.manifest)).rejects.toThrow();
    await expect(readOriginalSkillResource(f.root, "references/example.md", { maxChars: 4001 }, f.manifest)).rejects.toThrow("maxChars");
    expect(() => listOriginalSkillResources({ limit: 21 })).toThrow("limit");
    expect(() => listOriginalSkillResources({ filter: "no matches", offset: 1 })).toThrow("offset");
  });
});

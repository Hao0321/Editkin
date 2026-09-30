// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const originalKitCommit = "9fcd84691a0a2c2af1b8144ca5b6d4df04d7b0ba";
const editorCommit = "41163ea553f79fd58abe5d7bedea91af6a2d1c38";
const digest = data => createHash("sha256").update(data).digest("hex");
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 4_000_000 });

export async function deriveOriginalAgentSkills(root) {
  const kit = resolve(root, "../video-tool-research/video-autopilot-kit");
  if (git(kit, ["rev-parse", "HEAD"]).toString().trim() !== originalKitCommit || git(kit, ["status", "--porcelain"]).length)
    throw new Error("Original Kit is not the pinned clean checkout");
  const kitFiles = git(kit, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  const entries = kitFiles.filter(name => name.startsWith("codex-skill/video-autopilot/")
    || name.startsWith("tools/code-cleanup-helper/") || name.startsWith("knowledge/") || name.startsWith("templates/"))
    .map(name => ({ repository: "video-autopilot-kit", sourcePath: name, resource: name.startsWith("codex-skill/video-autopilot/")
      ? name.slice("codex-skill/video-autopilot/".length) : `upstream/${name}`, license: "MIT" }));
  const skills = [{ id: "video-autopilot", role: "editing", entry: "SKILL.md" },
    { id: "code-cleanup-helper", role: "maintenance-reference", entry: "upstream/tools/code-cleanup-helper/SKILL.md" },
    { id: "studio.hao.creator-workflow/balanced-creator-workflow", role: "editor-skill-pack", entry: "upstream/editor/creator-workflow/editkin-skill.json" }];
  const skillEntrypoints = kitFiles.filter(name => name.endsWith("/SKILL.md"));
  if (skillEntrypoints.some(name => !entries.some(entry => entry.sourcePath === name)))
    throw new Error("An original Git Skill is missing from the package inventory");
  const editorSkills = git(root, ["ls-tree", "-r", "--name-only", "-z", editorCommit]).toString("utf8").split("\0")
    .filter(name => /(?:^|\/)(?:SKILL\.md|editkin-skill\.json)$/.test(name));
  if (editorSkills.length !== 1 || editorSkills[0] !== "plugins/creator-workflow/editkin-skill.json")
    throw new Error("Original editor Skill inventory changed; explicitly review all entrypoints");
  for (const name of ["plugins/creator-workflow/editkin-plugin.json", "plugins/creator-workflow/editkin-skill.json", "video-autopilot-skill-integration.json"]) {
    entries.push({ repository: "editkin", sourcePath: name, resource: name.startsWith("plugins/")
      ? `upstream/editor/creator-workflow/${name.split("/").at(-1)}` : `upstream/editor/${name}`, license: "GPL-3.0-or-later" });
  }
  entries.push({ repository: "video-autopilot-kit", sourcePath: "LICENSE", resource: "Kit-LICENSE.txt", license: "MIT" });
  const files = [];
  for (const entry of entries.sort((a, b) => a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)) {
    if (entry.resource.split("/").some(part => !part || part === "." || part === "..")
      || /(?:^|\/)(?:\.env|\.dev\.vars|auth\.json|credentials\.json)/iu.test(entry.sourcePath))
      throw new Error("Invalid public original Skill path");
    const base = await realpath(entry.repository === "editkin" ? root : kit);
    const path = resolve(base, entry.sourcePath), actual = await realpath(path), relation = relative(base, actual);
    if (!relation || relation.startsWith("..") || isAbsolute(relation) || (await lstat(path)).isSymbolicLink()
      || !/^(?:[a-zA-Z0-9_./-]+)$/u.test(entry.resource) || /(?:^|\/)(?:\.env|auth\.json|credentials\.json)/iu.test(entry.resource))
      throw new Error("Invalid public original Skill resource");
    const data = await readFile(path);
    if (data.length > 1_000_000) throw new Error("Original Skill resource exceeds limit");
    if (entry.repository === "editkin" && !data.equals(git(root, ["show", `${editorCommit}:${entry.sourcePath}`])))
      throw new Error("Original editor Skill pack differs from the upstream baseline");
    files.push({ ...entry, bytes: data.length, sha256: digest(data) });
  }
  const value = { schema: "editkin.original-agent-skills/v1", kitCommit: originalKitCommit, editorCommit, skills, files };
  return { ...value, inventoryDigest: digest(JSON.stringify(value)) };
}

export async function verifyOriginalAgentSkills(root) {
  const actual = await deriveOriginalAgentSkills(root);
  const expected = JSON.parse(await readFile(resolve(root, "src/shared/originalAgentSkills.json"), "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Original Skill inventory is stale; run node scripts/original-agent-skills.mjs --write");
  return actual;
}

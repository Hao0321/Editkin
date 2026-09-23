import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
const kit = resolve(root, "scripts/editkin-plugin-kit.ts");
const temporary = await mkdtemp(join(tmpdir(), "editkin-skill-sdk-"));
try {
  const target = join(temporary, "creator-flow");
  const created = await run(process.execPath, [tsx, kit, "init-skill", target, "com.example.creator-flow", "creator-flow"], { cwd: root, windowsHide: true });
  const creation = JSON.parse(created.stdout);
  assert.equal(creation.status, "GREEN");
  assert.equal(creation.arbitraryCodeAllowed, false);

  const validated = await run(process.execPath, [tsx, kit, "validate", join(target, "editkin-plugin.json")], { cwd: root, windowsHide: true });
  const validation = JSON.parse(validated.stdout);
  assert.equal(validation.status, "GREEN");
  assert.equal(validation.workflowSkills.length, 1);
  assert.equal(validation.workflowSkills[0].planningReady, true);
  assert.equal(validation.workflowSkills[0].arbitraryCodeAllowed, false);

  let overwriteRejected = false;
  try {
    await run(process.execPath, [tsx, kit, "init-skill", target, "com.example.creator-flow", "creator-flow"], { cwd: root, windowsHide: true });
  } catch { overwriteRejected = true; }
  assert.equal(overwriteRejected, true);

  const skillPath = join(target, "editkin-skill.json");
  const skill = JSON.parse(await readFile(skillPath, "utf8"));
  skill.preferences.pacing = "dense";
  await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`, "utf8");
  let hashTamperRejected = false;
  try {
    await run(process.execPath, [tsx, kit, "validate", join(target, "editkin-plugin.json")], { cwd: root, windowsHide: true });
  } catch { hashTamperRejected = true; }
  assert.equal(hashTamperRejected, true);

  process.stdout.write(`${JSON.stringify({
    schema: "editkin.plugin-kit-self-test/v1",
    status: "GREEN",
    negativeControls: { overwriteRejected, hashTamperRejected },
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

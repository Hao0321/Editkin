// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { verifyOriginalAgentSkills } from "./original-agent-skills.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const checkout = resolve(root, "../video-tool-research/video-autopilot-kit");
const skill = resolve(checkout, "codex-skill/video-autopilot");
const source = resolve(root, "../artifacts/opencode-embedded/release/opencode.exe");
const license = resolve(root, "../artifacts/opencode-embedded/LICENSE");
const expectedBinarySha256 = "cf664aa1da32b788f9b2699b84a9bb9be30b7e025693b90f9b85829d5fe4e252";
const expectedKitCommit = "9fcd84691a0a2c2af1b8144ca5b6d4df04d7b0ba";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function stageEmbeddedAgent({ runtimeDirectory, kitDirectory }) {
  const originalSkills = await verifyOriginalAgentSkills(root);
  for (const path of [source, license, resolve(skill, "SKILL.md"), resolve(skill, "workflow_contract.py"), resolve(skill, "workflow_contract.json")]) {
    if (!existsSync(path)) throw new Error(`Embedded Agent source is missing: ${path}`);
  }
  if (await sha256(source) !== expectedBinarySha256) throw new Error("Pinned OpenCode 1.18.32 binary SHA-256 mismatch");
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const dirty = execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim();
  if (commit !== expectedKitCommit || dirty) throw new Error("Video Autopilot Kit checkout differs from the reviewed pinned source");
  await mkdir(runtimeDirectory, { recursive: true });
  const destination = resolve(runtimeDirectory, "opencode.exe");
  await copyFile(source, destination);
  if (await sha256(destination) !== expectedBinarySha256) throw new Error("Embedded OpenCode copy failed SHA-256 verification");
  await copyFile(license, resolve(runtimeDirectory, "OpenCode-LICENSE.txt"));
  // Copy only inventoried public Git files; ignored local files must never be bundled.
  await mkdir(kitDirectory, { recursive: true });
  for (const entry of originalSkills.files) {
    const repository = entry.repository === "editkin" ? root : checkout;
    const commit = entry.repository === "editkin" ? originalSkills.editorCommit : expectedKitCommit;
    const data = execFileSync("git", ["-C", repository, "show", `${commit}:${entry.sourcePath}`],
      { windowsHide: true, maxBuffer: 4_000_000 });
    if (createHash("sha256").update(data).digest("hex") !== entry.sha256) throw new Error("Original Skill Git blob hash mismatch");
    const output = resolve(kitDirectory, entry.resource);
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, data);
    if (await sha256(output) !== entry.sha256) throw new Error("Packaged original Skill resource hash mismatch");
  }
  await writeFile(resolve(kitDirectory, "original-agent-skills.json"), JSON.stringify(originalSkills, null, 2) + "\n", "utf8");
  await writeFile(resolve(runtimeDirectory, "embedded-agent-manifest.json"), JSON.stringify({
    schema: "editkin.embedded-opencode/v1",
    opencode: { version: "1.18.32", sha256: expectedBinarySha256,
      source: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-windows-x64.zip",
      archiveSha256: "1483c72d5adced825590a0ecf8cc18b3e87e535960a125dbf539d33bce135d0f", license: "MIT" },
    kit: { commit: expectedKitCommit, license: "MIT", skills: originalSkills.skills.map(skill => skill.id),
      resourceFiles: originalSkills.files.length, inventoryDigest: originalSkills.inventoryDigest },
  }, null, 2) + "\n", "utf8");
  return { version: "1.18.32", sha256: expectedBinarySha256, kitCommit: expectedKitCommit };
}

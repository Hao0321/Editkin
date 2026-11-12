// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { deriveAgentProvenance, verifyAgentProvenance, writeAgentProvenance } from "./agent-provenance.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "editkin-provenance-"));
  const scope = { schema: "editkin.agent-provenance-scope/v1", originId: "urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d",
    attribution: "djguan-jpg", profile: "https://github.com/djguan-jpg", modified: "2026-10-01", upstreamCommit: "1".repeat(40),
    agplFiles: ["src/agent.ts"], gplIntegrationFiles: ["src/bridge.ts"] };
  const source = `// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (C) 2026 ${scope.attribution} (${scope.profile})\n// ${scope.originId}\nexport const value = 1;\n`;
  await Promise.all(["config", "src/shared", "LICENSES"].map(name => mkdir(join(root, name), { recursive: true })));
  const saveScope = () => writeFile(join(root, "config/agent-provenance-scope.json"), JSON.stringify(scope));
  await saveScope();
  for (const [name, content] of [["src/agent.ts", source], ["src/bridge.ts", "Existing GPL fixture"], ["AGENT-NOTICE.md", "Notice"],
    ["LICENSE", "Existing GPL notice"], ["LICENSES/AGPL-3.0-or-later.txt", "AGPL fixture"]]) await writeFile(join(root, name), content);
  try { await run({ root, scope, source, saveScope }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("source modifications block builds until the source and runtime identities are regenerated", () => fixture(async ({ root, source }) => {
  await writeAgentProvenance(root);
  const initial = await verifyAgentProvenance(root);
  await writeFile(join(root, "src/agent.ts"), source.replace("value = 1", "value = 2"));
  await assert.rejects(verifyAgentProvenance(root), /stale/u);
  await writeAgentProvenance(root);
  assert.notEqual((await verifyAgentProvenance(root)).sourceDigest, initial.sourceDigest);
  const runtime = JSON.parse(await readFile(join(root, "src/shared/agentProvenance.json")));
  assert.equal(runtime.sourceDigest, (await verifyAgentProvenance(root)).sourceDigest);
}));
test("license or source notice removal blocks provenance generation", () => fixture(async ({ root, source }) => {
  await writeFile(join(root, "src/agent.ts"), source.replace("AGPL-3.0-or-later", "GPL-3.0-or-later"));
  await assert.rejects(writeAgentProvenance(root), /Missing Agent contribution notice/u);
}));
test("existing GPL notices remain unchanged and line-ending-only changes retain the digest", () => fixture(async ({ root, source }) => {
  const before = await readFile(join(root, "LICENSE"));
  const first = await writeAgentProvenance(root);
  await writeFile(join(root, "src/agent.ts"), source.replaceAll("\n", "\r\n"));
  assert.equal((await verifyAgentProvenance(root)).sourceDigest, first.runtime.sourceDigest);
  assert.deepEqual(await readFile(join(root, "LICENSE")), before);
}));
test("source manifests reject escaped paths, duplicate scope and recursive digests", () => fixture(async ({ root, scope, saveScope }) => {
  for (const path of ["../outside.ts", "C:\\private\\source.ts", ".env", "auth.json", "history.sqlite", "src/agent.ts", "src/shared/agentProvenance.json"]) {
    scope.gplIntegrationFiles = [path]; await saveScope();
    await assert.rejects(deriveAgentProvenance(root), /path|scope/iu);
  }
}));
test("public identity rejects private contact fields and mismatched profile URLs", () => fixture(async ({ root, scope, saveScope }) => {
  scope.profile = "https://github.com/other-fixture"; await saveScope();
  await assert.rejects(deriveAgentProvenance(root), /Invalid public/u);
  scope.profile = "https://github.com/djguan-jpg"; scope.email = "private-contact-fixture"; await saveScope();
  await assert.rejects(deriveAgentProvenance(root), /Invalid public/u);
}));
test("tampered generated runtime identities are rejected even if source did not change", () => fixture(async ({ root }) => {
  await writeAgentProvenance(root);
  const path = join(root, "src/shared/agentProvenance.json");
  const value = JSON.parse(await readFile(path)); value.sourceDigest = "0".repeat(64);
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(verifyAgentProvenance(root), /stale/u);
}));

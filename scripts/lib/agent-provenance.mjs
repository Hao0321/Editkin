// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const text = value => value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
const serialized = value => JSON.stringify(value, null, 2) + "\n";
const scopeFile = "config/agent-provenance-scope.json";
export const provenanceOutputs = ["AGENT-PROVENANCE.json", "src/shared/agentProvenance.json"];
const publicAccount = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/u;

async function safeFile(root, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || isAbsolute(name)
    || name.split("/").some(part => !part || part.startsWith("."))
    || (name !== "LICENSE" && !/\.(?:ts|tsx|css|mjs|md|txt|json|rs)$/u.test(name))
    || /(?:^|\/)(?:auth|credentials?|tokens?|secrets?|settings|history)\.json$/iu.test(name)) throw new Error("Invalid Agent provenance path");
  const path = resolve(root, name);
  const actual = await realpath(path);
  const relation = relative(root, actual);
  if (!relation || relation.startsWith("..") || isAbsolute(relation) || (await lstat(path)).isSymbolicLink())
    throw new Error("Agent provenance path escapes source root or is a link");
  if ((await lstat(path)).size > 2_000_000) throw new Error("Agent provenance source exceeds size limit");
  return path;
}

export async function deriveAgentProvenance(directory) {
  const root = await realpath(directory);
  const scope = JSON.parse(await readFile(await safeFile(root, scopeFile), "utf8"));
  const fields = ["schema", "originId", "attribution", "profile", "modified", "upstreamCommit", "agplFiles", "gplIntegrationFiles"];
  if (Object.keys(scope).some(key => !fields.includes(key)) || fields.some(key => !(key in scope))
    || scope.schema !== "editkin.agent-provenance-scope/v1"
    || !/^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(scope.originId)
    || !publicAccount.test(scope.attribution) || scope.profile !== `https://github.com/${scope.attribution}`
    || !/^\d{4}-\d{2}-\d{2}$/u.test(scope.modified) || !/^[0-9a-f]{40}$/u.test(scope.upstreamCommit)
    || !Array.isArray(scope.agplFiles) || !scope.agplFiles.length || !Array.isArray(scope.gplIntegrationFiles))
    throw new Error("Invalid public Agent provenance scope");
  const names = [...scope.agplFiles, ...scope.gplIntegrationFiles, scopeFile, "AGENT-NOTICE.md", "LICENSE", "LICENSES/AGPL-3.0-or-later.txt"];
  if (new Set(names).size !== names.length || names.some(name => provenanceOutputs.includes(name)))
    throw new Error("Duplicate or recursive Agent provenance scope");
  const files = [];
  for (const path of names.sort()) {
    const content = text(await readFile(await safeFile(root, path), "utf8"));
    const agpl = scope.agplFiles.includes(path);
    if (agpl && (!content.slice(0, 550).includes("SPDX-License-Identifier: AGPL-3.0-or-later")
      || !content.slice(0, 550).includes(scope.originId)
      || !content.slice(0, 550).includes(`Copyright (C) 2026 ${scope.attribution} (${scope.profile})`)))
      throw new Error(`Missing Agent contribution notice: ${path}`);
    files.push({ path, scope: agpl ? "new-agent-module" : scope.gplIntegrationFiles.includes(path) ? "gpl-integration" : "license-and-scope",
      license: agpl || path === "LICENSES/AGPL-3.0-or-later.txt" ? "AGPL-3.0-or-later" : "GPL-3.0-or-later", sha256: sha256(content) });
  }
  const payload = { schema: "editkin.agent-provenance/v1", originId: scope.originId,
    attribution: scope.attribution, profile: scope.profile, modified: scope.modified,
    upstream: { commit: scope.upstreamCommit, license: "GPL-3.0-or-later" },
    hashConvention: "sha256-utf8-bom-removed-lf", files };
  const sourceDigest = sha256(JSON.stringify(payload));
  const manifest = { ...payload, sourceDigest };
  const runtime = { schema: "editkin.agent-provenance/v1", originId: scope.originId,
    attribution: scope.attribution, profile: scope.profile, license: "AGPL-3.0-or-later", sourceDigest,
    notice: "AGENT-NOTICE.md", manifest: "AGENT-PROVENANCE.json" };
  return { root, manifest, runtime };
}

export async function writeAgentProvenance(directory) {
  const value = await deriveAgentProvenance(directory);
  for (const [index, data] of [value.manifest, value.runtime].entries()) {
    const path = resolve(value.root, provenanceOutputs[index]);
    const parent = await realpath(dirname(path));
    if (parent !== dirname(path)) throw new Error("Agent provenance output parent is a link");
    try { await safeFile(value.root, provenanceOutputs[index]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(path, serialized(data), "utf8");
  }
  return value;
}

export async function verifyAgentProvenance(directory) {
  const value = await deriveAgentProvenance(directory);
  for (const [index, data] of [value.manifest, value.runtime].entries()) {
    const current = text(await readFile(await safeFile(value.root, provenanceOutputs[index]), "utf8"));
    if (current !== serialized(data)) throw new Error("Agent provenance is stale; run node scripts/agent-provenance.mjs --write");
  }
  return { status: "PASS", originId: value.runtime.originId, attribution: value.runtime.attribution,
    sourceDigest: value.runtime.sourceDigest, files: value.manifest.files.length };
}

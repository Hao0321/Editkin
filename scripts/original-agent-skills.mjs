// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { deriveOriginalAgentSkills, verifyOriginalAgentSkills } from "./lib/original-agent-skills.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !["--write", "--check"].includes(arg))) throw new Error("Use --write or --check");
if (args.includes("--write")) await writeFile(resolve(root, "src/shared/originalAgentSkills.json"), JSON.stringify(await deriveOriginalAgentSkills(root), null, 2) + "\n");
const result = await verifyOriginalAgentSkills(root);
console.log(JSON.stringify({ status: "PASS", skills: result.skills.length, files: result.files.length, inventoryDigest: result.inventoryDigest }));

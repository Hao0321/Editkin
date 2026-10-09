// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { fileURLToPath } from "node:url";
import { verifyAgentProvenance, writeAgentProvenance } from "./lib/agent-provenance.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !["--write", "--check"].includes(arg))) throw new Error("Use --write or --check");
const root = fileURLToPath(new URL("..", import.meta.url));
if (args.includes("--write")) await writeAgentProvenance(root);
console.log(JSON.stringify(await verifyAgentProvenance(root)));

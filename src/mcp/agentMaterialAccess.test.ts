// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterialIntelligencePacket } from "../application/materialIntelligence";
import { assertAgentMaterialAccess, boundAgentProjectScope } from "./agentMaterialAccess";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Agent material project identity", () => {
  it("allows a sealed packet only in the project that prepared it, including after reconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-agent-material-")); roots.push(root);
    const a = join(root, "a.editkin.json"), b = join(root, "b.editkin.json");
    await writeFile(a, "{}"); await writeFile(b, "{}");
    const aScope = boundAgentProjectScope({ EDITKIN_AGENT_PROJECT_PATH: a })!;
    const bScope = boundAgentProjectScope({ EDITKIN_AGENT_PROJECT_PATH: b })!;
    const packet = { materialId: "a".repeat(64), cache: { identity: { agentProjectScope: aScope } } } as MaterialIntelligencePacket;
    expect(() => assertAgentMaterialAccess(aScope, packet)).not.toThrow();
    expect(() => assertAgentMaterialAccess(bScope, packet)).toThrow(/目前 Agent 專案/);
    expect(() => assertAgentMaterialAccess(aScope, { ...packet, cache: undefined })).toThrow(/目前 Agent 專案/);
  });
});

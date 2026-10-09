// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** The material cache identity, not a supplied material ID, owns project access. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readMaterialIntelligence, type MaterialIntelligencePacket } from "../application/materialIntelligence";

const denied = () => new Error("素材不屬於目前 Agent 專案；請在此專案重新準備素材");

export function boundAgentProjectScope(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const projectPath = environment.EDITKIN_AGENT_PROJECT_PATH;
  if (!projectPath) return undefined;
  if (!isAbsolute(projectPath)) throw new Error("Agent 專案綁定無效");
  return createHash("sha256").update(realpathSync(projectPath)).digest("hex");
}

export function assertAgentMaterialAccess(scope: string | undefined, packet: MaterialIntelligencePacket): void {
  if (scope && packet.cache?.identity.agentProjectScope !== scope) throw denied();
}

export async function assertAgentMaterialId(cacheRoot: string, scope: string | undefined, materialId: string): Promise<void> {
  if (!scope) return;
  assertAgentMaterialAccess(scope, await readMaterialIntelligence(cacheRoot, materialId));
}

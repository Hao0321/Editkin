// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Reject malformed transport data before any workflow action. Never silently repair a write. */
export function agentRunArgument(value: unknown, tool: string, verifiedRun?: string): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f]/u.test(value)) return value;
  const samePrefix = typeof value === "string" && verifiedRun && value.split(/[\r\n]/u, 1)[0] === verifiedRun;
  throw new Error(JSON.stringify({ code: "INVALID_KIT_RUN_ARGUMENT", mutationAttempted: false,
    message: "run must be an exact JSON string copied from get_kit_plan_context.run, without XML closing tags or line breaks. Do not manually claim/complete plan/audit/apply/render around the finish helper.",
    ...(samePrefix ? { correctedCall: { name: tool, arguments: { run: verifiedRun } }, correctionIsOnlyAHint: true }
      : { nextAction: "Read the bound run context and correct the argument before retrying." }) }));
}

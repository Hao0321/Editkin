// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import type { AgentEvent } from "../service/openCodeAcp";

/** ACP updates can revise an existing message or tool card without creating another row. */
export function mergeAgentEventUpdates(current: AgentEvent[], fresh: AgentEvent[], limit = 500): AgentEvent[] {
  if (!fresh.length) return current;
  const merged = [...current];
  for (const event of fresh) {
    const existing = event.entryId === undefined ? -1 : merged.findIndex((item) => item.entryId === event.entryId);
    if (existing >= 0) { merged[existing] = event; continue; }
    const later = event.entryId === undefined ? -1 : merged.findIndex((item) => item.entryId !== undefined && item.entryId > event.entryId!);
    if (later >= 0) merged.splice(later, 0, event);
    else merged.push(event);
  }
  return merged.slice(-limit);
}

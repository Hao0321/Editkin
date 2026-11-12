// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
import { describe, expect, it } from "vitest";
import { AgentResultStore } from "./agentResultStore";

describe("Agent evidence retention", () => {
  it("keeps a long context prefix and refuses capacity overflow without evicting earlier pages", () => {
    const store = new AgentResultStore<{ bytes: number; expiresAt: number }>(2048, 4096);
    for (let page = 0; page < 2048; page++) expect(store.put(`page-${page}`, { bytes: 2, expiresAt: 10_000 }, 0)).toBe(true);
    expect(store.put("overflow", { bytes: 1, expiresAt: 10_000 }, 0)).toBe(false);
    expect(store.get("page-0", 1)?.bytes).toBe(2);
    expect(store.get("page-2047", 1)?.bytes).toBe(2);
    store.delete("page-0");
    expect(store.put("replacement", { bytes: 2, expiresAt: 10_000 }, 1)).toBe(true);
  });

  it("releases expired evidence and accounts for bytes exactly", () => {
    const store = new AgentResultStore<{ bytes: number; expiresAt: number }>(3, 5);
    expect(store.put("first", { bytes: 4, expiresAt: 10 }, 0)).toBe(true);
    expect(store.put("second", { bytes: 2, expiresAt: 20 }, 0)).toBe(false);
    expect(store.get("first", 10)).toBeUndefined();
    expect(store.put("second", { bytes: 2, expiresAt: 20 }, 10)).toBe(true);
    expect(store.put("third", { bytes: 3, expiresAt: 20 }, 10)).toBe(true);
    expect(store.put("too-big", { bytes: 6, expiresAt: 20 }, 10)).toBe(false);
  });
});

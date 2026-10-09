// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Bounded, in-process MCP evidence. Active references are never silently evicted. */
export class AgentResultStore<T extends { bytes: number; expiresAt: number }> {
  private readonly items = new Map<string, T>();
  private totalBytes = 0;

  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}

  trim(now = Date.now()): void {
    for (const [id, item] of this.items) if (item.expiresAt <= now) this.delete(id);
  }

  put(id: string, item: T, now = Date.now()): boolean {
    this.trim(now);
    if (this.items.has(id) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > this.maxBytes
      || this.items.size >= this.maxItems || this.totalBytes + item.bytes > this.maxBytes) return false;
    this.items.set(id, item);
    this.totalBytes += item.bytes;
    return true;
  }

  get(id: string, now = Date.now()): T | undefined {
    this.trim(now);
    return this.items.get(id);
  }

  delete(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.totalBytes -= item.bytes;
    this.items.delete(id);
  }
}

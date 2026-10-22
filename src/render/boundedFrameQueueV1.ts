/** One producer/consumer, with a zero-capacity rendezvous mode. No discarded frames on overflow. */
export function boundedFrameQueueV1<T>(capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 64) throw Error("FRAME_QUEUE_CAPACITY_INVALID");
  const items: T[] = [];
  let ended = false, failure: unknown, peak = 0;
  let reader: { resolve(value: T | undefined): void; reject(reason: unknown): void } | undefined;
  let writer: { item: T; resolve(): void; reject(reason: unknown): void } | undefined;
  const promote = () => {
    if (!writer || items.length >= capacity) return;
    const pending = writer; writer = undefined; items.push(pending.item); peak = Math.max(peak, items.length); pending.resolve();
  };
  return {
    get receipt() { return { capacity, peakQueuedFrames: peak, queuedFrames: items.length, producerWaiting: Boolean(writer), ended }; },
    async push(item: T): Promise<void> {
      if (failure !== undefined) throw failure;
      if (ended || writer) throw Error("FRAME_QUEUE_WRITE_REFUSED");
      if (reader) { const waiting = reader; reader = undefined; waiting.resolve(item); return; }
      if (items.length < capacity) { items.push(item); peak = Math.max(peak, items.length); return; }
      await new Promise<void>((resolve, reject) => { writer = { item, resolve, reject }; });
    },
    async shift(): Promise<T | undefined> {
      if (failure !== undefined) throw failure;
      if (reader) throw Error("FRAME_QUEUE_READ_REFUSED");
      if (items.length) { const item = items.shift()!; promote(); return item; }
      if (writer) { const pending = writer; writer = undefined; pending.resolve(); return pending.item; }
      if (ended) return undefined;
      return new Promise<T | undefined>((resolve, reject) => { reader = { resolve, reject }; });
    },
    end() {
      if (failure !== undefined) throw failure;
      if (writer || ended) throw Error("FRAME_QUEUE_END_REFUSED");
      ended = true; reader?.resolve(undefined); reader = undefined;
    },
    fail(reason: unknown) {
      failure ??= reason ?? Error("FRAME_QUEUE_CANCELLED");
      items.length = 0; reader?.reject(failure); writer?.reject(failure); reader = undefined; writer = undefined;
    },
  };
}

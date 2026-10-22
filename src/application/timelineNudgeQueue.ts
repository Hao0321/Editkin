interface NudgeTask { operation: () => boolean | Promise<boolean>; onError: (error: unknown) => void }

/** Held keys wait for a template edit already in flight. Each next edit reads the committed live project,
 * rather than racing another plan made on the old project and losing frames when that plan becomes stale. */
export function createTimelineNudgeQueue() {
  const pending: NudgeTask[] = [];
  let running = false;
  const drain = () => {
    if (running) return;
    running = true;
    while (pending.length) {
      const task = pending.shift()!;
      let result: boolean | Promise<boolean>;
      try { result = task.operation(); }
      catch (error) { pending.length = 0; running = false; task.onError(error); return; }
      if (typeof result === "boolean") {
        if (!result) { pending.length = 0; break; }
        continue;
      }
      void result.then(ok => {
        if (!ok) pending.length = 0;
        running = false;
        drain();
      }, error => {
        pending.length = 0; running = false;
        task.onError(error);
      });
      return;
    }
    running = false;
  };
  return {
    enqueue(operation: NudgeTask["operation"], onError: NudgeTask["onError"]) {
      pending.push({ operation, onError }); drain();
    },
    cancelQueued() { pending.length = 0; },
  };
}

export type TimelineNudgeQueue = ReturnType<typeof createTimelineNudgeQueue>;

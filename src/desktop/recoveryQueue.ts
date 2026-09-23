/** Serialize recovery I/O; queued work must still own the current editor state. */
export function createRecoveryQueue() {
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    invalidate: () => ++generation,
    current: () => generation,
    enqueue: (token: number, operation: () => Promise<void>, isOwnerCurrent: () => boolean = () => true): Promise<boolean> => {
      const current = () => token === generation && isOwnerCurrent();
      const result = tail.catch(() => undefined).then(async () => {
        if (!current()) return false;
        await operation();
        return current();
      });
      tail = result;
      return result;
    },
  };
}

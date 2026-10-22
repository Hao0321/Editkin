/** Public failure and physical retirement are separate: only the native owner resolves `closed`. */
export class PendingNativeCloseError extends Error {
  readonly code = "NATIVE_CLOSE_PENDING";
  readonly closed: Promise<void>;
  /** Bounded local observations remain visible on the original public error. */
  readonly observations: string[] = [];
  constructor(message: string, closed: Promise<void>, cause: unknown) {
    super(message, { cause });
    this.name = "PendingNativeCloseError";
    this.closed = new Promise<void>(resolve => {
      // A failed close acknowledgement is unknown closure, never permission to retire.
      void closed.then(resolve, error => this.observeFailure(error));
    });
  }
  observeFailure(error: unknown): void {
    if (this.observations.length >= 8) return;
    let text: string;
    try { text = String(error); } catch { text = "Unprintable native close error"; }
    this.observations.push(text.slice(0, 512));
  }
}

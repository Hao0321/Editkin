/** Immutable PNG transport/publication, separate from renderer admission.
 * The caller must first verify the complete offscreen engine receipt, selected
 * executable/target, graph, physical paint/floating owners and SDR boundary.
 */
export interface ImmutableNativePngBytes {
  readonly pngBytes: readonly number[];
  readonly pngSha256: string;
  /** Native Windows pixel readback hash, deliberately not the PNG file SHA. */
  readonly pixelFnvHash: string;
  readonly width: number;
  readonly height: number;
}

export interface DecodedImmutablePngFrame {
  readonly url: string;
  readonly pngSha256: string;
  readonly pixelFnvHash: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

export interface ImmutablePngPlatform {
  sha256(bytes: ArrayBuffer): Promise<string>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  decode(url: string, signal: AbortSignal): Promise<{ width: number; height: number }>;
}

const browserPlatform: ImmutablePngPlatform = {
  async sha256(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  },
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => URL.revokeObjectURL(url),
  async decode(url, signal) {
    const image = new Image();
    const cancel = () => { image.removeAttribute("src"); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      image.decoding = "async";
      image.src = url;
      await abortable(image.decode(), signal);
      return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      signal.removeEventListener("abort", cancel);
      image.removeAttribute("src");
    }
  },
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

class RetiredPngFrame extends Error {
  constructor() { super("PNG preview owner/request retired"); }
}
interface HeldFrame {
  readonly value: DecodedImmutablePngFrame;
  revoked: boolean;
}

/** One immutable project/generation/font lease. At most two object URLs are
 * retained: current + decoded candidate, or current + previous DOM frame.
 * No next candidate is decoded until the prior publication is acknowledged.
 * The hook owns its one-in-flight/latest-pending native request queue.
 */
export class ImmutableDecodedPngFrameHolder {
  private disposed = false;
  private busy = false;
  private operation?: AbortController;
  private prepared?: HeldFrame;
  private current?: HeldFrame;
  private previous?: HeldFrame;
  private acknowledgment?: { promise: Promise<void>; resolve: () => void };
  private readonly candidates = new WeakMap<DecodedImmutablePngFrame, HeldFrame>();

  constructor(
    private readonly canvas: { readonly width: number; readonly height: number },
    /** Checks generation/request/project/font lease, but NOT latest seek token. */
    private readonly isOwnerCurrent: () => boolean,
    private readonly platform: ImmutablePngPlatform = browserPlatform,
    private readonly limits = { maxPngBytes: 40 * 1024 * 1024, maxPixels: 8_294_400, deadlineMs: 10_000 },
  ) {
    if (![canvas.width, canvas.height, limits.maxPngBytes, limits.maxPixels, limits.deadlineMs]
      .every(value => Number.isSafeInteger(value) && value > 0)
      || limits.maxPngBytes > 40 * 1024 * 1024 || limits.maxPixels > 8_294_400 || limits.deadlineMs > 15_000
      || canvas.width * canvas.height > limits.maxPixels) throw new Error("Invalid bounded PNG preview canvas/budget");
    this.canvas = Object.freeze({ ...canvas }); this.limits = Object.freeze({ ...limits });
  }

  private owned(): boolean { return !this.disposed && this.isOwnerCurrent(); }
  isActive(): boolean { return this.owned(); }
  private revoke(frame?: HeldFrame): void {
    if (frame && !frame.revoked) { frame.revoked = true; this.platform.revokeObjectURL(frame.value.url); }
  }

  /** Checks current seek token as well as the owner after every await boundary.
   * A superseded PNG never changes visible pixels, so it is discarded rather
   * than published as a native-surface intermediate frame.
   */
  async prepare(input: ImmutableNativePngBytes, isRequestCurrent: () => boolean,
    signal?: AbortSignal): Promise<DecodedImmutablePngFrame | undefined> {
    if (!this.owned() || !isRequestCurrent() || signal?.aborted) return undefined;
    if (this.busy || this.prepared) throw new Error("PNG holder requires a single serialized candidate");
    const { width, height, pngSha256, pixelFnvHash, pngBytes: sourceBytes } = input;
    if (width !== this.canvas.width || height !== this.canvas.height
      || !/^[a-f0-9]{64}$/.test(pngSha256) || !/^fnv1a64:[a-f0-9]{16}$/.test(pixelFnvHash)
      || !Array.isArray(sourceBytes) || sourceBytes.length < 33 || sourceBytes.length > this.limits.maxPngBytes) {
      throw new Error("Invalid immutable PNG envelope");
    }
    const operation = new AbortController();
    const retire = () => operation.abort(new RetiredPngFrame());
    const timer = setTimeout(() => operation.abort(new Error("PNG decode/publication acknowledgment deadline exceeded")), this.limits.deadlineMs);
    this.busy = true; this.operation = operation;
    signal?.addEventListener("abort", retire, { once: true });
    let held: HeldFrame | undefined;
    const assertCurrent = () => {
      if (!this.owned() || !isRequestCurrent() || signal?.aborted) throw new RetiredPngFrame();
      if (operation.signal.aborted) throw operation.signal.reason;
    };
    try {
      // The old DOM URL must remain valid until the new decoded image is
      // actually installed. Waiting here also bounds rapid-seek URL retention.
      if (this.acknowledgment) await abortable(this.acknowledgment.promise, operation.signal);
      assertCurrent();
      if (sourceBytes.length < 33 || sourceBytes.length > this.limits.maxPngBytes) throw new Error("PNG byte transport changed during wait");
      const storage = new ArrayBuffer(sourceBytes.length), bytes = new Uint8Array(storage);
      for (let index = 0; index < sourceBytes.length; index++) {
        const value = sourceBytes[index];
        if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Invalid PNG byte transport");
        bytes[index] = value;
      }
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      const view = new DataView(storage);
      if (!signature.every((value, index) => bytes[index] === value)
        || view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
        || view.getUint32(16) !== width || view.getUint32(20) !== height) {
        throw new Error("PNG header does not match the admitted canvas");
      }
      const actualSha = await abortable(this.platform.sha256(storage), operation.signal);
      assertCurrent();
      if (actualSha !== pngSha256) throw new Error("PNG full byte SHA mismatch");
      const value = Object.freeze({ url: this.platform.createObjectURL(new Blob([storage], { type: "image/png" })),
        pngSha256: actualSha, pixelFnvHash, width, height, byteLength: bytes.length });
      held = { value, revoked: false };
      const decoded = await abortable(this.platform.decode(value.url, operation.signal), operation.signal);
      assertCurrent();
      if (decoded.width !== width || decoded.height !== height) throw new Error("Decoded PNG dimensions changed");
      this.prepared = held; this.candidates.set(value, held);
      return value;
    } catch (error) {
      this.revoke(held);
      if (error instanceof RetiredPngFrame || !this.owned() || !isRequestCurrent() || signal?.aborted) return undefined;
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", retire);
      if (this.operation === operation) this.operation = undefined;
      this.busy = false;
    }
  }

  /** Call synchronously immediately before publishing the atomic React
   * {request, token, actualFrame, decodedFrame, bakedIDs} snapshot.
   */
  publish(candidate: DecodedImmutablePngFrame, isRequestCurrent: () => boolean): DecodedImmutablePngFrame | undefined {
    const held = this.candidates.get(candidate);
    if (!held || held !== this.prepared || held.revoked) throw new Error("PNG candidate is not owned by this generation");
    if (!this.owned() || !isRequestCurrent()) { this.discard(candidate); return undefined; }
    if (this.acknowledgment || this.previous) throw new Error("Prior PNG publication has not reached the DOM");
    this.prepared = undefined; this.previous = this.current; this.current = held;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.acknowledgment = { promise, resolve };
    return candidate;
  }

  /** Invoke from the real <img onLoad> for this exact currently published URL.
   * Do not gate this ACK by the latest requested seek token: the older frame
   * may legitimately reach the DOM while a newer request is queued.
   */
  acknowledgePresented(url: string): boolean {
    if (!this.owned() || !this.current || this.current.value.url !== url || !this.acknowledgment) return false;
    this.revoke(this.previous); this.previous = undefined;
    const acknowledgment = this.acknowledgment; this.acknowledgment = undefined;
    acknowledgment.resolve();
    return true;
  }

  /** A real DOM decode/load failure retires this holder. The caller must hide
   * its corresponding presentation snapshot; an old URL cannot retire a new one.
   */
  rejectPresentation(url: string): boolean {
    if (this.disposed || this.current?.value.url !== url) return false;
    this.dispose(); return true;
  }

  discard(candidate: DecodedImmutablePngFrame): void {
    const held = this.candidates.get(candidate);
    if (held === this.prepared) { this.revoke(held); this.prepared = undefined; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.operation?.abort(new RetiredPngFrame());
    this.revoke(this.prepared); this.revoke(this.current); this.revoke(this.previous);
    this.prepared = undefined; this.current = undefined; this.previous = undefined;
    const acknowledgment = this.acknowledgment; this.acknowledgment = undefined;
    acknowledgment?.resolve();
  }
}

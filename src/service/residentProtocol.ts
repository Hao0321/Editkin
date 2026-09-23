import type { Readable, Writable } from "node:stream";

export const SERVICE_STREAM_SCHEMA = "editkin.service-stream/v1" as const;
export const MAX_SERVICE_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_SERVICE_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_SERVICE_QUEUED_REQUESTS = 32;

export interface ResidentServiceRequest {
  command: string;
  payload: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

interface RequestFrame {
  schema: typeof SERVICE_STREAM_SCHEMA;
  id: string;
  request: ResidentServiceRequest;
}

export class ServiceProtocolError extends Error {
  constructor(message: string) {
    super(`Service stream protocol: ${message}`);
    this.name = "ServiceProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ServiceProtocolError("unknown fields");
  }
}

function parseFrame(bytes: Buffer): RequestFrame {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ServiceProtocolError("invalid UTF-8 or JSON");
  }
  if (!isRecord(value)) throw new ServiceProtocolError("expected request envelope");
  assertKeys(value, ["schema", "id", "request"]);
  if (value.schema !== SERVICE_STREAM_SCHEMA) throw new ServiceProtocolError("unsupported schema");
  if (typeof value.id !== "string" || !value.id.length || value.id.length > 128 || /[\u0000-\u0020\u007f]/u.test(value.id)) {
    throw new ServiceProtocolError("invalid request id");
  }
  if (!isRecord(value.request)) throw new ServiceProtocolError("expected request object");
  assertKeys(value.request, ["command", "payload", "runtime"]);
  if (typeof value.request.command !== "string" || !value.request.command.trim() || value.request.command.length > 128
    || !isRecord(value.request.payload) || (value.request.runtime !== undefined && !isRecord(value.request.runtime))) {
    throw new ServiceProtocolError("invalid request shape");
  }
  return value as unknown as RequestFrame;
}

/** Count wire bytes before decoding, so fragmented Unicode cannot bypass the limit. */
async function* readFrames(input: Readable, maxBytes: number): AsyncGenerator<{ frame: RequestFrame; bytes: number }> {
  // Geometric growth also bounds object overhead for one-byte fragmentation.
  let storage = Buffer.allocUnsafe(Math.min(4096, maxBytes));
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      const piece = buffer.subarray(offset, end);
      const required = length + piece.length;
      if (required > maxBytes) throw new ServiceProtocolError("request frame too large");
      if (required > storage.length) {
        const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(required, storage.length * 2)));
        storage.copy(grown, 0, 0, length);
        storage = grown;
      }
      piece.copy(storage, length);
      length = required;
      if (newline < 0) break;
      const frame = parseFrame(storage.subarray(0, length));
      const frameBytes = length;
      length = 0;
      yield { frame, bytes: frameBytes };
      offset = newline + 1;
    }
  }
  if (length) throw new ServiceProtocolError("EOF inside request frame");
}

function serializeFrame(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new ServiceProtocolError("response frame too large");
  return `${json}\n`;
}

/** Await the write callback even when write() returns true: only one response is buffered. */
async function writeFrame(output: Writable, value: unknown, maxBytes: number): Promise<void> {
  const line = serializeFrame(value, maxBytes);
  await new Promise<void>((resolve, reject) => {
    output.write(line, (error) => error ? reject(error) : resolve());
  });
}

export interface ResidentServiceOptions<Request extends ResidentServiceRequest> {
  input: Readable;
  output: Writable;
  dispatch: (request: Request) => Promise<unknown>;
  serviceArtifact: () => unknown;
  signal?: AbortSignal;
  /** Tests may lower limits; production callers cannot raise the protocol ceilings. */
  limits?: { requestBytes?: number; responseBytes?: number; queuedRequests?: number; queuedBytes?: number };
}

function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new ServiceProtocolError("invalid limit");
  return value;
}

/**
 * Serial execution in each worker. The host owns deadlines and process lifetime;
 * after fatal failure an unacknowledged request is indeterminate, not cancelled.
 */
export async function runResidentService<Request extends ResidentServiceRequest>(options: ResidentServiceOptions<Request>): Promise<void> {
  const requestLimit = boundedLimit(options.limits?.requestBytes, MAX_SERVICE_REQUEST_BYTES);
  const responseLimit = boundedLimit(options.limits?.responseBytes, MAX_SERVICE_RESPONSE_BYTES);
  const queueLimit = boundedLimit(options.limits?.queuedRequests, MAX_SERVICE_QUEUED_REQUESTS);
  const queueByteLimit = boundedLimit(options.limits?.queuedBytes, MAX_SERVICE_REQUEST_BYTES);
  const queue: { frame: RequestFrame; bytes: number }[] = [];
  const activeIds = new Set<string>();
  let queuedBytes = 0;
  let ended = false;
  let failure: Error | undefined;
  const waiters = new Set<() => void>();
  const changed = () => { for (const wake of waiters) wake(); waiters.clear(); };
  const waitForChange = () => new Promise<void>((resolve) => { waiters.add(resolve); });
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  // Attach a rejection handler before startup output or an already-aborted signal.
  void failed.catch(() => undefined);
  const fail = (reason: unknown) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new ServiceProtocolError(String(reason));
    queue.length = 0;
    activeIds.clear();
    options.input.destroy();
    changed();
    rejectFailure(failure);
  };
  const aborted = () => fail(new ServiceProtocolError("host lifetime ended"));
  const outputClosed = () => fail(new ServiceProtocolError("output closed"));
  options.signal?.addEventListener("abort", aborted, { once: true });
  options.output.on("error", fail);
  options.output.on("close", outputClosed);
  if (options.signal?.aborted) aborted();
  try {
    if (failure) throw failure;
    await Promise.race([writeFrame(options.output, { schema: SERVICE_STREAM_SCHEMA, kind: "ready", pid: process.pid }, responseLimit), failed]);
    const reader = async () => {
      for await (const entry of readFrames(options.input, requestLimit)) {
        if (entry.bytes > queueByteLimit) throw new ServiceProtocolError("request exceeds queue byte budget");
        if (activeIds.has(entry.frame.id)) throw new ServiceProtocolError("duplicate active request id");
        while (!failure && (queue.length >= queueLimit || queuedBytes + entry.bytes > queueByteLimit)) await waitForChange();
        if (failure) return;
        activeIds.add(entry.frame.id);
        queue.push(entry);
        queuedBytes += entry.bytes;
        changed();
      }
      ended = true;
      changed();
    };
    const worker = async () => {
      while (!failure) {
        if (!queue.length) {
          if (ended) return;
          await waitForChange();
          continue;
        }
        const entry = queue.shift()!;
        queuedBytes -= entry.bytes;
        changed();
        let response: { ok: boolean; result?: unknown; error?: string; serviceArtifact: unknown };
        try {
          const result = await options.dispatch(entry.frame.request as Request);
          response = { ok: true, result, serviceArtifact: options.serviceArtifact() };
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : String(error), serviceArtifact: options.serviceArtifact() };
        }
        if (failure) return;
        await writeFrame(options.output, { schema: SERVICE_STREAM_SCHEMA, id: entry.frame.id, response }, responseLimit);
        activeIds.delete(entry.frame.id);
      }
    };
    await Promise.race([Promise.all([reader().catch(fail), worker().catch(fail)]), failed]);
    if (failure) throw failure;
  } finally {
    options.signal?.removeEventListener("abort", aborted);
    options.output.off("error", fail);
    options.output.off("close", outputClosed);
  }
}

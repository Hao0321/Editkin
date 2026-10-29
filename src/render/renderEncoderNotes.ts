import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why an export did not use the hardware encoder it was asked to prefer (W2-4: the job result names the NVENC → x264
 * fallback instead of leaving the agent to guess). Notes are collected only inside withRenderEncoderNotes; everywhere
 * else noteRenderEncoder does nothing, so recording a note never changes what the render does.
 */
export type RenderEncoderNoteCode =
  /** The hardware encoder probe failed (driver, session limit or missing GPU); the software encoder was used. */
  | "hardware_probe_failed"
  /** The route composites on the CPU and picks x264 on purpose (floating video frames on Windows). */
  | "cpu_graph_route"
  /** The 3D scene pass feeds a CPU composite that encodes in software. */
  | "mesh3d_cpu_route";

export interface RenderEncoderNote {
  code: RenderEncoderNoteCode;
  /** The encoder that was preferred and not used, when known. */
  encoder?: string;
  /** One short line (the probe's first error line), never a full log. */
  detail?: string;
}

const MAX_NOTES = 8;
const MAX_DETAIL_CHARS = 200;
const current = new AsyncLocalStorage<RenderEncoderNote[]>();

function firstLine(text: string): string {
  return (text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "").slice(0, MAX_DETAIL_CHARS);
}

/** Records one encoder decision for the caller that asked (a no-op outside withRenderEncoderNotes). */
export function noteRenderEncoder(note: RenderEncoderNote): void {
  const notes = current.getStore();
  if (!notes || notes.length >= MAX_NOTES || notes.some(item => item.code === note.code && item.encoder === note.encoder)) return;
  const detail = note.detail ? firstLine(note.detail) : "";
  notes.push({ code: note.code, ...(note.encoder ? { encoder: note.encoder } : {}), ...(detail ? { detail } : {}) });
}

/** Runs `operation` and returns its value with the encoder notes recorded inside it (first decision first). */
export async function withRenderEncoderNotes<T>(operation: () => Promise<T>): Promise<{ value: T; notes: RenderEncoderNote[] }> {
  const notes: RenderEncoderNote[] = [];
  const value = await current.run(notes, operation);
  return { value, notes: notes.map(note => ({ ...note })) };
}

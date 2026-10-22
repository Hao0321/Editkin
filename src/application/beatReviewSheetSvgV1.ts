import type { BeatReviewPlanV1, reduceBeatReviewPcmV1 } from "./beatReviewSheetV1";

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const fixed = (n: number) => n.toFixed(3);
const label = (kind: string, inferred: boolean) => `${inferred ? "INFERRED low-confidence" : "Observed candidate"} ${kind}`;
export type BeatReviewWaveformV1 = Omit<ReturnType<typeof reduceBeatReviewPcmV1>, "pcm16">;

/** Private diagnostic plate: neutral greys, explicit hypothesis labels, no certification or product UI. */
export function beatReviewSvgV1(plan: BeatReviewPlanV1, waveform: BeatReviewWaveformV1, thumbnails: ReadonlyMap<number, string>) {
  if (waveform.samples !== plan.sampleCount || waveform.bins.length !== plan.request.waveformBins
    || waveform.bins.some(b => !Number.isFinite(b.min) || !Number.isFinite(b.max) || b.min > b.max || b.samples < 1)
    || waveform.bins.reduce((n, b) => n + b.samples, 0) !== waveform.samples) throw Error("BEAT_REVIEW_WAVEFORM_INVALID");
  if (thumbnails.size !== plan.frameIndices.length || plan.frameIndices.some(n => !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(thumbnails.get(n) ?? "")))
    throw Error("BEAT_REVIEW_THUMBNAILS_INCOMPLETE");
  const height = 470 + plan.groups.length * 230, parts: string[] = [];
  const text = (x: number, y: number, value: string, size = 16, anchor: "start" | "middle" | "end" = "start") =>
    `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}">${escape(value)}</text>`;
  const title = Array.from(plan.request.title);
  const wordBreak = title.slice(0, 70).lastIndexOf(" "), split = title.length <= 70 ? title.length : wordBreak > 35 ? wordBreak : 70;
  parts.push(text(40, 38, title.slice(0, split).join(""), 24), text(40, 68, title.slice(split).join("").trimStart(), 24));
  parts.push(text(40, 96, `Source ${fixed(plan.request.window.sourceStartSeconds)}s + ${fixed(plan.request.window.durationSeconds)}s | BPM raw ${plan.tempo.rawBpm?.toFixed(2) ?? "none"} / chosen ${plan.tempo.bpm?.toFixed(2) ?? "none"} | ${plan.tempo.state}`));
  parts.push(text(40, 124, "ART_PENDING_CLAUDE | Listening PENDING_HAO | F-measure NOT_MEASURED"));
  parts.push('<rect x="40" y="155" width="1120" height="170" fill="none" stroke="#aaa"/>');
  const y = (v: number) => 240 - Math.max(-1, Math.min(1, v)) * 70;
  const waveformPath = waveform.bins.map((b, i) => { const x = fixed(40 + (i + .5) / waveform.bins.length * 1120);
    return `M${x} ${fixed(y(b.min))}V${fixed(y(b.max))}`; }).join("");
  parts.push(`<path d="${waveformPath}" fill="none" stroke="#777" stroke-width="1"/>`);
  for (const event of plan.events) {
    const x = fixed(40 + event.offsetSeconds / plan.request.window.durationSeconds * 1120), bar = event.kind === "bar";
    parts.push(`<line data-event-kind="${event.inferred ? "inferred" : "observed"}-${event.kind}" x1="${x}" x2="${x}" y1="${bar ? 160 : 190}" y2="${bar ? 320 : 290}" stroke="#111" stroke-width="${bar ? 2.5 : .7}"${event.inferred ? ' stroke-dasharray="5 4"' : ""}><title>${escape(`${label(event.kind, event.inferred)} at ${fixed(event.timeSeconds)}s; confidence ${(event.confidence * 100).toFixed(1)}%`)}</title></line>`);
  }
  for (let i = 0; i <= 8; i++) parts.push(text(40 + i * 140, 350, `${fixed(plan.request.window.sourceStartSeconds + i * plan.request.window.durationSeconds / 8)}s`, 13,
    i === 0 ? "start" : i === 8 ? "end" : "middle"));
  parts.push(text(40, 380, "Solid = observed candidate; dashed = inferred hypothesis. Tall/thick = bar; short/thin = pulse."));
  parts.push(text(40, 404, `Audition: 16000 Hz mono s16. Clipped samples ${waveform.clippedSamples}; raw peak ${fixed(waveform.peak)}. No source-quality claim.`, 14));
  if (!plan.request.montage) parts.push(text(40, 442, "No montage supplied. Frame alignment has not been reviewed."));
  plan.groups.forEach((group, row) => {
    const top = 440 + row * 230, event = group.event;
    parts.push(text(40, top, event ? `${label(event.kind, event.inferred)} ${fixed(event.timeSeconds)}s | confidence ${(event.confidence * 100).toFixed(1)}%`
      : `No beat candidate; uniform context at ${fixed(group.sourceSeconds)}s`));
    group.frames.forEach((frame, col) => {
      const x = 40 + col * 375, videoTime = plan.request.montage!.sourceStartSeconds + frame / plan.request.reviewFps;
      parts.push(`<image x="${x}" y="${top + 10}" width="320" height="180" href="${thumbnails.get(frame)!}"/>`);
      parts.push(text(x, top + 212, `review f${frame} (${frame < group.centerFrame ? "before" : frame > group.centerFrame ? "after" : "nearest"}) / video ${fixed(videoTime)}s`, 13));
    });
  });
  parts.push(text(40, height - 12, "Review FPS grid, not original decoder PTS. Music/video offset is caller asserted. No project edits or approval.", 13));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-label="Beat analysis review, pending human approval"><rect width="1200" height="${height}" fill="white"/><g fill="#111" font-family="monospace">${parts.join("")}</g></svg>`;
}

export function beatReviewHtmlV1(title: string, svg: string, wavBase64: string) {
  if (!/^[A-Za-z0-9+/]+=*$/.test(wavBase64)) throw Error("BEAT_REVIEW_AUDIO_DATA_INVALID");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'"><title>${escape(title)}</title><style>body{margin:16px;font:16px monospace;color:#111;background:#fff}svg{display:block;max-width:100%;height:auto}audio{width:min(100%,640px)}p{max-width:90ch}</style></head><body><p>Private review. ART_PENDING_CLAUDE / Listening PENDING_HAO / F-measure NOT_MEASURED.</p><p>Listen to the bounded excerpt while inspecting the source-time ticks and frame triplets. Dashed ticks remain inferred hypotheses. The audio is resampled mono for timing review.</p><audio controls preload="metadata" src="data:audio/wav;base64,${wavBase64}"></audio>${svg}</body></html>`;
}

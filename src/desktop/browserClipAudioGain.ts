import type { ActivePreviewLayer } from "../application/previewMedia";
import type { TimelineClip } from "../domain/types";
import { clipAudioGainAt } from "../domain/clipAudioEnvelope";

const contexts = new WeakMap<Document, AudioContext>();
interface Entry {
  media: HTMLMediaElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  connected: boolean;
  layer?: ActivePreviewLayer;
  enabled: boolean;
  rate: number;
  key: string;
  origin: number;
  localOrigin: number;
  until: number;
  timer?: number;
  refresh: () => void;
}
// An element can only be attached to one MediaElementAudioSourceNode. Reuse that node across React remounts.
const entries = new WeakMap<HTMLMediaElement, Entry>();

/** The same sample envelope used by export/native playback, scheduled on the audio clock instead of UI frames. */
export function scheduleBrowserClipAudioGain(param: AudioParam, clip: TimelineClip, localStart: number,
  wallDuration: number, rate: number, contextStart: number, sampleRate = 48000, music = false): void {
  if (![localStart, wallDuration, rate, contextStart, sampleRate].every(Number.isFinite)
    || wallDuration <= 0 || wallDuration > 2 || rate <= 0 || sampleRate < 8000 || sampleRate > 192000) {
    throw Error("聲音預覽時間不合法，請重新播放。");
  }
  const count = Math.max(2, Math.ceil(wallDuration * sampleRate) + 1);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = clipAudioGainAt(clip, localStart + i / (count - 1) * wallDuration * rate, music);
  param.cancelScheduledValues(0);
  param.setValueCurveAtTime(values, contextStart, wallDuration);
  if (localStart + wallDuration * rate >= clip.duration - 1e-8) param.setValueAtTime(0, contextStart + wallDuration);
}

function refresh(entry: Entry, force = false): void {
  const { media, context, gain, layer, rate } = entry;
  if (!layer || !entry.enabled || media.paused || media.seeking) return;
  const clip = layer.clip, now = context.currentTime;
  const local = Math.max(0, Math.min(clip.duration, media.currentTime - clip.sourceStart));
  const remaining = (clip.duration - local) / rate;
  if (remaining <= 0) { gain.gain.cancelScheduledValues(0); gain.gain.setValueAtTime(0, now); return; }
  const key = JSON.stringify([clip.id, clip.sourceStart, clip.duration, clip.volume, clip.audioEnvelope, layer.asset.role, rate]);
  const drift = Math.abs(local - (entry.localOrigin + (now - entry.origin) * rate));
  if (!force && key === entry.key && now < entry.until - .5 && drift < .05) return;
  entry.key = key; entry.origin = now; entry.localOrigin = local;
  const duration = Math.min(2, remaining); entry.until = now + duration;
  if (clip.audioEnvelope) scheduleBrowserClipAudioGain(gain.gain, clip, local, duration, rate, now, context.sampleRate, layer.asset.role === "background-music");
  else { gain.gain.cancelScheduledValues(0); gain.gain.setValueAtTime(Math.max(0, Math.min(1, clip.volume)), now); }
}
function connect(entry: Entry): void {
  if (entry.connected) return;
  entry.source.connect(entry.gain); entry.gain.connect(entry.context.destination); entry.connected = true;
}
function release(entry: Entry): void {
  entry.enabled = false; entry.layer = undefined; entry.key = "";
  if (entry.timer !== undefined) entry.media.ownerDocument.defaultView?.clearInterval(entry.timer);
  entry.timer = undefined;
  entry.media.removeEventListener("playing", entry.refresh);
  entry.media.removeEventListener("seeked", entry.refresh);
  entry.media.removeEventListener("ratechange", entry.refresh);
  entry.gain.gain.cancelScheduledValues(0); entry.gain.gain.setValueAtTime(0, entry.context.currentTime);
  if (entry.connected) { entry.source.disconnect(); entry.gain.disconnect(); entry.connected = false; }
}
export function createBrowserClipAudioGainController(onFailure?: (media: HTMLMediaElement, error: unknown) => void) {
  const owned = new Set<Entry>();
  return {
    sync(media: HTMLMediaElement, layer: ActivePreviewLayer | undefined, enabled: boolean, rate: number): boolean {
      let entry = entries.get(media);
      if (!layer) { if (entry && owned.has(entry)) { release(entry); owned.delete(entry); } return true; }
      if (!entry && (!layer.clip.audioEnvelope || !enabled)) return true;
      try {
        if (!entry) {
          const doc = media.ownerDocument, Constructor = doc.defaultView?.AudioContext;
          if (!Constructor) throw Error("目前無法播放聲音曲線，請改用原生預覽或重新開啟預覽。");
          let context = contexts.get(doc);
          if (!context) { context = new Constructor({ sampleRate: 48000 }); contexts.set(doc, context); }
          const source = context.createMediaElementSource(media), gain = context.createGain();
          entry = { media, context, source, gain, connected: false, enabled: false, rate, key: "", origin: 0, localOrigin: 0, until: 0, refresh: () => {} };
          entry.refresh = () => refresh(entry!, true);
          entries.set(media, entry);
        }
        const wasEnabled = entry.enabled;
        entry.layer = layer; entry.enabled = enabled; entry.rate = rate;
        if (!owned.has(entry)) {
          owned.add(entry); connect(entry);
          media.addEventListener("playing", entry.refresh); media.addEventListener("seeked", entry.refresh); media.addEventListener("ratechange", entry.refresh);
          entry.timer = media.ownerDocument.defaultView?.setInterval(() => refresh(entry!), 500);
        }
        media.volume = 1;
        if (!enabled) { entry.key = ""; entry.gain.gain.cancelScheduledValues(0); entry.gain.gain.setValueAtTime(0, entry.context.currentTime); }
        else {
          if (entry.context.state === "suspended") void entry.context.resume().then(() => refresh(entry!, true), error => { media.pause(); media.muted = true; onFailure?.(media, error); });
          refresh(entry, !wasEnabled);
        }
        return true;
      } catch (error) { media.pause(); media.muted = true; onFailure?.(media, error); return false; }
    },
    retain(live: ReadonlySet<HTMLMediaElement>) { for (const entry of owned) if (!live.has(entry.media)) { release(entry); owned.delete(entry); } },
    dispose() { for (const entry of owned) release(entry); owned.clear(); },
  };
}

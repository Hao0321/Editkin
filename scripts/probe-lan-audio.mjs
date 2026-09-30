import { readFile } from "node:fs/promises";

const [origin, model, audioPath, transport = "input_audio"] = process.argv.slice(2);
if (!origin || !model || !audioPath || !/^http:\/\/(?:127\.0\.0\.1|localhost|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin)) {
  throw Error("Usage: node scripts/probe-lan-audio.mjs <private-LAN-origin> <model> <wav-path>");
}
const audio = (await readFile(audioPath)).toString("base64");
if (!["input_audio", "audio_url"].includes(transport)) throw Error("transport must be input_audio or audio_url");
const audioPart = transport === "input_audio"
  ? { type: "input_audio", input_audio: { data: audio, format: "wav" } }
  : { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${audio}` } };
const response = await fetch(`${origin.replace(/\/$/u, "")}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model, stream: false, temperature: 0, max_tokens: 128,
    messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe this speech audio. Return only the spoken words." },
      audioPart,
    ] }],
  }),
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json().catch(() => ({}));
const message = body?.choices?.[0]?.message?.content;
const error = body?.error?.message ?? body?.detail ?? body?.message;
process.stdout.write(`${JSON.stringify({ httpStatus: response.status, transport, model: body?.model ?? model,
  transcription: typeof message === "string" ? message.slice(0, 500) : undefined,
  error: error === undefined ? undefined : String(error).slice(0, 500) })}\n`);
if (!response.ok) process.exitCode = 1;

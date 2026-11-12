// Probe the saved private LAN model without writing its address or audio bytes to the report.
// Usage: node scripts/review-lan-qwen-asr.mjs <short-wav> <report-json>
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const [audioPath, reportPath] = process.argv.slice(2);
if (!audioPath || !reportPath) throw Error("Usage: node scripts/review-lan-qwen-asr.mjs <short-wav> <report-json>");
const savedPath = join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json");
const { origin: configuredOrigin } = JSON.parse(await readFile(savedPath, "utf8"));
const origin = new URL(configuredOrigin);
if (origin.protocol !== "http:" || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname)) {
  throw Error("Saved model origin is not a private LAN HTTP address");
}
const model = "qwen3.8-27b-nvfp4";
const audio = await readFile(resolve(audioPath));
const report = {
  checkedAt: new Date().toISOString(),
  model,
  sample: { name: basename(audioPath), bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex") },
  requests: {},
};

async function request(path, init = {}) {
  try {
    const response = await fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({}));
    const responseText = Array.isArray(body?.output) ? body.output.flatMap((item) =>
      Array.isArray(item?.content) ? item.content : []).filter((item) =>
        item?.type === "output_text" && typeof item.text === "string").map((item) => item.text).join("\n") : undefined;
    const rawMessage = body?.choices?.[0]?.message?.content ?? body?.text ?? responseText;
    const rawError = body?.error?.message ?? body?.detail ?? body?.message;
    return {
      httpStatus: response.status,
      content: typeof rawMessage === "string" ? rawMessage.slice(0, 300) : undefined,
      error: rawError === undefined ? undefined : String(rawError).replaceAll(origin.origin, "<private-model-origin>").slice(0, 300),
      modelIds: path === "/v1/models" ? (Array.isArray(body?.data) ? body.data : []).map((item) => item?.id).filter((id) => typeof id === "string") : undefined,
      capabilities: path === "/get_model_info" && response.ok ? {
        modelType: body?.model_type, architectures: body?.architectures,
        hasImageUnderstanding: body?.has_image_understanding,
        hasAudioUnderstanding: body?.has_audio_understanding,
      } : undefined,
    };
  } catch (error) {
    return { transportError: String(error?.message ?? error).replaceAll(origin.origin, "<private-model-origin>").slice(0, 300) };
  }
}

const jsonHeaders = { "content-type": "application/json" };
report.requests.models = await request("/v1/models");
report.requests.modelInfo = await request("/get_model_info");
report.requests.text = await request("/v1/chat/completions", {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({ model, stream: false, max_tokens: 128, messages: [{ role: "user", content: "只回覆 OK" }] }),
});
for (const transport of ["input_audio", "audio_url"]) {
  const payload = audio.toString("base64");
  const audioPart = transport === "input_audio"
    ? { type: "input_audio", input_audio: { data: payload, format: "wav" } }
    : { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${payload}` } };
  report.requests[transport] = await request("/v1/chat/completions", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ model, stream: false, max_tokens: 128, messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe this speech audio. Return only the spoken words." }, audioPart,
    ] }] }),
  });
}
report.requests.responsesAudio = await request("/v1/responses", {
  method: "POST", headers: jsonHeaders,
  body: JSON.stringify({ model, stream: false, max_output_tokens: 128, input: [{ role: "user", content: [
    { type: "input_text", text: "Transcribe this speech audio. Return only the spoken words." },
    { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
  ] }] }),
});
const form = new FormData();
form.append("file", new Blob([audio], { type: "audio/wav" }), basename(audioPath));
form.append("model", model);
form.append("language", "zh");
report.requests.transcriptions = await request("/v1/audio/transcriptions", { method: "POST", body: form });
report.textAvailable = report.requests.models?.modelIds?.includes(model)
  && report.requests.text?.httpStatus === 200
  && report.requests.text?.content?.includes("OK");
report.asrAvailable = ["input_audio", "audio_url", "responsesAudio", "transcriptions"].some((key) =>
  report.requests[key]?.httpStatus === 200 && /[\u4e00-\u9fff]/u.test(report.requests[key]?.content ?? ""));
await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ textAvailable: report.textAvailable, asrAvailable: report.asrAvailable,
  modelCapabilities: report.requests.modelInfo?.capabilities,
  audioStatuses: ["input_audio", "audio_url", "responsesAudio", "transcriptions"].map((key) => [key, report.requests[key]?.httpStatus ?? null]) })}\n`);

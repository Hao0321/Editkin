import { createSfxApprovalReviewV1, createEmptySfxListeningPreferencesV1, decodeSfxListeningPreferencesV1, encodeSfxListeningPreferencesV1,
  recordSfxListeningPreferenceV1, SFX_LISTENING_DOCUMENT_MAX_BYTES_V1, type SfxListeningPreferencesV1 } from "../../src/application/sfxApprovalV1";

async function start() {
  const status = document.querySelector<HTMLElement>("#status")!, player = document.querySelector<HTMLAudioElement>("#audition")!,
    reviewer = document.querySelector<HTMLInputElement>("#reviewer")!, reopen = document.querySelector<HTMLInputElement>("#reopen")!;
  const payload = JSON.parse(document.querySelector("#review-data")!.textContent!);
  const book = await createSfxApprovalReviewV1(payload.entries, payload.generatorPins);
  if (book.reviewSha256 !== payload.reviewSha256 || payload.sounds.length !== 40) throw Error("SFX_SHEET_IDENTITY_MISMATCH");
  const sounds = new Map<string, string>();
  for (const sound of payload.sounds) {
    const entry = book.entries.find(e => e.id === sound.id);
    if (!entry || sounds.has(sound.id) || typeof sound.wavBase64 !== "string") throw Error("SFX_SHEET_WAV_CLOSURE_REQUIRED");
    const bytes = Uint8Array.from(atob(sound.wavBase64), c => c.charCodeAt(0));
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)), b => b.toString(16).padStart(2, "0")).join("");
    if (bytes.length !== entry.bytes || sha !== entry.sha256) throw Error("SFX_SHEET_WAV_IDENTITY_MISMATCH");
    sounds.set(sound.id, sound.wavBase64);
  }
  let preferences = createEmptySfxListeningPreferencesV1(book), auditionEpoch = 0, importEpoch = 0;
  const rows = new Map(Array.from(document.querySelectorAll<HTMLElement>("[data-sound-id]"), row => [row.dataset.soundId!, row]));
  if (rows.size !== 40 || book.entries.some(e => !rows.has(e.id))) throw Error("SFX_SHEET_ROW_CLOSURE_REQUIRED");
  const refresh = () => {
    for (const [id, row] of rows) {
      const choice = preferences.decisions.find(d => d.id === id);
      row.querySelector<HTMLSelectElement>("select")!.value = choice?.preference ?? "unreviewed";
      row.querySelector<HTMLTextAreaElement>("textarea")!.value = choice?.note ?? "";
      row.querySelector<HTMLElement>(".decision")!.textContent = choice ? `${choice.reviewer} · ${choice.recordedAt}` : "尚無試聽紀錄";
    }
    status.dataset.decisionCount = String(preferences.decisions.length);
    status.textContent = `40 項來源已核對；已記錄 ${preferences.decisions.length} 項。偏好紀錄不代表聲音認證或預設啟用。`;
  };
  const stop = () => { auditionEpoch++; player.pause(); player.removeAttribute("src"); player.removeAttribute("data-sound-id"); player.load(); };
  for (const [id, row] of rows) {
    row.querySelector<HTMLButtonElement>(".play")!.addEventListener("click", () => {
      const epoch = ++auditionEpoch; player.pause(); player.src = "data:audio/wav;base64," + sounds.get(id); player.dataset.soundId = id;
      player.play().catch(error => { if (epoch === auditionEpoch) status.textContent = String(error); });
    });
    const record = () => {
      try {
        const previous = preferences.decisions.find(d => d.id === id), time = Math.max(Date.now(), previous ? Date.parse(previous.recordedAt) + 1 : 0);
        preferences = recordSfxListeningPreferenceV1(book, preferences, { id, reviewer: reviewer.value,
          recordedAt: new Date(time).toISOString(), preference: row.querySelector<HTMLSelectElement>("select")!.value,
          note: row.querySelector<HTMLTextAreaElement>("textarea")!.value }); refresh();
      } catch (error) { refresh(); status.textContent = "無法記錄：" + String(error); }
    };
    row.querySelector("select")!.addEventListener("change", record); row.querySelector("textarea")!.addEventListener("change", record);
  }
  const urls = new Set<string>();
  document.querySelector("#download")!.addEventListener("click", () => {
    try {
      const bytes = encodeSfxListeningPreferencesV1(book, preferences), url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/json" }));
      urls.add(url); const a = document.createElement("a"); a.href = url; a.download = "Editkin-SFX-preferences.json"; a.click();
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    } catch (error) { status.textContent = "無法下載：" + String(error); }
  });
  reopen.addEventListener("change", async () => {
    const epoch = ++importEpoch, file = reopen.files?.[0]; if (!file) return;
    try {
      if (file.size > SFX_LISTENING_DOCUMENT_MAX_BYTES_V1) throw Error("SFX_PREFERENCES_DOCUMENT_BUDGET");
      const bytes = new Uint8Array(await file.arrayBuffer()); if (epoch !== importEpoch) return;
      const loaded: SfxListeningPreferencesV1 = decodeSfxListeningPreferencesV1(book, bytes); stop(); preferences = loaded; refresh();
    } catch (error) { if (epoch === importEpoch) status.textContent = "無法重開：" + String(error); }
    finally { if (epoch === importEpoch) reopen.value = ""; }
  });
  window.addEventListener("pagehide", () => { importEpoch++; stop(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); });
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-action]").forEach(element => { element.disabled = false; });
  refresh(); document.documentElement.dataset.reviewReady = "true";
}
start().catch(error => { document.querySelector("#status")!.textContent = "來源驗證失敗，試聽與紀錄保持停用：" + String(error); document.documentElement.dataset.reviewReady = "failed"; });

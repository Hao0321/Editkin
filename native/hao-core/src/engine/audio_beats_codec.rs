//! One pinned codec child -> bounded PCM -> native beat DSP. No exported audio is modified.
use super::{audio_beats::{Analysis, BeatAnalyzer, SAMPLE_RATE, MAX_SAMPLES, RhythmV2, refine_rhythm_v2},
    audio_codec_pipe::{DecoderAudit, DecoderPipe}, audio_codec_stream::ValidatedDecoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, fs::{File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::AtomicBool}, time::Instant};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub schema: String, pub input_path: PathBuf, pub source_bytes: u64, pub source_sha256: String,
    pub ffmpeg_path: PathBuf, pub ffmpeg_sha256: String, pub source_start_seconds: f64,
    pub duration_seconds: f64, pub prior_bpm: Option<f64>,
    #[serde(default)] pub rhythm_refinement_v2: bool,
    pub output_path: PathBuf,
}
fn valid_sha(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn validate(request: &Request) -> Result<u64, String> {
    let count = (request.duration_seconds * SAMPLE_RATE as f64).round();
    if request.schema != "editkin.music-beats-request/v1" || !request.input_path.is_absolute()
        || !request.ffmpeg_path.is_absolute() || !request.output_path.is_absolute()
        || request.input_path == request.output_path || request.ffmpeg_path == request.output_path
        || !valid_sha(&request.source_sha256) || !valid_sha(&request.ffmpeg_sha256)
        || request.source_bytes == 0 || request.source_bytes > 64 * 1024_u64.pow(3)
        || !request.duration_seconds.is_finite() || request.duration_seconds <= 0.0
        || count < 1.0 || count > MAX_SAMPLES as f64 { return Err("MUSIC_BEATS_REQUEST_INVALID".into()); }
    BeatAnalyzer::new(request.prior_bpm, request.source_start_seconds)?;
    Ok(count as u64)
}
pub fn decoder_args(request: &Request, count: u64) -> Result<Vec<OsString>, String> {
    validate(request)?;
    // An integer-second anchor preserves rational resampling phase and bounded codec preroll.
    let anchor = (request.source_start_seconds.floor() as u64).saturating_sub(1);
    let trim = ((request.source_start_seconds - anchor as f64) * SAMPLE_RATE as f64).round() as u64;
    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,wav,flac,mp3,ogg,aac"]
        .into_iter().map(OsString::from).collect();
    if anchor > 0 { args.extend([OsString::from("-ss"), anchor.to_string().into()]); }
    args.push("-i".into()); args.push(request.input_path.as_os_str().to_owned());
    args.extend(["-map".into(), "0:a:0".into(), "-vn".into(), "-sn".into(), "-dn".into(), "-filter_threads".into(), "1".into(),
        "-af".into(), format!("aresample={SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=mono,atrim=start_sample={trim}:end_sample={},asetpts=PTS-STARTPTS", trim + count).into(),
        "-t".into(), format!("{:.9}", count as f64 / SAMPLE_RATE as f64).into(), "-c:a".into(), "pcm_f32le".into(),
        "-ar".into(), SAMPLE_RATE.to_string().into(), "-ac".into(), "1".into(), "-f".into(), "f32le".into(), "pipe:1".into()]);
    Ok(args)
}
fn open_source(request: &Request) -> Result<File, String> {
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(1); }
    let mut file = options.open(&request.input_path).map_err(|e| format!("MUSIC_BEATS_SOURCE_OPEN: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != request.source_bytes { return Err("MUSIC_BEATS_SOURCE_CHANGED".into()); }
    let mut sha = Sha256::new(); let mut buffer = [0_u8; 65_536]; let mut read = 0_u64;
    loop { let n = file.read(&mut buffer).map_err(|e| e.to_string())?; if n == 0 { break; }
        read += n as u64; if read > request.source_bytes { return Err("MUSIC_BEATS_SOURCE_CHANGED".into()); } sha.update(&buffer[..n]); }
    if read != request.source_bytes || format!("{:x}", sha.finalize()) != request.source_sha256 { return Err("MUSIC_BEATS_SOURCE_CHANGED".into()); }
    Ok(file)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResult {
    #[serde(flatten)] legacy: Analysis,
    #[serde(skip_serializing_if = "Option::is_none")] rhythm_v2: Option<RhythmV2>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema: String, source_sha256: String, source_bytes: u64, ffmpeg_sha256: String,
    pcm_sha256: String, decoded_bytes: u64, pcm_staged_bytes: u64, maximum_pcm_queue_bytes: usize,
    elapsed_ms: u128, analysis: AnalysisResult, decoder_audit: Vec<serde_json::Value>,
}
struct BoundedWriter { file: File, bytes: usize }
impl Write for BoundedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.bytes.checked_add(data.len()).is_none_or(|n| n > 64 * 1024 * 1024) {
            return Err(std::io::Error::other("MUSIC_BEATS_RESULT_BUDGET_EXCEEDED"));
        }
        let n = self.file.write(data)?; self.bytes += n; Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.file.flush() }
}
pub fn run_request(path: &Path) -> Result<serde_json::Value, String> {
    let started = Instant::now(); let file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 65_536 { return Err("MUSIC_BEATS_REQUEST_BUDGET_EXCEEDED".into()); }
    let mut bytes = Vec::new(); file.take(65_537).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 65_536 { return Err("MUSIC_BEATS_REQUEST_BUDGET_EXCEEDED".into()); }
    let request: Request = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let count = validate(&request)?; let cancel = Arc::new(AtomicBool::new(false));
    // Windows Job lifetime guarantees remain in DecoderPipe, including parent termination.
    let _decoder_guard = ValidatedDecoder::open(&request.ffmpeg_path, &request.ffmpeg_sha256, &cancel)?;
    let _source_guard = open_source(&request)?;
    let audit: DecoderAudit = Arc::new(Mutex::new(Vec::new()));
    let mut decoder = DecoderPipe::start(&request.ffmpeg_path, &decoder_args(&request, count)?, count * 4,
        cancel, audit.clone(), "music-beats-source".into())?;
    let mut analyzer = BeatAnalyzer::new(request.prior_bpm, request.source_start_seconds)?;
    let mut pending = count; let mut buffer = [0_u8; 32_768]; let mut pcm_sha = Sha256::new();
    while pending > 0 {
        let samples = pending.min(8192) as usize; let block = &mut buffer[..samples * 4]; decoder.read_exact(block)?;
        pcm_sha.update(&*block);
        let decoded: Vec<f32> = block.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        analyzer.push(&decoded)?; pending -= samples as u64;
    }
    decoder.finish()?;
    let analysis = analyzer.finish()?;
    let rhythm_v2 = if request.rhythm_refinement_v2 { Some(refine_rhythm_v2(&analysis, request.prior_bpm)?) } else { None };
    if analysis.decoded_samples != count { return Err("MUSIC_BEATS_SAMPLE_COUNT_MISMATCH".into()); }
    let observed = audit.lock().map_err(|_| "music decoder audit poisoned")?.clone();
    if observed.len() != 1 || observed[0]["treeClosed"] != true || observed[0]["pipeThreadsClosed"] != true
        || observed[0]["exitBeforeCleanup"] != 0 || observed[0]["decodedBytes"] != count * 4 { return Err("MUSIC_BEATS_DECODER_CLOSE_UNPROVEN".into()); }
    let receipt = Receipt { schema: "editkin.music-beats-receipt/v1".into(), source_sha256: request.source_sha256,
        source_bytes: request.source_bytes, ffmpeg_sha256: request.ffmpeg_sha256, pcm_sha256: format!("{:x}", pcm_sha.finalize()),
        decoded_bytes: count * 4, pcm_staged_bytes: 0, maximum_pcm_queue_bytes: 32_768 * 4,
        elapsed_ms: started.elapsed().as_millis(), analysis: AnalysisResult { legacy: analysis, rhythm_v2 }, decoder_audit: observed };
    let output = OpenOptions::new().write(true).create_new(true).open(&request.output_path).map_err(|e| e.to_string())?;
    let mut writer = BoundedWriter { file: output, bytes: 0 };
    serde_json::to_writer(&mut writer, &receipt).map_err(|e| e.to_string())?; writer.flush().map_err(|e| e.to_string())?;
    writer.file.sync_all().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"schema":"editkin.music-beats-command/v1","outputBytes":writer.bytes,
        "decodedSamples":count,"pcmStagedBytes":0,"decoderTreeClosed":true,"outputPath":request.output_path}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request { Request { schema: "editkin.music-beats-request/v1".into(), input_path: PathBuf::from("D:/owned.wav"),
        source_bytes: 10, source_sha256: "a".repeat(64), ffmpeg_path: PathBuf::from("D:/owned-ffmpeg.exe"), ffmpeg_sha256: "b".repeat(64),
        source_start_seconds: 0.0, duration_seconds: 2.0, prior_bpm: None, rhythm_refinement_v2: false, output_path: PathBuf::from("D:/owned-result.json") } }
    #[test]
    fn origin_decode_does_not_seek_or_allocate_a_pcm_file() {
        let r = request(); let args = decoder_args(&r, 32_000).unwrap();
        assert!(!args.iter().any(|s| s == "-ss")); assert_eq!(args.last().unwrap(), "pipe:1");
        assert!(args.iter().any(|s| s.to_string_lossy().contains("atrim=start_sample=0:end_sample=32000")));
    }
    #[test]
    fn late_seek_retains_history_and_uses_wide_exact_sample_ranges() {
        let mut r = request(); r.source_start_seconds = 36_000.25; r.duration_seconds = 86_400.0;
        let count = validate(&r).unwrap(); assert!(count * 4 > u32::MAX as u64);
        let args = decoder_args(&r, count).unwrap();
        assert!(args.windows(2).any(|a| a[0] == "-ss" && a[1] == "35999"));
        assert!(args.iter().any(|s| s.to_string_lossy().contains("start_sample=20000:end_sample=1382420000")));
    }
    #[test]
    fn malformed_requests_are_rejected_before_spawning_a_codec() {
        let mut r = request(); r.duration_seconds = f64::NAN; assert!(validate(&r).is_err());
        r = request(); r.source_bytes = 0; assert!(validate(&r).is_err());
        r = request(); r.output_path = r.input_path.clone(); assert!(validate(&r).is_err());
        r = request(); r.ffmpeg_sha256 = "untrusted".into(); assert!(validate(&r).is_err());
        r = request(); r.duration_seconds = 86_401.0; assert!(validate(&r).is_err());
    }
}

//! Direct codec -> bounded PCM -> native stateful DSP. No source PCM staging.
use super::{
    audio::{self, AudioBuffer},
    audio_codec_pipe::{DecoderAudit, DecoderPipe},
    audio_codec_schedule::{MAX_CATALOG, Schedule},
    audio_stream::{LIMITER_POLICY, StreamBlock, StreamSettings, StreamingAudioGraph},
    audio_stream_pull::AudioBlockReader,
    model::{AudioGraph, AutomationLane},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
const SCHEMA: &str = "editkin.audio-codec-stream-plan/v1";
const CATALOG_SCHEMA: &str = "editkin.audio-codec-stream-plan/v2";
const MAX_FRAME: u64 = 48000 * 86400;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema: String,
    generation: u64,
    start_frame: u64,
    frame_count: u64,
    block_frames: usize,
    lookahead_frames: usize,
    limiter_release_ms: f32,
    limiter_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    media_roots: Vec<PathBuf>,
    graph: AudioGraph,
    sources: Vec<Source>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: String,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    timeline_start_frame: u64,
    source_start_frame: u64,
    duration_frames: u64,
    audio_stream_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gain_db: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gain_automation: Option<AutomationLane>,
}
struct ActiveSource {
    spec: Source,
    _guard: Arc<File>,
    from: u64,
    to: u64,
    next: u64,
    pipe: Option<DecoderPipe>,
}
pub struct CodecAudioStream {
    pub generation: u64,
    pub start_frame: u64,
    pub frame_count: u64,
    block_frames: usize,
    position: u64,
    chunks: u64,
    stream: StreamingAudioGraph,
    sources: Vec<ActiveSource>,
    schedule: Schedule,
    catalog: bool,
    unique_files_hashed: usize,
    decoder: PathBuf,
    _decoder_guard: Arc<File>,
    decoder_sha: String,
    manifest_sha: String,
    cancel: Arc<AtomicBool>,
    pub audit: DecoderAudit,
    finished: bool,
    failed: bool,
}
/// A decoder executable is hashed once and held immutable for a resident session.
/// The same guard is shared with each reader; no executable comes from a plan.
#[derive(Clone)]
pub struct ValidatedDecoder {
    path: PathBuf,
    sha256: String,
    guard: Arc<File>,
}
impl ValidatedDecoder {
    pub fn open(path: &Path, sha256: &str, cancel: &AtomicBool) -> Result<Self, String> {
        let (path, guard) = locked_identity(path, None, sha256, 256 * 1024 * 1024, cancel)?;
        Ok(Self {
            path,
            sha256: sha256.into(),
            guard: Arc::new(guard),
        })
    }
}
fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn locked_identity(
    path: &Path,
    expected: Option<u64>,
    hash: &str,
    max: u64,
    cancel: &AtomicBool,
) -> Result<(PathBuf, File), String> {
    if !path.is_absolute() || !valid_sha(hash) {
        return Err("codec path/hash identity invalid".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| format!("codec path unavailable: {e}"))?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(canonical.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
        {
            return Err("codec requires a local disk file, not a network share".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options
        .open(&canonical)
        .map_err(|e| format!("open immutable codec input: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let size = metadata.len();
    if !metadata.is_file() || size == 0 || size > max || expected.is_some_and(|n| n != size) {
        return Err("codec file byte identity exceeds contract".into());
    }
    let mut sha = Sha256::new();
    let mut buffer = [0_u8; 65536];
    let mut read = 0_u64;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("codec input validation cancelled".into());
        }
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if read > size {
            return Err("codec input grew during validation".into());
        }
        sha.update(&buffer[..n]);
    }
    if read != size || format!("{:x}", sha.finalize()) != hash {
        return Err("codec file SHA-256 mismatch".into());
    }
    Ok((canonical, file))
}
pub fn decoder_args(
    path: &Path,
    stream: u32,
    offset: u64,
    frames: u64,
) -> Result<Vec<OsString>, String> {
    if !path.is_absolute()
        || stream > 31
        || frames == 0
        || offset.checked_add(frames).is_none_or(|n| n > MAX_FRAME)
    {
        return Err("codec decode range invalid".into());
    }
    // Seeking directly to the first requested sample resets codec overlap and
    // resampler history at that boundary. Use an integer-second anchor so the
    // rational conversion phase agrees with a decode from zero, and retain
    // 1..2 seconds of history before trimming canonical 48 kHz sample indices.
    // This is bounded preroll, not whole-source decoding or PCM staging.
    let anchor_seconds = (offset / 48000).saturating_sub(1);
    let trim_frames = offset - anchor_seconds * 48000;
    let mut strings = vec![
        "-hide_banner".to_string(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-threads".into(),
        "1".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-format_whitelist".into(),
        "mov,matroska,webm,wav,flac,mp3,ogg,aac".into(),
    ];
    // Even `-ss 0` invokes a demuxer seek. With AAC that can omit the initial
    // priming packet and change decoded samples; an origin read must not seek.
    if anchor_seconds != 0 {
        strings.extend(["-ss".into(), anchor_seconds.to_string()]);
    }
    strings.push("-i".into());
    let mut args = strings.into_iter().map(OsString::from).collect::<Vec<_>>();
    args.push(path.as_os_str().to_owned());
    args.extend(["-map".into(),format!("0:a:{stream}").into(),"-vn".into(),"-sn".into(),"-dn".into(),"-filter_threads".into(),"1".into(),"-af".into(),
        format!("aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,atrim=start_sample={trim_frames}:end_sample={},asetpts=PTS-STARTPTS", trim_frames+frames).into(),
        "-t".into(),format!("{:.9}",frames as f64/48000.0).into(),"-c:a".into(),"pcm_f32le".into(),"-ar".into(),"48000".into(),"-ac".into(),"2".into(),"-f".into(),"f32le".into(),"pipe:1".into()]);
    Ok(args)
}
impl CodecAudioStream {
    pub fn into_prepared_playback(self) -> Result<super::audio_session::PreparedPlayback, String> {
        let (generation, start, frames, cancel) = (
            self.generation,
            self.start_frame,
            self.frame_count,
            self.cancel.clone(),
        );
        super::audio_session::PreparedPlayback::new(self, generation, start, frames, cancel)
    }
    pub fn open(
        plan_path: &Path,
        decoder: &Path,
        decoder_sha: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        Self::open_bound(plan_path, None, decoder, decoder_sha, None, cancel)
    }
    pub fn open_with_decoder(
        plan_path: &Path,
        plan_sha256: &str,
        decoder: &ValidatedDecoder,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if !valid_sha(plan_sha256) {
            return Err("codec plan SHA-256 invalid".into());
        }
        Self::open_bound(
            plan_path,
            Some(plan_sha256),
            &decoder.path,
            &decoder.sha256,
            Some(decoder.guard.clone()),
            cancel,
        )
    }
    fn open_bound(
        plan_path: &Path,
        plan_sha256: Option<&str>,
        decoder: &Path,
        decoder_sha: &str,
        decoder_guard: Option<Arc<File>>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if !plan_path.is_absolute() {
            return Err("codec plan must be absolute".into());
        }
        let mut bytes = Vec::new();
        File::open(plan_path)
            .map_err(|e| e.to_string())?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("codec plan exceeds 4 MiB".into());
        }
        if plan_sha256.is_some_and(|expected| format!("{:x}", Sha256::digest(&bytes)) != expected) {
            return Err("codec plan SHA-256 mismatch".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let plan: Plan = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        super::audio_stream_file::reject_unknown_fields(
            &value,
            &serde_json::to_value(&plan).map_err(|e| e.to_string())?,
        )?;
        let catalog = plan.schema == CATALOG_SCHEMA;
        if (!catalog && plan.schema != SCHEMA)
            || plan.limiter_policy != LIMITER_POLICY
            || plan.frame_count == 0
            || plan
                .start_frame
                .checked_add(plan.frame_count)
                .is_none_or(|n| n > MAX_FRAME)
            || (catalog
                && (plan.media_root.is_some()
                    || plan.media_roots.is_empty()
                    || plan.media_roots.len() > 64
                    || plan.sources.len() > MAX_CATALOG))
            || (!catalog
                && (bytes.len() > 1024 * 1024
                    || value.get("mediaRoots").is_some()
                    || plan.media_root.is_none()
                    || plan.sources.is_empty()
                    || plan.sources.len() > 8))
        {
            return Err("codec plan bounds/schema invalid".into());
        }
        let mut roots = BTreeSet::new();
        for path in plan.media_root.iter().chain(plan.media_roots.iter()) {
            if !path.is_absolute() {
                return Err("codec media root must be absolute".into());
            }
            let root = fs::canonicalize(path).map_err(|e| e.to_string())?;
            if !root.is_dir() || !roots.insert(root) {
                return Err("codec media roots must be distinct directories".into());
            }
        }
        let settings = StreamSettings {
            block_frames: plan.block_frames,
            lookahead_frames: plan.lookahead_frames,
            limiter_release_ms: plan.limiter_release_ms,
        };
        let stream =
            StreamingAudioGraph::new(&plan.graph, settings, plan.generation, plan.start_frame)?;
        let mut ids = BTreeSet::new();
        for (index, source) in plan.sources.iter().enumerate() {
            if !ids.insert(source.id.clone())
                || !source.path.is_absolute()
                || source.bytes == 0
                || source.bytes > 32 * 1024 * 1024 * 1024
                || !valid_sha(&source.sha256)
                || source.duration_frames == 0
                || source.audio_stream_index > 31
                || source
                    .timeline_start_frame
                    .checked_add(source.duration_frames)
                    .is_none_or(|n| n > MAX_FRAME)
                || source
                    .source_start_frame
                    .checked_add(source.duration_frames)
                    .is_none_or(|n| n > MAX_FRAME)
            {
                return Err("codec source identity/range invalid".into());
            }
            let raw = &value["sources"][index];
            if !catalog
                && ["bus", "gainDb", "gainAutomation"]
                    .iter()
                    .any(|key| raw.get(key).is_some())
            {
                return Err("codec v1 does not accept catalog source fields".into());
            }
            if catalog {
                if source.id.is_empty()
                    || source.id.len() > 128
                    || !matches!(source.bus.as_deref(), Some("voice" | "music"))
                {
                    return Err("codec catalog source ID/bus invalid".into());
                }
                audio::db_to_gain(source.gain_db.ok_or("codec catalog gain missing")?)?;
                if let Some(lane) = &source.gain_automation {
                    if lane.property != "gainDb"
                        || lane.points.is_empty()
                        || lane.points.len() > 64
                        || lane.points.windows(2).any(|w| w[0].sample >= w[1].sample)
                    {
                        return Err("codec catalog gain automation invalid".into());
                    }
                    for point in &lane.points {
                        audio::db_to_gain(point.value)?;
                        if point.sample < source.timeline_start_frame
                            || point.sample >= source.timeline_start_frame + source.duration_frames
                        {
                            return Err("codec catalog gain point outside source range".into());
                        }
                    }
                }
            }
        }
        let graph_ids = if catalog {
            BTreeSet::from(["voice".to_string(), "music".to_string()])
        } else {
            ids
        };
        if &graph_ids != stream.source_ids() {
            return Err("codec source IDs do not bind the complete graph".into());
        }
        let schedule = Schedule::new(
            plan.sources
                .iter()
                .map(|s| {
                    (
                        s.timeline_start_frame,
                        s.timeline_start_frame + s.duration_frames,
                    )
                })
                .collect(),
            plan.start_frame,
            plan.start_frame + plan.frame_count,
        )?;
        let (decoder, decoder_guard) = if let Some(guard) = decoder_guard {
            (decoder.to_path_buf(), guard)
        } else {
            let (path, guard) =
                locked_identity(decoder, None, decoder_sha, 256 * 1024 * 1024, &cancel)?;
            (path, Arc::new(guard))
        };
        let mut sources = Vec::new();
        let mut identities: BTreeMap<PathBuf, (u64, String, Arc<File>)> = BTreeMap::new();
        for mut source in plan.sources {
            if cancel.load(Ordering::Acquire) {
                return Err("codec catalog validation cancelled".into());
            }
            let canonical = fs::canonicalize(&source.path).map_err(|e| e.to_string())?;
            if !roots.iter().any(|root| canonical.starts_with(root)) {
                return Err("codec source escaped declared media root".into());
            }
            let guard = if let Some((bytes, sha, guard)) = identities.get(&canonical) {
                if *bytes != source.bytes || *sha != source.sha256 {
                    return Err("codec repeated file identity conflicts".into());
                }
                guard.clone()
            } else {
                let (path, guard) = locked_identity(
                    &canonical,
                    Some(source.bytes),
                    &source.sha256,
                    32 * 1024 * 1024 * 1024,
                    &cancel,
                )?;
                if path != canonical {
                    return Err("codec source changed during binding".into());
                }
                let guard = Arc::new(guard);
                identities.insert(
                    canonical.clone(),
                    (source.bytes, source.sha256.clone(), guard.clone()),
                );
                guard
            };
            source.path = canonical;
            let from = source.timeline_start_frame.max(plan.start_frame);
            let to = (source.timeline_start_frame + source.duration_frames)
                .min(plan.start_frame + plan.frame_count);
            sources.push(ActiveSource {
                spec: source,
                _guard: guard,
                from,
                to,
                next: from,
                pipe: None,
            });
        }
        Ok(Self {
            generation: plan.generation,
            start_frame: plan.start_frame,
            frame_count: plan.frame_count,
            block_frames: settings.block_frames,
            position: plan.start_frame,
            chunks: 0,
            stream,
            sources,
            schedule,
            catalog,
            unique_files_hashed: identities.len(),
            decoder,
            _decoder_guard: decoder_guard,
            decoder_sha: decoder_sha.into(),
            manifest_sha: format!("{:x}", Sha256::digest(&bytes)),
            cancel,
            audit: Arc::new(Mutex::new(Vec::new())),
            finished: false,
            failed: false,
        })
    }
    fn source_blocks(&mut self, frames: usize) -> Result<BTreeMap<String, AudioBuffer>, String> {
        let mut out = self
            .stream
            .source_ids()
            .iter()
            .map(|id| Ok((id.clone(), AudioBuffer::silence(48000, 2, frames)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        while let Some(segment) = self.schedule.next_segment(self.position + frames as u64)? {
            for index in segment.sources {
                let source = &mut self.sources[index];
                let (begin, end) = (segment.from, segment.to);
                if begin != source.next {
                    return Err("codec source timeline gap/overlap".into());
                }
                if source.pipe.is_none() {
                    let offset = source.spec.source_start_frame + source.from
                        - source.spec.timeline_start_frame;
                    let args = decoder_args(
                        &source.spec.path,
                        source.spec.audio_stream_index,
                        offset,
                        source.to - source.from,
                    )?;
                    source.pipe = Some(DecoderPipe::start(
                        &self.decoder,
                        &args,
                        (source.to - source.from) * 8,
                        self.cancel.clone(),
                        self.audit.clone(),
                        source.spec.id.clone(),
                    )?);
                }
                let mut bytes = vec![0_u8; (end - begin) as usize * 8];
                let pipe = source.pipe.as_mut().unwrap();
                pipe.read_exact(&mut bytes)?;
                let at = (begin - self.position) as usize * 2;
                let target = source.spec.bus.as_ref().unwrap_or(&source.spec.id);
                let samples = &mut out
                    .get_mut(target)
                    .ok_or("codec source bus missing")?
                    .samples;
                for (i, sample) in bytes.chunks_exact(4).enumerate() {
                    let value = f32::from_le_bytes(sample.try_into().unwrap());
                    if !value.is_finite() {
                        return Err("codec returned non-finite PCM".into());
                    }
                    let gain = if let Some(db) = source.spec.gain_db {
                        let db = match &source.spec.gain_automation {
                            Some(lane) => audio::automation_value(lane, begin + (i / 2) as u64)?,
                            None => db,
                        };
                        audio::db_to_gain(db)?
                    } else {
                        1.0
                    };
                    if self.catalog {
                        samples[at + i] += value * gain;
                    } else {
                        samples[at + i] = value;
                    }
                }
                source.next = end;
                if end == source.to {
                    pipe.finish()?;
                    source.pipe.take();
                }
            }
        }
        Ok(out)
    }
    fn pull(&mut self) -> Result<Option<StreamBlock>, String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("codec stream cancelled".into());
        }
        if self.finished {
            return Ok(None);
        }
        let end = self.start_frame + self.frame_count;
        if self.position < end {
            let frames = (end - self.position).min(self.block_frames as u64) as usize;
            let blocks = self.source_blocks(frames)?;
            let block = self
                .stream
                .process(self.generation, self.position, &blocks)?;
            self.position += frames as u64;
            self.chunks += 1;
            return Ok(Some(block));
        }
        let block = self.stream.finish(self.generation)?;
        self.finished = true;
        Ok(Some(block))
    }
    pub fn inspect(mut self) -> Result<Value, String> {
        let mut sha = Sha256::new();
        let mut expected = self.start_frame;
        let mut peak = 0_f32;
        while let Some(block) = self.next_block()? {
            if block.start_frame != expected {
                return Err("codec mixed frame gap".into());
            }
            expected += block.buffer.frames() as u64;
            for sample in block.buffer.samples {
                peak = peak.max(sample.abs());
                sha.update(sample.to_le_bytes());
            }
        }
        if expected != self.start_frame + self.frame_count {
            return Err("codec mixed frame count mismatch".into());
        }
        Ok(
            serde_json::json!({"schema":"editkin.codec-stream-inspection/v1","status":"GREEN","mixedSha256":format!("{:x}",sha.finalize()),"samplePeak":peak,"source":self.receipt()}),
        )
    }
}
impl AudioBlockReader for CodecAudioStream {
    fn shutdown(&mut self) -> Result<(), String> {
        let reason = if self.cancel.load(Ordering::Acquire) {
            "cancelled"
        } else if self.finished {
            "finished"
        } else {
            "aborted"
        };
        let mut errors = Vec::new();
        for source in &mut self.sources {
            if let Some(pipe) = source.pipe.as_mut() {
                if let Err(error) = pipe.close(reason) {
                    errors.push(error);
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        if self.failed {
            return Err("codec stream is terminally failed".into());
        }
        let result = self.pull();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn receipt(&self) -> Value {
        serde_json::json!({"schema":"editkin.codec-stream-source/v1","generation":self.generation,"startFrame":self.start_frame,"frames":self.frame_count,
            "manifestSha256":self.manifest_sha,"decoderSha256":self.decoder_sha,"decoderExecutor":"ffmpeg-codec-pipe/v1","dspExecutor":"hao-core-streaming-dag/v1",
            "seekPolicy":"integer-second-anchor-bounded-preroll/v1","maxPrerollFrames":95999,
            "chunks":self.chunks,"finished":self.finished,"failed":self.failed,"stream":self.stream.receipt(),"pcmStagingFiles":0,
            "catalog":self.catalog,"catalogSourceCount":self.sources.len(),"peakActiveSources":self.schedule.peak_active,"uniqueFilesHashed":self.unique_files_hashed,
            "decoderCount":self.audit.lock().map(|v|v.len()).unwrap_or_default(),
            "decoders":self.audit.lock().map(|v|v.iter().take(32).map(|row| if self.catalog {
                serde_json::json!({"sourceId":row["sourceId"],"treeClosed":row["treeClosed"],"pipeThreadsClosed":row["pipeThreadsClosed"],"cleanupError":row["cleanupError"],"decodedBytes":row["decodedBytes"],"expectedBytes":row["expectedBytes"],"exitCode":row["exitCode"]})
            } else {row.clone()}).collect::<Vec<_>>()).unwrap_or_default(),
            "sourceIdentitiesTruncated":self.sources.len()>32,
            "sourceIdentities":self.sources.iter().take(32).map(|s|serde_json::json!({"id":s.spec.id,"sha256":s.spec.sha256,"bytes":s.spec.bytes})).collect::<Vec<_>>(),
            "boundary":"Direct bounded codec stdout and native DSP, not UI/installer completion. Initial file hashing is cold validation. Windows source guards deny write/delete while open; Unix does not claim identical file-lock or process-containment semantics."})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_argv_is_a_bounded_non_shell_codec_only_route() {
        let path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("a $ & 中文 movie.mp4");
        let args = decoder_args(&path, 0, 24000, 48000).unwrap();
        let text = args
            .iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(text.last().unwrap(), "pipe:1");
        assert!(!text.contains(&"-ss".into()));
        assert!(
            text.iter()
                .any(|v| v
                    .contains("atrim=start_sample=24000:end_sample=72000,asetpts=PTS-STARTPTS"))
        );
        let seek = decoder_args(&path, 0, 31 * 48000 + 123, 96000).unwrap();
        let seek = seek.iter().map(|v| v.to_string_lossy()).collect::<Vec<_>>();
        assert_eq!(
            seek[seek.iter().position(|v| *v == "-ss").unwrap() + 1],
            "30"
        );
        assert!(
            seek.iter()
                .any(|v| v.contains("atrim=start_sample=48123:end_sample=144123,"))
        );
        assert!(text.contains(&"file,pipe".into()));
        assert!(!text.iter().any(|v| v.contains("amix")
            || v.contains("volume")
            || v.contains("alimiter")
            || v == "-y"));
        assert!(decoder_args(Path::new("relative.mp4"), 0, 0, 1).is_err());
        assert!(decoder_args(&path, 32, 0, 1).is_err());
        assert!(decoder_args(&path, 0, 0, 0).is_err());
    }
    #[test]
    fn codec_hash_and_range_validation_reject_invalid_contracts() {
        assert!(valid_sha(&"0".repeat(64)));
        assert!(!valid_sha(&"G".repeat(64)));
        assert!(!valid_sha("a"));
        assert!(
            CodecAudioStream::open(
                Path::new("relative"),
                Path::new("ffmpeg.exe"),
                "bad",
                Arc::new(AtomicBool::new(false))
            )
            .is_err()
        );
    }
}

//! Native worker-side file adapter for the explicitly versioned streaming DAG.
//! Sources are pulled in bounded blocks; this adapter does not decode codecs,
//! itself open an audio device or pretend that the installed UI uses this route yet.
use super::{
    audio::AudioBuffer,
    audio_stream::{EXECUTOR, LIMITER_POLICY, StreamBlock, StreamSettings, StreamingAudioGraph},
    model::AudioGraph,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const SCHEMA: &str = "editkin.audio-stream-plan/v1";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
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
    graph: AudioGraph,
    sources: Vec<Source>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    id: String,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    timeline_start_frame: u64,
    source_start_frame: u64,
    duration_frames: u64,
}
struct OpenSource {
    spec: Source,
    file: File,
}

pub(super) fn reject_unknown_fields(input: &Value, normalized: &Value) -> Result<(), String> {
    match (input, normalized) {
        (Value::Object(original), Value::Object(canonical)) => {
            for (key, value) in original {
                reject_unknown_fields(
                    value,
                    canonical
                        .get(key)
                        .ok_or_else(|| format!("unknown stream plan field: {key}"))?,
                )?;
            }
        }
        (Value::Array(original), Value::Array(canonical)) => {
            if original.len() != canonical.len() {
                return Err("stream plan array identity changed".into());
            }
            for (a, b) in original.iter().zip(canonical) {
                reject_unknown_fields(a, b)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn hash_reader(file: &mut File, expected_bytes: u64) -> Result<String, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut remaining = expected_bytes + 1;
    loop {
        let limit = (remaining as usize).min(buffer.len());
        let n = file.read(&mut buffer[..limit]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        remaining -= n as u64;
        if remaining == 0 {
            return Err("stream source grew beyond declared byte bound".into());
        }
        sha.update(&buffer[..n]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
struct OwnedOutput {
    file: Option<File>,
    path: PathBuf,
}
impl Drop for OwnedOutput {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}
impl OpenSource {
    fn block(&mut self, start: u64, frames: usize) -> Result<AudioBuffer, String> {
        let mut samples = vec![0.0; frames * 2];
        let overlap_start = start.max(self.spec.timeline_start_frame);
        let overlap_end =
            (start + frames as u64).min(self.spec.timeline_start_frame + self.spec.duration_frames);
        if overlap_start < overlap_end {
            let first =
                self.spec.source_start_frame + overlap_start - self.spec.timeline_start_frame;
            self.file
                .seek(SeekFrom::Start(first * 8))
                .map_err(|e| e.to_string())?;
            let count = (overlap_end - overlap_start) as usize;
            let mut bytes = vec![0_u8; count * 8];
            self.file
                .read_exact(&mut bytes)
                .map_err(|e| format!("stream source truncated: {e}"))?;
            let at = (overlap_start - start) as usize * 2;
            for (i, raw) in bytes.chunks_exact(4).enumerate() {
                samples[at + i] = f32::from_le_bytes(raw.try_into().unwrap());
            }
        }
        Ok(AudioBuffer {
            sample_rate: 48_000,
            channels: 2,
            samples,
        })
    }
}
fn write_block(
    output: &mut OwnedOutput,
    block: StreamBlock,
    expected: &mut u64,
    sha: &mut Sha256,
    peak: &mut f32,
) -> Result<(), String> {
    if block.start_frame != *expected {
        return Err("stream output timeline has a gap or overlap".into());
    }
    let mut bytes = Vec::with_capacity(block.buffer.samples.len() * 4);
    for sample in &block.buffer.samples {
        *peak = peak.max(sample.abs());
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    output
        .file
        .as_mut()
        .unwrap()
        .write_all(&bytes)
        .map_err(|e| e.to_string())?;
    sha.update(&bytes);
    *expected += block.buffer.frames() as u64;
    Ok(())
}

/// Owns validated source handles and persistent DSP. Only the background producer
/// calls this reader; neither file IO nor DSP is permitted in the device callback.
pub struct FileAudioStream {
    pub generation: u64,
    pub start_frame: u64,
    pub frame_count: u64,
    root: PathBuf,
    manifest_sha: String,
    block_frames: usize,
    position: u64,
    chunks: u64,
    finished: bool,
    stream: StreamingAudioGraph,
    sources: Vec<OpenSource>,
}

impl FileAudioStream {
    pub fn open(plan_path: &Path) -> Result<Self, String> {
        if !plan_path.is_absolute() {
            return Err("stream plan path must be absolute".into());
        }
        let plan_path = fs::canonicalize(plan_path).map_err(|e| e.to_string())?;
        if fs::metadata(&plan_path).map_err(|e| e.to_string())?.len() > MAX_MANIFEST_BYTES {
            return Err("stream plan exceeds 1 MiB".into());
        }
        let mut bytes = Vec::new();
        File::open(&plan_path)
            .map_err(|e| e.to_string())?
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("stream plan grew beyond 1 MiB".into());
        }
        let original: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let plan: Plan = serde_json::from_value(original.clone()).map_err(|e| e.to_string())?;
        reject_unknown_fields(
            &original,
            &serde_json::to_value(&plan).map_err(|e| e.to_string())?,
        )?;
        if plan.schema != SCHEMA
            || plan.limiter_policy != LIMITER_POLICY
            || plan.frame_count == 0
            || plan
                .start_frame
                .checked_add(plan.frame_count)
                .is_none_or(|end| end > 48_000 * 86_400)
            || plan.frame_count > MAX_SOURCE_BYTES / 8
            || plan.sources.is_empty()
            || plan.sources.len() > 8
        {
            return Err("unsupported or unbounded stream plan".into());
        }
        let settings = StreamSettings {
            block_frames: plan.block_frames,
            lookahead_frames: plan.lookahead_frames,
            limiter_release_ms: plan.limiter_release_ms,
        };
        let stream =
            StreamingAudioGraph::new(&plan.graph, settings, plan.generation, plan.start_frame)?;
        let root = plan_path.parent().ok_or("stream plan has no parent")?;
        let mut source_ids = BTreeSet::new();
        let mut sources = Vec::new();
        let mut total_bytes = 0_u64;
        for spec in plan.sources {
            if !source_ids.insert(spec.id.clone())
                || !spec.path.is_absolute()
                || spec.bytes == 0
                || spec.bytes > MAX_SOURCE_BYTES
                || spec.bytes % 8 != 0
                || spec.duration_frames == 0
                || spec
                    .source_start_frame
                    .checked_add(spec.duration_frames)
                    .is_none_or(|end| end > spec.bytes / 8)
                || spec
                    .timeline_start_frame
                    .checked_add(spec.duration_frames)
                    .is_none_or(|end| end > 48_000 * 86_400)
                || spec.sha256.len() != 64
                || !spec
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("stream source contract invalid".into());
            }
            let canonical = fs::canonicalize(&spec.path).map_err(|e| e.to_string())?;
            if !canonical.starts_with(root) || canonical == plan_path {
                return Err("stream source escaped plan root".into());
            }
            let mut file = File::open(&canonical).map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() != spec.bytes
                || hash_reader(&mut file, spec.bytes)? != spec.sha256
            {
                return Err("stream source bytes/hash mismatch".into());
            }
            total_bytes += spec.bytes;
            if total_bytes > 512 * 1024 * 1024 {
                return Err("stream source byte budget exceeded".into());
            }
            sources.push(OpenSource { spec, file });
        }
        if &source_ids != stream.source_ids() {
            return Err("stream source bindings do not match complete graph".into());
        }
        Ok(Self {
            generation: plan.generation,
            start_frame: plan.start_frame,
            frame_count: plan.frame_count,
            root: root.to_owned(),
            manifest_sha: format!("{:x}", Sha256::digest(&bytes)),
            block_frames: settings.block_frames,
            position: plan.start_frame,
            chunks: 0,
            finished: false,
            stream,
            sources,
        })
    }

    pub fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        if self.finished {
            return Ok(None);
        }
        let end = self.start_frame + self.frame_count;
        if self.position < end {
            let frames = ((end - self.position) as usize).min(self.block_frames);
            let blocks = self
                .sources
                .iter_mut()
                .map(|source| Ok((source.spec.id.clone(), source.block(self.position, frames)?)))
                .collect::<Result<BTreeMap<_, _>, String>>()?;
            let block = self
                .stream
                .process(self.generation, self.position, &blocks)?;
            self.position += frames as u64;
            self.chunks += 1;
            return Ok(Some(block));
        }
        let tail = self.stream.finish(self.generation)?;
        // Handles are rechecked after consumption. This is local-file drift
        // detection, not an adversarial immutable snapshot or pre-play certification.
        for source in &mut self.sources {
            if source.file.metadata().map_err(|e| e.to_string())?.len() != source.spec.bytes
                || hash_reader(&mut source.file, source.spec.bytes)? != source.spec.sha256
            {
                return Err("stream source changed during rendering".into());
            }
        }
        self.finished = true;
        Ok(Some(tail))
    }

    pub fn receipt(&self) -> Value {
        serde_json::json!({"manifestSha256":self.manifest_sha,"generation":self.generation,
        "startFrame":self.start_frame,"frames":self.frame_count,"chunks":self.chunks,
        "finished":self.finished,"stream":self.stream.receipt(),
        "sourceIdentities":self.sources.iter().map(|source|serde_json::json!({"id":source.spec.id,"sha256":source.spec.sha256,"bytes":source.spec.bytes})).collect::<Vec<_>>()})
    }
}

pub fn render_stream_plan(plan_path: &Path, output_path: &Path) -> Result<Value, String> {
    if !output_path.is_absolute() {
        return Err("stream output path must be absolute".into());
    }
    let mut reader = FileAudioStream::open(plan_path)?;
    let root = reader.root.clone();
    let output_parent =
        fs::canonicalize(output_path.parent().ok_or("stream output has no parent")?)
            .map_err(|e| e.to_string())?;
    if output_parent != root {
        return Err("stream output must be in its owned plan directory".into());
    }
    if output_path.try_exists().map_err(|e| e.to_string())? {
        return Err("stream output already exists".into());
    }
    static NEXT_OUTPUT: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_OUTPUT
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
            value.checked_add(1)
        })
        .map_err(|_| "stream temporary sequence exhausted")?;
    let partial = root.join(format!(".stream-{}-{sequence}.partial", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|e| format!("create new stream output: {e}"))?;
    let mut output = OwnedOutput {
        file: Some(file),
        path: partial,
    };
    let end = reader.start_frame + reader.frame_count;
    let mut expected = reader.start_frame;
    let mut output_sha = Sha256::new();
    let mut peak = 0.0_f32;
    let memory = reader.stream.buffered_sample_bytes();
    while let Some(block) = reader.next_block()? {
        write_block(
            &mut output,
            block,
            &mut expected,
            &mut output_sha,
            &mut peak,
        )?;
        if reader.stream.buffered_sample_bytes() != memory {
            return Err("stream DSP sample storage grew".into());
        }
    }
    if expected != end {
        return Err("stream output frame count mismatch".into());
    }
    output
        .file
        .as_mut()
        .unwrap()
        .flush()
        .map_err(|e| e.to_string())?;
    output
        .file
        .as_mut()
        .unwrap()
        .sync_all()
        .map_err(|e| e.to_string())?;
    drop(output.file.take());
    // Create the completed name atomically without ever replacing an existing
    // destination (rename would overwrite on Unix). Requires hard-link support
    // in this local stage; an unsupported filesystem fails explicitly.
    fs::hard_link(&output.path, output_path)
        .map_err(|e| format!("publish new stream output: {e}"))?;
    let temporary_link_retired = fs::remove_file(&output.path).is_ok();
    Ok(
        serde_json::json!({"schema":"editkin.audio-stream-mix-receipt/v1","status":"GREEN","executor":EXECUTOR,"limiterPolicy":LIMITER_POLICY,
        "manifestSha256":reader.manifest_sha,"generation":reader.generation,"startFrame":reader.start_frame,"frames":reader.frame_count,"sampleRate":48_000,"channels":2,
        "outputBytes":reader.frame_count*8,"outputSha256":format!("{:x}",output_sha.finalize()),"samplePeak":peak,"chunks":reader.chunks,"stream":reader.stream.receipt(),"publication":"atomic-new-hardlink","temporaryLinkRetired":temporary_link_retired,
        "sourceIdentities":reader.receipt()["sourceIdentities"],
        "boundary":"Native bounded worker-side PCM reads and persistent DSP; explicit look-ahead sample-peak limiter, not legacy whole-window normalization or true-peak certification. Local-file hashes before/after consumption are not adversarial immutable-snapshot isolation. No codec decoder/device/UI/installer integration claimed by this receipt."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_relative_paths_before_io() {
        assert!(
            render_stream_plan(Path::new("plan.json"), Path::new("out.f32le"))
                .unwrap_err()
                .contains("absolute")
        );
    }
    #[test]
    fn nested_unknown_semantics_are_rejected() {
        let known =
            serde_json::json!({"graph":{"nodes":[{"operation":{"kind":"gain","gain_db":-2}}]}});
        reject_unknown_fields(&known, &known).unwrap();
        let mut extra = known.clone();
        extra["graph"]["nodes"][0]["operation"]["unimplemented"] = Value::Bool(true);
        assert!(reject_unknown_fields(&extra, &known).is_err());
    }
}

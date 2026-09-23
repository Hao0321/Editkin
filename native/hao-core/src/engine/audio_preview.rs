use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::audio::{AudioBuffer, render_audio_graph};
use super::model::{
    AudioGraph, AudioNode, AudioOperation, AutomationInterpolation, AutomationLane, AutomationPoint,
};

const MIX_SCHEMA: &str = "editkin.native-audio-preview-mix/v1";
const MIX_RECEIPT_SCHEMA: &str = "editkin.native-audio-preview-mix-receipt/v1";
const DECODER_EXECUTOR: &str = "ffmpeg-source-decode/v1";
const MIX_EXECUTOR: &str = "hao-core-native-dag/v1";
const MAX_SOURCES: usize = 8;
const MAX_DURATION_SECONDS: u64 = 30;
const MAX_TOTAL_SOURCE_BYTES: u64 = 192 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewAudioMixManifest {
    schema: String,
    sample_rate: u32,
    channels: u16,
    duration_frames: u64,
    decoder_executor: String,
    sources: Vec<PreviewAudioSource>,
    ducking: PreviewDucking,
    master: PreviewMaster,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewAudioSource {
    id: String,
    clip_id: String,
    asset_id: String,
    role: PreviewAudioRole,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    start_frame: u64,
    gain_db: f32,
    #[serde(default)]
    gain_automation: Vec<PreviewGainPoint>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PreviewAudioRole {
    Voice,
    Music,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewGainPoint {
    sample: u64,
    value_db: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewDucking {
    enabled: bool,
    threshold_db: f32,
    floor_db: f32,
    attack_ms: f32,
    release_ms: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewMaster {
    limiter_ceiling_db: f32,
}

pub struct RenderedPreviewAudioMix {
    pub buffer: AudioBuffer,
    pub receipt: Value,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sample_peak(buffer: &AudioBuffer) -> f32 {
    buffer
        .samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max)
}

fn load_source(
    manifest_parent: &Path,
    source: &PreviewAudioSource,
    sample_rate: u32,
    channels: u16,
    duration_frames: usize,
) -> Result<AudioBuffer, String> {
    if source.id.trim().is_empty()
        || source.clip_id.trim().is_empty()
        || source.asset_id.trim().is_empty()
    {
        return Err("audio preview source identity cannot be empty".into());
    }
    if !source.path.is_absolute() || !is_sha256(&source.sha256) {
        return Err("audio preview source path or SHA-256 is invalid".into());
    }
    let path = fs::canonicalize(&source.path)
        .map_err(|error| format!("resolve audio preview source: {error}"))?;
    if !path.starts_with(manifest_parent) || !path.is_file() {
        return Err("audio preview source escaped the managed manifest directory".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("read audio preview source: {error}"))?;
    if bytes.len() as u64 != source.bytes
        || bytes.is_empty()
        || bytes.len() % (channels as usize * 4) != 0
        || !sha256(&bytes).eq_ignore_ascii_case(&source.sha256)
    {
        return Err("audio preview source bytes or SHA-256 mismatch".into());
    }
    let start_frame =
        usize::try_from(source.start_frame).map_err(|_| "audio preview start frame overflow")?;
    if start_frame >= duration_frames {
        return Err("audio preview source starts outside the preview window".into());
    }
    let mut output = AudioBuffer::silence(sample_rate, channels, duration_frames)?;
    let source_frames = bytes.len() / (channels as usize * 4);
    let copied_frames = source_frames.min(duration_frames - start_frame);
    for (index, chunk) in bytes
        .chunks_exact(4)
        .take(copied_frames * channels as usize)
        .enumerate()
    {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if !sample.is_finite() {
            return Err("audio preview source contains a non-finite sample".into());
        }
        output.samples[start_frame * channels as usize + index] = sample;
    }
    Ok(output)
}

fn automation_lane(
    source: &PreviewAudioSource,
    duration_frames: u64,
) -> Result<Vec<AutomationLane>, String> {
    if source.gain_automation.is_empty() {
        return Ok(Vec::new());
    }
    let mut previous = None;
    let mut points = Vec::with_capacity(source.gain_automation.len());
    for point in &source.gain_automation {
        if point.sample >= duration_frames
            || !point.value_db.is_finite()
            || !(-144.0..=48.0).contains(&point.value_db)
            || previous.is_some_and(|sample| point.sample <= sample)
        {
            return Err("audio preview gain automation is invalid or unsorted".into());
        }
        previous = Some(point.sample);
        points.push(AutomationPoint {
            sample: point.sample,
            value: point.value_db,
            interpolation: AutomationInterpolation::Linear,
        });
    }
    Ok(vec![AutomationLane {
        property: "gainDb".into(),
        points,
    }])
}

fn build_graph(manifest: &PreviewAudioMixManifest) -> Result<(AudioGraph, Vec<String>), String> {
    let mut nodes = Vec::new();
    let mut voice_inputs = Vec::new();
    let mut music_inputs = Vec::new();
    for (index, source) in manifest.sources.iter().enumerate() {
        if !source.gain_db.is_finite() || !(-144.0..=48.0).contains(&source.gain_db) {
            return Err("audio preview source gain is outside the native graph range".into());
        }
        let source_node = format!("source-{index}");
        let gain_node = format!("gain-{index}");
        nodes.push(AudioNode {
            id: source_node.clone(),
            inputs: vec![],
            operation: AudioOperation::Source {
                asset_id: source.id.clone(),
            },
            automation: vec![],
        });
        nodes.push(AudioNode {
            id: gain_node.clone(),
            inputs: vec![source_node],
            operation: AudioOperation::Gain {
                gain_db: source.gain_db,
            },
            automation: automation_lane(source, manifest.duration_frames)?,
        });
        match source.role {
            PreviewAudioRole::Voice => voice_inputs.push(gain_node),
            PreviewAudioRole::Music => music_inputs.push(gain_node),
        }
    }

    let mut master_inputs = Vec::new();
    if !voice_inputs.is_empty() {
        nodes.push(AudioNode {
            id: "voice-bus".into(),
            inputs: voice_inputs,
            operation: AudioOperation::Bus,
            automation: vec![],
        });
        master_inputs.push("voice-bus".into());
    }
    if !music_inputs.is_empty() {
        nodes.push(AudioNode {
            id: "music-bus".into(),
            inputs: music_inputs,
            operation: AudioOperation::Bus,
            automation: vec![],
        });
        if !master_inputs.is_empty() && manifest.ducking.enabled {
            nodes.push(AudioNode {
                id: "music-ducker".into(),
                inputs: vec!["music-bus".into(), "voice-bus".into()],
                operation: AudioOperation::Ducker {
                    threshold_db: manifest.ducking.threshold_db,
                    floor_db: manifest.ducking.floor_db,
                    attack_ms: manifest.ducking.attack_ms,
                    release_ms: manifest.ducking.release_ms,
                },
                automation: vec![],
            });
            master_inputs.push("music-ducker".into());
        } else {
            master_inputs.push("music-bus".into());
        }
    }
    if master_inputs.is_empty() {
        return Err("audio preview graph has no voice or music input".into());
    }
    nodes.push(AudioNode {
        id: "master-bus".into(),
        inputs: master_inputs,
        operation: AudioOperation::Bus,
        automation: vec![],
    });
    nodes.push(AudioNode {
        id: "master-limiter".into(),
        inputs: vec!["master-bus".into()],
        operation: AudioOperation::Limiter {
            ceiling_db: manifest.master.limiter_ceiling_db,
        },
        automation: vec![],
    });
    nodes.push(AudioNode {
        id: "output".into(),
        inputs: vec!["master-limiter".into()],
        operation: AudioOperation::Output,
        automation: vec![],
    });
    let node_kinds = nodes
        .iter()
        .map(|node| match node.operation {
            AudioOperation::Source { .. } => "source",
            AudioOperation::Gain { .. } => "gain",
            AudioOperation::Pan { .. } => "pan",
            AudioOperation::Eq { .. } => "eq",
            AudioOperation::Compressor { .. } => "compressor",
            AudioOperation::Ducker { .. } => "ducker",
            AudioOperation::Limiter { .. } => "limiter",
            AudioOperation::Bus => "bus",
            AudioOperation::Output => "output",
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect();
    Ok((
        AudioGraph {
            sample_rate: manifest.sample_rate,
            channels: manifest.channels,
            master_node: "output".into(),
            nodes,
        },
        node_kinds,
    ))
}

pub fn render_preview_audio_mix(manifest_path: &Path) -> Result<RenderedPreviewAudioMix, String> {
    let manifest_path = fs::canonicalize(manifest_path)
        .map_err(|error| format!("resolve audio preview manifest: {error}"))?;
    if !manifest_path.is_file() {
        return Err("audio preview manifest is not a file".into());
    }
    let manifest_parent = manifest_path
        .parent()
        .ok_or("audio preview manifest has no parent")?;
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|error| format!("read audio preview manifest: {error}"))?;
    let manifest: PreviewAudioMixManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("parse audio preview manifest: {error}"))?;
    if manifest.schema != MIX_SCHEMA
        || manifest.decoder_executor != DECODER_EXECUTOR
        || manifest.sample_rate != 48_000
        || manifest.channels != 2
        || manifest.sources.is_empty()
        || manifest.sources.len() > MAX_SOURCES
        || manifest.duration_frames == 0
        || manifest.duration_frames > u64::from(manifest.sample_rate) * MAX_DURATION_SECONDS
    {
        return Err("audio preview manifest contract is unsupported or unbounded".into());
    }
    let duration_frames =
        usize::try_from(manifest.duration_frames).map_err(|_| "audio preview duration overflow")?;
    let mut ids = HashSet::new();
    let total_source_bytes = manifest.sources.iter().try_fold(0_u64, |total, source| {
        if !ids.insert(source.id.as_str()) {
            return Err("audio preview source ids must be unique".to_string());
        }
        total
            .checked_add(source.bytes)
            .ok_or("audio preview source byte total overflow".to_string())
    })?;
    if total_source_bytes > MAX_TOTAL_SOURCE_BYTES {
        return Err("audio preview decoded sources exceed the native mix budget".into());
    }
    let mut sources = BTreeMap::new();
    for source in &manifest.sources {
        sources.insert(
            source.id.clone(),
            load_source(
                manifest_parent,
                source,
                manifest.sample_rate,
                manifest.channels,
                duration_frames,
            )?,
        );
    }
    let (graph, node_kinds) = build_graph(&manifest)?;
    let buffer = render_audio_graph(&graph, &sources)?;
    let post_limit_peak = sample_peak(&buffer);
    let mut output_hasher = Sha256::new();
    for sample in &buffer.samples {
        output_hasher.update(sample.to_le_bytes());
    }
    let output_sha256 = format!("{:x}", output_hasher.finalize());
    let voice_clip_count = manifest
        .sources
        .iter()
        .filter(|source| source.role == PreviewAudioRole::Voice)
        .count();
    let music_clip_count = manifest.sources.len() - voice_clip_count;
    let feature_execution = serde_json::json!({
        "timelinePlacement": true,
        "clipGain": true,
        "musicFadeAutomation": music_clip_count > 0 && manifest.sources.iter().filter(|source| source.role == PreviewAudioRole::Music).all(|source| source.gain_automation.len() >= 2),
        "voiceBus": voice_clip_count > 0,
        "musicBus": music_clip_count > 0,
        "sidechainDucking": voice_clip_count > 0 && music_clip_count > 0 && manifest.ducking.enabled,
        "masterLimiter": true,
    });
    let receipt = serde_json::json!({
        "schema": MIX_RECEIPT_SCHEMA,
        "status": "GREEN",
        "manifestSha256": sha256(&manifest_bytes),
        "decoderExecutor": DECODER_EXECUTOR,
        "mixExecutor": MIX_EXECUTOR,
        "nativeGraphExecution": true,
        "sampleRate": manifest.sample_rate,
        "channels": manifest.channels,
        "frames": buffer.frames(),
        "durationSeconds": buffer.frames() as f64 / manifest.sample_rate as f64,
        "sourceCount": manifest.sources.len(),
        "voiceClipCount": voice_clip_count,
        "musicClipCount": music_clip_count,
        "graph": { "nodeCount": graph.nodes.len(), "nodeKinds": node_kinds, "featureExecution": feature_execution },
        "signal": {
            "outputBytes": buffer.samples.len() * size_of::<f32>(),
            "outputSha256": output_sha256,
            "postLimitPeak": post_limit_peak,
            "limiterCeilingDb": manifest.master.limiter_ceiling_db,
        },
        "sourceIdentities": manifest.sources.iter().map(|source| serde_json::json!({ "id": source.id, "clipId": source.clip_id, "assetId": source.asset_id, "sha256": source.sha256, "bytes": source.bytes })).collect::<Vec<_>>(),
        "claimBoundary": "FFmpeg supplied independently decoded bounded source PCM only. Timeline placement, clip gain and music fade automation, voice/music buses, sidechain ducking, master limiting and output summing executed in the hao-core Rust DAG. Device replacement, multi-hour drift, encoded loudness and CoreAudio are separate obligations."
    });
    Ok(RenderedPreviewAudioMix { buffer, receipt })
}

pub fn write_preview_audio_mix(manifest_path: &Path, output_path: &Path) -> Result<Value, String> {
    if !output_path.is_absolute() {
        return Err("audio preview mix output must be an absolute path".into());
    }
    let rendered = render_preview_audio_mix(manifest_path)?;
    let mut bytes = Vec::with_capacity(rendered.buffer.samples.len() * size_of::<f32>());
    for sample in &rendered.buffer.samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    fs::write(output_path, bytes).map_err(|error| format!("write audio preview mix: {error}"))?;
    Ok(rendered.receipt)
}

pub fn attach_mix_receipt(event: &Value, receipt: &Value) -> Result<Value, String> {
    let mut decorated = event.clone();
    decorated
        .as_object_mut()
        .ok_or("audio preview event is not an object")?
        .insert("nativeMix".into(), receipt.clone());
    Ok(decorated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_mix_output_before_manifest_access() {
        let error = write_preview_audio_mix(Path::new("missing.json"), Path::new("relative.f32le"))
            .unwrap_err();
        assert!(error.contains("absolute"));
    }

    #[test]
    fn attaches_pathless_mix_receipt_to_device_event() {
        let event = serde_json::json!({ "schema": "editkin.native-audio-preview-event/v1", "event": "started" });
        let receipt =
            serde_json::json!({ "schema": MIX_RECEIPT_SCHEMA, "nativeGraphExecution": true });
        let decorated = attach_mix_receipt(&event, &receipt).expect("decorate event");
        assert_eq!(decorated["nativeMix"]["nativeGraphExecution"], true);
        assert!(decorated.get("path").is_none());
    }
}

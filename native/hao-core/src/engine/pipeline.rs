use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use serde_json::{Value, json};

use super::audio::{AudioBuffer, render_audio_graph};
use super::composite::{
    FloatFrame, LinearRgba, apply_adjustment, composite_frames, linear_to_srgb, quantize_unorm,
    srgb_to_linear,
};
use super::model::{
    AudioGraph, AudioNode, AudioOperation, AutomationInterpolation, AutomationLane,
    AutomationPoint, BlendMode,
};
use super::scene::{
    CameraProjection, DirectionalLight, SceneLayer, Vec3, draw_particles, render_2_5d_scene,
    simulate_particles,
};
use super::vfx::{depth_of_field, frame_energy, motion_blur};

fn write_png(path: &Path, frame: &FloatFrame) -> Result<(), String> {
    frame.validate()?;
    let file = File::create(path).map_err(|error| format!("create {}: {error}", path.display()))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), frame.width, frame.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("png header: {error}"))?;
    let mut bytes = Vec::with_capacity(frame.pixels.len() * 4);
    for premult in &frame.pixels {
        let pixel = premult.unpremultiplied();
        for value in [pixel.r, pixel.g, pixel.b] {
            let encoded = linear_to_srgb(value.max(0.0))?.clamp(0.0, 1.0);
            bytes.push((quantize_unorm(encoded, 8)? * 255.0).round() as u8);
        }
        bytes.push((pixel.a.clamp(0.0, 1.0) * 255.0).round() as u8);
    }
    writer
        .write_image_data(&bytes)
        .map_err(|error| format!("png data: {error}"))
}

fn write_wav(path: &Path, buffer: &AudioBuffer) -> Result<(), String> {
    let mut file = BufWriter::new(
        File::create(path).map_err(|error| format!("create {}: {error}", path.display()))?,
    );
    let data_bytes = (buffer.samples.len() * 2) as u32;
    let byte_rate = buffer.sample_rate * buffer.channels as u32 * 2;
    file.write_all(b"RIFF")
        .and_then(|_| file.write_all(&(36 + data_bytes).to_le_bytes()))
        .and_then(|_| file.write_all(b"WAVEfmt "))
        .and_then(|_| file.write_all(&16_u32.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&buffer.channels.to_le_bytes()))
        .and_then(|_| file.write_all(&buffer.sample_rate.to_le_bytes()))
        .and_then(|_| file.write_all(&byte_rate.to_le_bytes()))
        .and_then(|_| file.write_all(&(buffer.channels * 2).to_le_bytes()))
        .and_then(|_| file.write_all(&16_u16.to_le_bytes()))
        .and_then(|_| file.write_all(b"data"))
        .and_then(|_| file.write_all(&data_bytes.to_le_bytes()))
        .map_err(|error| format!("wav header: {error}"))?;
    for sample in &buffer.samples {
        file.write_all(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes())
            .map_err(|error| format!("wav data: {error}"))?;
    }
    file.flush().map_err(|error| format!("wav flush: {error}"))
}

fn render_scene_sample(child_x: f32) -> Result<(FloatFrame, Vec<f32>, usize), String> {
    let camera = CameraProjection {
        position: Vec3::new([0.0, 0.0, 0.0]),
        target: Vec3::new([0.0, 0.0, 1.0]),
        up: Vec3::new([0.0, 1.0, 0.0]),
        vertical_fov: 0.9,
        aspect: 16.0 / 9.0,
        near: 0.1,
        far: 100.0,
    };
    let rgb = |value: [f32; 3], alpha: f32| -> Result<LinearRgba, String> {
        LinearRgba::new(
            srgb_to_linear(value[0])?,
            srgb_to_linear(value[1])?,
            srgb_to_linear(value[2])?,
            alpha,
        )
    };
    let layers = vec![
        SceneLayer {
            id: "back".into(),
            parent: None,
            position: Vec3::new([0.0, 0.0, 4.0]),
            rotation: Vec3::new([0.0, 0.0, 0.0]),
            scale: Vec3::new([1.0, 1.0, 1.0]),
            size: [6.8, 3.8],
            color: rgb([0.13, 0.20, 0.36], 1.0)?,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
        },
        SceneLayer {
            id: "card".into(),
            parent: None,
            position: Vec3::new([-0.35, 0.0, 2.5]),
            rotation: Vec3::new([0.12, -0.22, -0.08]),
            scale: Vec3::new([1.0, 1.0, 1.0]),
            size: [1.8, 1.05],
            color: rgb([0.12, 0.78, 1.0], 0.94)?,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
        },
        SceneLayer {
            id: "badge".into(),
            parent: Some("card".into()),
            position: Vec3::new([child_x, 0.2, -0.08]),
            rotation: Vec3::new([0.0, 0.0, 0.18]),
            scale: Vec3::new([1.0, 1.0, 1.0]),
            size: [0.72, 0.34],
            color: rgb([1.0, 0.28, 0.56], 0.88)?,
            blend_mode: BlendMode::Screen,
            opacity: 0.92,
        },
    ];
    let lights = [DirectionalLight {
        direction: Vec3::new([0.2, -0.4, 1.0]),
        color: [0.75, 0.9, 1.0],
        intensity: 0.9,
    }];
    let (mut frame, depth) = render_2_5d_scene(640, 360, camera, &layers, 0.28, &lights)?;
    apply_adjustment(
        &mut frame,
        [
            [1.03, 0.0, 0.0, 0.0],
            [0.0, 1.01, 0.0, 0.0],
            [0.0, 0.0, 0.98, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        [0.0; 4],
        0.75,
    )?;
    let overlay = FloatFrame::solid(640, 360, rgb([0.30, 0.85, 1.0], 0.15)?)?;
    let mut matte = FloatFrame::transparent(640, 360)?;
    for y in 0..360_usize {
        for x in 0..640_usize {
            let alpha = ((x as f32 / 639.0) * 0.55).clamp(0.0, 1.0);
            matte.pixels[y * 640 + x] = LinearRgba {
                r: alpha,
                g: alpha,
                b: alpha,
                a: alpha,
            };
        }
    }
    frame = composite_frames(
        &frame,
        &overlay,
        BlendMode::Screen,
        0.35,
        Some((&matte, super::model::MatteMode::Alpha)),
    )?;
    let mut particles = simulate_particles(
        42,
        52.0,
        2.2,
        Vec3::new([0.2, 1.2, 0.0]),
        Vec3::new([0.0, -1.3, 0.0]),
        1.2,
        80,
    )?;
    for particle in &mut particles {
        particle.position = particle.position.add(Vec3::new([-0.8, -0.7, 2.1]));
    }
    let visible = draw_particles(
        &mut frame,
        camera,
        &particles,
        LinearRgba::new(0.2, 0.95, 0.75, 0.72)?,
        2,
    )?;
    Ok((frame, depth, visible))
}

fn render_audio() -> Result<(AudioBuffer, f32), String> {
    let sample_rate = 48_000_u32;
    let frames = 48_000_usize;
    let mut samples = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let value =
            (2.0 * std::f32::consts::PI * 440.0 * frame as f32 / sample_rate as f32).sin() * 0.36;
        samples.extend([value, value]);
    }
    let source = AudioBuffer {
        sample_rate,
        channels: 2,
        samples,
    };
    let mut sources = BTreeMap::new();
    sources.insert("tone".into(), source);
    let graph = AudioGraph {
        sample_rate,
        channels: 2,
        master_node: "out".into(),
        nodes: vec![
            AudioNode {
                id: "source".into(),
                inputs: vec![],
                operation: AudioOperation::Source {
                    asset_id: "tone".into(),
                },
                automation: vec![],
            },
            AudioNode {
                id: "gain".into(),
                inputs: vec!["source".into()],
                operation: AudioOperation::Gain { gain_db: -3.0 },
                automation: vec![AutomationLane {
                    property: "gainDb".into(),
                    points: vec![
                        AutomationPoint {
                            sample: 0,
                            value: -18.0,
                            interpolation: AutomationInterpolation::Smooth,
                        },
                        AutomationPoint {
                            sample: 12_000,
                            value: -3.0,
                            interpolation: AutomationInterpolation::Linear,
                        },
                    ],
                }],
            },
            AudioNode {
                id: "pan".into(),
                inputs: vec!["gain".into()],
                operation: AudioOperation::Pan { pan: 0.15 },
                automation: vec![],
            },
            AudioNode {
                id: "eq".into(),
                inputs: vec!["pan".into()],
                operation: AudioOperation::Eq {
                    low_db: -1.5,
                    mid_db: 1.0,
                    high_db: 0.5,
                },
                automation: vec![],
            },
            AudioNode {
                id: "comp".into(),
                inputs: vec!["eq".into()],
                operation: AudioOperation::Compressor {
                    threshold_db: -15.0,
                    ratio: 3.0,
                },
                automation: vec![],
            },
            AudioNode {
                id: "out".into(),
                inputs: vec!["comp".into()],
                operation: AudioOperation::Output,
                automation: vec![],
            },
        ],
    };
    let output = render_audio_graph(&graph, &sources)?;
    let peak = output
        .samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f32::max);
    Ok((output, peak))
}

pub fn pipeline_selftest(output_dir: &Path) -> Result<Value, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("create {}: {error}", output_dir.display()))?;
    let mut samples = Vec::new();
    let mut depth = Vec::new();
    let mut visible = 0;
    for x in [-0.08, 0.0, 0.08] {
        let (frame, z, count) = render_scene_sample(x)?;
        samples.push(frame);
        if depth.is_empty() {
            depth = z;
        }
        visible = visible.max(count);
    }
    let blurred = motion_blur(&samples, Some(&[0.25, 0.5, 0.25]))?;
    let final_frame = depth_of_field(&blurred, &depth, 0.024, 4.0, 4)?;
    let png_path = output_dir.join("native-scene-vfx.png");
    write_png(&png_path, &final_frame)?;
    let (audio, peak) = render_audio()?;
    let wav_path = output_dir.join("native-audio-graph.wav");
    write_wav(&wav_path, &audio)?;
    let transparent = final_frame
        .pixels
        .iter()
        .filter(|pixel| pixel.a < 0.999)
        .count();
    let energy = frame_energy(&final_frame)?;
    if energy <= 100.0 || visible == 0 || peak <= 0.01 || peak > 1.0 {
        return Err("native pipeline produced invalid evidence".into());
    }
    let report_path = output_dir.join("report.json");
    let receipt = json!({"schema":"editkin.native-pipeline-selftest/v1","status":"GREEN","scene":{"width":final_frame.width,"height":final_frame.height,"parentedLayers":1,"trackMatteLayers":1,"adjustmentPasses":1,"visibleParticles":visible,"transparentPixels":transparent,"energy":energy,"motionBlurSamples":samples.len(),"depthOfFieldRadius":4,"pngPath":png_path},"audio":{"sampleRate":audio.sample_rate,"channels":audio.channels,"frames":audio.frames(),"peak":peak,"automation":"sample-accurate","wavPath":wav_path},"reportPath":report_path});
    fs::write(
        &report_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&receipt).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| format!("write {}: {error}", report_path.display()))?;
    Ok(receipt)
}

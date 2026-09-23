pub mod audio;
pub mod audio_codec_pipe;
mod audio_codec_schedule;
pub mod audio_codec_stream;
pub mod audio_device;
pub mod audio_preview;
pub mod audio_session;
pub mod audio_session_protocol;
pub mod audio_session_server;
#[cfg(windows)]
mod audio_session_stdio;
pub mod audio_stream;
pub mod audio_stream_file;
pub mod audio_stream_pull;
pub mod audio_stream_transport;
#[path = "../../../shared/owned_process.rs"]
pub mod owned_process;
pub mod auto_roto;
#[cfg(feature = "auto-roto-research-onnx")]
pub mod auto_roto_onnx;
pub mod composite;
pub mod diagnostics;
pub mod model;
pub mod optical_alpha;
pub mod pipeline;
pub mod planar_track;
pub mod plugin;
pub mod region_memory_roto;
pub mod roto;
pub mod runtime;
pub mod scene;
pub mod validate;
pub mod white_balance;
pub mod vfx;

pub use model::EngineGraph;
pub use validate::compile_graph;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::audio::{
        AudioBuffer, RealtimeAudioTransport, SpscAudioRing, render_audio_graph,
    };
    use crate::engine::audio::{automation_value, db_to_gain, stereo_pan_gains};
    use crate::engine::composite::{
        FloatFrame, LinearRgba, apply_adjustment, composite_frames, quantize_unorm, srgb_to_linear,
    };
    use crate::engine::model::*;
    use crate::engine::plugin::{EffectPluginManifest, validate_plugin_manifest};
    use crate::engine::roto::{
        MatteFrame, MatteRefine, boundary_chatter, refine_matte, warp_translation,
    };
    use crate::engine::runtime::{
        DeviceRecovery, DeviceState, EngineClock, FrameRing, ResourceCache,
    };
    use crate::engine::scene::{CameraProjection, Vec3, shutter_sample_times, simulate_particles};
    use crate::engine::scene::{DirectionalLight, SceneLayer, draw_particles, render_2_5d_scene};
    use crate::engine::vfx::{depth_of_field, motion_blur};
    use std::collections::BTreeMap;

    fn fixture_graph() -> EngineGraph {
        EngineGraph {
            schema: ENGINE_GRAPH_SCHEMA.into(),
            graph_id: "fixture".into(),
            width: 1920,
            height: 1080,
            timebase: RationalTimebase {
                numerator: 1001,
                denominator: 30_000,
            },
            working_format: PixelFormat::Rgba16Float,
            cache_budget_mb: 512,
            nodes: vec![
                EngineNode {
                    id: "source".into(),
                    inputs: vec![],
                    enabled: true,
                    operation: NodeOperation::Source {
                        asset_id: "asset".into(),
                        media_kind: "video".into(),
                        input_color_space: Some("rec709".into()),
                        alpha_mode: model::AlphaMode::Auto,
                        timeline: Some(NodeFrameRange {
                            timeline_start_frame: 0,
                            source_start_frame: 0,
                            duration_frames: 300,
                        }),
                    },
                },
                EngineNode {
                    id: "transform".into(),
                    inputs: vec!["source".into()],
                    enabled: true,
                    operation: NodeOperation::Transform3d {
                        position: [0.0, 0.0, 2.0],
                        rotation_radians: [0.0; 3],
                        scale: [1.0; 3],
                        parent: None,
                    },
                },
                EngineNode {
                    id: "color".into(),
                    inputs: vec!["transform".into()],
                    enabled: true,
                    operation: NodeOperation::Color {
                        processor: "ocio-gpu".into(),
                        input_space: "rec709".into(),
                        working_space: "ACEScg".into(),
                        output_space: "rec709".into(),
                        grade: PrimaryGrade::default(),
                    },
                },
                EngineNode {
                    id: "particles".into(),
                    inputs: vec![],
                    enabled: true,
                    operation: NodeOperation::ParticleEmitter {
                        timeline: Some(NodeFrameRange {
                            timeline_start_frame: 0,
                            source_start_frame: 0,
                            duration_frames: 120,
                        }),
                        seed: 7,
                        rate_per_second: 20.0,
                        lifetime_seconds: 2.0,
                        initial_velocity: [0.0, 1.0, 0.0],
                        gravity: [0.0, -9.8, 0.0],
                        max_particles: 1000,
                        emitter_position: [0.5, 0.72],
                        radius_pixels: 3.0,
                        color: [1.0, 0.42, 0.06, 0.92],
                    },
                },
                EngineNode {
                    id: "composite".into(),
                    inputs: vec!["color".into(), "particles".into()],
                    enabled: true,
                    operation: NodeOperation::Composite {
                        blend_mode: BlendMode::Screen,
                        opacity: 1.0,
                        matte_input: None,
                        matte_mode: None,
                    },
                },
                EngineNode {
                    id: "output".into(),
                    inputs: vec!["composite".into()],
                    enabled: true,
                    operation: NodeOperation::Output {
                        format: PixelFormat::Rgba16Float,
                    },
                },
            ],
            output_node: "output".into(),
            audio: None,
        }
    }

    #[test]
    fn graph_compiles_all_dependencies_in_order_and_reports_features() {
        let compiled = compile_graph(fixture_graph()).expect("compile graph");
        assert_eq!(compiled.passes.last().unwrap().node_id, "output");
        assert!(compiled.feature_families.contains(&"scene_3d"));
        assert!(compiled.feature_families.contains(&"particles"));
    }

    #[test]
    fn graph_rejects_cycle_and_unfrozen_roto() {
        let mut graph = fixture_graph();
        graph.nodes[0].inputs.push("output".into());
        assert!(compile_graph(graph).unwrap_err().contains("cycle"));
        let mut graph = fixture_graph();
        graph.nodes.insert(
            1,
            EngineNode {
                id: "roto".into(),
                inputs: vec!["source".into()],
                enabled: true,
                operation: NodeOperation::AutoRoto {
                    sequence_id: "seq".into(),
                    model_id: "model".into(),
                    model_sha256: "0".repeat(64),
                    cache_manifest: "matte.json".into(),
                    frozen: false,
                },
            },
        );
        assert!(compile_graph(graph).unwrap_err().contains("frozen"));

        let mut invalid_grade = fixture_graph();
        if let NodeOperation::Color { grade, .. } = &mut invalid_grade.nodes[2].operation {
            grade.exposure = f32::NAN;
        }
        assert!(
            compile_graph(invalid_grade)
                .unwrap_err()
                .contains("incomplete color transform")
        );
    }

    #[test]
    fn graph_tracks_implicit_parent_and_matte_dependencies_and_validates_timed_overlays() {
        let mut parent_cycle = fixture_graph();
        if let NodeOperation::Transform3d { parent, .. } = &mut parent_cycle.nodes[1].operation {
            *parent = Some("output".into());
        }
        assert!(compile_graph(parent_cycle).unwrap_err().contains("cycle"));

        let mut unpaired_matte = fixture_graph();
        if let NodeOperation::Composite {
            matte_input,
            matte_mode,
            ..
        } = &mut unpaired_matte.nodes[4].operation
        {
            *matte_input = Some("source".into());
            *matte_mode = None;
        }
        assert!(
            compile_graph(unpaired_matte)
                .unwrap_err()
                .contains("invalid composite")
        );

        let mut overlays = fixture_graph();
        overlays.nodes.insert(
            4,
            EngineNode {
                id: "caption".into(),
                inputs: vec![],
                enabled: true,
                operation: NodeOperation::Caption {
                    cue_id: "cue".into(),
                    text: "Editkin".into(),
                    timeline: NodeFrameRange {
                        timeline_start_frame: 30,
                        source_start_frame: 0,
                        duration_frames: 60,
                    },
                    font_family: "Noto Sans TC".into(),
                    font_size: 48.0,
                    text_color: "#FFFFFFFF".into(),
                    outline_color: "#000000FF".into(),
                    outline_width: 3.0,
                    background_color: "#00000000".into(),
                    alignment: 2,
                    margin_vertical: 36.0,
                    bold: true,
                    italic: false,
                    shadow: 1.0,
                    letter_spacing: 0.0,
                    translation: None,
                },
            },
        );
        overlays.nodes.insert(
            5,
            EngineNode {
                id: "motion".into(),
                inputs: vec![],
                enabled: true,
                operation: NodeOperation::MotionGraphic {
                    graphic_id: "title".into(),
                    graphic_kind: "title".into(),
                    text: "One graph".into(),
                    timeline: NodeFrameRange {
                        timeline_start_frame: 0,
                        source_start_frame: 0,
                        duration_frames: 90,
                    },
                    x: 0.5,
                    y: 0.2,
                    width: 0.7,
                    font_size: 72.0,
                    font_family: "Noto Sans TC".into(),
                    font_weight: 700,
                    letter_spacing: 0.0,
                    outline_width: 2.0,
                    shadow_depth: 2.0,
                    corner_radius: 18.0,
                    text_color: "#FFFFFFFF".into(),
                    background_color: "#000000AA".into(),
                    accent_color: "#A8FF3EFF".into(),
                    visual_style: "solid_panel".into(),
                    animation: "spring_soft".into(),
                    tracking_mode: "anchor".into(),
                    offset_x: 0.0,
                    offset_y: 0.0,
                    tracking: None,
                },
            },
        );
        let compiled = compile_graph(overlays).expect("compile timed overlays");
        assert!(compiled.feature_families.contains(&"caption_rendering"));
        assert!(compiled.feature_families.contains(&"motion_graphics"));
    }

    #[test]
    fn dirty_graph_only_marks_descendants() {
        let dirty =
            validate::dirty_descendants(&fixture_graph(), &["color".into()]).expect("dirty graph");
        assert_eq!(dirty, vec!["color", "composite", "output"]);
    }

    #[test]
    fn exact_clock_ring_cache_and_device_recovery_work() {
        let clock = EngineClock::new(
            RationalTimebase {
                numerator: 1001,
                denominator: 30_000,
            },
            48_000,
        )
        .unwrap();
        assert_eq!(clock.frame_to_sample(30_000), 48_048_000);
        assert_eq!(clock.sample_to_frame(48_048_000), 30_000);
        assert!(clock.frame_to_nanoseconds(1) > 33_000_000);
        let mut ring = FrameRing::triple();
        assert!(ring.push(1).is_ok() && ring.push(2).is_ok() && ring.push(3).is_ok());
        assert_eq!(ring.push(4), Err(4));
        assert_eq!(ring.rejected(), 1);
        assert_eq!(ring.pop(), Some(1));
        assert_eq!(ring.len(), 2);
        let mut cache = ResourceCache::new(10).unwrap();
        cache.insert("a".into(), 1, 4).unwrap();
        cache.insert("b".into(), 2, 4).unwrap();
        let _ = cache.get("a");
        assert_eq!(cache.insert("c".into(), 3, 4).unwrap(), vec!["b"]);
        assert_eq!(cache.used_bytes(), 8);
        let mut recovery = DeviceRecovery::new();
        recovery.mark_lost();
        recovery.begin_recovery().unwrap();
        recovery.finish_recovery(true);
        assert_eq!(recovery.state(), DeviceState::Ready);
        assert_eq!(recovery.generation(), 2);
    }

    #[test]
    fn pixel_matte_refinement_and_propagation_are_real_pixel_operations() {
        let mut alpha = vec![0_u8; 25];
        alpha[12] = 255;
        let source = MatteFrame {
            frame: 0,
            width: 5,
            height: 5,
            alpha,
            confidence: 1.0,
        };
        let warped = warp_translation(&source, 1, 1, 0, 0.9).unwrap();
        assert_eq!(warped.alpha[13], 255);
        let refined = refine_matte(
            &warped,
            Some(&source),
            MatteRefine {
                radius: 1,
                contrast: 1.2,
                edge_shift: 1,
                temporal_stability: 0.25,
            },
        )
        .unwrap();
        assert!(refined.alpha.iter().filter(|value| **value > 0).count() > 1);
        assert!(boundary_chatter(&source, &warped).unwrap() > 0.0);
    }

    #[test]
    fn audio_automation_3d_particles_and_plugin_contract_are_deterministic() {
        let lane = AutomationLane {
            property: "gainDb".into(),
            points: vec![
                AutomationPoint {
                    sample: 0,
                    value: 0.0,
                    interpolation: AutomationInterpolation::Linear,
                },
                AutomationPoint {
                    sample: 100,
                    value: 1.0,
                    interpolation: AutomationInterpolation::Hold,
                },
            ],
        };
        assert!((automation_value(&lane, 25).unwrap() - 0.25).abs() < 0.0001);
        assert!((db_to_gain(0.0).unwrap() - 1.0).abs() < 0.0001);
        let (left, right) = stereo_pan_gains(0.0).unwrap();
        assert!((left - right).abs() < 0.0001);
        let camera = CameraProjection {
            position: Vec3::new([0.0, 0.0, 0.0]),
            target: Vec3::new([0.0, 0.0, 1.0]),
            up: Vec3::new([0.0, 1.0, 0.0]),
            vertical_fov: 1.0,
            aspect: 16.0 / 9.0,
            near: 0.1,
            far: 100.0,
        };
        assert_eq!(
            camera.project(Vec3::new([0.0, 0.0, 1.0])).unwrap().unwrap()[0],
            0.0
        );
        let first = simulate_particles(
            9,
            30.0,
            2.0,
            Vec3::new([0.0, 1.0, 0.0]),
            Vec3::new([0.0, -9.8, 0.0]),
            1.0,
            100,
        )
        .unwrap();
        let second = simulate_particles(
            9,
            30.0,
            2.0,
            Vec3::new([0.0, 1.0, 0.0]),
            Vec3::new([0.0, -9.8, 0.0]),
            1.0,
            100,
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            shutter_sample_times(1.0, 1.0 / 30.0, 180.0, 8)
                .unwrap()
                .len(),
            8
        );
        validate_plugin_manifest(&EffectPluginManifest {
            schema: "editkin.effect-plugin/v1".into(),
            id: "gain".into(),
            version: "1.0.0".into(),
            abi_version: 1,
            library_sha256: "a".repeat(64),
            entry_symbol: "editkin_effect_plugin_v1".into(),
            supported_formats: vec![PixelFormat::Rgba16Float],
            max_temporal_radius: 0,
            timeout_ms: 1000,
            deterministic: true,
        })
        .unwrap();
    }

    #[test]
    fn native_audio_dag_processes_buffers_and_rejects_cycles() {
        let source = AudioBuffer {
            sample_rate: 48_000,
            channels: 2,
            samples: vec![0.5; 960],
        };
        let mut sources = BTreeMap::new();
        sources.insert("source-a".into(), source);
        let mut graph = AudioGraph {
            sample_rate: 48_000,
            channels: 2,
            master_node: "out".into(),
            nodes: vec![
                AudioNode {
                    id: "source".into(),
                    inputs: vec![],
                    operation: AudioOperation::Source {
                        asset_id: "source-a".into(),
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "gain".into(),
                    inputs: vec!["source".into()],
                    operation: AudioOperation::Gain { gain_db: -6.0 },
                    automation: vec![],
                },
                AudioNode {
                    id: "out".into(),
                    inputs: vec!["gain".into()],
                    operation: AudioOperation::Output,
                    automation: vec![],
                },
            ],
        };
        let result = render_audio_graph(&graph, &sources).unwrap();
        assert_eq!(result.frames(), 480);
        assert!(result.samples[0] > 0.24 && result.samples[0] < 0.26);
        graph.nodes[0].inputs.push("out".into());
        assert!(
            render_audio_graph(&graph, &sources)
                .unwrap_err()
                .contains("cycle")
        );
    }

    #[test]
    fn realtime_audio_ring_ducking_seek_and_recovery_hold() {
        let ring = SpscAudioRing::new(5).unwrap();
        assert_eq!(ring.usable_capacity(), 4);
        assert_eq!(ring.push_slice(&[1.0, 2.0, 3.0, 4.0, 5.0]), 4);
        let mut popped = [0.0; 3];
        assert_eq!(ring.pop_slice(&mut popped), 3);
        assert_eq!(popped, [1.0, 2.0, 3.0]);

        let mut transport = RealtimeAudioTransport::new(48_000, 2, 16).unwrap();
        assert_eq!(transport.queue_interleaved(&[0.25; 16]).unwrap(), 16);
        let mut callback = [0.0; 16];
        transport.callback_fill(&mut callback).unwrap();
        assert!(
            callback
                .iter()
                .all(|sample| (*sample - 0.25).abs() < f32::EPSILON)
        );
        transport.callback_fill(&mut callback).unwrap();
        assert!(callback.iter().all(|sample| *sample == 0.0));
        transport.seek(96_000);
        assert_eq!(transport.recover_device(), 2);
        let receipt = transport.receipt();
        assert_eq!(receipt["masterFrame"], 96_000);
        assert_eq!(receipt["underrunSamples"], 16);
        assert_eq!(transport.master_frame(), 96_000);
        assert_eq!(transport.underrun_samples(), 16);

        let program = AudioBuffer {
            sample_rate: 48_000,
            channels: 2,
            samples: vec![0.5; 9_600],
        };
        let mut key_samples = vec![0.0; 9_600];
        key_samples[2_400..7_200].fill(0.9);
        let key = AudioBuffer {
            sample_rate: 48_000,
            channels: 2,
            samples: key_samples,
        };
        let mut sources = BTreeMap::new();
        sources.insert("music".into(), program);
        sources.insert("voice".into(), key);
        let graph = AudioGraph {
            sample_rate: 48_000,
            channels: 2,
            master_node: "out".into(),
            nodes: vec![
                AudioNode {
                    id: "music".into(),
                    inputs: vec![],
                    operation: AudioOperation::Source {
                        asset_id: "music".into(),
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "voice".into(),
                    inputs: vec![],
                    operation: AudioOperation::Source {
                        asset_id: "voice".into(),
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "duck".into(),
                    inputs: vec!["music".into(), "voice".into()],
                    operation: AudioOperation::Ducker {
                        threshold_db: -30.0,
                        floor_db: -18.0,
                        attack_ms: 2.0,
                        release_ms: 40.0,
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "out".into(),
                    inputs: vec!["duck".into()],
                    operation: AudioOperation::Output,
                    automation: vec![],
                },
            ],
        };
        let ducked = render_audio_graph(&graph, &sources).unwrap();
        let before = ducked.samples[1_000];
        let during = ducked.samples[5_000];
        assert!(
            before > 0.45 && during < 0.2,
            "sidechain did not duck program: {before} -> {during}"
        );
    }

    #[test]
    fn premultiplied_track_matte_adjustment_and_pixel_depth_contract_hold() {
        let backdrop =
            FloatFrame::solid(2, 2, LinearRgba::new(0.1, 0.2, 0.3, 1.0).unwrap()).unwrap();
        let source =
            FloatFrame::solid(2, 2, LinearRgba::new(0.8, 0.1, 0.2, 0.75).unwrap()).unwrap();
        let matte = FloatFrame::solid(2, 2, LinearRgba::new(0.5, 0.5, 0.5, 0.5).unwrap()).unwrap();
        let mut output = composite_frames(
            &backdrop,
            &source,
            BlendMode::Overlay,
            0.8,
            Some((&matte, MatteMode::Alpha)),
        )
        .unwrap();
        apply_adjustment(
            &mut output,
            [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 0.9, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            [0.0; 4],
            1.0,
        )
        .unwrap();
        output.validate().unwrap();
        assert!(output.pixels[0].a > 0.99);
        assert!(srgb_to_linear(0.5).unwrap() > 0.21);
        assert_eq!(quantize_unorm(0.5, 8).unwrap(), 128.0 / 255.0);
    }

    #[test]
    fn parented_2_5d_scene_particles_dof_and_motion_blur_render_pixels() {
        let camera = CameraProjection {
            position: Vec3::new([0.0, 0.0, 0.0]),
            target: Vec3::new([0.0, 0.0, 1.0]),
            up: Vec3::new([0.0, 1.0, 0.0]),
            vertical_fov: 1.0,
            aspect: 1.0,
            near: 0.1,
            far: 20.0,
        };
        let layers = vec![
            SceneLayer {
                id: "parent".into(),
                parent: None,
                position: Vec3::new([0.0, 0.0, 3.0]),
                rotation: Vec3::new([0.0, 0.0, 0.0]),
                scale: Vec3::new([1.0, 1.0, 1.0]),
                size: [2.0, 2.0],
                color: LinearRgba::new(0.2, 0.4, 0.8, 1.0).unwrap(),
                blend_mode: BlendMode::Normal,
                opacity: 1.0,
            },
            SceneLayer {
                id: "child".into(),
                parent: Some("parent".into()),
                position: Vec3::new([0.4, 0.0, -0.2]),
                rotation: Vec3::new([0.0, 0.0, 0.2]),
                scale: Vec3::new([1.0, 1.0, 1.0]),
                size: [0.6, 0.4],
                color: LinearRgba::new(1.0, 0.2, 0.1, 0.8).unwrap(),
                blend_mode: BlendMode::Screen,
                opacity: 1.0,
            },
        ];
        let (mut frame, depth) = render_2_5d_scene(
            96,
            96,
            camera,
            &layers,
            0.4,
            &[DirectionalLight {
                direction: Vec3::new([0.0, 0.0, 1.0]),
                color: [1.0; 3],
                intensity: 0.6,
            }],
        )
        .unwrap();
        let particles = vec![crate::engine::scene::Particle {
            position: Vec3::new([0.0, 0.0, 2.0]),
            velocity: Vec3::new([0.0, 0.0, 0.0]),
            age: 0.5,
            lifetime: 1.0,
        }];
        assert_eq!(
            draw_particles(
                &mut frame,
                camera,
                &particles,
                LinearRgba::new(1.0, 1.0, 1.0, 0.8).unwrap(),
                2
            )
            .unwrap(),
            1
        );
        let dof = depth_of_field(&frame, &depth, 0.12, 2.0, 2).unwrap();
        let blurred = motion_blur(&[frame, dof.clone()], None).unwrap();
        blurred.validate().unwrap();
        assert!(blurred.pixels.iter().any(|pixel| pixel.a > 0.0));
    }
}

use super::super::model::{AutomationInterpolation, AutomationLane, AutomationPoint};
use super::*;

fn node(id: &str, inputs: &[&str], operation: AudioOperation) -> AudioNode {
    AudioNode {
        id: id.into(),
        inputs: inputs.iter().map(|s| s.to_string()).collect(),
        operation,
        automation: vec![],
    }
}
fn graph(limiter: bool) -> AudioGraph {
    let mut nodes = vec![
        node(
            "voice",
            &[],
            AudioOperation::Source {
                asset_id: "voice".into(),
            },
        ),
        node(
            "music",
            &[],
            AudioOperation::Source {
                asset_id: "music".into(),
            },
        ),
        node(
            "eq",
            &["voice"],
            AudioOperation::Eq {
                low_db: 2.0,
                mid_db: -1.0,
                high_db: 1.0,
            },
        ),
        node(
            "comp",
            &["eq"],
            AudioOperation::Compressor {
                threshold_db: -18.0,
                ratio: 3.0,
            },
        ),
        node("gain", &["music"], AudioOperation::Gain { gain_db: -5.0 }),
        node("pan", &["gain"], AudioOperation::Pan { pan: 0.25 }),
        node(
            "duck",
            &["pan", "comp"],
            AudioOperation::Ducker {
                threshold_db: -32.0,
                floor_db: -18.0,
                attack_ms: 25.0,
                release_ms: 360.0,
            },
        ),
        node("bus", &["comp", "duck"], AudioOperation::Bus),
    ];
    nodes[4].automation = vec![AutomationLane {
        property: "gainDb".into(),
        points: vec![
            AutomationPoint {
                sample: 0,
                value: -8.0,
                interpolation: AutomationInterpolation::Linear,
            },
            AutomationPoint {
                sample: 5000,
                value: -2.0,
                interpolation: AutomationInterpolation::Smooth,
            },
            AutomationPoint {
                sample: 16000,
                value: -6.0,
                interpolation: AutomationInterpolation::Hold,
            },
        ],
    }];
    if limiter {
        nodes.push(node(
            "limit",
            &["bus"],
            AudioOperation::Limiter { ceiling_db: -3.0 },
        ));
    }
    nodes.push(node(
        "out",
        &[if limiter { "limit" } else { "bus" }],
        AudioOperation::Output,
    ));
    AudioGraph {
        sample_rate: 48_000,
        channels: 2,
        master_node: "out".into(),
        nodes,
    }
}
fn inputs(start: usize, frames: usize) -> BTreeMap<String, AudioBuffer> {
    ["voice", "music"]
        .into_iter()
        .map(|id| {
            let mut samples = Vec::with_capacity(frames * 2);
            for i in start..start + frames {
                let s = if id == "voice" {
                    if (i / 700) % 2 == 0 {
                        (i as f32 * 0.071).sin() * 0.6
                    } else {
                        0.0
                    }
                } else {
                    (i as f32 * 0.029).sin() * 0.4
                };
                samples.extend([s, s * 0.7]);
            }
            (
                id.into(),
                AudioBuffer {
                    sample_rate: 48_000,
                    channels: 2,
                    samples,
                },
            )
        })
        .collect()
}
fn streamed(graph: &AudioGraph, total: usize, sizes: &[usize]) -> Vec<f32> {
    let mut stream = StreamingAudioGraph::new(graph, StreamSettings::default(), 1, 0).unwrap();
    let reserved = stream.buffered_sample_bytes();
    let mut at = 0;
    let mut result = Vec::new();
    let mut iteration = 0;
    while at < total {
        let n = sizes[iteration % sizes.len()].min(total - at);
        let output = stream.process(1, at as u64, &inputs(at, n)).unwrap();
        assert_eq!(output.generation, 1);
        assert_eq!(output.start_frame as usize, result.len() / 2);
        result.extend(output.buffer.samples);
        at += n;
        iteration += 1;
        assert_eq!(stream.buffered_sample_bytes(), reserved);
    }
    let tail = stream.finish(1).unwrap();
    assert_eq!(tail.start_frame as usize, result.len() / 2);
    result.extend(tail.buffer.samples);
    assert_eq!(result.len(), total * 2);
    result
}

#[test]
fn persistent_dsp_and_absolute_automation_match_existing_continuous_renderer() {
    let graph = graph(false);
    let total = 17011;
    let expected = audio::render_audio_graph(&graph, &inputs(0, total)).unwrap();
    let candidate = streamed(&graph, total, &[1, 17, 509, 2048, 3]);
    assert_eq!(
        candidate, expected.samples,
        "shared DSP must preserve sample order/math exactly"
    );
    // Calibration: resetting the old graph at chunk boundaries is NOT parity.
    let reset = audio::render_audio_graph(&graph, &inputs(2048, 2048)).unwrap();
    assert!(
        reset
            .samples
            .iter()
            .zip(&expected.samples[4096..8192])
            .any(|(a, b)| (a - b).abs() > 0.001)
    );
}

#[test]
fn lookahead_output_is_partition_invariant_and_preserves_exact_tail() {
    let graph = graph(true);
    let a = streamed(&graph, 17011, &[2048]);
    let b = streamed(&graph, 17011, &[1, 19, 127, 1009]);
    assert_eq!(a, b);
    assert!(
        a.iter()
            .all(|s| s.abs() <= audio::db_to_gain(-3.0).unwrap() + 1e-6)
    );
    for frames in [0, 1, 239, 240, 241] {
        assert_eq!(streamed(&graph, frames, &[1]).len(), frames * 2);
    }
}

#[test]
fn limiter_sees_future_boundary_peak_without_changing_partition_semantics() {
    let settings = StreamSettings {
        block_frames: 32,
        lookahead_frames: 8,
        limiter_release_ms: 80.0,
    };
    let mut limiter = LookaheadLimiter::new(settings, -6.0).unwrap();
    let mut output = Vec::new();
    for i in 0..64 {
        limiter.push([if i == 32 { 2.0 } else { 0.1 }; 2], &mut output);
    }
    for _ in 0..8 {
        limiter.push([0.0; 2], &mut output);
    }
    assert_eq!(output.len(), 128);
    assert!(
        output
            .iter()
            .all(|s| s.abs() <= audio::db_to_gain(-6.0).unwrap() + 1e-6)
    );
    assert!(
        output[24 * 2] < 0.1,
        "lookahead must attenuate before the peak, not after clipping it"
    );
    assert!(
        output[0] > output[24 * 2],
        "not legacy whole-window normalization"
    );
}

#[test]
fn generation_seek_and_cancel_discard_old_dsp_and_delayed_samples() {
    let graph = graph(true);
    let settings = StreamSettings::default();
    let mut stream = StreamingAudioGraph::new(&graph, settings, 7, 0).unwrap();
    stream.process(7, 0, &inputs(0, 500)).unwrap();
    assert!(!stream.cancel(6));
    assert!(stream.cancel(7));
    assert!(stream.process(7, 500, &inputs(500, 500)).is_err());
    assert!(stream.finish(7).is_err());
    assert!(stream.restart(7, 1000).is_err());
    stream.restart(8, 1000).unwrap();
    assert!(stream.process(7, 1000, &inputs(1000, 500)).is_err());
    let fresh = StreamingAudioGraph::new(&graph, settings, 8, 1000)
        .unwrap()
        .process(8, 1000, &inputs(1000, 500))
        .unwrap();
    let actual = stream.process(8, 1000, &inputs(1000, 500)).unwrap();
    assert_eq!(actual.start_frame, 1000);
    assert_eq!(actual.buffer, fresh.buffer);
    stream.finish(8).unwrap();
    assert!(stream.finish(8).is_err());
}

#[test]
fn invalid_inputs_do_not_consume_state_and_nonfinite_dsp_retires_generation() {
    let graph = graph(false);
    let mut stream = StreamingAudioGraph::new(&graph, StreamSettings::default(), 1, 0).unwrap();
    for variant in 0..6 {
        let mut source = inputs(0, 32);
        match variant {
            0 => {
                source.remove("voice");
            }
            1 => {
                source.insert("extra".into(), source["voice"].clone());
            }
            2 => source.get_mut("voice").unwrap().channels = 0,
            3 => source.get_mut("voice").unwrap().samples[0] = f32::NAN,
            4 => source
                .get_mut("voice")
                .unwrap()
                .samples
                .pop()
                .map(|_| ())
                .unwrap(),
            _ => source.get_mut("voice").unwrap().sample_rate = 44_100,
        };
        assert!(stream.process(1, 0, &source).is_err());
    }
    assert!(stream.process(1, 1, &inputs(0, 32)).is_err());
    assert!(stream.process(1, 0, &inputs(0, 4097)).is_err());
    assert_eq!(stream.process(1, 0, &inputs(0, 32)).unwrap().start_frame, 0);
    let bad = AudioGraph {
        sample_rate: 48_000,
        channels: 2,
        master_node: "out".into(),
        nodes: vec![
            node(
                "source",
                &[],
                AudioOperation::Source {
                    asset_id: "voice".into(),
                },
            ),
            node("out", &["source", "source"], AudioOperation::Output),
        ],
    };
    let mut stream = StreamingAudioGraph::new(&bad, StreamSettings::default(), 1, 0).unwrap();
    let source = BTreeMap::from([(
        "voice".into(),
        AudioBuffer {
            sample_rate: 48_000,
            channels: 2,
            samples: vec![f32::MAX; 2],
        },
    )]);
    assert!(stream.process(1, 0, &source).is_err());
    assert_eq!(stream.phase, Phase::Failed);
    assert!(stream.process(1, 0, &source).is_err());
}

#[test]
fn unsupported_graph_structure_and_automation_are_rejected_not_ignored() {
    for variant in 0..8 {
        let mut g = graph(true);
        match variant {
            0 => g.nodes.push(node(
                "unused",
                &[],
                AudioOperation::Source {
                    asset_id: "unused".into(),
                },
            )),
            1 => g.nodes[2].inputs = vec!["out".into()],
            2 => g.nodes[1].id = "voice".into(),
            3 => g.nodes[4].automation[0].property = "unknown".into(),
            4 => g.nodes[4].automation[0].points[1].sample = 0,
            5 => g.nodes[4].operation = AudioOperation::Limiter { ceiling_db: -3.0 },
            6 => {
                g.nodes[3].operation = AudioOperation::Compressor {
                    threshold_db: f32::NAN,
                    ratio: 3.0,
                }
            }
            _ => g.nodes[6].inputs.pop().map(|_| ()).unwrap(),
        }
        assert!(
            StreamingAudioGraph::new(&g, StreamSettings::default(), 1, 0).is_err(),
            "variant {variant}"
        );
    }
}

#[test]
fn long_stream_crosses_thirty_seconds_without_growing_dsp_buffers() {
    let g = graph(true);
    let mut stream = StreamingAudioGraph::new(&g, StreamSettings::default(), 1, 0).unwrap();
    let bytes = stream.buffered_sample_bytes();
    let total = 48_000 * 34;
    let mut at = 0;
    let mut output = 0;
    while at < total {
        let frames = 2048.min(total - at);
        output += stream
            .process(1, at as u64, &inputs(at, frames))
            .unwrap()
            .buffer
            .frames();
        at += frames;
        assert_eq!(stream.buffered_sample_bytes(), bytes);
    }
    output += stream.finish(1).unwrap().buffer.frames();
    assert_eq!(output, total);
    assert!(bytes < 1024 * 1024);
    println!("NATIVE_STREAM_DAG_RECEIPT {}", stream.receipt());
}

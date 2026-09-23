use super::*;
use crate::engine::audio::AudioBuffer;
use std::collections::VecDeque;

struct Reader(VecDeque<StreamBlock>);
impl AudioBlockReader for Reader {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        Ok(self.0.pop_front())
    }
    fn receipt(&self) -> Value {
        serde_json::json!({"testSource":true})
    }
}
fn reader(samples: &[f32], partition: usize) -> Reader {
    Reader(
        samples
            .chunks(partition * 2)
            .enumerate()
            .map(|(i, chunk)| StreamBlock {
                generation: 7,
                start_frame: 120 + i as u64 * partition as u64,
                buffer: AudioBuffer {
                    sample_rate: 48000,
                    channels: 2,
                    samples: chunk.to_vec(),
                },
            })
            .collect(),
    )
}
fn convert(
    samples: &[f32],
    partition: usize,
    rate: u32,
    channels: u16,
    out_chunk: usize,
) -> Vec<f32> {
    let mut pull = DevicePcmPull::new(
        reader(samples, partition),
        7,
        120,
        (samples.len() / 2) as u64,
        rate,
        channels,
    )
    .unwrap();
    let mut out = Vec::new();
    let mut block = vec![0.0; out_chunk * channels as usize];
    loop {
        let n = pull.read(&mut block).unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&block[..n * channels as usize]);
    }
    assert_eq!(pull.receipt()["finished"], true);
    assert_eq!(pull.receipt()["failed"], false);
    out
}
#[test]
fn conversion_has_exact_length_and_partition_independent_global_phase() {
    let samples = (0..9973)
        .flat_map(|i| {
            [
                (i as f32 * 0.13).sin() * 0.1,
                (i as f32 * 0.031).cos() * 0.2,
            ]
        })
        .collect::<Vec<_>>();
    for rate in [8000, 44100, 48000, 96000, 192000] {
        for channels in [1, 2] {
            let a = convert(&samples, 2048, rate, channels, 1024);
            assert_eq!(
                a.len(),
                (9973_u64 * rate as u64).div_ceil(48000) as usize * channels as usize
            );
            for part in [1, 19, 127, 1009] {
                assert_eq!(a, convert(&samples, part, rate, channels, 257));
            }
            // Independent whole-source index oracle, not a second chunk reader.
            for (i, frame) in a.chunks(channels as usize).enumerate() {
                let n = i as u64 * 48000;
                let left = (n / rate as u64) as usize;
                let right = (left + 1).min(9972);
                let f = (n % rate as u64) as f32 / rate as f32;
                let l = samples[left * 2] + (samples[right * 2] - samples[left * 2]) * f;
                let r =
                    samples[left * 2 + 1] + (samples[right * 2 + 1] - samples[left * 2 + 1]) * f;
                assert_eq!(frame[0], if channels == 1 { (l + r) * 0.5 } else { l });
                if channels == 2 {
                    assert_eq!(frame[1], r);
                }
            }
        }
    }
    assert_eq!(convert(&samples, 19, 48000, 2, 257), samples);
}
#[test]
fn single_frame_and_trailing_source_failure_are_not_lost() {
    for rate in [8000, 44100, 96000, 192000] {
        let out = convert(&[0.2, 0.4], 1, rate, 2, 3);
        assert_eq!(out, vec![0.2, 0.4].repeat((rate as usize).div_ceil(48000)));
    }
    let mut bad = reader(&[0.1, 0.2, 0.3, 0.4], 1);
    bad.0.back_mut().unwrap().buffer.samples[0] = f32::NAN;
    let mut pull = DevicePcmPull::new(bad, 7, 120, 2, 8000, 2).unwrap();
    assert!(pull.read(&mut [0.0; 2]).is_err());
    assert_eq!(pull.receipt()["failed"], true);
    let samples = [f32::MAX, f32::MAX, -f32::MAX, -f32::MAX];
    let mut overflow = DevicePcmPull::new(reader(&samples, 1), 7, 120, 2, 96000, 2).unwrap();
    assert!(overflow.read(&mut [0.0; 8]).is_err());
    assert_eq!(overflow.receipt()["finished"], false);
}
#[test]
fn malformed_stale_gap_and_early_eof_fail_without_success() {
    for mode in 0..7 {
        let mut r = reader(&[0.1; 12], 2);
        let block = r.0.front_mut().unwrap();
        match mode {
            0 => block.generation = 6,
            1 => block.start_frame += 1,
            2 => block.buffer.channels = 0,
            3 => block.buffer.samples.push(0.1),
            4 => block.buffer.samples[0] = f32::NAN,
            5 => {
                r.0.pop_back();
            }
            _ => block.buffer.samples = vec![0.0; 8194],
        };
        let mut pull = DevicePcmPull::new(r, 7, 120, 6, 48000, 2).unwrap();
        assert!(pull.read(&mut [0.0; 12]).is_err());
        assert_eq!(pull.receipt()["finished"], false);
        assert!(pull.read(&mut [0.0; 12]).is_err());
    }
}
#[test]
fn unbounded_output_rejected_before_source_consumption() {
    let mut pull = DevicePcmPull::new(reader(&[0.1; 12], 2), 7, 120, 6, 48000, 2).unwrap();
    assert!(pull.read(&mut vec![0.0; 8194]).is_err());
    assert!(pull.read(&mut [0.0; 3]).is_err());
    assert_eq!(pull.read(&mut [0.0; 12]).unwrap(), 6);
}

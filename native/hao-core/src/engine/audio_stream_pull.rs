//! Worker-only bounded, phase-continuous PCM conversion. The rational source
//! position is global to the stream, never restarted at a block boundary.
use super::{audio_stream::StreamBlock, audio_stream_file::FileAudioStream};
use serde_json::Value;

pub trait AudioBlockReader: Send {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String>;
    fn receipt(&self) -> Value;
    /// Worker-side bounded resource closure; failures must not be lost in Drop.
    fn shutdown(&mut self) -> Result<(), String> {
        Ok(())
    }
}
impl<T: AudioBlockReader + ?Sized> AudioBlockReader for Box<T> {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        (**self).next_block()
    }
    fn receipt(&self) -> Value {
        (**self).receipt()
    }
    fn shutdown(&mut self) -> Result<(), String> {
        (**self).shutdown()
    }
}
impl AudioBlockReader for FileAudioStream {
    fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
        self.next_block()
    }
    fn receipt(&self) -> Value {
        self.receipt()
    }
}

pub struct DevicePcmPull<R: AudioBlockReader> {
    reader: R,
    generation: u64,
    start: u64,
    frames: u64,
    rate: u32,
    channels: u16,
    output_frames: u64,
    output_position: u64,
    next_input: u64,
    block: Vec<f32>,
    block_at: usize,
    pair: Option<([f32; 2], [f32; 2])>,
    left_index: u64,
    consumed: u64,
    finished: bool,
    failed: bool,
}
impl<R: AudioBlockReader> DevicePcmPull<R> {
    pub fn new(
        reader: R,
        generation: u64,
        start: u64,
        frames: u64,
        rate: u32,
        channels: u16,
    ) -> Result<Self, String> {
        if generation == 0
            || frames == 0
            || !(8_000..=192_000).contains(&rate)
            || !(1..=2).contains(&channels)
            || start
                .checked_add(frames)
                .is_none_or(|n| n > 48_000 * 86_400)
        {
            return Err("stream device conversion contract invalid".into());
        }
        Ok(Self {
            reader,
            generation,
            start,
            frames,
            rate,
            channels,
            output_frames: (u128::from(frames) * u128::from(rate)).div_ceil(48_000) as u64,
            output_position: 0,
            next_input: start,
            block: Vec::new(),
            block_at: 0,
            pair: None,
            left_index: 0,
            consumed: 0,
            finished: false,
            failed: false,
        })
    }
    pub fn output_frames(&self) -> u64 {
        self.output_frames
    }
    pub fn shutdown(&mut self) -> Result<(), String> {
        self.reader.shutdown()
    }
    pub fn sample_rate(&self) -> u32 {
        self.rate
    }
    pub fn channels(&self) -> u16 {
        self.channels
    }
    fn load_block(&mut self) -> Result<bool, String> {
        for _ in 0..1024 {
            let Some(block) = self.reader.next_block()? else {
                return Ok(false);
            };
            if block.generation != self.generation
                || block.start_frame != self.next_input
                || block.buffer.sample_rate != 48_000
                || block.buffer.channels != 2
                || block.buffer.samples.len() > 8192
                || block.buffer.samples.len() % 2 != 0
                || block.buffer.samples.iter().any(|s| !s.is_finite())
            {
                return Err("stream device received invalid, stale or discontinuous PCM".into());
            }
            let n = (block.buffer.samples.len() / 2) as u64;
            if self.next_input + n > self.start + self.frames {
                return Err("stream device source overrun".into());
            }
            self.next_input += n;
            if n > 0 {
                self.block = block.buffer.samples;
                self.block_at = 0;
                return Ok(true);
            }
        }
        Err("stream device source returned too many empty blocks".into())
    }
    fn frame(&mut self) -> Result<[f32; 2], String> {
        if self.consumed >= self.frames {
            return Err("stream device source frame overrun".into());
        }
        if self.block_at == self.block.len() && !self.load_block()? {
            return Err("stream device source ended early".into());
        }
        let out = [self.block[self.block_at], self.block[self.block_at + 1]];
        self.block_at += 2;
        self.consumed += 1;
        Ok(out)
    }
    fn read_inner(&mut self, output: &mut [f32]) -> Result<usize, String> {
        if self.finished {
            return Ok(0);
        }
        if self.pair.is_none() {
            let a = self.frame()?;
            let b = if self.frames > 1 { self.frame()? } else { a };
            self.pair = Some((a, b));
        }
        let frames = (output.len() / self.channels as usize)
            .min((self.output_frames - self.output_position) as usize);
        for i in 0..frames {
            let position = u128::from(self.output_position) * 48_000;
            let index = (position / u128::from(self.rate)) as u64;
            while self.left_index < index {
                let (_, b) = self.pair.unwrap();
                let next = if self.consumed < self.frames {
                    self.frame()?
                } else {
                    b
                };
                self.pair = Some((b, next));
                self.left_index += 1;
            }
            let (a, b) = self.pair.unwrap();
            let fraction = (position % u128::from(self.rate)) as f32 / self.rate as f32;
            let left = a[0] + (b[0] - a[0]) * fraction;
            let right = a[1] + (b[1] - a[1]) * fraction;
            let at = i * self.channels as usize;
            output[at] = if self.channels == 1 {
                (left + right) * 0.5
            } else {
                left
            };
            if self.channels == 2 {
                output[at + 1] = right;
            }
            self.output_position += 1;
        }
        if self.output_position == self.output_frames {
            // Downsampling may skip final input frames. Still consume/validate
            // them and the reader's end/hash check before declaring completion.
            while self.consumed < self.frames {
                self.frame()?;
            }
            if self.load_block()? {
                return Err("stream device unexpected trailing PCM".into());
            }
            if self.next_input != self.start + self.frames {
                return Err("stream device incomplete source".into());
            }
            self.finished = true;
        }
        if output[..frames * self.channels as usize]
            .iter()
            .any(|s| !s.is_finite())
        {
            return Err("stream device conversion overflow".into());
        }
        Ok(frames)
    }
    pub fn read(&mut self, output: &mut [f32]) -> Result<usize, String> {
        if self.failed {
            return Err("stream device converter is failed".into());
        }
        if output.is_empty() || output.len() > 8192 || output.len() % self.channels as usize != 0 {
            return Err("stream device output block must be bounded and frame aligned".into());
        }
        let result = self.read_inner(output);
        if result.is_err() {
            self.failed = true;
            self.finished = false;
        }
        result
    }
    pub fn receipt(&self) -> Value {
        serde_json::json!({"schema":"editkin.device-pcm-pull/v1","generation":self.generation,
            "sourceFrames":self.frames,"sourceFramesConsumed":self.consumed,"outputFrames":self.output_position,
            "sampleRate":self.rate,"channels":self.channels,"finished":self.finished,"failed":self.failed,
            "conversion":"rational-phase-linear/v1","qualityBoundary":"linear device-format adaptation, not band-limited mastering SRC",
            "source":self.reader.receipt()})
    }
}

#[cfg(test)]
#[path = "audio_stream_pull_tests.rs"]
mod tests;

"""Deterministic eight-second original synth cue for renderer tests, not a released song."""

import math
import struct
import wave
from pathlib import Path

RATE = 24_000
SECONDS = 8
OUT = Path(__file__).resolve().parents[1] / ".rd/benchmarks/jpop-mv-motion-20260928/illustrated-mv/assets/demo-original-instrumental.wav"
OUT.parent.mkdir(parents=True, exist_ok=True)


def tone(frequency: float, seconds: float, attack: float = 0.008, release: float = 0.12) -> list[float]:
    length = int(seconds * RATE)
    return [
        math.sin(2 * math.pi * frequency * index / RATE)
        * min(1, index / max(1, attack * RATE))
        * min(1, (length - index) / max(1, release * RATE))
        for index in range(length)
    ]


samples = [0.0] * (RATE * SECONDS)


def add(start: float, sound: list[float], gain: float) -> None:
    offset = int(start * RATE)
    for index, value in enumerate(sound):
        if offset + index < len(samples):
            samples[offset + index] += value * gain


chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63),
          (261.63, 329.63, 392.0), (196.0, 246.94, 293.66)]
for bar, chord in enumerate(chords):
    start = bar * 2
    for note in chord:
        add(start, tone(note, 1.95, 0.08, 0.6), 0.055)
    for step in range(4):
        beat = start + step * 0.5
        add(beat, tone(chord[0] / 2, 0.31, 0.002, 0.16), 0.20)
        # One short kick and soft high tick per beat.
        add(beat, [math.sin(2 * math.pi * (95 - 52 * min(1, i / (RATE * 0.15))) * i / RATE)
                   * math.exp(-i / (RATE * 0.075)) for i in range(int(RATE * 0.23))], 0.28)
        add(beat + 0.25, [math.sin(2 * math.pi * 6_200 * i / RATE)
                           * math.exp(-i / (RATE * 0.018)) for i in range(int(RATE * 0.055))], 0.045)
        if step % 2:
            add(beat, [math.sin(2 * math.pi * 2_100 * i / RATE)
                       * math.exp(-i / (RATE * 0.05)) for i in range(int(RATE * 0.16))], 0.065)

melody = [(0, 440), (.5, 523.25), (1, 659.26), (1.5, 523.25),
          (2, 440), (2.5, 392), (3, 523.25), (3.5, 587.33),
          (4, 659.26), (4.5, 783.99), (5, 659.26), (5.5, 587.33),
          (6, 523.25), (6.5, 659.26), (7, 783.99), (7.5, 659.26)]
for start, note in melody:
    add(start, tone(note, 0.46, 0.005, 0.13), 0.09)
    add(start, tone(note * 2, 0.21, 0.003, 0.12), 0.028)

with wave.open(str(OUT), "wb") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(RATE)
    for sample in samples:
        value = int(max(-1, min(1, sample * 0.78)) * 32767)
        output.writeframesraw(struct.pack("<hh", value, value))
print(OUT)

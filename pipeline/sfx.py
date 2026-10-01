#!/usr/bin/env python3
"""Synthesize the "unlock" notification chime: public/sfx/unlock.mp3.

    python pipeline/sfx.py

An original late-90s-console-flavoured chime (no sample from any game): a short rising arpeggio
(D5 F#5 A5 D6, then a held A6 sparkle) of two-operator FM bells, a touch of Schroeder reverb, then
the late-90s treatment: the mix is decimated to 22.05 kHz with sample-and-hold (aliasing, no
anti-alias filter), crushed to 8-bit with a little dither, and encoded as a tiny mono MP3.
Only numpy and ffmpeg are needed; nothing here plays audio.
"""
from __future__ import annotations

import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sfx" / "unlock.mp3"

SR = 44100  # render rate
LO_SR = 22050  # the "console" rate
BITS = 8
RNG = np.random.default_rng(64)

# (frequency Hz, start s, length s, level)
NOTES = [
    (587.33, 0.00, 0.50, 0.70),  # D5
    (739.99, 0.09, 0.50, 0.70),  # F#5
    (880.00, 0.18, 0.55, 0.70),  # A5
    (1174.66, 0.27, 0.70, 0.75),  # D6
    (1760.00, 0.40, 0.95, 0.55),  # A6, the sparkle
]
TOTAL_SEC = 1.6


def bell(freq: float, length: float, level: float) -> np.ndarray:
    """Two-operator FM bell: inharmonic 3.5:1 modulator whose index decays fast, plus a soft octave."""
    n = int(SR * length)
    t = np.arange(n) / SR
    amp = np.exp(-t * 5.0) * np.minimum(1.0, t * 800)  # 1.25 ms attack: no click
    index = 2.2 * np.exp(-t * 9.0)
    mod = np.sin(2 * np.pi * freq * 3.5 * t) * index
    tone = np.sin(2 * np.pi * freq * t + mod)
    tone += 0.25 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t * 8.0)
    # a detuned twin: the slow beating is the "chorus" of cheap wavetable synths
    twin = np.sin(2 * np.pi * freq * 1.004 * t + mod)
    return level * amp * (0.7 * tone + 0.3 * twin)


def reverb(x: np.ndarray, wet: float = 0.22) -> np.ndarray:
    """Schroeder reverb: four parallel feedback combs into two allpasses."""
    def comb(sig: np.ndarray, delay: int, gain: float) -> np.ndarray:
        out = sig.copy()
        for i in range(delay, len(sig)):
            out[i] += gain * out[i - delay]
        return out

    def allpass(sig: np.ndarray, delay: int, gain: float) -> np.ndarray:
        out = np.zeros_like(sig)
        for i in range(len(sig)):
            delayed = out[i - delay] if i >= delay else 0.0
            before = sig[i - delay] if i >= delay else 0.0
            out[i] = -gain * sig[i] + before + gain * delayed
        return out

    acc = sum(comb(x, d, g) for d, g in ((1687, 0.70), (1601, 0.71), (2053, 0.68), (2251, 0.66))) / 4
    acc = allpass(allpass(acc, 556, 0.5), 441, 0.5)
    return x + wet * acc


def main() -> None:
    mix = np.zeros(int(SR * TOTAL_SEC))
    for freq, start, length, level in NOTES:
        i = int(SR * start)
        note = bell(freq, length, level)
        mix[i : i + len(note)] += note
    mix = reverb(mix)
    # fade the tail out smoothly so the 8-bit floor never ends in a click
    fade = int(SR * 0.25)
    mix[-fade:] *= np.linspace(1, 0, fade)
    mix /= np.max(np.abs(mix)) / 0.8

    # late-90s treatment: drop every other sample with no anti-alias filter (aliasing on purpose),
    # then 8-bit quantize + dither
    lo = mix[:: SR // LO_SR]
    levels = 2 ** (BITS - 1)
    lo = np.round(lo * levels + RNG.uniform(-0.5, 0.5, len(lo))) / levels
    pcm = np.clip(lo * 32767, -32768, 32767).astype("<i2")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "unlock.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(LO_SR)
            w.writeframes(pcm.tobytes())
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "48k", "-ac", "1", str(OUT)],
            check=True,
        )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

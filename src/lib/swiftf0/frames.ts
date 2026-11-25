/**
 * SwiftF0 (https://github.com/lars76/swift-f0, MIT — see LICENSE here; model.onnx is v0.3.0 from
 * commit d1ba77f): a 135 KB pitch model that reads 16 kHz audio and answers with a pitch and a
 * confidence every 256 samples (16 ms). This file is the part that needs no ONNX runtime: running
 * the model over a long recording in windows, and the per-frame loudness and silence gate the
 * reference implementation applies. Ported from the author's browser demo
 * (https://github.com/swift-f0/swift-f0.github.io, src/onnx-worker.js, MIT).
 */

export const SAMPLE_RATE = 16000
export const HOP = 256
/** Seconds between frames; frame `t` starts at `t * FRAME_PERIOD`. */
export const FRAME_PERIOD = HOP / SAMPLE_RATE
export const FMIN = 46.875
export const FMAX = 2093.75
/** A frame is voiced when its confidence is at least this (the reference implementation's rule). */
export const VOICED = 0.5

/** One pass of the model over 16 kHz samples: a value per HOP samples. */
export type Infer = (
  samples: Float32Array,
) => Promise<{ pitch: Float32Array; confidence: Float32Array }>

export interface PitchFrames {
  /** Hz per frame (meaningful where `confidence >= VOICED`). */
  readonly pitchHz: Float32Array
  readonly confidence: Float32Array
  /** Frame loudness, dBFS. */
  readonly loudnessDb: Float64Array
}

// The model sees 11 frames back and 10 ahead, so a window fed with that much context returns the
// frames a single pass would. Windows keep the wasm heap flat on long recordings.
const LEFT_FRAMES = 11
const LOOKAHEAD_FRAMES = 10
const WINDOW_FRAMES = 18750
/** Frames whose audio peaks below this are silence: the model answers noise with random pitch. */
const SILENT_PEAK = 1e-3

export async function detectFrames(
  samples: Float32Array,
  infer: Infer,
  onProgress?: (fraction: number) => void,
): Promise<PitchFrames> {
  const total = Math.floor(samples.length / HOP)
  let pitch: Float32Array
  let confidence: Float32Array
  if (total <= WINDOW_FRAMES) {
    ;({ pitch, confidence } = await infer(samples))
    pitch = pitch.slice(0, total)
    confidence = confidence.slice(0, total)
  } else {
    pitch = new Float32Array(total)
    confidence = new Float32Array(total)
    for (let first = 0; first < total; first += WINDOW_FRAMES) {
      const last = Math.min(total, first + WINDOW_FRAMES)
      const left = Math.min(first, LEFT_FRAMES)
      const start = (first - left) * HOP
      const end = Math.min(samples.length, (last + LOOKAHEAD_FRAMES) * HOP)
      const part = await infer(samples.subarray(start, end))
      pitch.set(part.pitch.subarray(left, left + last - first), first)
      confidence.set(part.confidence.subarray(left, left + last - first), first)
      onProgress?.(last / total)
    }
  }
  onProgress?.(1)
  gate(samples, confidence)
  return { pitchHz: pitch, confidence, loudnessDb: frameLoudness(samples, pitch.length) }
}

function gate(samples: Float32Array, confidence: Float32Array): void {
  for (let i = 0; i < confidence.length; i++) {
    let peak = 0
    const end = Math.min(samples.length, (i + 1) * HOP)
    for (let j = i * HOP; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]!))
    if (peak < SILENT_PEAK) confidence[i] = 0
  }
}

/** RMS over this frame and the one before (512 samples), dBFS. */
function frameLoudness(samples: Float32Array, n: number): Float64Array {
  const out = new Float64Array(n)
  let previous = 0
  for (let t = 0; t < n; t++) {
    let power = 0
    const end = Math.min(samples.length, (t + 1) * HOP)
    for (let i = t * HOP; i < end; i++) power += samples[i]! * samples[i]!
    out[t] = 20 * Math.log10(Math.max(Math.sqrt((previous + power) / 512), 1e-7))
    previous = power
  }
  return out
}

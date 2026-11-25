import { Fft } from '@audio-core/core/dsp/fft'

/**
 * Attacks in a recording, in the manner of MELISMA (`./melisma`): spectral flux over
 * log-compressed magnitudes that stands out of its local median, together with a rise in level,
 * at most one per 45 ms. A new attack on the same pitch — «ма-ма-ма» on one note — is how a
 * repeated note is told from a held one.
 */

const WINDOW_SECONDS = 1024 / 48000
const HOP_SECONDS = 256 / 48000
const MEDIAN_SECONDS = 0.15
/** Flux above its local median by this much is a candidate. */
const FLUX_MARGIN = 0.12
/** …and the level has to rise by this much across it, dB. */
const RISE_DB = 1
const MIN_GAP_SECONDS = 0.045

/** Seconds of each attack. */
export function detectOnsets(samples: Float32Array, sampleRate: number): number[] {
  let size = Math.max(64, Math.round(WINDOW_SECONDS * sampleRate))
  size += size % 2
  const hop = Math.max(1, Math.round(HOP_SECONDS * sampleRate))
  const fftSize = 2 ** Math.ceil(Math.log2(size))
  const fft = new Fft(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const window = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)),
  )
  const bins = fftSize / 2 + 1
  const frames = Math.max(0, Math.floor((samples.length - size) / hop) + 1)
  const flux = new Float64Array(frames)
  const rms = new Float64Array(frames)
  let previous = new Float64Array(bins)
  let current = new Float64Array(bins)
  for (let f = 0; f < frames; f++) {
    const at = f * hop
    let power = 0
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < size; i++) {
      const x = samples[at + i]!
      power += x * x
      re[i] = x * window[i]!
    }
    rms[f] = Math.sqrt(power / size)
    fft.forward(re, im)
    let sum = 0
    for (let k = 0; k < bins; k++) {
      current[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!))
      if (f > 0) sum += Math.max(0, current[k]! - previous[k]!)
    }
    flux[f] = sum / bins
    ;[previous, current] = [current, previous]
  }

  const dt = hop / sampleRate
  const half = Math.max(1, Math.round(MEDIAN_SECONDS / dt / 2))
  const third = Math.max(1, Math.round(half / 3))
  const gap = Math.round(MIN_GAP_SECONDS / dt)
  const out: number[] = []
  let last = -Infinity
  for (let f = 1; f + 1 < frames; f++) {
    if (!(flux[f]! > flux[f - 1]! && flux[f]! > flux[f + 1]!)) continue
    if (f - last < gap) continue
    const around = Array.from(flux.subarray(Math.max(0, f - half), Math.min(frames, f + half + 1)))
    around.sort((p, q) => p - q)
    if (flux[f]! <= around[around.length >> 1]! + FLUX_MARGIN) continue
    const before = rms[Math.max(0, f - third)]!
    const after = rms[Math.min(frames - 1, f + third)]!
    if (20 * Math.log10(Math.max(after, 1e-9) / Math.max(before, 1e-9)) < RISE_DB) continue
    out.push((f * hop + size / 2) / sampleRate)
    last = f
  }
  return out
}

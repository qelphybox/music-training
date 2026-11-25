/**
 * Notes from a pitch contour as a penalized changepoint problem, solved by dynamic programming —
 * SwiftF0's `segment_notes` (https://github.com/lars76/swift-f0, swift_f0/music.py; TS port from
 * https://github.com/swift-f0/swift-f0.github.io, src/notes.ts; both MIT, Lars Nieradzik).
 *
 * Each note holds one pitch μ, chosen among the pitches measured. A frame costs its distance from
 * μ in semitones, weighted by confidence and capped at 2 (so a stray octave frame does not cut a
 * note), plus how unvoiced it is (the confidence's logit) and how much quieter it is than its
 * neighbours. Starting a note costs `pitchHoldMs` worth of frames: a new pitch a semitone away has
 * to hold that long to become a note. Vibrato therefore stays inside its note; ornaments faster
 * than `pitchHoldMs` merge into their neighbours.
 */

export interface ContourNote {
  /** Seconds. */
  readonly start: number
  readonly end: number
  /** The note's pitch, fractional MIDI. */
  readonly midi: number
}

export function segmentContour(
  pitchHz: ArrayLike<number>,
  confidence: ArrayLike<number>,
  loudnessDb: ArrayLike<number>,
  framePeriod: number,
  pitchHoldMs = 80,
): ContourNote[] {
  const n = pitchHz.length
  const m = new Float64Array(n)
  const w = new Float64Array(n)
  const q = new Float64Array(n)
  const observed: number[] = []
  for (let t = 0; t < n; t++) {
    const hz = pitchHz[t]!
    if (Number.isFinite(hz) && hz > 0) {
      m[t] = 69 + 12 * Math.log2(hz / 440)
      w[t] = confidence[t]!
      observed.push(Math.floor(m[t]! * 100 + 0.5) / 100)
    }
    // Loudness dip: how much quieter this frame is than the loudest within 5 frames either side.
    let left = -Infinity
    let right = -Infinity
    for (let j = 0; j < 5; j++) {
      left = Math.max(left, loudnessDb[reflect(t - j, n)]!)
      right = Math.max(right, loudnessDb[reflect(t + j, n)]!)
    }
    const c = Math.min(Math.max(w[t]!, 0.01), 0.99)
    q[t] =
      -Math.log(c / (1 - c)) +
      Math.max(0, Math.min(left, right) - loudnessDb[t]! - 10 * Math.log10(2))
  }
  const mu = Float64Array.from(new Set(observed)).sort()
  const u = mu.length
  if (u === 0) return []
  const beta = pitchHoldMs / 1000 / framePeriod
  const vn = new Float64Array(u).fill(Infinity)
  const noteStart = new Int32Array(u)
  const back = new Int32Array(n + 1)
  const kind = new Int32Array(n + 1).fill(-1)
  let best = 0
  for (let t = 0; t < n; t++) {
    const start = best + beta
    let j = 0
    for (let k = 0; k < u; k++) {
      if (start < vn[k]!) {
        vn[k] = start
        noteStart[k] = t
      }
      vn[k]! += w[t]! * Math.min(Math.abs(mu[k]! - m[t]!), 2) + q[t]!
      if (vn[k]! < vn[j]!) j = k
    }
    if (vn[j]! < best) {
      best = vn[j]!
      back[t + 1] = noteStart[j]!
      kind[t + 1] = j
    } else {
      back[t + 1] = t
    }
  }
  const notes: ContourNote[] = []
  for (let b = n; b > 0;) {
    const a = back[b]!
    if (kind[b]! >= 0)
      notes.push({ start: a * framePeriod, end: b * framePeriod, midi: mu[kind[b]!]! })
    b = a
  }
  return notes.reverse()
}

/** Index reflected back into `[0, n)` (numpy's symmetric padding). */
function reflect(i: number, n: number): number {
  while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1
  return i
}

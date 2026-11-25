/**
 * Notes from a pitch contour in the manner of MELISMA (SnowTec), an audio-to-MIDI tool for music
 * whose pitch does not stand still.
 *
 * The contour stays a contour until the very end: every frame is first labelled silence, note,
 * slide or vibrato, and only then are notes cut — from the runs of note and vibrato frames. A slide
 * between two notes belongs to neither; it is kept as the way into the next one. Short notes
 * between leaps stay as ornaments; a run of held points inside a slide becomes a chain of them.
 * The knobs are MELISMA's own thresholds (ORNAMENT, SLIDE, VIBRATO, SENSITIVITY).
 *
 * Differences from MELISMA, for singing and for SwiftF0's 16 ms frames:
 * - Voice/silence: SwiftF0's confidence instead of MELISMA's fused voicing, so SENSITIVITY's scale
 *   is SwiftF0's (0.5 by default, its reference threshold); the gates around it are MELISMA's.
 * - No Viterbi over a pitch map (SwiftF0 gives one pitch a frame): octave jumps are folded back to
 *   their neighbourhood instead.
 * - A long monotone run (MELISMA's «sweep») is a slide only where the voice does not hold: a fast
 *   scale sung note by note stays notes, a glissando stays a slide.
 * - The gap between two notes is not closed: the slide stays the next note's `slideIn`.
 * - A lone short note with no neighbour in its phrase is dropped, not kept as an ornament.
 * - The note's pitch is not shifted to fit the bend range: the part wants the sung pitch.
 */

export const FRAME = { SILENCE: 0, NOTE: 1, SLIDE: 2, VIBRATO: 3 } as const
export type FrameClass = (typeof FRAME)[keyof typeof FRAME]

export interface MelismaSettings {
  /** The shortest note, seconds (ORNAMENT, 0.03–0.2). */
  readonly ornament: number
  /** Pitch speed from which the voice slides rather than holds, cents per second (SLIDE, 60–400). */
  readonly slide: number
  /** How wide and slow a wobble still counts as vibrato, 0…1 (VIBRATO). */
  readonly vibrato: number
  /** Confidence a frame needs to be voice (SENSITIVITY, on SwiftF0's scale), 0…1. */
  readonly sensitivity: number
  /** Pitch-bend range, semitones: how far the voice may travel inside one note (BEND). */
  readonly bend: number
  /** Keep short notes between leaps as ornaments instead of merging them (ORNAMENTS). */
  readonly ornaments: boolean
}

export const MELISMA_DEFAULTS: MelismaSettings = {
  ornament: 0.055,
  slide: 100,
  vibrato: 0.55,
  sensitivity: 0.5,
  bend: 12,
  ornaments: true,
}

/** A pitch tracker's frames: SwiftF0's output (`@/lib/swiftf0`). */
export interface PitchInput {
  readonly pitchHz: ArrayLike<number>
  readonly confidence: ArrayLike<number>
  readonly loudnessDb: ArrayLike<number>
}

export interface Vibrato {
  /** Hz. */
  readonly rate: number
  /** Peak to peak, cents. */
  readonly extent: number
}

export interface MelismaNote {
  /** Seconds. */
  readonly start: number
  readonly end: number
  /** Pitch, cents above MIDI 0 (MIDI × 100), as sung. */
  readonly cents: number
  /** A short note between leaps, or one of a run inside a slide. */
  readonly ornament: boolean
  /** Seconds the voice starts sliding into this note from the previous one; null when it steps. */
  readonly slideIn: number | null
  readonly vibrato: Vibrato | null
  /** The voice from `slideIn ?? start` to `end`: [seconds, cents], thinned like MIDI bend. */
  readonly curve: readonly (readonly [number, number])[]
}

export interface Scale {
  /** How far the singer's tuning is from A440, cents. */
  readonly tuning: number
  /** A4 of that tuning, Hz. */
  readonly a4: number
  /** Steps of the mode sung, cents within the octave (0 = C), ascending. */
  readonly degrees: readonly number[]
  /** Whether a step sits more than a quarter tone's half (25 ¢) off the semitone grid. */
  readonly microtonal: boolean
}

export interface MelismaResult {
  readonly notes: MelismaNote[]
  /** The voice, cents (MIDI × 100); NaN where there is none. */
  readonly cents: Float32Array
  readonly classes: Uint8Array
  /** Pitches the voice held steadily, cents: where ornaments may land. */
  readonly lines: readonly number[]
  readonly scale: Scale
}

/** A note while it is being made: frames, [s, e). */
interface Draft {
  s: number
  e: number
  cents: number
  ornament: boolean
  /** Cut off a longer note because it travelled past the bend range. */
  continuation: boolean
  slideIn: number | null
}

/**
 * The frames of a recording → notes. `hop` is seconds between frames; `onsets` are attack times,
 * seconds (`detectOnsets`): a new attack on the same pitch starts a new note.
 */
export function melismaNotes(
  input: PitchInput,
  hop: number,
  settings: Partial<MelismaSettings> = {},
  onsets: readonly number[] = [],
): MelismaResult {
  const s = { ...MELISMA_DEFAULTS, ...settings }
  const n = input.pitchHz.length
  const voiced = voicing(input, hop, s.sensitivity)
  const raw = new Float64Array(n).fill(NaN)
  for (let t = 0; t < n; t++) {
    const hz = input.pitchHz[t]!
    if (voiced[t] && hz > 0) raw[t] = 6900 + 1200 * Math.log2(hz / 440)
    else voiced[t] = 0
  }
  foldOctaves(raw)
  fillGaps(raw, voiced, Math.round(0.06 / hop))

  const a = new Analysis(n)
  const segments = runsOf(voiced).filter(([from, to]) => to - from > 2)
  for (const [from, to] of segments) a.classify(raw, from, to, hop, s)
  const lines = findLines(a.m1, voiced, hop)
  const amplitude = Float64Array.from({ length: n }, (_, t) => 10 ** (input.loudnessDb[t]! / 20))
  const onsetFrames = onsets.map((time) => Math.round(time / hop))

  const notes: MelismaNote[] = []
  for (const [from, to] of segments) {
    for (const d of notesOf(a, from, to, hop, s, lines, amplitude, onsetFrames))
      notes.push(finish(d, a, hop))
  }
  const cents = new Float32Array(n).fill(NaN)
  for (let t = 0; t < n; t++) if (voiced[t]) cents[t] = a.m1[t]!
  return { notes, cents, classes: a.classes, lines, scale: findScale(notes) }
}

// ─── Voice and silence ────────────────────────────────────────────────────────────────────────

/** Below this a frame is silence whatever the tracker says, dBFS. */
const ABSOLUTE_GATE = -55
/** …and this far below the loudest within LOCAL_SECONDS around it: a room's tail, not the voice. */
const RELATIVE_GATE = 26
const LOCAL_SECONDS = 1.5

/**
 * A frame is voice when it is loud enough, absolutely and against its neighbourhood, and the
 * tracker is confident enough — half as confident will do right after a voiced frame.
 */
function voicing(input: PitchInput, hop: number, threshold: number): Uint8Array {
  const n = input.pitchHz.length
  const out = new Uint8Array(n)
  const half = Math.round(LOCAL_SECONDS / hop / 2)
  let previous = false
  for (let t = 0; t < n; t++) {
    let loudest = -Infinity
    for (let k = Math.max(0, t - half); k <= Math.min(n - 1, t + half); k++)
      loudest = Math.max(loudest, input.loudnessDb[k]!)
    const db = input.loudnessDb[t]!
    const loud = db >= ABSOLUTE_GATE && db >= loudest - RELATIVE_GATE
    const sure: boolean = input.confidence[t]! >= (previous ? threshold / 2 : threshold)
    previous = loud && sure && input.pitchHz[t]! > 0
    out[t] = previous ? 1 : 0
  }
  return out
}

/** A frame an octave or more away from the voice around it is the tracker's octave slip. */
function foldOctaves(raw: Float64Array): void {
  const copy = raw.slice()
  const around: number[] = []
  for (let t = 0; t < raw.length; t++) {
    if (!Number.isFinite(copy[t]!)) continue
    around.length = 0
    for (let k = Math.max(0, t - 10); k <= Math.min(raw.length - 1, t + 10); k++)
      if (k !== t && Number.isFinite(copy[k]!)) around.push(copy[k]!)
    if (around.length < 5) continue
    const off = copy[t]! - medianOf(around)
    if (Math.abs(off) > 900) raw[t] = copy[t]! - 1200 * Math.round(off / 1200)
  }
}

/** Gaps of at most `most` frames inside the voice are a consonant or a dropout: bridged. */
function fillGaps(raw: Float64Array, voiced: Uint8Array, most: number): void {
  let last = -1
  for (let t = 0; t < raw.length; t++) {
    if (!voiced[t]) continue
    const gap = t - last - 1
    if (last >= 0 && gap > 0 && gap <= most) {
      for (let k = last + 1; k < t; k++) {
        raw[k] = raw[last]! + ((raw[t]! - raw[last]!) * (k - last)) / (t - last)
        voiced[k] = 1
      }
    }
    last = t
  }
}

// ─── Frame classes ────────────────────────────────────────────────────────────────────────────

/** Swing a vibrato extremum has to clear, cents. */
const VIBRATO_HYSTERESIS = 6
const VIBRATO_MIN_RATE = 3
const VIBRATO_MAX_RATE = 9
/** MELISMA's is 12; SwiftF0 drifts that much on a held note. */
const VIBRATO_MIN_EXTENT = 20
/** A vibrato window drifting faster than this is a slide with a wobble, cents per second. */
const VIBRATO_MAX_TREND = 600
/** Sweep: this much travel within SWEEP_SECONDS, almost all one way. */
const SWEEP_CENTS = 400
const SWEEP_SECONDS = 0.4
const SWEEP_STRAIGHTNESS = 0.72
/** Slower than this the voice holds, whatever SLIDE says: SwiftF0's jitter, cents per second. */
const HELD_FLOOR = 250
/**
 * A wobble whose RMS is this close to its half-extent is square — a run of held notes up and down
 * — not vibrato, which is round (a sine's RMS is 0.71 of its peak).
 */
const VIBRATO_MAX_SQUARENESS = 0.85
/** This many frames within FLAT_CENTS are a held pitch, however short. */
const FLAT_FRAMES = 3
const FLAT_CENTS = 12
/** Frames within this of the first are one flat step, cents. */
const PLATEAU_STEP = 25

class Analysis {
  /** Pitch, lightly median-smoothed, cents. */
  readonly m1: Float64Array
  /** Pitch speed of m1, cents per second. */
  readonly slope: Float64Array
  /** 0 none, 1 vibrato found around this frame, 2 the vibrato's note carried on. */
  readonly vibrato: Uint8Array
  readonly rate: Float64Array
  readonly extent: Float64Array
  /** Vibrato's centre where there is vibrato, the steady pitch elsewhere. */
  readonly central: Float64Array
  readonly sweep: Uint8Array
  readonly classes: Uint8Array

  constructor(n: number) {
    this.m1 = new Float64Array(n).fill(NaN)
    this.slope = new Float64Array(n)
    this.vibrato = new Uint8Array(n)
    this.rate = new Float64Array(n)
    this.extent = new Float64Array(n)
    this.central = new Float64Array(n).fill(NaN)
    this.sweep = new Uint8Array(n)
    this.classes = new Uint8Array(n)
  }

  /** Labels frames [a, b) of one stretch of voice. */
  classify(raw: Float64Array, a: number, b: number, hop: number, s: MelismaSettings): void {
    const { m1, slope, vibrato, rate, extent, central, sweep, classes } = this
    const halfOf = (seconds: number, least = 1) => Math.max(least, Math.round(seconds / hop / 2))
    const h1 = halfOf(0.025)
    for (let t = a; t < b; t++)
      m1[t] = medianRange(raw, Math.max(a, t - h1), Math.min(b, t + h1 + 1))
    const hs = halfOf(0.03)
    for (let t = a; t < b; t++) slope[t] = slopeAt(m1, t, hs, a, b, hop)

    // Vibrato: a regular 3–9 Hz wobble of the right width around a trend that barely moves.
    const half = halfOf(0.2 + 0.4 * s.vibrato, 3)
    const widest = 120 + 320 * s.vibrato
    const centre = new Float64Array(b - a).fill(NaN)
    for (let t = a; t < b; t++) {
      const found = vibratoAt(m1, t, half, a, b, hop, widest)
      if (!found) continue
      vibrato[t] = 1
      rate[t] = found.rate
      extent[t] = found.extent
      const period = Math.max(1, Math.round(0.5 / (found.rate * hop)))
      centre[t - a] = meanRange(m1, Math.max(a, t - period), Math.min(b, t + period + 1))
    }

    // Steady pitch: a long median, unless the voice moved too far from it to be the same note.
    const h2 = halfOf(0.18)
    for (let t = a; t < b; t++) {
      const m2 = medianRange(m1, Math.max(a, t - h2), Math.min(b, t + h2 + 1))
      central[t] = Math.abs(m1[t]! - m2) <= 0.35 * widest ? m2 : m1[t]!
    }

    // The vibrato's note goes on either side of where the wobble was found, while near its centre.
    const reach = Math.round(0.75 * half)
    for (let t = a; t < b; t++) {
      if (vibrato[t] !== 1) continue
      const edge = (k: number) => k >= a && k < b && vibrato[k] === 0
      const near = (k: number) =>
        Math.abs(m1[k]! - centre[t - a]!) <= Math.max(60, 1.5 * extent[t]!)
      for (const step of [-1, 1]) {
        if (!edge(t + step)) continue
        for (let k = t + step; Math.abs(k - t) <= reach && edge(k) && near(k); k += step) {
          vibrato[k] = 2
          rate[k] = rate[t]!
          extent[k] = extent[t]!
          centre[k - a] = centre[t - a]!
        }
      }
    }
    for (let t = a; t < b; t++) if (vibrato[t]) central[t] = centre[t - a]!
    const hc = halfOf(0.12)
    const centralSlope = new Float64Array(b - a)
    for (let t = a; t < b; t++) centralSlope[t - a] = slopeAt(central, t, hc, a, b, hop)

    // Sweep: a long, nearly straight run of pitch.
    const hw = halfOf(SWEEP_SECONDS, 2)
    for (let t = a; t < b; t++) {
      if (vibrato[t]) continue
      const lo = Math.max(a, t - hw)
      const hi = Math.min(b - 1, t + hw)
      if (hi - lo < 2 * hw) continue
      const travel = Math.abs(m1[hi]! - m1[lo]!)
      if (travel < SWEEP_CENTS) continue
      let path = 0
      for (let k = lo + 1; k <= hi; k++) path += Math.abs(m1[k]! - m1[k - 1]!)
      if (path >= 1e-6 && travel / path >= SWEEP_STRAIGHTNESS) sweep[t] = 1
    }

    // Held: a few frames in a row slower than SLIDE. At 16 ms a frame the tracker's few cents of
    // jitter read as a couple of hundred cents a second over MELISMA's 30 ms, so the speed is taken
    // over a wider window and never asked to be slower than the jitter.
    const held = new Uint8Array(b - a)
    const least = Math.max(2, Math.round(0.028 / hop))
    const hh = halfOf(0.03 * 2)
    const still = Math.max(s.slide, HELD_FLOOR)
    const speed = new Float64Array(b - a)
    for (let t = a; t < b; t++) speed[t - a] = Math.abs(slopeAt(m1, t, hh, a, b, hop))
    for (let t = a; t < b;) {
      if (speed[t - a]! >= still) {
        t++
        continue
      }
      let u = t
      while (u < b && speed[u - a]! < still) u++
      if (u - t >= least) held.fill(1, t - a, u - a)
      t = u
    }
    // A run note of 100 ms keeps one or two frames clear of that window: three frames within
    // MELISMA's 12 ¢ of each other (its test for a held pitch) hold too.
    for (let t = a; t + FLAT_FRAMES <= b; t++) {
      let lo = Infinity
      let hi = -Infinity
      for (let k = t; k < t + FLAT_FRAMES; k++) {
        lo = Math.min(lo, m1[k]!)
        hi = Math.max(hi, m1[k]!)
      }
      // Not next to vibrato: there a wobble's turn between two notes looks flat for a moment.
      let wobbling = false
      for (let k = Math.max(a, t - FLAT_FRAMES); k < Math.min(b, t + 2 * FLAT_FRAMES); k++)
        if (vibrato[k]) wobbling = true
      if (hi - lo < FLAT_CENTS && !wobbling) held.fill(1, t - a, t - a + FLAT_FRAMES)
    }
    // A grace note lasts two or three frames here, too few for the wide window: a flat step that
    // stands above (or below) the voice on both sides holds too.
    for (let t = a + 1; t < b - 1;) {
      let u = t + 1
      while (u < b - 1 && Math.abs(m1[u]! - m1[t]!) < PLATEAU_STEP) u++
      if (u - t >= least && !held.subarray(t - a, u - a).every(Boolean)) {
        const level = meanRange(m1, t, u)
        const before = m1[t - 1]! - level
        const after = m1[u]! - level
        if (
          Math.sign(before) === Math.sign(after) &&
          Math.min(Math.abs(before), Math.abs(after)) > ORNAMENT_LEAP
        )
          held.fill(1, t - a, u - a)
      }
      t = u
    }

    for (let t = a; t < b; t++) {
      if (vibrato[t]) classes[t] = FRAME.VIBRATO
      else if (sweep[t] && !held[t - a]) classes[t] = FRAME.SLIDE
      else if (Math.abs(centralSlope[t - a]!) >= s.slide)
        classes[t] = held[t - a] ? FRAME.NOTE : FRAME.SLIDE
      else classes[t] = FRAME.NOTE
    }
  }
}

/** Vibrato around frame `t`: its rate and peak-to-peak extent, or null. */
function vibratoAt(
  m1: Float64Array,
  t: number,
  half: number,
  a: number,
  b: number,
  hop: number,
  widest: number,
): Vibrato | null {
  const lo = Math.max(a, t - half)
  const hi = Math.min(b - 1, t + half)
  const n = hi - lo + 1
  if (n <= 5) return null
  // Trend: a straight line through the window.
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const y = m1[lo + k]!
    sx += k
    sy += y
    sxx += k * k
    sxy += k * y
  }
  const trend = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  if (Math.abs(trend / hop) > VIBRATO_MAX_TREND) return null
  const base = (sy - trend * sx) / n
  // Extrema of what is left, each clearing the last by the hysteresis; the window's edges are not.
  const peaks: { at: number; value: number }[] = []
  let direction = 0
  let hiV = m1[lo]! - base
  let hiAt = 0
  let loV = hiV
  let loAt = 0
  for (let k = 1; k < n; k++) {
    const v = m1[lo + k]! - base - trend * k
    if (direction >= 0 && v > hiV) {
      hiV = v
      hiAt = k
    }
    if (direction <= 0 && v < loV) {
      loV = v
      loAt = k
    }
    if (direction >= 0 && v <= hiV - VIBRATO_HYSTERESIS) {
      if (hiAt > 0) peaks.push({ at: hiAt, value: hiV })
      direction = -1
      loV = v
      loAt = k
    } else if (direction <= 0 && v >= loV + VIBRATO_HYSTERESIS) {
      if (loAt > 0) peaks.push({ at: loAt, value: loV })
      direction = 1
      hiV = v
      hiAt = k
    }
  }
  const k = peaks.length
  if (k < 3) return null
  const gaps = peaks.slice(1).map((p, i) => p.at - peaks[i]!.at)
  if (gaps.length >= 3 && Math.max(...gaps) > 2 * medianOf(gaps)) return null
  const span = (peaks[k - 1]!.at - peaks[0]!.at) * hop
  const rate = (k - 1) / (2 * span)
  if (rate < VIBRATO_MIN_RATE || rate > VIBRATO_MAX_RATE) return null
  const extent = (2 * peaks.reduce((sum, p) => sum + Math.abs(p.value), 0)) / k
  if (extent <= VIBRATO_MIN_EXTENT || extent > widest) return null
  // Not MELISMA's: on singing a quick turn of held notes passes everything above.
  let power = 0
  for (let j = peaks[0]!.at; j <= peaks[k - 1]!.at; j++)
    power += (m1[lo + j]! - base - trend * j) ** 2
  const rms = Math.sqrt(power / (peaks[k - 1]!.at - peaks[0]!.at + 1))
  if (rms > VIBRATO_MAX_SQUARENESS * (extent / 2)) return null
  return { rate, extent }
}

// ─── Lines: pitches held steadily ─────────────────────────────────────────────────────────────

function findLines(m1: Float64Array, voiced: Uint8Array, hop: number): number[] {
  const h = Math.max(1, Math.round(0.025 / hop / 2))
  const held: number[] = []
  for (let t = h; t < m1.length - h; t++) {
    if (!voiced[t]) continue
    let lo = Infinity
    let hi = -Infinity
    for (let k = t - h; k <= t + h; k++) {
      lo = Math.min(lo, m1[k]!)
      hi = Math.max(hi, m1[k]!)
    }
    if (hi - lo < 12) held.push(m1[t]!)
  }
  if (held.length < 20) return []
  const first = Math.floor(Math.min(...held)) - 60
  const histogram = new Float64Array(Math.ceil(Math.max(...held)) + 60 - first + 1)
  const sigma = 20
  const reach = Math.ceil(2.5 * sigma)
  for (const value of held) {
    const at = value - first
    for (let i = Math.max(0, Math.round(at) - reach); i <= Math.round(at) + reach; i++)
      if (i < histogram.length) histogram[i]! += Math.exp(-((i - at) ** 2) / (2 * sigma * sigma))
  }
  const top = Math.max(...histogram)
  const peaks: number[] = []
  for (let i = 0; i < histogram.length; i++) {
    const v = histogram[i]!
    if (v < 0.02 * top) continue
    let local = true
    for (let k = Math.max(0, i - 55); k <= Math.min(histogram.length - 1, i + 55) && local; k++)
      if (histogram[k]! > v) local = false
    if (local) peaks.push(i)
  }
  const kept: number[] = []
  for (const i of [...peaks].sort((p, q) => histogram[q]! - histogram[p]!))
    if (kept.every((k) => Math.abs(k - i) >= 55)) kept.push(i)
  return kept.sort((p, q) => p - q).map((i) => i + first)
}

// ─── Notes ────────────────────────────────────────────────────────────────────────────────────

/** Leap an ornament needs on both sides, cents. */
const ORNAMENT_LEAP = 70
/** An ornament this short is noise. Seconds. */
const ORNAMENT_SHORTEST = 0.025
/** A short note this far above (below) both neighbours is the top (bottom) of a leap: kept. */
const PEAK_LEAP = 250
/** A slide frame this close to a note's pitch is still the note, cents. */
const ON_PITCH = 50
/** Neighbours this close in pitch with no gap are one note, cents. */
const SAME_PITCH = 0.65 * ORNAMENT_LEAP

function notesOf(
  a: Analysis,
  from: number,
  to: number,
  hop: number,
  s: MelismaSettings,
  lines: readonly number[],
  amplitude: Float64Array,
  onsets: readonly number[],
): Draft[] {
  const { m1, slope, classes, vibrato, sweep } = a
  // 1 where the voice holds (note or vibrato), 0 where it slides, 2 where a slide is a run of ornaments.
  const mask = new Uint8Array(to - from)
  for (let t = from; t < to; t++) mask[t - from] = classes[t] === FRAME.SLIDE ? 0 : 1
  const cuts = new Set<number>()

  // Ornaments inside a slide: two or more points where it slows down near a held pitch.
  for (let t = from; t < to;) {
    if (mask[t - from] !== 0) {
      t++
      continue
    }
    let u = t
    while (u < to && mask[u - from] === 0) u++
    const anchors = anchorsIn(a, t, u, hop, lines)
    if (anchors.length >= 2) {
      mask.fill(2, t - from, u - from)
      for (let i = 1; i < anchors.length; i++) {
        let fastest = anchors[i - 1]! + 1
        for (let k = anchors[i - 1]! + 1; k < anchors[i]!; k++)
          if (Math.abs(slope[k]!) > Math.abs(slope[fastest]!)) fastest = k
        cuts.add(fastest)
      }
    }
    t = u
  }

  // Not MELISMA's: a jump between two held frames (a step sung cleanly, with no frame of slide
  // between at 16 ms) is a cut too. Vibrato swings that fast, so inside it nothing is cut, and on
  // its edge its centre is what the next frame is compared with: a vibrato note running straight
  // into a plain one a tone away has no slide frame between them either.
  // A plain frame next to the vibrato may still be at a crest of it: half the extent is allowed.
  const level = (t: number) => (vibrato[t] ? a.central[t]! : m1[t]!)
  for (let t = from + 1; t < to; t++) {
    if (!mask[t - from] || !mask[t - 1 - from] || (vibrato[t] && vibrato[t - 1])) continue
    const swing = Math.max(vibrato[t] ? a.extent[t]! : 0, vibrato[t - 1] ? a.extent[t - 1]! : 0)
    if (Math.abs(level(t) - level(t - 1)) > ON_PITCH + swing / 2) cuts.add(t)
  }

  // Pieces: runs of one kind of holding, broken at the cuts; slide frames belong to none.
  const pieces: { s: number; e: number; ornament: boolean }[] = []
  for (let t = from; t < to;) {
    const kind = mask[t - from]!
    if (kind === 0) {
      t++
      continue
    }
    let u = t + 1
    while (u < to && mask[u - from] === kind && !cuts.has(u)) u++
    pieces.push({ s: t, e: u, ornament: kind === 2 })
    t = u
  }
  if (pieces.length === 0) pieces.push({ s: from, e: to, ornament: false })
  pieces[0]!.s = from
  pieces[pieces.length - 1]!.e = to

  // A new attack inside a piece starts a new note, if both halves are long enough to be one.
  const shortest = Math.max(1, Math.round(s.ornament / hop))
  for (const onset of onsets) {
    const i = pieces.findIndex((p) => onset > p.s + shortest && onset < p.e - shortest)
    if (i < 0) continue
    const p = pieces[i]!
    pieces.splice(i, 1, { ...p, e: onset }, { ...p, s: onset })
  }

  const pitchOf = (from: number, to: number) => {
    const cut = Math.floor((to - from) / 5)
    const values: number[] = []
    for (let t = from + cut; t < to - cut; t++) values.push(vibrato[t] ? a.central[t]! : m1[t]!)
    return medianOf(values)
  }
  let notes: Draft[] = pieces.map((p) => ({
    s: p.s,
    e: p.e,
    cents: pitchOf(p.s, p.e),
    ornament: p.ornament,
    continuation: false,
    slideIn: null,
  }))
  const seconds = (d: Draft) => (d.e - d.s) * hop

  // Not MELISMA's: a note owns the slide frames next to it that are still at its pitch, so a slide
  // is only the travel. At 16 ms a frame a 100 ms note of a run holds for one or two frames by the
  // speed test alone.
  for (let i = 0; i < notes.length; i++) {
    const d = notes[i]!
    const floor = i > 0 ? notes[i - 1]!.e : from
    const ceiling = i + 1 < notes.length ? notes[i + 1]!.s : to
    const near = (t: number) => Math.abs(m1[t]! - d.cents) <= ON_PITCH
    while (d.s > floor && mask[d.s - 1 - from] === 0 && near(d.s - 1)) d.s--
    while (d.e < ceiling && mask[d.e - from] === 0 && near(d.e)) d.e++
  }

  // A quieter, lower, short tail after a note is the note dying away.
  const loudness = (from: number, to: number) => meanRange(amplitude, from, Math.max(from + 1, to))
  for (let i = 1; i < notes.length; i++) {
    const d = notes[i]!
    const prev = notes[i - 1]!
    const next = notes[i + 1]
    const third = Math.max(1, Math.floor((d.e - d.s) / 3))
    let before = 0
    for (let t = Math.max(0, d.s - Math.round(1.5 / hop)); t < d.s; t++)
      before = Math.max(before, amplitude[t]!)
    const trough =
      next !== undefined && prev.cents - d.cents >= PEAK_LEAP && next.cents - d.cents >= PEAK_LEAP
    if (
      d.cents < prev.cents - 20 &&
      seconds(d) <= 0.45 &&
      loudness(d.s, d.e) < 0.55 * before &&
      loudness(d.e - third, d.e) < loudness(d.s, d.s + third) * 10 ** (2.5 / 20) &&
      !trough
    ) {
      prev.e = d.e
      notes.splice(i--, 1)
    }
  }

  // Notes shorter than ORNAMENT: an ornament between leaps, the top of a leap, or part of a neighbour.
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < notes.length; i++) {
      const d = notes[i]!
      if (seconds(d) >= s.ornament) continue
      const prev = notes[i - 1]
      const next = notes[i + 1]
      if (!prev && !next) {
        notes.splice(i, 1)
        changed = true
        break
      }
      const left = prev ? d.cents - prev.cents : null
      const right = next ? d.cents - next.cents : null
      if (
        s.ornaments &&
        (left === null || Math.abs(left) > ORNAMENT_LEAP) &&
        (right === null || Math.abs(right) > ORNAMENT_LEAP) &&
        seconds(d) >= ORNAMENT_SHORTEST
      ) {
        if (!d.ornament) {
          d.ornament = true
          changed = true
        }
        continue
      }
      if (
        left !== null &&
        right !== null &&
        ((left >= PEAK_LEAP && right >= PEAK_LEAP) || (left <= -PEAK_LEAP && right <= -PEAK_LEAP))
      )
        continue
      const intoNext = !prev || (next !== undefined && Math.abs(right!) <= Math.abs(left!))
      if (intoNext) next!.s = d.s
      else prev!.e = d.e
      notes.splice(i, 1)
      changed = true
      break
    }
  }

  // Touching neighbours on the same pitch are one note, unless the voice attacked again.
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1]!
    const d = notes[i]!
    const attacked = onsets.some((o) => Math.abs(o - d.s) * hop < 0.04)
    if (
      d.s - prev.e < Math.round(0.01 / hop) + 1 &&
      Math.abs(d.cents - prev.cents) < SAME_PITCH &&
      !attacked
    ) {
      const wa = prev.e - prev.s
      const wb = d.e - d.s
      prev.cents = (prev.cents * wa + d.cents * wb) / (wa + wb)
      prev.ornament = prev.ornament && d.ornament
      prev.e = d.e
      notes.splice(i--, 1)
    }
  }

  // The voice travelling further than the bend range from a note starts another.
  const range = Math.min(900, Math.max(140, s.bend * 100 - 60))
  const split: Draft[] = []
  for (const d of notes) {
    let current: Draft = { ...d }
    for (let t = d.s; t < d.e; t++) {
      if (Math.abs(m1[t]! - current.cents) <= range) continue
      if ((d.e - t) * hop < ORNAMENT_SHORTEST && !sweep[t]) {
        current.e = t
        break
      }
      if (t > current.s) {
        split.push({ ...current, e: t })
        current = { ...current, s: t, cents: pitchOf(t, d.e), continuation: true, slideIn: null }
      }
    }
    split.push(current)
  }
  notes = split.filter((d) => d.e > d.s)

  // A brief piece cut off that way and lying against a note of its pitch joins it.
  for (let i = 0; i + 1 < notes.length; i++) {
    const d = notes[i]!
    const next = notes[i + 1]!
    if (
      d.continuation &&
      seconds(d) < 0.07 &&
      next.s - d.e <= 1 &&
      Math.abs(next.cents - d.cents) < ORNAMENT_LEAP
    ) {
      next.s = d.s
      notes.splice(i--, 1)
    }
  }

  // Slides between notes: the frames between them are the way into the next.
  for (let i = 1; i < notes.length; i++) {
    const prev = notes[i - 1]!
    const d = notes[i]!
    if (d.s < prev.e) prev.e = d.s
    if (d.s > prev.e) d.slideIn = prev.e
  }

  // Slivers under 20 ms are not notes: the next one starts where they did.
  const kept: Draft[] = []
  for (let i = 0; i < notes.length; i++) {
    const d = notes[i]!
    const next = notes[i + 1]
    if (next && seconds(d) < 0.02) {
      if (next.slideIn !== null) next.slideIn = d.slideIn ?? d.s
      else {
        next.s = d.s
        next.slideIn = d.slideIn
      }
      continue
    }
    kept.push(d)
  }
  return kept
}

/** Points inside slide frames [t, u) where the voice slows down near a held pitch. */
function anchorsIn(
  a: Analysis,
  t: number,
  u: number,
  hop: number,
  lines: readonly number[],
): number[] {
  const { m1, slope, sweep, vibrato } = a
  const n = u - t
  if (n < Math.round(0.08 / hop)) return []
  let swept = 0
  for (let k = t; k < u; k++) swept += sweep[k]!
  if (swept > n / 2) return []
  const speed = Array.from({ length: n }, (_, k) => Math.abs(slope[t + k]!))
  const fastest = Math.max(...speed)
  let lo = 0
  let hi = n
  while (lo < hi && speed[lo]! < 0.25 * fastest) lo++
  while (hi > lo && speed[hi - 1]! < 0.25 * fastest) hi--
  if (hi - lo < 3) return []
  const sorted = speed.slice(lo, hi).sort((p, q) => p - q)
  const slow = 0.35 * sorted[Math.floor(0.75 * (sorted.length - 1))]!
  const least = Math.max(3, Math.round(0.025 / hop / 2))
  const anchors: number[] = []
  for (let k = lo; k < hi;) {
    if (speed[k]! > slow) {
      k++
      continue
    }
    let j = k
    while (j < hi && speed[j]! <= slow) j++
    if (j - k >= least) {
      let best = k
      for (let q = k; q < j; q++) if (speed[q]! < speed[best]!) best = q
      const at = t + best
      const value = m1[at]!
      const last = anchors[anchors.length - 1]
      if (
        !vibrato[at] &&
        (last === undefined || Math.abs(value - m1[last]!) >= 60) &&
        (lines.length < 2 || lines.some((line) => Math.abs(line - value) <= 40))
      )
        anchors.push(at)
    }
    k = j
  }
  return anchors
}

/** A draft → the note: seconds, its vibrato, its curve thinned the way MIDI bend is written. */
function finish(d: Draft, a: Analysis, hop: number): MelismaNote {
  const rates: number[] = []
  const extents: number[] = []
  for (let t = d.s; t < d.e; t++) {
    if (!a.vibrato[t]) continue
    rates.push(a.rate[t]!)
    extents.push(a.extent[t]!)
  }
  const vibrato =
    rates.length >= 3 && rates.length >= 0.3 * (d.e - d.s)
      ? { rate: round(medianOf(rates), 10), extent: Math.round(medianOf(extents)) }
      : null
  const curve: [number, number][] = []
  const first = d.slideIn ?? d.s
  for (let t = first; t < d.e; t++) {
    const value = a.m1[t]!
    if (!Number.isFinite(value)) continue
    const last = curve[curve.length - 1]
    if (
      !last ||
      t === d.e - 1 ||
      Math.abs(value - last[1]) >= BEND_STEP_CENTS ||
      t * hop - last[0] >= BEND_STEP_SECONDS - 1e-9
    )
      curve.push([round(t * hop, 1000), round(value, 10)])
  }
  return {
    start: round(d.s * hop, 1000),
    end: round(d.e * hop, 1000),
    cents: round(d.cents, 10),
    ornament: d.ornament,
    slideIn: d.slideIn === null ? null : round(d.slideIn * hop, 1000),
    vibrato,
    curve,
  }
}

/** A bend point is written when the pitch moved this far, cents, … */
const BEND_STEP_CENTS = 1.5
/** …or this long after the last one, seconds. */
const BEND_STEP_SECONDS = 0.03

// ─── Tuning and mode ──────────────────────────────────────────────────────────────────────────

/**
 * The singer's A4 and the steps of the mode, from a pitch-class profile of the notes (ornaments
 * count a quarter): the tuning is the shift of the semitone comb that catches most of it, the
 * steps are its peaks.
 */
export function findScale(notes: readonly MelismaNote[]): Scale {
  if (notes.length === 0) return { tuning: 0, a4: 440, degrees: [], microtonal: false }
  const raw = new Float64Array(1200)
  for (const note of notes) {
    const bin = ((Math.round(note.cents) % 1200) + 1200) % 1200
    raw[bin]! += (note.end - note.start) * (note.ornament ? 0.25 : 1)
  }
  const profile = new Float64Array(1200)
  for (let i = 0; i < 1200; i++) {
    if (raw[i] === 0) continue
    for (let k = -45; k <= 45; k++)
      profile[(i + k + 1200) % 1200]! += raw[i]! * Math.exp(-(k * k) / (2 * 15 * 15))
  }
  const top = Math.max(...profile)
  for (let i = 0; i < 1200; i++) profile[i]! /= top
  const at = (cents: number) => profile[((Math.round(cents) % 1200) + 1200) % 1200]!

  let tuning = 0
  let best = -Infinity
  for (let d = -50; d < 50; d += 0.5) {
    let sum = 0
    for (let k = 0; k < 12; k++) sum += at(d + 100 * k)
    if (sum > best) {
      best = sum
      tuning = d
    }
  }

  const candidates: number[] = []
  for (let i = 0; i < 1200; i++) {
    if (profile[i]! < 0.08) continue
    let peak = true
    for (let k = -25; k <= 24 && peak; k++) if (at(i + k) > profile[i]!) peak = false
    if (peak) candidates.push(i)
  }
  const circular = (p: number, q: number) => Math.min(Math.abs(p - q), 1200 - Math.abs(p - q))
  const degrees: number[] = []
  for (const c of candidates.sort((p, q) => profile[q]! - profile[p]!)) {
    if (degrees.length >= 12) break
    if (degrees.every((d) => circular(d, c) >= 50)) degrees.push(c)
  }
  degrees.sort((p, q) => p - q)
  const microtonal = degrees.some(
    (deg) => Math.abs(deg - tuning - Math.round((deg - tuning) / 100) * 100) > 25,
  )
  return { tuning, a4: round(440 * 2 ** (tuning / 1200), 10), degrees, microtonal }
}

// ─── Small helpers ────────────────────────────────────────────────────────────────────────────

function runsOf(flags: Uint8Array): [number, number][] {
  const out: [number, number][] = []
  for (let t = 0; t < flags.length;) {
    if (!flags[t]) {
      t++
      continue
    }
    let u = t
    while (u < flags.length && flags[u]) u++
    out.push([t, u])
    t = u
  }
  return out
}

/** Least-squares slope of `values` over frames t ± half within [a, b), per second. */
function slopeAt(
  values: Float64Array,
  t: number,
  half: number,
  a: number,
  b: number,
  hop: number,
): number {
  const lo = Math.max(a, t - half)
  const hi = Math.min(b - 1, t + half)
  const n = hi - lo + 1
  if (n < 2) return 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let k = lo; k <= hi; k++) {
    const x = k - lo
    sx += x
    sy += values[k]!
    sxx += x * x
    sxy += x * values[k]!
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx) / hop
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((p, q) => p - q)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function medianRange(values: Float64Array, from: number, to: number): number {
  const finite: number[] = []
  for (let k = from; k < to; k++) if (Number.isFinite(values[k]!)) finite.push(values[k]!)
  return medianOf(finite)
}

function meanRange(values: Float64Array, from: number, to: number): number {
  let sum = 0
  let count = 0
  for (let k = from; k < to; k++) {
    if (!Number.isFinite(values[k]!)) continue
    sum += values[k]!
    count++
  }
  return count ? sum / count : NaN
}

const round = (value: number, scale: number) => Math.round(value * scale) / scale

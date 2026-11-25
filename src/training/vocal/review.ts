import type { Contour, PartNote } from './part'

/**
 * A student's take against the part, by pitch only.
 *
 * The student sings in their own time — by default with nothing playing — so a note of the part is
 * found by order, not by the clock: the take's voiced frames are aligned to the part's notes by
 * dynamic time warping on pitch. Each note then gets the frames sung for it, and its pitch is their
 * middle: the first and last fifth are the way in and out of the note, not the note. A note that
 * gets (almost) no frames was skipped.
 *
 * Octave matters: a note sung an octave away is 1200 cents off.
 */

/** Tolerance levels, cents either side: easy, medium, strict. */
export const LEVELS = [15, 7, 2] as const
export type Level = (typeof LEVELS)[number]

export interface NoteReview {
  readonly note: PartNote
  /** Sung pitch minus the note, cents; null when the note was not sung. */
  readonly cents: number | null
}

export interface Review {
  readonly notes: readonly NoteReview[]
  /** Share of the part's notes hit, percent, per tolerance level. */
  readonly scores: Readonly<Record<Level, number>>
  /** The take warped onto the part's clock, to draw over its notes. */
  readonly warped: Contour
  /** Whether any voice was heard at all. */
  readonly heard: boolean
}

/** Frames per second the alignment works at: enough for notes, cheap for a minute of singing. */
const RATE = 25
/** A pitch further off than this costs no more, semitones: a wrong note is wrong, however far. */
const CAP = 4
/** A note sung with fewer frames than this share of its expected length counts as skipped. */
const SKIPPED = 0.3
/** Share of a note's frames dropped at each end before its pitch is taken. */
const EDGE = 0.2

/** A take as frames: fractional MIDI (NaN where nothing is sung) from `start`, `frameRate` per second. */
export interface Take {
  readonly midi: ArrayLike<number>
  readonly frameRate: number
  readonly start: number
}

export function review(part: readonly PartNote[], take: Take): Review {
  // The part as frames: every RATE-th of a second inside a note.
  const targetMidi: number[] = []
  const targetNote: number[] = []
  const targetTime: number[] = []
  part.forEach((note, index) => {
    const first = Math.ceil(note.start * RATE)
    const last = Math.max(first, Math.floor(note.end * RATE) - 1)
    for (let k = first; k <= last; k++) {
      targetMidi.push(note.midi)
      targetNote.push(index)
      targetTime.push(k / RATE)
    }
  })
  const sung = binned(take)
  const T = targetMidi.length
  const S = sung.length
  const empty = (): Review => ({
    notes: part.map((note) => ({ note, cents: null })),
    scores: { 15: 0, 7: 0, 2: 0 },
    warped: warpedContour(part, [], []),
    heard: S > 0,
  })
  if (T === 0 || S === 0) return empty()

  // DTW, student frames × part frames. Steps: both advance, the student holds, the part moves on.
  const cost = new Float64Array(S * T)
  const from = new Uint8Array(S * T) // 0 diagonal, 1 from the previous student frame, 2 from the previous part frame
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < T; j++) {
      const d = Math.min(Math.abs(sung[i]! - targetMidi[j]!), CAP)
      const at = i * T + j
      if (i === 0 && j === 0) {
        cost[at] = d
        continue
      }
      let best = Infinity
      let step = 0
      if (i > 0 && j > 0 && cost[at - T - 1]! < best) {
        best = cost[at - T - 1]!
        step = 0
      }
      if (i > 0 && cost[at - T]! < best) {
        best = cost[at - T]!
        step = 1
      }
      if (j > 0 && cost[at - 1]! < best) {
        best = cost[at - 1]!
        step = 2
      }
      cost[at] = best + d
      from[at] = step
    }
  }
  // Back along the path: which student frames went to which part frame.
  const byTarget: number[][] = Array.from({ length: T }, () => [])
  for (let i = S - 1, j = T - 1; ;) {
    byTarget[j]!.push(i)
    if (i === 0 && j === 0) break
    const step = from[i * T + j]
    if (step === 0) {
      i--
      j--
    } else if (step === 1) i--
    else j--
  }

  const stretch = S / T
  const notes: NoteReview[] = part.map((note, index) => {
    const frames = new Set<number>()
    let length = 0
    for (let j = 0; j < T; j++) {
      if (targetNote[j] !== index) continue
      length++
      for (const i of byTarget[j]!) frames.add(i)
    }
    if (frames.size < Math.max(2, SKIPPED * length * stretch)) return { note, cents: null }
    const ordered = [...frames].sort((a, b) => a - b)
    const cut = ordered.length >= 5 ? Math.floor(ordered.length * EDGE) : 0
    const middle = ordered.slice(cut, ordered.length - cut).map((i) => sung[i]!)
    const cents = (centre(middle) - note.midi) * 100
    return { note, cents: Math.round(cents * 10) / 10 }
  })

  const scores = Object.fromEntries(
    LEVELS.map((level) => [
      level,
      Math.round(
        (100 * notes.filter((n) => n.cents !== null && Math.abs(n.cents) <= level).length) /
          notes.length,
      ),
    ]),
  ) as Record<Level, number>

  // A skipped note stays blank: the frame the path borrowed for it belongs to a neighbour.
  const warpedMidi = byTarget.map((frames, j) =>
    notes[targetNote[j]!]!.cents === null ? NaN : median(frames.map((i) => sung[i]!)),
  )
  return { notes, scores, warped: warpedContour(part, targetTime, warpedMidi), heard: true }
}

/** The take's voiced frames at RATE: each bin the median of the voiced frames in it. */
function binned(take: Take): number[] {
  const out: number[] = []
  let bin = -Infinity
  let values: number[] = []
  const flush = () => {
    if (values.length) out.push(median(values))
    values = []
  }
  for (let k = 0; k < take.midi.length; k++) {
    const value = take.midi[k]!
    if (!Number.isFinite(value)) continue
    const at = Math.floor((take.start + k / take.frameRate) * RATE)
    if (at !== bin) {
      flush()
      bin = at
    }
    values.push(value)
  }
  flush()
  return out
}

/** The warped take as a contour on the part's clock: a frame per RATE, NaN between notes. */
function warpedContour(
  part: readonly PartNote[],
  times: readonly number[],
  midi: readonly number[],
): Contour {
  const end = (part[part.length - 1]?.end ?? 0) + 1
  const count = Math.ceil(end * RATE) + 1
  const out = new Float32Array(count).fill(NaN)
  const level = new Float32Array(count)
  times.forEach((time, j) => {
    const k = Math.round(time * RATE)
    if (k < count) {
      out[k] = midi[j]!
      level[k] = 0.75
    }
  })
  return { midi: out, level, frameRate: RATE, start: 0 }
}

/** Frames a vibrato period spans at RATE: 200 ms, a 5 Hz cycle (sung vibrato runs 4.5–7 Hz). */
const VIBRATO_FRAMES = 5

/**
 * The pitch a note was sung at. A plain median of a vibrato that does not span whole cycles leans
 * to whichever side has the extra half-cycle — ten cents and more on a ±70 ¢ vibrato. So a note
 * long enough is first smoothed by a vibrato period, twice (a triangle that all but cancels 4–7 Hz),
 * and the median taken of that.
 */
function centre(values: readonly number[]): number {
  const rough = median(values)
  // Averaging is not robust: frames of a neighbouring note that the alignment let in (a legato
  // step away) would pull the mean, so they go first. Vibrato stays well inside this.
  const own = values.filter((v) => Math.abs(v - rough) <= OUTLIER)
  if (own.length < 2 * VIBRATO_FRAMES) return median(own)
  return median(movingAverage(movingAverage(own, VIBRATO_FRAMES), VIBRATO_FRAMES))
}

/** Frames further than this from a note's rough pitch are not of it, semitones. */
const OUTLIER = 1.5

/** Means of every `width` consecutive values (only windows that fit). */
function movingAverage(values: readonly number[], width: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= width) sum -= values[i - width]!
    if (i >= width - 1) out.push(sum / width)
  }
  return out
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

import { analyzeOffline, level, pitch, segmentTake } from '@audio-core/core/index'
import { segmentContour, type ContourNote } from './changepoint'
import { melismaNotes, type MelismaSettings, type Scale, type Vibrato } from './melisma'

/**
 * The vocal trainer's part: the notes a teacher sang, in seconds of their recording. Each note is
 * a tempered pitch (integer MIDI) held from `start` to `end`. What the voice does around and inside
 * it — the slide into it, vibrato, the pitch as actually sung — rides along as optional fields, the
 * way MIDI carries pitch bend on a note; parts made before them have none.
 */
export interface PartNote {
  readonly midi: number
  readonly start: number
  readonly end: number
  /** The pitch as sung, fractional MIDI. */
  readonly pitch?: number
  /** A short note between leaps or one of a run: drawn apart and not judged. */
  readonly ornament?: boolean
  /** Seconds the voice starts sliding into this note from the previous one. */
  readonly slideIn?: number
  readonly vibrato?: Vibrato
  /** The voice from `slideIn ?? start` to `end`: [seconds from `start`, cents from `midi`]. */
  readonly bend?: readonly (readonly [number, number])[]
  /** The syllable sung on it; ends with «-» when the word goes on. */
  readonly lyric?: string
}

/** Pitch and loudness frames of a whole recording, for drawing it under its notes. */
export interface Contour {
  /** Fractional MIDI per frame; NaN where nothing is sung. */
  readonly midi: Float32Array
  /** Loudness per frame, 0…1. */
  readonly level: Float32Array
  readonly frameRate: number
  /** Seconds of frame 0. */
  readonly start: number
  /** What each frame is (`FRAME` in ./melisma): silence, note, slide, vibrato. */
  readonly classes?: Uint8Array
}

export interface Transcription {
  readonly notes: PartNote[]
  readonly contour: Contour
  /** The singer's tuning and mode, when the transcription finds them. */
  readonly scale?: Scale
}

/** Silence added either side of a recording before it is segmented, seconds. */
const PAD_SECONDS = 0.4
/** dBFS that reads as an empty and a full brush. */
const QUIET_DB = -60

/**
 * A recording → its notes, the old way: the analysis the live microphone runs (pYIN pitch, level)
 * over the whole signal, then the take segmenter; each note keeps its nearest tempered pitch.
 * Kept to compare against SwiftF0 (`transcribeFrames`).
 */
export function transcribe(samples: Float32Array, sampleRate: number): Transcription {
  // The segmenter tells sound from pause by the quiet around it; a recording that starts or ends
  // mid-note has none, so it gets a little silence either side and the times are moved back.
  const pad = Math.round(PAD_SECONDS * sampleRate)
  const padded = new Float32Array(samples.length + 2 * pad)
  padded.set(samples, pad)
  const { timeline } = analyzeOffline(padded, { sampleRate }, [pitch, level], {
    f0: { tracker: 'pyin' },
  })
  const { notes } = segmentTake(timeline)
  const midi = timeline.alignedSlice('midi')
  const dbfs = timeline.alignedSlice('dbfs')
  const loud = new Float32Array(dbfs.length)
  for (let i = 0; i < dbfs.length; i++) {
    const db = dbfs[i]!
    loud[i] = Number.isFinite(db) ? Math.min(1, Math.max(0, 1 - db / QUIET_DB)) : 0
  }
  return {
    notes: notes.map((note) => ({
      midi: note.note,
      start: round(Math.max(0, note.startTime - PAD_SECONDS)),
      end: round(note.endTime - PAD_SECONDS),
    })),
    contour: {
      midi,
      level: loud,
      frameRate: timeline.frameRate,
      start: (timeline.length ? timeline.frameTime(0) : 0) - PAD_SECONDS,
    },
  }
}

/**
 * How a recording is turned into notes: SwiftF0 frames read the MELISMA way (slides, vibrato,
 * ornaments), SwiftF0 frames through its author's changepoint segmenter, or the old pYIN path.
 */
export type Tracker = 'melisma' | 'swiftf0' | 'pyin'

/** A pitch model's frames over a recording (SwiftF0's output, `@/lib/swiftf0`). */
export interface ModelFrames {
  readonly pitchHz: ArrayLike<number>
  readonly confidence: ArrayLike<number>
  readonly loudnessDb: ArrayLike<number>
}

/**
 * Model frames → notes: SwiftF0's changepoint segmentation over the whole contour, each note on
 * its nearest tempered pitch. Frames below `voiced` confidence are drawn as silence.
 */
export function transcribeFrames(
  frames: ModelFrames,
  framePeriod: number,
  voiced = 0.5,
  pitchHoldMs = 80,
): Transcription {
  const n = frames.pitchHz.length
  const notes = segmentContour(
    frames.pitchHz,
    frames.confidence,
    frames.loudnessDb,
    framePeriod,
    pitchHoldMs,
  )
  const midi = new Float32Array(n)
  const loud = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    const hz = frames.pitchHz[t]!
    midi[t] = frames.confidence[t]! >= voiced && hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN
    const db = frames.loudnessDb[t]!
    loud[t] = Number.isFinite(db) ? Math.min(1, Math.max(0, 1 - db / QUIET_DB)) : 0
  }
  return {
    notes: settled(withoutGlides(notes, midi, framePeriod), midi, framePeriod).map((note) => ({
      midi: Math.round(note.midi),
      start: round(note.start),
      end: round(note.end),
    })),
    contour: { midi, level: loud, frameRate: 1 / framePeriod, start: 0 },
  }
}

/**
 * Model frames → notes the way MELISMA reads them (`./melisma`): notes on their nearest tempered
 * pitch, with the slide into each, its vibrato, its sung pitch and its curve. `onsets` are attack
 * times, seconds (`detectOnsets`).
 */
export function transcribeMelisma(
  frames: ModelFrames,
  framePeriod: number,
  settings: Partial<MelismaSettings> = {},
  onsets: readonly number[] = [],
): Transcription {
  const result = melismaNotes(frames, framePeriod, settings, onsets)
  const n = frames.pitchHz.length
  const midi = new Float32Array(n)
  const loud = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    midi[t] = result.cents[t]! / 100
    const db = frames.loudnessDb[t]!
    loud[t] = Number.isFinite(db) ? Math.min(1, Math.max(0, 1 - db / QUIET_DB)) : 0
  }
  return {
    notes: result.notes.map((note) => {
      const tempered = Math.round(note.cents / 100)
      return {
        midi: tempered,
        start: note.start,
        end: note.end,
        pitch: Math.round(note.cents) / 100,
        ...(note.ornament ? { ornament: true } : {}),
        ...(note.slideIn !== null ? { slideIn: note.slideIn } : {}),
        ...(note.vibrato ? { vibrato: note.vibrato } : {}),
        bend: note.curve.map(
          ([t, c]) => [round(t - note.start), Math.round((c - tempered * 100) * 10) / 10] as const,
        ),
      }
    }),
    contour: { midi, level: loud, frameRate: 1 / framePeriod, start: 0, classes: result.classes },
    scale: result.scale,
  }
}

/** A note shorter than this can be the middle of a slide rather than a note, seconds. */
const GLIDE_MAX_SECONDS = 0.25
/** …when its pitch travels at least this far from its first frames to its last, semitones. */
const GLIDE_TRAVEL = 1

/**
 * The segmenter cuts a slide between two notes into a short note of its own on the way. Such a
 * "note" is a glide, not a note: its pitch travels across it instead of holding. It is dropped and
 * its time split between its neighbours. A fast run holds each note, so its notes stay.
 */
function withoutGlides(
  notes: readonly ContourNote[],
  midi: Float32Array,
  framePeriod: number,
): ContourNote[] {
  const out: ContourNote[] = []
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!
    const previous = out[out.length - 1]
    const next = notes[i + 1]
    const joined =
      previous !== undefined &&
      next !== undefined &&
      Math.abs(previous.end - note.start) < 1e-6 &&
      Math.abs(next.start - note.end) < 1e-6
    if (joined && note.end - note.start < GLIDE_MAX_SECONDS && travels(note, midi, framePeriod)) {
      const middle = (note.start + note.end) / 2
      out[out.length - 1] = { ...previous, end: middle }
      notes = [...notes.slice(0, i + 1), { ...next, start: middle }, ...notes.slice(i + 2)]
      continue
    }
    out.push(note)
  }
  return out
}

/** How close to a note's pitch the voice has to be to be on it, semitones (vibrato fits). */
const ON_NOTE = 0.75
/** Frames in a row the voice has to stay there to have arrived or still be there. */
const STEADY_FRAMES = 3

/**
 * Between two touching notes of different pitch the segmenter puts the boundary somewhere in the
 * move from one to the other — mid-slide. A note begins when the voice arrives at its pitch and ends
 * when it leaves; the time between, if any, is the slide and belongs to neither.
 */
function settled(
  notes: readonly ContourNote[],
  midi: Float32Array,
  framePeriod: number,
): ContourNote[] {
  const out = notes.map((note) => ({ ...note }))
  const near = (t: number, pitch: number) =>
    Number.isFinite(midi[t]!) && Math.abs(midi[t]! - pitch) <= ON_NOTE
  const steady = (t: number, pitch: number, step: 1 | -1) => {
    for (let k = 0; k < STEADY_FRAMES; k++) if (!near(t + k * step, pitch)) return false
    return true
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!
    const b = out[i + 1]!
    if (Math.abs(a.end - b.start) > 1e-6 || Math.abs(a.midi - b.midi) < 1) continue
    // Only a boundary in the middle of a move: where the voice sits on one of the notes (a
    // legato step, or wide vibrato that never settles within ON_NOTE) it is already right.
    const at = Math.round(b.start / framePeriod)
    const there = (midi[at - 1]! + midi[at]!) / 2
    if (
      !Number.isFinite(there) ||
      Math.min(Math.abs(there - a.midi), Math.abs(there - b.midi)) <= ON_NOTE
    )
      continue
    const first = Math.round(a.start / framePeriod)
    const last = Math.min(midi.length, Math.round(b.end / framePeriod))
    let arrival = -1
    for (let t = first; t + STEADY_FRAMES <= last; t++) {
      if (steady(t, b.midi, 1)) {
        arrival = t
        break
      }
    }
    if (arrival < 0) continue
    let departure = -1
    for (let t = arrival - 1; t - STEADY_FRAMES + 1 >= first; t--) {
      if (steady(t, a.midi, -1)) {
        departure = t
        break
      }
    }
    if (departure < 0 || !monotone(midi, departure, arrival, Math.sign(b.midi - a.midi))) continue
    a.end = (departure + 1) * framePeriod
    b.start = arrival * framePeriod
  }
  return out
}

/**
 * Whether the voice goes one way from frame `from` to `to`: a slide does, wide vibrato swings back
 * and forth. Most steps (80%) have to go `direction`.
 */
function monotone(midi: Float32Array, from: number, to: number, direction: number): boolean {
  let steps = 0
  let forward = 0
  for (let t = from + 1; t <= to; t++) {
    const step = midi[t]! - midi[t - 1]!
    if (!Number.isFinite(step)) continue
    steps++
    if (Math.sign(step) === direction) forward++
  }
  return steps === 0 || forward >= 0.8 * steps
}

/** Whether the voiced pitch at the note's two ends differs by a glide's worth. */
function travels(note: ContourNote, midi: Float32Array, framePeriod: number): boolean {
  const from = Math.round(note.start / framePeriod)
  const to = Math.min(midi.length, Math.round(note.end / framePeriod))
  const voiced: number[] = []
  for (let t = from; t < to; t++) if (Number.isFinite(midi[t]!)) voiced.push(midi[t]!)
  if (voiced.length < 4) return false
  const edge = Math.max(1, Math.floor(voiced.length / 4))
  const head = voiced.slice(0, edge).reduce((a, b) => a + b, 0) / edge
  const tail = voiced.slice(-edge).reduce((a, b) => a + b, 0) / edge
  return Math.abs(tail - head) >= GLIDE_TRAVEL
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000

/** Mono samples of a decoded recording: the channels averaged. */
export function monoOf(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i]! += data[i]! / buffer.numberOfChannels
  }
  return out
}

/** The part's span with a breath either side, seconds. */
export function spanOf(notes: readonly PartNote[]): { from: number; to: number } {
  return {
    from: Math.max(0, (notes[0]?.start ?? 0) - 0.6),
    to: (notes[notes.length - 1]?.end ?? 4) + 0.6,
  }
}

const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си']

/** «ля4»: the note's name and scientific octave. */
export function noteName(midi: number): string {
  const m = Math.round(midi)
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`
}

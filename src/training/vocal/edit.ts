import type { PartNote } from './part'

/**
 * The teacher's hand on the part: what the recognition got wrong is fixed note by note, the notes
 * are pulled onto a beat grid so the part can be played slower or faster as an exercise, and words
 * are laid under them syllable by syllable. Every edit takes the notes and returns new ones; the
 * page keeps the old arrays for undo.
 *
 * Notes stay in time order and never overlap: a note moves or stretches only as far as its
 * neighbours.
 */

/** A beat grid over the recording. */
export interface Grid {
  readonly bpm: number
  /** Seconds of the recording where beat 0 (a downbeat) falls. */
  readonly offset: number
  readonly beatsPerBar: number
}

/** A note shorter than this is not made by an edit, seconds. */
export const SHORTEST = 0.03

type Note = PartNote

const seconds = (bpm: number) => 60 / bpm

// ─── Note edits ───────────────────────────────────────────────────────────────────────────────

/** Moves note `i` up or down by `semitones`: its sung pitch and curve go with it. */
export function transpose(notes: readonly Note[], i: number, semitones: number): Note[] {
  return replace(notes, i, (note) => ({
    ...note,
    midi: note.midi + semitones,
    ...(note.pitch !== undefined ? { pitch: round(note.pitch + semitones, 100) } : {}),
  }))
}

/** Shifts note `i` in time by `dt` seconds, as far as its neighbours let it. */
export function move(notes: readonly Note[], i: number, dt: number): Note[] {
  const note = notes[i]
  if (!note) return [...notes]
  const lo = (notes[i - 1]?.end ?? 0) - (note.slideIn ?? note.start)
  const hi = (notes[i + 1]?.start ?? Infinity) - note.end
  const d = Math.min(hi, Math.max(lo, dt))
  return replace(notes, i, (n) => ({
    ...n,
    start: round(n.start + d),
    end: round(n.end + d),
    ...(n.slideIn !== undefined ? { slideIn: round(n.slideIn + d) } : {}),
  }))
}

/** Moves one edge of note `i` to `time`, between its neighbours and keeping it SHORTEST long. */
export function resize(
  notes: readonly Note[],
  i: number,
  edge: 'start' | 'end',
  time: number,
): Note[] {
  const note = notes[i]
  if (!note) return [...notes]
  if (edge === 'end') {
    const end = Math.min(notes[i + 1]?.start ?? Infinity, Math.max(note.start + SHORTEST, time))
    return replace(notes, i, (n) => ({ ...n, end: round(end) }))
  }
  const floor = Math.max(notes[i - 1]?.end ?? 0, note.slideIn ?? -Infinity)
  const start = Math.max(floor, Math.min(note.end - SHORTEST, time))
  const shift = note.start - start
  return replace(notes, i, (n) => ({
    ...n,
    start: round(start),
    // The curve is timed from the note's start: it stays where it was sung.
    ...(n.bend ? { bend: n.bend.map(([t, c]) => [round(t + shift), c] as const) } : {}),
  }))
}

/** Cuts note `i` in two at `time`. The words and the slide in stay with the first half. */
export function split(notes: readonly Note[], i: number, time: number): Note[] {
  const note = notes[i]
  if (!note || time - note.start < SHORTEST || note.end - time < SHORTEST) return [...notes]
  const offset = time - note.start
  const { slideIn: _slide, lyric: _lyric, ...rest } = note
  const first: Note = {
    ...note,
    end: round(time),
    ...(note.bend ? { bend: note.bend.filter(([t]) => t <= offset) } : {}),
  }
  const second: Note = {
    ...rest,
    start: round(time),
    ...(note.bend
      ? {
          bend: note.bend
            .filter(([t]) => t >= offset)
            .map(([t, c]) => [round(t - offset), c] as const),
        }
      : {}),
  }
  return [...notes.slice(0, i), first, second, ...notes.slice(i + 1)]
}

/**
 * Joins note `i` with the next one: the pitch of the longer, the words of the first, the curve of
 * both.
 */
export function join(notes: readonly Note[], i: number): Note[] {
  const a = notes[i]
  const b = notes[i + 1]
  if (!a || !b) return [...notes]
  const main = b.end - b.start > a.end - a.start ? b : a
  const curve = (n: Note) =>
    (n.bend ?? []).map(
      ([t, c]) =>
        [round(t + n.start - a.start), round(c + (n.midi - main.midi) * 100, 10)] as const,
    )
  const { slideIn: _slide, lyric: _lyric, bend: _bend, ...base } = main
  const joined: Note = {
    ...base,
    start: a.start,
    end: b.end,
    ...(a.slideIn !== undefined ? { slideIn: a.slideIn } : {}),
    ...(a.lyric !== undefined ? { lyric: a.lyric } : {}),
    ...(a.bend || b.bend ? { bend: [...curve(a), ...curve(b)] } : {}),
  }
  return [...notes.slice(0, i), joined, ...notes.slice(i + 2)]
}

export function remove(notes: readonly Note[], i: number): Note[] {
  return notes.filter((_, k) => k !== i)
}

/**
 * A new note of `midi` from `start` to `end`, cut to the room between its neighbours. Returns the
 * notes unchanged when there is no room.
 */
export function add(notes: readonly Note[], midi: number, start: number, end: number): Note[] {
  const at = notes.findIndex((n) => n.start > start)
  const i = at < 0 ? notes.length : at
  const from = Math.max(start, notes[i - 1]?.end ?? 0)
  const to = Math.min(end, notes[i]?.start ?? Infinity)
  if (to - from < SHORTEST) return [...notes]
  return [...notes.slice(0, i), { midi, start: round(from), end: round(to) }, ...notes.slice(i)]
}

export function setOrnament(notes: readonly Note[], i: number, ornament: boolean): Note[] {
  return replace(notes, i, (n) => {
    const { ornament: _o, ...rest } = n
    return ornament ? { ...rest, ornament: true } : rest
  })
}

export function setLyric(notes: readonly Note[], i: number, lyric: string): Note[] {
  return replace(notes, i, (n) => {
    const { lyric: _l, ...rest } = n
    const text = lyric.trim()
    return text ? { ...rest, lyric: text } : rest
  })
}

/** The note under `time`, or -1. */
export function noteAt(notes: readonly Note[], time: number): number {
  return notes.findIndex((n) => time >= n.start && time < n.end)
}

// ─── Groups and boundaries ────────────────────────────────────────────────────────────────────

/** Notes closer than this are touching: they share a boundary, seconds. */
const TOUCHING = 0.002

/** Moves the notes `picked` up or down by `semitones` together. */
export function transposeMany(
  notes: readonly Note[],
  picked: readonly number[],
  semitones: number,
): Note[] {
  return picked.reduce<Note[]>((out, i) => transpose(out, i, semitones), [...notes])
}

/**
 * Shifts the notes `picked` in time by `dt` together, as far as the notes not picked let them:
 * a run of picked neighbours moves as one block.
 */
export function moveMany(notes: readonly Note[], picked: readonly number[], dt: number): Note[] {
  const set = new Set(picked)
  let lo = -Infinity
  let hi = Infinity
  for (const i of set) {
    const note = notes[i]
    if (!note) continue
    if (!set.has(i - 1)) lo = Math.max(lo, (notes[i - 1]?.end ?? 0) - (note.slideIn ?? note.start))
    if (!set.has(i + 1)) hi = Math.min(hi, (notes[i + 1]?.start ?? Infinity) - note.end)
  }
  const d = Math.min(hi, Math.max(lo, dt))
  if (!Number.isFinite(d) || d === 0) return [...notes]
  return notes.map((n, i) =>
    set.has(i)
      ? {
          ...n,
          start: round(n.start + d),
          end: round(n.end + d),
          ...(n.slideIn !== undefined ? { slideIn: round(n.slideIn + d) } : {}),
        }
      : n,
  )
}

export function removeMany(notes: readonly Note[], picked: readonly number[]): Note[] {
  const set = new Set(picked)
  return notes.filter((_, i) => !set.has(i))
}

/** Joins the notes from `first` to `last` into one (as `join` does, pair by pair). */
export function joinRange(notes: readonly Note[], first: number, last: number): Note[] {
  let out = [...notes]
  for (let k = first; k < last; k++) out = join(out, first)
  return out
}

/** Whether notes `i` and `i + 1` touch: one boundary between them. */
export function touching(notes: readonly Note[], i: number): boolean {
  const a = notes[i]
  const b = notes[i + 1]
  return !!a && !!b && Math.abs(b.start - a.end) < TOUCHING
}

/**
 * Moves the end of note `i` to `time`. When the next note touches it, their shared boundary moves:
 * `ripple` false — both notes stretch (the next starts where this one ends); `ripple` true — only
 * this note stretches and everything after it moves by as much. A free end just stretches.
 */
export function moveBoundary(
  notes: readonly Note[],
  i: number,
  time: number,
  ripple = false,
): Note[] {
  const note = notes[i]
  if (!note) return [...notes]
  if (ripple) {
    const end = Math.max(note.start + SHORTEST, time)
    const d = end - note.end
    return notes.map((n, k) => {
      if (k < i) return n
      if (k === i) return { ...n, end: round(end) }
      return {
        ...n,
        start: round(n.start + d),
        end: round(n.end + d),
        ...(n.slideIn !== undefined ? { slideIn: round(n.slideIn + d) } : {}),
      }
    })
  }
  if (!touching(notes, i)) return resize(notes, i, 'end', time)
  const next = notes[i + 1]!
  const at = Math.min(next.end - SHORTEST, Math.max(note.start + SHORTEST, time))
  const shift = next.start - at
  return notes.map((n, k) => {
    if (k === i) return { ...n, end: round(at) }
    if (k !== i + 1) return n
    return {
      ...n,
      start: round(at),
      ...(n.bend ? { bend: n.bend.map(([t, c]) => [round(t + shift), c] as const) } : {}),
    }
  })
}

// ─── Words ────────────────────────────────────────────────────────────────────────────────────

/**
 * Syllables of a lyric: words split on spaces, syllables of a word on hyphens («ма-ма» → «ма-»,
 * «ма»: the hyphen stays on the syllable that the word goes on from). «_» holds the syllable
 * before over one more note.
 */
export function syllables(text: string): string[] {
  const out: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word === '_') {
      out.push('_')
      continue
    }
    const parts = word.split('-').filter(Boolean)
    parts.forEach((part, k) => out.push(k < parts.length - 1 ? `${part}-` : part))
  }
  return out
}

/**
 * Lays a lyric over the notes in order, a syllable to a note; ornaments get none (they ride on the
 * syllable before). Returns the notes and how many syllables were left with no note.
 */
export function assignLyrics(
  notes: readonly Note[],
  text: string,
): { notes: Note[]; left: number } {
  const queue = syllables(text)
  const out = notes.map((note) => {
    const { lyric: _l, ...rest } = note
    if (note.ornament) return rest
    const next = queue.shift()
    return next === undefined || next === '_' ? rest : { ...rest, lyric: next }
  })
  return { notes: out, left: queue.length }
}

/** The lyric as typed back: what `assignLyrics` would lay over the notes the same way. */
export function lyricsOf(notes: readonly Note[]): string {
  const sung = notes.filter((n) => !n.ornament)
  let last = -1
  sung.forEach((n, k) => {
    if (n.lyric) last = k
  })
  let text = ''
  for (let k = 0; k <= last; k++) {
    const piece = sung[k]!.lyric ?? '_'
    const glued = text.endsWith('-') && piece !== '_'
    text += (text && !glued ? ' ' : '') + piece
  }
  return text
}

// ─── Beat grid ────────────────────────────────────────────────────────────────────────────────

/** Tempi tried, BPM. */
const SLOWEST = 50
const FASTEST = 200
/** How far an onset may be from a grid line and still count as on it, seconds. */
const ONSET_SPREAD = 0.035
/** A tempo near this is preferred when the notes allow two: the singer's usual pace, BPM. */
const USUAL_BPM = 100

/**
 * The grid the notes were most likely sung to: the tempo whose beats and half-beats catch the most
 * note starts, from the first note on. A free-time recording still gets one — the teacher corrects
 * it by ear.
 */
export function estimateGrid(notes: readonly Note[], beatsPerBar = 4): Grid | null {
  const onsets = notes.filter((n) => !n.ornament).map((n) => n.start)
  if (onsets.length === 0) return null
  const offset = onsets[0]!
  if (onsets.length < 3) return { bpm: USUAL_BPM, offset: round(offset), beatsPerBar }
  let best = USUAL_BPM
  let bestScore = -Infinity
  for (let bpm = SLOWEST; bpm <= FASTEST; bpm += 0.5) {
    const beat = seconds(bpm)
    let score = 0
    for (const onset of onsets) {
      const beats = (onset - offset) / beat
      const onBeat = Math.abs(beats - Math.round(beats)) * beat
      const onHalf = Math.abs(beats * 2 - Math.round(beats * 2)) * (beat / 2)
      score += Math.max(near(onBeat), 0.5 * near(onHalf))
    }
    score = score / onsets.length - 0.15 * Math.log2(bpm / USUAL_BPM) ** 2
    if (score > bestScore) {
      bestScore = score
      best = bpm
    }
  }
  return { bpm: best, offset: round(offset), beatsPerBar }
}

const near = (distance: number) => Math.exp(-(distance * distance) / (2 * ONSET_SPREAD ** 2))

/** Seconds of the grid line nearest `time`, lines every `division` beats. */
export function snap(time: number, grid: Grid, division: number): number {
  const step = seconds(grid.bpm) * division
  return round(grid.offset + Math.round((time - grid.offset) / step) * step)
}

/** Seconds of beat `k` (bar `k / beatsPerBar`). */
export function beatTime(grid: Grid, k: number): number {
  return grid.offset + k * seconds(grid.bpm)
}

/**
 * Pulls every note onto the grid: starts and ends to the nearest line `division` beats apart (a
 * quarter is 1, an eighth 0.5), at least one line long. Ornaments keep their length and land just
 * before the note they lead to. Slides in move with their note.
 */
export function quantize(notes: readonly Note[], grid: Grid, division: number): Note[] {
  const step = seconds(grid.bpm) * division
  const out: Note[] = []
  // Notes first, then ornaments into the room before the note after them.
  const placed = notes.map((note) => {
    if (note.ornament) return null
    const start = snap(note.start, grid, division)
    return { start, end: Math.max(start + step, snap(note.end, grid, division)) }
  })
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!
    const previousEnd = out[out.length - 1]?.end ?? 0
    let start: number
    let end: number
    const spot = placed[i]
    if (spot) {
      start = Math.max(spot.start, previousEnd)
      end = Math.max(start + step, spot.end)
    } else {
      const next = placed.slice(i + 1).find(Boolean)
      const length = note.end - note.start
      end = next ? next.start : note.end
      start = end - length
      // The note before gives up its tail to make room.
      const before = out[out.length - 1]
      if (before && start < before.end) {
        const trimmed = Math.max(before.start + SHORTEST, start)
        out[out.length - 1] = { ...before, end: round(trimmed) }
        start = trimmed
      }
      if (end - start < SHORTEST) continue
    }
    const scale = (end - start) / Math.max(SHORTEST, note.end - note.start)
    const shift = start - note.start
    out.push({
      ...note,
      start: round(start),
      end: round(end),
      ...(note.slideIn !== undefined
        ? { slideIn: round(Math.max(previousEnd, note.slideIn + shift)) }
        : {}),
      ...(note.bend
        ? { bend: note.bend.map(([t, c]) => [round(t >= 0 ? t * scale : t), c] as const) }
        : {}),
    })
  }
  return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────

function replace(notes: readonly Note[], i: number, change: (note: Note) => Note): Note[] {
  return notes.map((note, k) => (k === i ? change(note) : note))
}

function round(value: number, scale = 1000): number {
  return Math.round(value * scale) / scale
}

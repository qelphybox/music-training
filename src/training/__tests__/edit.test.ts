import { describe, expect, it } from 'vitest'
import {
  add,
  assignLyrics,
  estimateGrid,
  join,
  joinRange,
  lyricsOf,
  move,
  moveBoundary,
  moveMany,
  removeMany,
  quantize,
  resize,
  split,
  syllables,
  transpose,
  transposeMany,
} from '@/training/vocal/edit'
import { stretch } from '@/training/vocal/stretch'
import type { PartNote } from '@/training/vocal/part'

const n = (midi: number, start: number, end: number, extra: Partial<PartNote> = {}): PartNote => ({
  midi,
  start,
  end,
  ...extra,
})

describe('note edits', () => {
  const part = [n(60, 0.5, 1.0), n(62, 1.2, 1.6, { pitch: 62.1 }), n(64, 1.8, 2.4)]

  it('moves a note only as far as its neighbours', () => {
    expect(move(part, 1, 1)[1]).toMatchObject({ start: 1.4, end: 1.8 })
    expect(move(part, 1, -1)[1]).toMatchObject({ start: 1.0, end: 1.4 })
  })

  it('transposes the sung pitch with the note', () => {
    expect(transpose(part, 1, 2)[1]).toMatchObject({ midi: 64, pitch: 64.1 })
  })

  it('stretches an edge up to the neighbour and keeps the curve where it was sung', () => {
    const curved = [n(60, 0.5, 1.0, { bend: [[0.1, 5]] }), n(62, 1.2, 1.6)]
    expect(resize(curved, 0, 'end', 2)[0]!.end).toBe(1.2)
    const earlier = resize(curved, 0, 'start', 0.3)[0]!
    expect(earlier.start).toBe(0.3)
    expect(earlier.bend![0]![0]).toBeCloseTo(0.3)
  })

  it('splits and joins back', () => {
    const cut = split(
      [
        n(60, 0, 1, {
          lyric: 'ля',
          bend: [
            [0, 1],
            [0.6, 2],
          ],
        }),
      ],
      0,
      0.5,
    )
    expect(cut.map((x) => [x.start, x.end, x.lyric])).toEqual([
      [0, 0.5, 'ля'],
      [0.5, 1, undefined],
    ])
    expect(cut[1]!.bend).toEqual([[0.1, 2]])
    const whole = join(cut, 0)
    expect(whole).toHaveLength(1)
    expect(whole[0]).toMatchObject({ start: 0, end: 1, lyric: 'ля' })
  })

  it('adds a note only where there is room', () => {
    expect(add(part, 65, 1.0, 1.2)).toHaveLength(4)
    expect(add(part, 65, 0.6, 0.9)).toHaveLength(3)
  })
})

describe('words', () => {
  it('splits syllables on hyphens and keeps holds', () => {
    expect(syllables('ма-ма мы-ла _ ра-му')).toEqual(['ма-', 'ма', 'мы-', 'ла', '_', 'ра-', 'му'])
  })

  it('lays syllables on notes, skipping ornaments, and reads them back', () => {
    const notes = [
      n(60, 0, 1),
      n(62, 1, 1.05, { ornament: true }),
      n(64, 1.1, 2),
      n(65, 2, 3),
      n(67, 3, 4),
    ]
    const { notes: sung, left } = assignLyrics(notes, 'ма-ма _ мы')
    expect(sung.map((x) => x.lyric)).toEqual(['ма-', undefined, 'ма', undefined, 'мы'])
    expect(left).toBe(0)
    expect(lyricsOf(sung)).toBe('ма-ма _ мы')
    expect(assignLyrics(notes, 'раз два три четыре пять').left).toBe(1)
  })
})

describe('beat grid', () => {
  // Quarters and eighths at 96 BPM, sung a little loose.
  const beat = 60 / 96
  const starts = [0, 1, 2, 2.5, 3, 4, 5, 5.5, 6, 7].map(
    (b, k) => 0.8 + b * beat + (k % 2 ? 0.012 : -0.01),
  )
  const notes = starts.map((s, k) => n(60 + (k % 5), s, (starts[k + 1] ?? s + beat) - 0.03))

  it('finds the tempo the notes were sung to', () => {
    const grid = estimateGrid(notes)!
    expect(grid.bpm).toBeGreaterThan(94)
    expect(grid.bpm).toBeLessThan(98)
    expect(grid.offset).toBeCloseTo(0.79, 2)
  })

  it('pulls the notes onto the grid', () => {
    const grid = { bpm: 96, offset: 0.8, beatsPerBar: 4 }
    const on = quantize(notes, grid, 0.5)
    on.forEach((note, k) => {
      const beats = (note.start - grid.offset) / beat
      // On an eighth, to the millisecond the part is kept in.
      expect(Math.abs(beats * 2 - Math.round(beats * 2)) * (beat / 2)).toBeLessThanOrEqual(0.0011)
      if (k > 0) expect(note.start).toBeGreaterThanOrEqual(on[k - 1]!.end)
    })
  })

  it('puts an ornament right before the note it leads to', () => {
    const grid = { bpm: 120, offset: 0, beatsPerBar: 4 }
    const on = quantize(
      [n(60, 0.02, 0.45), n(67, 0.46, 0.5, { ornament: true }), n(64, 0.52, 0.98)],
      grid,
      0.5,
    )
    expect(on[2]!.start).toBe(0.5)
    expect(on[1]!.end).toBe(0.5)
    expect(on[1]!.end - on[1]!.start).toBeCloseTo(0.04)
  })
})

describe('time stretch', () => {
  const rate = 48000
  const tone = Float32Array.from({ length: rate }, (_, i) =>
    Math.sin((2 * Math.PI * 220 * i) / rate),
  )
  const crossings = (x: Float32Array) => {
    let count = 0
    for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) count++
    return count
  }

  for (const speed of [0.5, 0.75, 1.5]) {
    it(`plays ${speed}× as fast at the same pitch`, () => {
      const out = stretch(tone, rate, speed)
      expect(out.length / rate).toBeCloseTo(1 / speed, 2)
      // Pitch from zero crossings over the middle, away from the fades at the ends.
      const middle = out.subarray(Math.round(0.1 * rate), out.length - Math.round(0.1 * rate))
      expect(crossings(middle) / (middle.length / rate)).toBeCloseTo(220, -0.5)
    })
  }
})

describe('groups and boundaries', () => {
  // 60 and 62 touch; 64 stands apart.
  const part = [n(60, 0.5, 1.0), n(62, 1.0, 1.5), n(64, 1.8, 2.4)]

  it('moves a picked run as one block, stopped by the notes not picked', () => {
    const later = moveMany(part, [0, 1], 1)
    expect(later.map((x) => [x.start, x.end])).toEqual([
      [0.8, 1.3],
      [1.3, 1.8],
      [1.8, 2.4],
    ])
  })

  it('transposes and removes a group', () => {
    expect(transposeMany(part, [0, 2], -2).map((x) => x.midi)).toEqual([58, 62, 62])
    expect(removeMany(part, [0, 2]).map((x) => x.midi)).toEqual([62])
  })

  it('moves a shared boundary: both notes, or the rest of the part along', () => {
    const both = moveBoundary(part, 0, 1.2)
    expect(both.map((x) => [x.start, x.end])).toEqual([
      [0.5, 1.2],
      [1.2, 1.5],
      [1.8, 2.4],
    ])
    const ripple = moveBoundary(part, 0, 1.2, true)
    expect(ripple.map((x) => [x.start, x.end])).toEqual([
      [0.5, 1.2],
      [1.2, 1.7],
      [2, 2.6],
    ])
    // A free end only stretches up to the next note.
    expect(moveBoundary(part, 1, 2)[1]!.end).toBe(1.8)
  })

  it('joins a run of notes', () => {
    expect(joinRange(part, 0, 2)).toHaveLength(1)
  })
})

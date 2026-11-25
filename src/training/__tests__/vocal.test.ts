import { describe, expect, it } from 'vitest'
import { noteSequence, seq, TEST_SAMPLE_RATE } from '@audio-core/core/testing/signals'
import { transcribe, type PartNote } from '@/training/vocal/part'
import { review, type Take } from '@/training/vocal/review'

const PART: PartNote[] = [
  { midi: 60, start: 0.5, end: 1.0 },
  { midi: 62, start: 1.0, end: 1.5 },
  { midi: 64, start: 1.7, end: 2.2 },
  { midi: 65, start: 2.2, end: 3.2 },
]

/** A take at 100 frames/s: each [midi, seconds], NaN for silence. */
function take(events: readonly (readonly [number, number])[], start = 0): Take {
  const midi: number[] = []
  for (const [value, seconds] of events) {
    for (let k = 0; k < Math.round(seconds * 100); k++) midi.push(value)
  }
  return { midi, frameRate: 100, start }
}

describe('review', () => {
  it('finds the notes by order when the take is slower and starts later', () => {
    const result = review(
      PART,
      take(
        [
          [NaN, 1],
          [60, 0.8],
          [62, 0.8],
          [NaN, 0.4],
          [64.3, 0.8],
          [65, 1.5],
        ],
        3,
      ),
    )
    expect(result.notes.map((n) => n.cents)).toEqual([0, 0, 30, 0])
    expect(result.scores).toEqual({ 15: 75, 7: 75, 2: 75 })
  })

  it('tells the three tolerance levels apart', () => {
    const result = review(
      PART,
      take([
        [60.01, 0.5],
        [62.05, 0.5],
        [64.12, 0.5],
        [65.2, 1],
      ]),
    )
    expect(result.notes.map((n) => n.cents)).toEqual([1, 5, 12, 20])
    expect(result.scores).toEqual({ 15: 75, 7: 50, 2: 25 })
  })

  it('finds the centre of a note sung with vibrato', () => {
    // 5–6 Hz, ±70 ¢, sung slower than the part, notes off by known amounts.
    const offsets = [0, 0, 10, -25]
    const lengths = [0.9, 0.95, 1.1, 1.3]
    const midi: number[] = []
    PART.forEach((note, i) => {
      const rate = 5 + i * 0.4
      for (let k = 0; k < lengths[i]! * 100; k++) {
        midi.push(note.midi + offsets[i]! / 100 + 0.7 * Math.sin((2 * Math.PI * rate * k) / 100))
      }
      for (let k = 0; k < 15; k++) midi.push(NaN)
    })
    const result = review(PART, { midi, frameRate: 100, start: 0 })
    result.notes.forEach((n, i) => expect(Math.abs(n.cents! - offsets[i]!)).toBeLessThanOrEqual(3))
  })

  it('keeps a legato neighbour out of a vibrato note', () => {
    // ми straight into ре with no gap: the alignment may hand ре a few of ми's frames.
    const part: PartNote[] = [
      { midi: 64, start: 0, end: 1 },
      { midi: 62, start: 1, end: 1.6 },
    ]
    const midi: number[] = []
    for (let k = 0; k < 120; k++) midi.push(64.1 + 0.7 * Math.sin((2 * Math.PI * 5 * k) / 100))
    for (let k = 0; k < 80; k++) midi.push(61.75 + 0.7 * Math.sin((2 * Math.PI * 5 * k) / 100))
    const result = review(part, { midi, frameRate: 100, start: 0 })
    expect(Math.abs(result.notes[0]!.cents! - 10)).toBeLessThanOrEqual(3)
    expect(Math.abs(result.notes[1]!.cents! + 25)).toBeLessThanOrEqual(3)
  })

  it('counts an octave away as a miss', () => {
    const result = review(PART, take(PART.map((n) => [n.midi + 12, n.end - n.start] as const)))
    for (const note of result.notes) expect(note.cents).toBe(1200)
    expect(result.scores[15]).toBe(0)
  })

  it('reports a skipped note as not sung', () => {
    const result = review(
      PART,
      take([
        [60, 0.5],
        [64, 0.5],
        [65, 1],
      ]),
    )
    expect(result.notes[1]!.cents).toBeNull()
    expect(result.notes[0]!.cents).toBe(0)
    expect(result.notes[3]!.cents).toBe(0)
  })

  it('hears nothing in silence', () => {
    const result = review(PART, take([[NaN, 2]]))
    expect(result.heard).toBe(false)
    expect(result.notes.every((n) => n.cents === null)).toBe(true)
  })
})

describe('transcribe', () => {
  it('turns a sung phrase into its notes in seconds', () => {
    const signal = noteSequence([
      seq.pause(0.5),
      seq.note(57, 0.6),
      seq.note(60, 0.6),
      seq.pause(0.3),
      seq.note(64, 1),
      seq.pause(0.5),
    ])
    const { notes, contour } = transcribe(signal.samples, TEST_SAMPLE_RATE)
    expect(notes.map((n) => n.midi)).toEqual([57, 60, 64])
    const expected = [
      [0.5, 1.1],
      [1.1, 1.7],
      [2.0, 3.0],
    ]
    notes.forEach((note, i) => {
      expect(Math.abs(note.start - expected[i]![0]!)).toBeLessThan(0.08)
      expect(Math.abs(note.end - expected[i]![1]!)).toBeLessThan(0.12)
    })
    expect(contour.midi.length).toBeGreaterThan(100)
  })

  it('and a student singing it back reviews clean', () => {
    const signal = noteSequence([seq.note(57, 0.6), seq.note(60, 0.6), seq.note(64, 1)])
    const part = transcribe(signal.samples, TEST_SAMPLE_RATE).notes
    const sung = transcribe(
      noteSequence([seq.pause(1), seq.note(57, 0.9), seq.note(60, 0.5), seq.note(64, 1.4)]).samples,
      TEST_SAMPLE_RATE,
    ).contour
    expect(part.map((n) => n.midi)).toEqual([57, 60, 64])
    const result = review(part, sung)
    for (const note of result.notes) expect(Math.abs(note.cents!)).toBeLessThan(5)
    expect(result.scores[15]).toBe(100)
  })
})

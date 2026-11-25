import { describe, expect, it } from 'vitest'
import { FRAME, findScale, melismaNotes, type MelismaNote } from '@/training/vocal/melisma'

// The MELISMA reading on contours drawn by hand: no model, frame by frame.

const HOP = 0.016

/** A contour from pieces of [cents at start, cents at end, seconds]; NaN cents is silence. */
function contour(pieces: readonly (readonly [number, number, number])[]) {
  const cents: number[] = []
  for (const [from, to, seconds] of pieces) {
    const n = Math.round(seconds / HOP)
    for (let k = 0; k < n; k++) cents.push(from + ((to - from) * k) / Math.max(1, n - 1))
  }
  return {
    pitchHz: cents.map((c) => (Number.isFinite(c) ? 440 * 2 ** ((c - 6900) / 1200) : 0)),
    confidence: cents.map((c) => (Number.isFinite(c) ? 0.95 : 0)),
    loudnessDb: cents.map((c) => (Number.isFinite(c) ? -20 : -90)),
  }
}

const hold = (cents: number, seconds: number) => [cents, cents, seconds] as const
const silence = (seconds: number) => [NaN, NaN, seconds] as const

describe('MELISMA reading', () => {
  it('labels holds, slides and silence', () => {
    const frames = contour([
      silence(0.2),
      hold(6000, 0.5),
      [6000, 6700, 0.4],
      hold(6700, 0.5),
      silence(0.2),
    ])
    const { notes, classes } = melismaNotes(frames, HOP)
    expect(notes.map((n) => Math.round(n.cents / 100))).toEqual([60, 67])
    expect(notes[1]!.slideIn).not.toBeNull()
    const at = (seconds: number) => classes[Math.round(seconds / HOP)]
    expect(at(0.1)).toBe(FRAME.SILENCE)
    expect(at(0.45)).toBe(FRAME.NOTE)
    expect(at(0.9)).toBe(FRAME.SLIDE)
    expect(at(1.3)).toBe(FRAME.NOTE)
  })

  it('merges a short step into its neighbour but keeps the top of a leap', () => {
    // 40 ms 60 ¢ under 62: too short, and too close to it to be an ornament: part of the 62.
    const step = melismaNotes(contour([hold(6000, 0.4), hold(6140, 0.04), hold(6200, 0.4)]), HOP)
    expect(step.notes.map((n) => Math.round(n.cents / 100))).toEqual([60, 62])
    // 40 ms a sixth above both: kept (MELISMA's leap rule), whatever ORNAMENTS says.
    const peak = melismaNotes(contour([hold(6000, 0.4), hold(6900, 0.04), hold(6200, 0.4)]), HOP, {
      ornaments: false,
    })
    expect(peak.notes.map((n) => Math.round(n.cents / 100))).toEqual([60, 69, 62])
  })

  it('finds the singer’s A4 and a step off the semitone grid', () => {
    const note = (cents: number, start: number): MelismaNote => ({
      start,
      end: start + 0.5,
      cents,
      ornament: false,
      slideIn: null,
      vibrato: null,
      curve: [],
    })
    // Sung 20 ¢ sharp: A4 ≈ 445 Hz; every step on the (shifted) grid.
    const sharp = findScale([6020, 6220, 6420, 6520, 6720].map((c, i) => note(c, i)))
    expect(Math.abs(sharp.tuning - 20)).toBeLessThanOrEqual(1)
    expect(sharp.a4).toBeCloseTo(445.1, 0)
    expect(sharp.microtonal).toBe(false)
    // A neutral third (350 ¢ above C) is a step of its own and marks the mode microtonal.
    const neutral = findScale([6000, 6200, 6350, 6500, 6700, 6000, 6200].map((c, i) => note(c, i)))
    expect(neutral.degrees).toContain(350)
    expect(neutral.microtonal).toBe(true)
  })
})

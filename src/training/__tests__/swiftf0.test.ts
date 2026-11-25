import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  mix,
  noteSequence,
  seq,
  whiteNoise,
  type SequenceEventSpec,
} from '@audio-core/core/testing/signals'
import { detectFrames, FMAX, FMIN, FRAME_PERIOD, SAMPLE_RATE } from '@/lib/swiftf0/frames'
import {
  transcribe,
  transcribeFrames,
  transcribeMelisma,
  type PartNote,
} from '@/training/vocal/part'
import { detectOnsets } from '@/training/vocal/onsets'

// SwiftF0 against pYIN on synthesised singing. The real model runs here through onnxruntime-web's
// wasm build, the same runtime the browser uses.

let session: ort.InferenceSession
beforeAll(async () => {
  ort.env.wasm.numThreads = 1
  session = await ort.InferenceSession.create(
    new Uint8Array(readFileSync('src/lib/swiftf0/model.onnx')),
  )
}, 60_000)

/** Room noise under the voice, so silence is not digital zero. */
function withNoise(samples: Float32Array, rate: number): Float32Array {
  return mix(
    samples,
    whiteNoise({ seconds: samples.length / rate, amplitude: 0.003, sampleRate: rate }),
  )
}

async function swift(
  specs: readonly SequenceEventSpec[],
  pitchHoldMs = 80,
): Promise<{ changepoint: PartNote[]; melisma: PartNote[] }> {
  const samples = withNoise(noteSequence(specs, { sampleRate: SAMPLE_RATE }).samples, SAMPLE_RATE)
  const frames = await detectFrames(samples, async (audio) => {
    const out = await session.run({
      audio: new ort.Tensor('float32', audio, [1, audio.length]),
      fmin: new ort.Tensor('float32', Float32Array.of(FMIN), []),
      fmax: new ort.Tensor('float32', Float32Array.of(FMAX), []),
    })
    return {
      pitch: Float32Array.from(out.pitch!.data as Float32Array),
      confidence: Float32Array.from(out.confidence!.data as Float32Array),
    }
  })
  return {
    changepoint: transcribeFrames(frames, FRAME_PERIOD, 0.5, pitchHoldMs).notes,
    melisma: transcribeMelisma(frames, FRAME_PERIOD, {}, detectOnsets(samples, SAMPLE_RATE)).notes,
  }
}

function pyin(specs: readonly SequenceEventSpec[]): PartNote[] {
  const samples = withNoise(noteSequence(specs, { sampleRate: 48000 }).samples, 48000)
  return transcribe(samples, 48000).notes
}

/** The notes a phrase should give: its note events (a slide belongs to neither side). */
function truth(specs: readonly SequenceEventSpec[]): PartNote[] {
  const out: PartNote[] = []
  let at = 0
  for (const spec of specs) {
    if (spec.kind === 'note') out.push({ midi: spec.midi, start: at, end: at + spec.seconds })
    at += spec.seconds
  }
  return out
}

/**
 * Note F-measure in the COnP sense: a note is found when one transcribed note has its pitch and an
 * onset within `onsetTolerance` seconds. Each transcribed note matches at most once.
 */
function fMeasure(expected: readonly PartNote[], got: readonly PartNote[], onsetTolerance = 0.1) {
  const used = new Set<number>()
  let hits = 0
  for (const note of expected) {
    const match = got.findIndex(
      (g, i) =>
        !used.has(i) && g.midi === note.midi && Math.abs(g.start - note.start) <= onsetTolerance,
    )
    if (match >= 0) {
      used.add(match)
      hits++
    }
  }
  const precision = got.length ? hits / got.length : 0
  const recall = expected.length ? hits / expected.length : 0
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0
}

const VIBRATO = { rate: 5.5, extentCents: 60 }
const FAST = new Set(['melisma, 100 ms a note'])
const CASES: Record<string, SequenceEventSpec[]> = {
  'legato and pauses': [
    seq.pause(0.4),
    seq.note(57, 0.6),
    seq.note(60, 0.6),
    seq.pause(0.3),
    seq.note(64, 0.8),
    seq.note(62, 0.5),
    seq.pause(0.4),
  ],
  'vibrato ±60 ¢': [
    seq.pause(0.4),
    seq.note(60, 1.2, VIBRATO),
    seq.note(64, 1.2, VIBRATO),
    seq.pause(0.3),
    seq.note(67, 1.5, VIBRATO),
    seq.pause(0.4),
  ],
  'slides between notes': [
    seq.pause(0.4),
    seq.note(60, 0.6),
    seq.slide(60, 65, 0.25),
    seq.note(65, 0.7),
    seq.slide(65, 62, 0.2),
    seq.note(62, 0.8),
    seq.pause(0.4),
  ],
  'fast run, 150 ms a note': [
    seq.pause(0.4),
    ...[60, 62, 64, 65, 67, 65, 64, 62].map((m) => seq.note(m, 0.15)),
    seq.note(60, 0.6),
    seq.pause(0.4),
  ],
  'wide vibrato ±100 ¢': [
    seq.pause(0.4),
    seq.note(62, 1.0, { rate: 6, extentCents: 100 }),
    seq.note(65, 1.0, { rate: 6, extentCents: 100 }),
    seq.note(69, 1.4, { rate: 6, extentCents: 100 }),
    seq.pause(0.4),
  ],
  'melisma, 100 ms a note': [
    seq.pause(0.4),
    seq.note(64, 0.4),
    ...[65, 64, 62, 64].map((m) => seq.note(m, 0.1)),
    seq.note(62, 0.6),
    seq.pause(0.4),
  ],
  'slow portamento, 0.6 s': [
    seq.pause(0.4),
    seq.note(60, 0.6),
    seq.slide(60, 67, 0.6),
    seq.note(67, 0.7),
    seq.slide(67, 62, 0.5),
    seq.note(62, 0.7),
    seq.pause(0.4),
  ],
  'grace notes on leaps, 45 ms': [
    seq.pause(0.4),
    seq.note(62, 0.5),
    seq.note(67, 0.045),
    seq.note(64, 0.5),
    seq.note(60, 0.045),
    seq.note(65, 0.6),
    seq.pause(0.4),
  ],
  'slow wide vibrato, 4.5 Hz ±80 ¢': [
    seq.pause(0.4),
    seq.note(64, 1.2, { rate: 4.5, extentCents: 80 }),
    seq.note(62, 1.2, { rate: 4.5, extentCents: 80 }),
    seq.note(60, 1.6, { rate: 4.5, extentCents: 80 }),
    seq.pause(0.4),
  ],
  'phrase: vibrato, slide, grace note, semitone run': [
    seq.pause(0.5),
    seq.note(62, 0.8, VIBRATO),
    seq.slide(62, 67, 0.3),
    seq.note(67, 0.9, VIBRATO),
    seq.note(71, 0.045),
    seq.note(69, 0.5),
    ...[67, 65, 64, 65].map((m) => seq.note(m, 0.1)),
    seq.note(64, 0.6),
    seq.pause(0.3),
    seq.note(60, 0.5),
    seq.slide(60, 67, 0.6),
    seq.note(67, 1.2, { rate: 5, extentCents: 70 }),
    seq.pause(0.5),
  ],
  'vibrato into a plain step': [
    seq.pause(0.5),
    seq.note(62, 0.8, VIBRATO),
    seq.slide(62, 67, 0.3),
    seq.note(67, 0.9, VIBRATO),
    seq.note(69, 0.5),
    ...[67, 65, 64, 65].map((m) => seq.note(m, 0.1)),
    seq.note(64, 0.6),
    seq.pause(0.4),
  ],
  'repeated note after a short gap': [
    seq.pause(0.4),
    seq.note(62, 0.5),
    seq.pause(0.12),
    seq.note(62, 0.5),
    seq.note(64, 0.6),
    seq.pause(0.4),
  ],
}

describe('SwiftF0 transcription', () => {
  const results: string[] = []

  for (const [name, specs] of Object.entries(CASES)) {
    it(`reads ${name}`, async () => {
      const expected = truth(specs)
      // Melismas need the teacher's «быстрые ноты»: a shorter hold before a new note counts.
      const { changepoint: ours, melisma } = await swift(specs, FAST.has(name) ? 40 : 80)
      const old = pyin(specs)
      const swiftF = fMeasure(expected, ours)
      const pyinF = fMeasure(expected, old)
      // MELISMA's reading needs no «быстрые ноты»: its ornament threshold is the same everywhere.
      const melismaF = fMeasure(expected, melisma)
      results.push(
        `${name.padEnd(32)} MELISMA ${melismaF.toFixed(2)} (${melisma.length} нот)   SwiftF0 ${swiftF.toFixed(2)} (${ours.length} нот)   pYIN ${pyinF.toFixed(2)} (${old.length} нот)   надо ${expected.length}`,
      )
      expect(melismaF).toBeGreaterThanOrEqual(Math.max(swiftF, pyinF))
    }, 60_000)
  }

  it('prints the comparison', () => {
    process.stderr.write(`\n${results.join('\n')}\n`)
  })
})

describe('MELISMA reading on SwiftF0', () => {
  const read = async (name: string) => (await swift(CASES[name]!)).melisma

  it('keeps the slide between notes as the way into the next', async () => {
    const notes = await read('slides between notes')
    expect(notes.map((n) => n.midi)).toEqual([60, 65, 62])
    // The slides last 0.25 s and 0.2 s; the notes begin where the voice arrives.
    expect(notes[1]!.slideIn).toBeDefined()
    expect(notes[1]!.start - notes[1]!.slideIn!).toBeGreaterThan(0.12)
    expect(notes[1]!.start).toBeCloseTo(1.25, 1)
    expect(notes[2]!.slideIn).toBeDefined()
  }, 60_000)

  it('measures vibrato inside its note', async () => {
    const notes = await read('vibrato ±60 ¢')
    for (const note of notes) {
      expect(note.vibrato?.rate).toBeCloseTo(5.5, 0)
      // ±60 ¢ is 120 ¢ peak to peak.
      expect(note.vibrato!.extent).toBeGreaterThan(90)
      expect(note.vibrato!.extent).toBeLessThan(150)
      expect(Math.abs(note.pitch! - note.midi)).toBeLessThan(0.1)
    }
  }, 60_000)

  it('keeps a grace note on a leap as an ornament', async () => {
    const notes = await read('grace notes on leaps, 45 ms')
    const grace = notes.find((n) => n.midi === 67)
    expect(grace?.ornament).toBe(true)
    expect(notes.filter((n) => !n.ornament).map((n) => n.midi)).toEqual([62, 64, 65])
  }, 60_000)
})

describe('MELISMA reading on a recording made outside the test signals', () => {
  // The phrase the deployed page was checked with: each note's vibrato starts at its own onset,
  // so the 67 ends mid-swing straight into a plain 69, with no frame of slide between them.
  function phrase(rate: number): Float32Array {
    type Seg =
      [midi: number | null, seconds: number, vibrato?: boolean] | ['slide', number, number, number]
    const segs: Seg[] = [
      [null, 0.5],
      [62, 0.8, true],
      ['slide', 62, 67, 0.3],
      [67, 0.9, true],
      [69, 0.5],
      [67, 0.1],
      [65, 0.1],
      [64, 0.1],
      [65, 0.1],
      [64, 0.6],
      [null, 0.4],
    ]
    const seconds = (s: Seg) => (s[0] === 'slide' ? s[3] : s[1])
    const out = new Float32Array(Math.round(segs.reduce((sum, s) => sum + seconds(s), 0) * rate))
    let i = 0
    let phase = 0
    let seed = 7
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.006
    for (const s of segs) {
      const length = Math.round(seconds(s) * rate)
      for (let k = 0; k < length && i < out.length; k++, i++) {
        if (s[0] === null) {
          out[i] = noise()
          continue
        }
        const midi =
          s[0] === 'slide'
            ? s[1] + ((s[2] - s[1]) * k) / length
            : s[0] + (s[2] ? 0.6 * Math.sin((2 * Math.PI * 5.5 * k) / rate) : 0)
        phase += (2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / rate
        out[i] =
          0.25 * Math.sin(phase) + 0.12 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase) + noise()
      }
    }
    return out
  }

  it('cuts a vibrato note running straight into a plain one', async () => {
    const samples = phrase(SAMPLE_RATE)
    const frames = await detectFrames(samples, async (audio) => {
      const out = await session.run({
        audio: new ort.Tensor('float32', audio, [1, audio.length]),
        fmin: new ort.Tensor('float32', Float32Array.of(FMIN), []),
        fmax: new ort.Tensor('float32', Float32Array.of(FMAX), []),
      })
      return {
        pitch: Float32Array.from(out.pitch!.data as Float32Array),
        confidence: Float32Array.from(out.confidence!.data as Float32Array),
      }
    })
    const { notes } = transcribeMelisma(
      frames,
      FRAME_PERIOD,
      {},
      detectOnsets(samples, SAMPLE_RATE),
    )
    expect(notes.map((n) => n.midi)).toEqual([62, 67, 69, 67, 65, 64, 65, 64])
  }, 60_000)
})

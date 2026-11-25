import type { TakeSource } from '@/components/pitch/inkTake'
import type { PitchTrace } from '@/components/pitch/trace'
import type { Contour } from '@/training/vocal/part'

/** A finished contour as the ink sheet reads it. */
export function contourSource(contour: Contour): TakeSource {
  return {
    length: () => contour.midi.length,
    frameRate: () => contour.frameRate,
    timeOf: (index) => contour.start + index / contour.frameRate,
    read(begin, end, midi, level) {
      midi.set(contour.midi.subarray(begin, end))
      level.set(contour.level.subarray(begin, end))
    },
  }
}

/**
 * The microphone's frames gathered as they come, for as long as a take lasts. `shift` moves the
 * trace clock onto the part's: set it when the take starts.
 */
export class LiveTake implements TakeSource {
  private readonly midi: number[] = []
  private readonly level: number[] = []
  private first = 0
  private rate = 50
  private last = -Infinity
  /** Seconds added to trace-clock times to get the part's. */
  shift = 0

  clear(): void {
    this.midi.length = 0
    this.level.length = 0
    this.last = -Infinity
  }

  /** Appends the trace's frames not seen yet. Returns the trace-clock time of the newest. */
  push(trace: PitchTrace): number {
    const rate = trace.frameRate
    for (let k = 0; k < trace.length; k++) {
      const time = trace.endTime - (trace.length - 1 - k) / rate
      if (time <= this.last + 0.5 / rate) continue
      if (this.midi.length === 0) {
        this.first = time
        this.rate = rate
      }
      this.midi.push(trace.midi[k] ?? NaN)
      this.level.push(trace.level[k] ?? 0)
      this.last = time
    }
    return this.last
  }

  length(): number {
    return this.midi.length
  }
  frameRate(): number {
    return this.rate
  }
  timeOf(index: number): number {
    return this.first + index / this.rate + this.shift
  }
  read(begin: number, end: number, midi: Float32Array, level: Float32Array): void {
    for (let i = begin; i < end; i++) {
      midi[i - begin] = this.midi[i] ?? NaN
      level[i - begin] = this.level[i] ?? 0
    }
  }

  /** Trace-clock seconds of the first and last frame, or null before any. */
  traceSpan(): { from: number; to: number } | null {
    if (this.midi.length === 0) return null
    return { from: this.first, to: this.first + (this.midi.length - 1) / this.rate }
  }

  /** The take so far as a contour on the part's clock. */
  contour(): Contour {
    return {
      midi: Float32Array.from(this.midi),
      level: Float32Array.from(this.level),
      frameRate: this.rate,
      start: this.first + this.shift,
    }
  }
}

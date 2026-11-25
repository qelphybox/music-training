import { onScopeDispose, ref } from 'vue'
import type { PartNote } from '@/training/vocal/part'

/** What plays the part: the teacher's recording or its notes by synthesis. */
export type PartSound = 'recording' | 'notes'

/**
 * Plays a vocal training's part on one AudioContext and keeps `now` — seconds of the recording —
 * running while it plays, for the sheet to drift by. Start it from a tap: phones keep audio off
 * until one.
 */
export function useVocalPlayback() {
  const playing = ref(false)
  const now = ref(0)
  let context: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let stopAll: (() => void) | null = null
  let raf = 0

  function audio(): AudioContext {
    context ??= new AudioContext()
    return context
  }

  /** Decodes the recording once; later plays reuse it. */
  async function load(recording: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const bytes = recording instanceof Blob ? await recording.arrayBuffer() : recording
    buffer = await audio().decodeAudioData(bytes)
    return buffer
  }

  /**
   * Plays from `from` to `to` (seconds of the recording); resolves when it ends or is stopped.
   * `onTick` runs every animation frame with the moment playing.
   */
  function play(
    sound: PartSound,
    notes: readonly PartNote[],
    from: number,
    to: number,
    onTick?: (seconds: number) => void,
  ): Promise<void> {
    stop()
    const ctx = audio()
    void ctx.resume()
    const t0 = ctx.currentTime + 0.1
    const nodes: AudioScheduledSourceNode[] = []
    if (sound === 'recording' && buffer) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(t0, from, Math.max(0, to - from))
      nodes.push(source)
    } else {
      for (const note of notes) {
        if (note.end <= from || note.start >= to) continue
        nodes.push(...synthNote(ctx, note, t0 - from))
      }
    }
    playing.value = true
    return new Promise((resolve) => {
      const finish = () => {
        cancelAnimationFrame(raf)
        for (const node of nodes) {
          try {
            node.stop()
          } catch {
            // already stopped
          }
        }
        stopAll = null
        playing.value = false
        resolve()
      }
      stopAll = finish
      const tick = () => {
        const at = from + Math.max(0, ctx.currentTime - t0)
        now.value = at
        onTick?.(at)
        if (at >= to) finish()
        else raf = requestAnimationFrame(tick)
      }
      tick()
    })
  }

  function stop(): void {
    stopAll?.()
  }

  onScopeDispose(() => {
    stop()
    void context?.close()
  })

  return { playing, now, load, play, stop }
}

/**
 * A soft two-oscillator voice for one note, `shift` seconds from the part's clock to the context's.
 * A note with a bend sings it — the slide into the note, its vibrato, its pitch as sung — the way
 * a synth plays MIDI pitch bend; a note without one holds its tempered pitch.
 */
function synthNote(ctx: AudioContext, note: PartNote, shift: number): AudioScheduledSourceNode[] {
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
  const begin = (note.slideIn ?? note.start) + shift
  const start = Math.max(ctx.currentTime, begin)
  const hold = Math.max(start + 0.02, note.end + shift)
  return (
    [
      ['triangle', 0.35],
      ['sine', 0.25],
    ] as const
  ).map(([type, peak]) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    const bend = note.bend ?? []
    osc.frequency.setValueAtTime(hz(note.midi + (bend[0]?.[1] ?? 0) / 100), start)
    for (const [t, cents] of bend) {
      const at = note.start + t + shift
      if (at > start) osc.frequency.linearRampToValueAtTime(hz(note.midi + cents / 100), at)
    }
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.02)
    gain.gain.setValueAtTime(peak, hold)
    gain.gain.linearRampToValueAtTime(0, hold + 0.06)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(hold + 0.08)
    return osc
  })
}

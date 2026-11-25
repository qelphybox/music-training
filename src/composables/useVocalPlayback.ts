import { onScopeDispose, reactive, ref, watch } from 'vue'
import { audibleTime } from '@/lib/audibleTime'
import type { Grid } from '@/training/vocal/edit'
import { monoOf, type PartNote } from '@/training/vocal/part'
import { stretch } from '@/training/vocal/stretch'

/** What plays the part: the teacher's recording or its notes by synthesis. */
export type PartSound = 'recording' | 'notes'

/** A stretch of the part, seconds of the recording. */
export interface Range {
  readonly from: number
  readonly to: number
}

/** How the part plays: the player's knobs, shared by the page and its controls. */
export interface PlayerSettings {
  /** Speed, 1 = as recorded; the pitch stays. */
  rate: number
  /** 0…1. */
  volume: number
  metronome: boolean
  /** A bar of clicks before playing. */
  countIn: boolean
  /** The stretch to repeat, when set and `looping`. */
  loop: Range | null
  looping: boolean
}

export interface PlayRequest {
  readonly sound: PartSound
  readonly notes: readonly PartNote[]
  /** The whole part: where playing starts over after the end. */
  readonly span: Range
  readonly grid?: Grid | null
  /** Where to start; the cursor by default. */
  readonly from?: number
  /** Ignore the loop and the count-in (singing along goes through once). */
  readonly once?: boolean
  /** Runs every animation frame with the moment playing. */
  readonly onTick?: (seconds: number) => void
}

/** Clicks when there is no grid yet, BPM. */
const DEFAULT_BPM = 100
/** Lead time before the first sound, seconds: room for scheduling. */
const LEAD = 0.12

/**
 * Plays a vocal training's part on one AudioContext: the recording or the notes, at any speed
 * without changing pitch, from any point, with a count-in, a metronome on the part's grid and a
 * stretch on repeat. `now` (seconds of the recording) runs while it plays; when it stops it is the
 * cursor the next play starts from. Start it from a tap: phones keep audio off until one.
 *
 * Both sounds are rendered ahead into buffers — the recording stretched by WSOLA, the notes
 * synthesised offline — so everything, clicks included, runs on the audio clock.
 */
export function useVocalPlayback() {
  const playing = ref(false)
  /** A slower or faster recording is being stretched before it can play. */
  const preparing = ref(false)
  const now = ref(0)
  const settings = reactive<PlayerSettings>({
    rate: 1,
    volume: 0.9,
    metronome: false,
    countIn: false,
    loop: null,
    looping: false,
  })
  let context: AudioContext | null = null
  let gain: GainNode | null = null
  let recording: AudioBuffer | null = null
  let recordingMono: Float32Array | null = null
  const stretched = new Map<number, AudioBuffer>()
  let synthCache: { notes: readonly PartNote[]; rate: number; buffer: AudioBuffer } | null = null
  let stopAll: (() => void) | null = null
  let raf = 0
  /** Bumped by every play and stop: a play still preparing its buffer sees it was overtaken. */
  let generation = 0
  let last: PlayRequest | null = null

  function audio(): AudioContext {
    if (context) return context
    context = new AudioContext()
    gain = context.createGain()
    gain.gain.value = settings.volume
    gain.connect(context.destination)
    return context
  }
  watch(
    () => settings.volume,
    (volume) => gain?.gain.setTargetAtTime(volume, audio().currentTime, 0.02),
  )

  /** Decodes the recording once; later plays reuse it. */
  async function load(source: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const bytes = source instanceof Blob ? await source.arrayBuffer() : source
    recording = await audio().decodeAudioData(bytes)
    recordingMono = null
    stretched.clear()
    return recording
  }

  async function bufferOf(sound: PartSound, notes: readonly PartNote[], rate: number) {
    const ctx = audio()
    const key = Math.round(rate * 100) / 100
    if (sound === 'recording') {
      if (!recording) return null
      if (key === 1) return recording
      const cached = stretched.get(key)
      if (cached) return cached
      // Let the page paint «preparing» before the stretch holds the thread.
      await new Promise((resolve) => setTimeout(resolve, 0))
      recordingMono ??= monoOf(recording)
      const samples = stretch(recordingMono, recording.sampleRate, key)
      const buffer = ctx.createBuffer(1, samples.length, recording.sampleRate)
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
      stretched.set(key, buffer)
      return buffer
    }
    if (synthCache && synthCache.notes === notes && synthCache.rate === key)
      return synthCache.buffer
    const end = Math.max(1, ...notes.map((n) => n.end)) + 0.5
    const offline = new OfflineAudioContext(
      1,
      Math.ceil((end / key) * ctx.sampleRate),
      ctx.sampleRate,
    )
    for (const note of notes) synthNote(offline, note, key)
    const buffer = await offline.startRendering()
    synthCache = { notes, rate: key, buffer }
    return buffer
  }

  /**
   * Plays until the end (or, looping, until stopped); resolves when it ends or is stopped. Reaching
   * the end puts the cursor back at the start of the part.
   */
  async function play(request: PlayRequest): Promise<void> {
    stop()
    const id = ++generation
    last = request
    const ctx = audio()
    void ctx.resume()
    const rate = settings.rate
    const { span, grid } = request
    const loop =
      !request.once &&
      settings.looping &&
      settings.loop &&
      settings.loop.to - settings.loop.from > 0.05
        ? settings.loop
        : null
    let from = request.from ?? now.value
    if (from < span.from || from >= span.to - 0.02) from = span.from
    if (loop && (from < loop.from || from >= loop.to)) from = loop.from
    playing.value = true
    now.value = from
    preparing.value = true
    const buffer = await bufferOf(request.sound, request.notes, rate).finally(() => {
      if (id === generation) preparing.value = false
    })
    if (id !== generation) return
    if (!buffer) {
      playing.value = false
      return
    }

    const bpm = grid?.bpm ?? DEFAULT_BPM
    const beat = 60 / bpm / rate
    const countIn = settings.countIn && !request.once ? (grid?.beatsPerBar ?? 4) : 0
    const t0 = ctx.currentTime + LEAD + countIn * beat
    const nodes: AudioScheduledSourceNode[] = []
    for (let k = 0; k < countIn; k++)
      nodes.push(click(ctx, gain!, t0 - (countIn - k) * beat, k === 0))

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gain!)
    if (loop) {
      source.loop = true
      source.loopStart = loop.from / rate
      source.loopEnd = loop.to / rate
      source.start(t0, from / rate)
    } else {
      source.start(t0, from / rate, Math.max(0, (span.to - from) / rate))
    }
    nodes.push(source)
    if (settings.metronome && grid) {
      const clicks = ctx.createBufferSource()
      clicks.buffer = clickTrack(ctx, grid, rate, buffer.duration)
      clicks.connect(gain!)
      if (loop) {
        clicks.loop = true
        clicks.loopStart = loop.from / rate
        clicks.loopEnd = loop.to / rate
        clicks.start(t0, from / rate)
      } else clicks.start(t0, from / rate, Math.max(0, (span.to - from) / rate))
      nodes.push(clicks)
    }

    return new Promise((resolve) => {
      const finish = (ended: boolean) => {
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
        if (ended) now.value = span.from
        resolve()
      }
      stopAll = () => finish(false)
      const tick = () => {
        // What is heard, not what is scheduled: on Bluetooth the two are a fifth of a second apart.
        let at = from + Math.max(0, audibleTime(ctx) - t0) * rate
        if (loop && at >= loop.to) at = loop.from + ((at - loop.from) % (loop.to - loop.from))
        now.value = at
        request.onTick?.(at)
        if (!loop && at >= span.to) finish(true)
        else raf = requestAnimationFrame(tick)
      }
      tick()
    })
  }

  /** Stops where it is: the cursor stays there. */
  function stop(): void {
    generation++
    stopAll?.()
    playing.value = false
    preparing.value = false
  }

  /**
   * Renders the sound ahead, so pressing play does not wait for it: the notes are synthesised again
   * after every edit, a new speed stretches the recording.
   */
  async function prepare(sound: PartSound, notes: readonly PartNote[]): Promise<void> {
    try {
      await bufferOf(sound, notes, settings.rate)
    } catch {
      // Play will try again and say so.
    }
  }

  /** A short tone of `midi`, for the keyboard down the sheet. */
  function previewNote(midi: number): void {
    const ctx = audio()
    void ctx.resume()
    const at = ctx.currentTime + 0.01
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * 2 ** ((midi - 69) / 12)
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(0.35, at + 0.015)
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.6)
    osc.connect(env).connect(gain!)
    osc.start(at)
    osc.stop(at + 0.62)
  }

  /** Moves the cursor; playing, it goes on from there. */
  function seek(seconds: number): void {
    now.value = seconds
    if (playing.value && last) void play({ ...last, from: seconds })
  }

  // A new speed, loop or click setting takes effect at once: playing goes on from where it is.
  watch(
    () => [settings.rate, settings.metronome, settings.looping, settings.loop],
    () => {
      if (playing.value && last) void play({ ...last, from: now.value })
    },
  )

  onScopeDispose(() => {
    stop()
    void context?.close()
  })

  return { playing, preparing, now, settings, load, play, stop, seek, previewNote, prepare }
}

/** One metronome click at `when`: higher on the downbeat. */
function click(ctx: BaseAudioContext, out: AudioNode, when: number, downbeat: boolean) {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.frequency.value = downbeat ? 1500 : 1000
  env.gain.setValueAtTime(0, Math.max(0, when))
  env.gain.linearRampToValueAtTime(0.5, when + 0.002)
  env.gain.exponentialRampToValueAtTime(0.001, when + 0.05)
  osc.connect(env).connect(out)
  osc.start(Math.max(0, when))
  osc.stop(when + 0.06)
  return osc
}

/** The grid's clicks as a buffer on the stretched timeline, `duration` seconds long. */
function clickTrack(
  ctx: BaseAudioContext,
  grid: Grid,
  rate: number,
  duration: number,
): AudioBuffer {
  const sr = ctx.sampleRate
  const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(duration * sr)), sr)
  const data = buffer.getChannelData(0)
  const beat = 60 / grid.bpm
  const first = Math.ceil(-grid.offset / beat)
  for (let k = first; ; k++) {
    const at = (grid.offset + k * beat) / rate
    if (at >= duration) break
    if (at < 0) continue
    const downbeat = ((k % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0
    const freq = downbeat ? 1500 : 1000
    const start = Math.round(at * sr)
    for (let i = 0; i < 0.05 * sr && start + i < data.length; i++) {
      const t = i / sr
      data[start + i]! += 0.45 * Math.exp(-t / 0.012) * Math.sin(2 * Math.PI * freq * t)
    }
  }
  return buffer
}

/**
 * A soft two-oscillator voice for one note, its times divided by `rate`. A note with a bend sings
 * it — the slide into the note, its vibrato, its pitch as sung — the way a synth plays MIDI pitch
 * bend; a note without one holds its tempered pitch.
 */
function synthNote(ctx: BaseAudioContext, note: PartNote, rate: number): void {
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
  const start = (note.slideIn ?? note.start) / rate
  const hold = Math.max(start + 0.02, note.end / rate)
  for (const [type, peak] of [
    ['triangle', 0.35],
    ['sine', 0.25],
  ] as const) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = type
    const bend = note.bend ?? []
    osc.frequency.setValueAtTime(hz(note.midi + (bend[0]?.[1] ?? 0) / 100), start)
    for (const [t, cents] of bend) {
      const at = (note.start + t) / rate
      if (at > start && at <= hold)
        osc.frequency.linearRampToValueAtTime(hz(note.midi + cents / 100), at)
    }
    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(peak, start + 0.02)
    env.gain.setValueAtTime(peak, hold)
    env.gain.linearRampToValueAtTime(0, hold + 0.06)
    osc.connect(env).connect(ctx.destination)
    osc.start(start)
    osc.stop(hold + 0.08)
  }
}

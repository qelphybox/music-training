import { SAMPLE_RATE, type PitchFrames } from './frames'
import type { SwiftF0Request } from './swiftf0.worker'

export { FRAME_PERIOD, VOICED, type PitchFrames } from './frames'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  {
    resolve: (frames: PitchFrames) => void
    reject: (error: Error) => void
    progress?: (fraction: number) => void
  }
>()

function start(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./swiftf0.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    if ('progress' in data) {
      request.progress?.(data.progress)
      return
    }
    pending.delete(data.id)
    if (data.ok) request.resolve(data.frames)
    else request.reject(new Error(data.error))
  }
  worker.onerror = (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message))
    pending.clear()
    worker = null
  }
  return worker
}

/**
 * SwiftF0 over a whole recording, in a worker: pitch and confidence every 16 ms. The samples are
 * resampled to the model's 16 kHz first. The first call loads the runtime and the model.
 */
export async function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): Promise<PitchFrames> {
  const resampled = await resample(samples, sampleRate)
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: onProgress })
    const request: SwiftF0Request = { id, samples: resampled }
    start().postMessage(request, [resampled.buffer])
  })
}

async function resample(samples: Float32Array, rate: number): Promise<Float32Array> {
  if (rate === SAMPLE_RATE) return samples.slice()
  const length = Math.ceil((samples.length * SAMPLE_RATE) / rate)
  const offline = new OfflineAudioContext(1, Math.max(1, length), SAMPLE_RATE)
  const buffer = offline.createBuffer(1, samples.length, rate)
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  return (await offline.startRendering()).getChannelData(0).slice()
}

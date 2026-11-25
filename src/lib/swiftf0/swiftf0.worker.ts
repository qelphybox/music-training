/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import modelUrl from './model.onnx?url'
import { detectFrames, FMAX, FMIN } from './frames'

// SwiftF0 off the main thread: the model loads once, then each request runs a whole recording.
// One wasm thread, as in the author's demo: more need cross-origin isolation.
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = { wasm: wasmUrl }

let session: Promise<ort.InferenceSession> | null = null

function load(): Promise<ort.InferenceSession> {
  session ??= fetch(modelUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`Модель не загрузилась (${response.status})`)
      return response.arrayBuffer()
    })
    .then((bytes) =>
      ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] }),
    )
  return session
}

async function infer(samples: Float32Array) {
  const output = await (
    await load()
  ).run({
    audio: new ort.Tensor('float32', samples, [1, samples.length]),
    fmin: new ort.Tensor('float32', Float32Array.of(FMIN), []),
    fmax: new ort.Tensor('float32', Float32Array.of(FMAX), []),
  })
  return {
    pitch: Float32Array.from(output.pitch!.data as Float32Array),
    confidence: Float32Array.from(output.confidence!.data as Float32Array),
  }
}

export interface SwiftF0Request {
  readonly id: number
  /** Mono 16 kHz samples. */
  readonly samples: Float32Array
}

self.onmessage = async ({ data }: MessageEvent<SwiftF0Request>) => {
  const { id, samples } = data
  try {
    const frames = await detectFrames(samples, infer, (fraction) =>
      self.postMessage({ id, progress: fraction }),
    )
    self.postMessage({ id, ok: true, frames }, [
      frames.pitchHz.buffer,
      frames.confidence.buffer,
      frames.loudnessDb.buffer,
    ])
  } catch (cause) {
    self.postMessage({
      id,
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

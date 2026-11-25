/**
 * Plays a recording slower or faster without changing its pitch: WSOLA (waveform-similarity
 * overlap-add, Verhelst & Roelands 1993). The output is built from Hann-windowed grains laid half a
 * grain apart; each grain is read from the input near where the tempo says, shifted by up to a
 * quarter grain to the spot whose waveform best continues the grain before. For a single voice that
 * keeps the pitch and keeps the waveform from cancelling itself.
 */

/** Grain length, seconds: a few periods of the lowest voice. */
const GRAIN_SECONDS = 0.043
/** The search for the best continuation runs on the signal brought down to about this rate. */
const SEARCH_RATE = 12000

/** `input` played at `rate` times its speed (2 = twice as fast, half as long), same pitch. */
export function stretch(input: Float32Array, sampleRate: number, rate: number): Float32Array {
  if (Math.abs(rate - 1) < 1e-3 || input.length === 0) return input.slice()
  const grain = 2 ** Math.round(Math.log2(GRAIN_SECONDS * sampleRate))
  const hop = grain / 2
  const tolerance = grain / 4
  const window = Float32Array.from(
    { length: grain },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain),
  )
  const outLength = Math.ceil(input.length / rate)
  const out = new Float32Array(outLength + grain)

  // Coarse copy for the search.
  const factor = Math.max(1, Math.round(sampleRate / SEARCH_RATE))
  const coarse = new Float32Array(Math.ceil(input.length / factor))
  for (let i = 0; i < coarse.length; i++) {
    let sum = 0
    let count = 0
    for (let k = i * factor; k < Math.min(input.length, (i + 1) * factor); k++, count++)
      sum += input[k]!
    coarse[i] = count ? sum / count : 0
  }
  const at = (signal: Float32Array, i: number) => (i >= 0 && i < signal.length ? signal[i]! : 0)
  // Only the half that overlaps the grain before has to match it.
  const span = Math.floor(hop / factor)
  const reach = Math.floor(tolerance / factor)

  let previous = 0
  for (let m = 0; m * hop < outLength; m++) {
    const ideal = Math.round(m * hop * rate)
    let chosen = ideal
    if (m > 0) {
      // What would naturally follow the last grain; find where the input looks most like it.
      const follow = Math.round((previous + hop) / factor)
      const centre = Math.round(ideal / factor)
      let best = -Infinity
      for (let d = -reach; d <= reach; d++) {
        let dot = 0
        let energy = 1e-9
        const start = centre + d
        if (
          start >= 0 &&
          follow >= 0 &&
          start + span <= coarse.length &&
          follow + span <= coarse.length
        ) {
          for (let k = 0; k < span; k++) {
            const x = coarse[start + k]!
            dot += x * coarse[follow + k]!
            energy += x * x
          }
        } else {
          for (let k = 0; k < span; k++) {
            const x = at(coarse, start + k)
            dot += x * at(coarse, follow + k)
            energy += x * x
          }
        }
        const score = dot / Math.sqrt(energy)
        if (score > best) {
          best = score
          chosen = start * factor
        }
      }
    }
    const base = m * hop
    for (let k = 0; k < grain; k++) out[base + k]! += window[k]! * at(input, chosen + k)
    previous = chosen
  }
  return out.subarray(0, outLength).slice()
}

/**
 * The context time now reaching the speakers. `currentTime` runs ahead of what is heard by the
 * output latency — a few milliseconds on built-in speakers, a fifth of a second and more on
 * Bluetooth headphones — so anything drawn in step with the sound reads this instead.
 */
export function audibleTime(context: AudioContext): number {
  const { contextTime, performanceTime } = context.getOutputTimestamp()
  if (contextTime === undefined || performanceTime === undefined || performanceTime === 0) {
    return context.currentTime - (context.outputLatency || 0)
  }
  return contextTime + (performance.now() - performanceTime) / 1000
}

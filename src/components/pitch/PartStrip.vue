<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Range, useVocalPlayback } from '@/composables/useVocalPlayback'
import { snap, type Grid } from '@/training/vocal/edit'
import type { PartNote } from '@/training/vocal/part'

/**
 * The whole part as a strip: a tap jumps there, a drag marks the stretch to repeat (on the beats,
 * with a grid). Under it the time so far and the length. Everything goes straight to the player.
 */
const props = defineProps<{
  player: ReturnType<typeof useVocalPlayback>
  notes: readonly PartNote[]
  span: Range
  grid?: Grid | null
  disabled?: boolean
  /** The words under the strip's middle, when nothing is marked to repeat. */
  hint?: string
}>()

const settings = props.player.settings
const now = props.player.now

const length = computed(() => Math.max(0.1, props.span.to - props.span.from))
const share = (t: number) => `${(100 * (t - props.span.from)) / length.value}%`
const pitchRange = computed(() => {
  const midis = props.notes.map((n) => n.midi)
  const low = Math.min(...midis, 60)
  const high = Math.max(...midis, low + 6)
  return { low, high }
})
const top = (midi: number) =>
  `${82 - (64 * (midi - pitchRange.value.low)) / (pitchRange.value.high - pitchRange.value.low)}%`
const clock = (t: number) => {
  const s = Math.max(0, t - props.span.from)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
const loopText = computed(() => {
  const loop = settings.loop
  if (!loop || !settings.looping) return props.hint ?? ''
  if (!props.grid) return `Повтор ${clock(loop.from)}–${clock(loop.to)}`
  const bar = (60 / props.grid.bpm) * props.grid.beatsPerBar
  const a = Math.floor((loop.from - props.grid.offset) / bar + 0.01) + 1
  const b = Math.ceil((loop.to - props.grid.offset) / bar - 0.01)
  return b > a ? `Повтор: такты ${a}–${b}` : `Повтор: такт ${a}`
})

const strip = ref<HTMLElement | null>(null)
let press: { x: number; t: number; moved: boolean } | null = null
function timeAt(event: PointerEvent): number {
  const rect = strip.value!.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  return props.span.from + x * length.value
}
function onDown(event: PointerEvent): void {
  if (props.disabled) return
  press = { x: event.clientX, t: timeAt(event), moved: false }
  strip.value?.setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent): void {
  if (!press) return
  if (!press.moved && Math.abs(event.clientX - press.x) < 6) return
  press.moved = true
  const onGrid = (t: number) => (props.grid ? snap(t, props.grid, 1) : t)
  const a = onGrid(press.t)
  const b = onGrid(timeAt(event))
  if (Math.abs(b - a) > 0.05) {
    settings.loop = {
      from: Math.max(props.span.from, Math.min(a, b)),
      to: Math.min(props.span.to, Math.max(a, b)),
    }
    settings.looping = true
  }
}
function onUp(event: PointerEvent): void {
  if (press && !press.moved) props.player.seek(timeAt(event))
  press = null
}
function onKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 1 : 0.25
  if (event.key === 'ArrowLeft') props.player.seek(Math.max(props.span.from, now.value - step))
  else if (event.key === 'ArrowRight') props.player.seek(Math.min(props.span.to, now.value + step))
  else if (event.key === 'Home') props.player.seek(props.span.from)
  else return
  event.preventDefault()
}
</script>

<template>
  <div class="strip-wrap">
    <div
      ref="strip"
      class="strip"
      :class="{ disabled }"
      role="slider"
      tabindex="0"
      aria-label="Где играть; протяни, чтобы повторять кусок"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(length * 10) / 10"
      :aria-valuenow="Math.round((now - span.from) * 10) / 10"
      :aria-valuetext="clock(now)"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="press = null"
      @keydown="onKey"
    >
      <span
        v-if="settings.loop"
        class="strip__loop"
        :class="{ off: !settings.looping }"
        :style="{
          left: share(settings.loop.from),
          width: `calc(${share(settings.loop.to)} - ${share(settings.loop.from)})`,
        }"
      />
      <span
        v-for="(note, i) in notes"
        :key="i"
        class="strip__note"
        :class="{ ornament: note.ornament }"
        :style="{
          left: share(note.start),
          width: `calc(${share(note.end)} - ${share(note.start)})`,
          top: top(note.midi),
        }"
      />
      <span class="strip__head" :style="{ left: share(now) }" />
    </div>
    <p class="strip__under num">
      <span>{{ clock(now) }}</span>
      <span class="strip__hint">{{ loopText }}</span>
      <span>{{ clock(span.to) }}</span>
    </p>
  </div>
</template>

<style scoped>
.strip-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.strip {
  position: relative;
  height: 44px;
  border-radius: 10px;
  background: #e2dccf;
  cursor: pointer;
  touch-action: none;
  overflow: hidden;
}
.strip.disabled {
  opacity: 0.5;
  cursor: default;
}
.strip__loop {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgb(217 178 90 / 42%);
  border-inline: 2px solid var(--gold-edge, #b8902f);
}
.strip__loop.off {
  background: rgb(28 27 25 / 6%);
  border-color: rgb(28 27 25 / 22%);
}
.strip__note {
  position: absolute;
  height: 3px;
  margin-top: -1.5px;
  border-radius: 2px;
  background: #8a7a55;
}
.strip__note.ornament {
  background: #3b6fd1;
}
.strip__head {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--seal, #a8361c);
}
.strip__under {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: var(--muted, #5f5a52);
}
.strip__hint {
  text-align: center;
}
</style>

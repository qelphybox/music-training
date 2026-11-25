<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Range, useVocalPlayback } from '@/composables/useVocalPlayback'
import { snap, type Grid } from '@/training/vocal/edit'
import type { PartNote } from '@/training/vocal/part'

/**
 * The part's transport: play and stop, a strip of the whole part to jump around in and to mark a
 * stretch to repeat (drag across it), speed without changing pitch, volume, a metronome on the
 * part's grid and a bar of count-in. The page decides what «play» means (`toggle`); everything
 * else goes straight to the player.
 */
const props = defineProps<{
  player: ReturnType<typeof useVocalPlayback>
  notes: readonly PartNote[]
  span: Range
  grid?: Grid | null
  disabled?: boolean
  /** The button's words while stopped. */
  playLabel?: string
}>()
const emit = defineEmits<{ toggle: [] }>()

const settings = props.player.settings
const now = props.player.now
const playing = props.player.playing
const preparing = props.player.preparing

const length = computed(() => Math.max(0.1, props.span.to - props.span.from))
const share = (t: number) => `${(100 * (t - props.span.from)) / length.value}%`
const pitchRange = computed(() => {
  const midis = props.notes.map((n) => n.midi)
  const low = Math.min(...midis, 60)
  const high = Math.max(...midis, low + 6)
  return { low, high }
})
const top = (midi: number) =>
  `${88 - (76 * (midi - pitchRange.value.low)) / (pitchRange.value.high - pitchRange.value.low)}%`

const bpm = computed(() => (props.grid ? Math.round(props.grid.bpm * settings.rate) : null))
const clock = (t: number) => {
  const s = Math.max(0, t - props.span.from)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// The strip: a tap jumps there, a drag marks the stretch to repeat (on the beats, with a grid).
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
function clearLoop(): void {
  settings.looping = false
  settings.loop = null
}
function toStart(): void {
  props.player.seek(settings.looping && settings.loop ? settings.loop.from : props.span.from)
}
</script>

<template>
  <div class="player" :class="{ disabled }">
    <div class="player__row">
      <button
        type="button"
        class="player__play"
        :disabled="disabled"
        :aria-label="playing ? 'Стоп' : (playLabel ?? 'Играть')"
        @click="emit('toggle')"
      >
        {{ playing ? '■' : '▶' }}
      </button>
      <button
        type="button"
        class="player__small"
        aria-label="В начало"
        :disabled="disabled"
        @click="toStart"
      >
        ⏮
      </button>
      <span class="player__time">{{ preparing ? 'готовлю…' : clock(now) }}</span>
      <div
        ref="strip"
        class="player__strip"
        role="slider"
        aria-label="Где играть; протяни, чтобы выделить кусок для повтора"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(length * 10) / 10"
        :aria-valuenow="Math.round((now - span.from) * 10) / 10"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="press = null"
      >
        <span
          v-if="settings.loop"
          class="player__loop"
          :class="{ off: !settings.looping }"
          :style="{
            left: share(settings.loop.from),
            width: `calc(${share(settings.loop.to)} - ${share(settings.loop.from)})`,
          }"
        />
        <span
          v-for="(note, i) in notes"
          :key="i"
          class="player__note"
          :class="{ ornament: note.ornament }"
          :style="{
            left: share(note.start),
            width: `calc(${share(note.end)} - ${share(note.start)})`,
            top: top(note.midi),
          }"
        />
        <span class="player__head" :style="{ left: share(now) }" />
      </div>
    </div>
    <div class="player__row player__knobs">
      <label class="player__knob">
        <span
          >Темп <b>{{ Math.round(settings.rate * 100) }}%</b
          ><template v-if="bpm"> · {{ bpm }} BPM</template></span
        >
        <input
          v-model.number="settings.rate"
          type="range"
          min="0.5"
          max="1.5"
          step="0.05"
          :disabled="disabled"
        />
      </label>
      <label class="player__knob">
        <span
          >Громкость <b>{{ Math.round(settings.volume * 100) }}%</b></span
        >
        <input v-model.number="settings.volume" type="range" min="0" max="1" step="0.05" />
      </label>
      <div class="player__toggles">
        <button
          type="button"
          :aria-pressed="settings.countIn"
          :disabled="disabled"
          @click="settings.countIn = !settings.countIn"
        >
          Отсчёт
        </button>
        <button
          type="button"
          :aria-pressed="settings.metronome"
          :disabled="disabled || !grid"
          :title="grid ? '' : 'У партии нет сетки'"
          @click="settings.metronome = !settings.metronome"
        >
          Метроном
        </button>
        <button
          type="button"
          :aria-pressed="settings.looping"
          :disabled="disabled || !settings.loop"
          title="Протяни по полосе, чтобы выделить кусок"
          @click="settings.looping = !settings.looping"
        >
          Цикл
        </button>
        <button v-if="settings.loop" type="button" aria-label="Убрать цикл" @click="clearLoop">
          ×
        </button>
      </div>
    </div>
    <p v-if="!settings.loop" class="player__hint">
      Протяни по полосе — этот кусок будет повторяться.
    </p>
  </div>
</template>

<style scoped>
.player {
  display: grid;
  gap: 0.5rem;
}
.player__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.player__play {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  border: 0;
  background: var(--ink, #1c1b19);
  color: #f2efe9;
  font-size: 1rem;
  cursor: pointer;
  flex: none;
}
.player__small {
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 6px;
  border: 1px solid rgb(28 27 25 / 30%);
  background: transparent;
  color: inherit;
  cursor: pointer;
  flex: none;
}
.player__time {
  min-width: 4.2rem;
  font-variant-numeric: tabular-nums;
  font-size: 0.9rem;
}
.player__strip {
  position: relative;
  flex: 1;
  height: 2.75rem;
  border-radius: 6px;
  background: rgb(28 27 25 / 8%);
  cursor: pointer;
  touch-action: none;
  overflow: hidden;
}
.player__loop {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgb(199 154 42 / 30%);
  border-inline: 2px solid rgb(199 154 42 / 90%);
}
.player__loop.off {
  background: rgb(28 27 25 / 6%);
  border-color: rgb(28 27 25 / 25%);
}
.player__note {
  position: absolute;
  height: 3px;
  margin-top: -1.5px;
  border-radius: 2px;
  background: var(--ink, #1c1b19);
  opacity: 0.6;
}
.player__note.ornament {
  background: #3b6fd1;
}
.player__head {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--seal, #a8361c);
}
.player__knobs {
  flex-wrap: wrap;
  gap: 0.5rem 1.2rem;
}
.player__knob {
  display: grid;
  gap: 0.15rem;
  font-size: 0.85rem;
  min-width: 10rem;
  flex: 1;
}
.player__knob b {
  font-variant-numeric: tabular-nums;
}
.player__knob input {
  width: 100%;
  accent-color: var(--ink, #1c1b19);
}
.player__toggles {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.player__toggles button {
  min-height: 2.25rem;
  padding: 0 0.75rem;
  border: 1px solid var(--ink, #1c1b19);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.player__toggles button[aria-pressed='true'] {
  background: var(--ink, #1c1b19);
  color: #f2efe9;
}
.player__toggles button:disabled {
  opacity: 0.4;
  cursor: default;
}
.player__hint {
  margin: 0;
  color: var(--muted, #6a665f);
  font-size: 0.75rem;
}
</style>

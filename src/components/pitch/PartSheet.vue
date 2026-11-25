<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FRAME, type Scale } from '@/training/vocal/melisma'
import type { Contour, PartNote } from '@/training/vocal/part'

/**
 * A part the way MELISMA shows a transcription: on a dark sheet the voice runs as an orange line —
 * yellow where it slides, pink where it wobbles in vibrato — and the notes lie under it as green
 * bars, ornaments blue. Each slide into a note is drawn as the note's glide, dashed, the way the
 * MIDI bend carries it. Dashed lines across are the steps of the mode the singer used; orange when
 * a step sits more than 25 cents off the semitone grid.
 *
 * A sideways swipe, shift+wheel or a drag moves along time; ctrl+wheel (a pinch) and the buttons
 * zoom.
 */
const props = withDefaults(
  defineProps<{
    notes: readonly PartNote[]
    contour: Contour | null
    scale?: Scale | null
    /** The whole part's span, seconds. */
    span: { readonly from: number; readonly to: number }
    /** The moment playing, seconds; null when nothing plays. */
    now?: number | null
    label?: string
  }>(),
  { scale: null, now: null, label: 'Партия' },
)

const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си']
const COLORS = {
  sheet: '#16181b',
  lane: 'rgba(255,255,255,0.045)',
  octave: 'rgba(255,255,255,0.14)',
  text: '#8d9096',
  note: '#3fbf7f',
  ornament: '#5aa0ff',
  voice: '#ff8a3d',
  slide: '#ffd166',
  vibrato: '#ff6fa3',
  degree: 'rgba(200,205,215,0.45)',
  offGrid: '#ff8a3d',
  playhead: '#f4f4f4',
}
const GUTTER = 44
const AXIS = 20
const TOP = 8

const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0

/** Seconds visible across the sheet, and the first of them. */
const zoom = ref(1)
const offset = ref(0)
const whole = computed(() => Math.max(0.5, props.span.to - props.span.from))
const visible = computed(() => whole.value / zoom.value)

function clampOffset(value: number): number {
  return Math.min(Math.max(props.span.from, value), props.span.from + whole.value - visible.value)
}

function zoomBy(factor: number, anchor = offset.value + visible.value / 2): void {
  const share = (anchor - offset.value) / visible.value
  zoom.value = Math.min(40, Math.max(1, zoom.value * factor))
  offset.value = clampOffset(anchor - share * visible.value)
  draw()
}

function fit(): void {
  zoom.value = 1
  offset.value = props.span.from
  draw()
}

/** The pitch range drawn: everything sung and noted, a semitone to spare, an octave at least. */
function pitchRange(): { low: number; high: number } {
  let low = Infinity
  let high = -Infinity
  for (const note of props.notes) {
    low = Math.min(low, note.midi)
    high = Math.max(high, note.midi)
  }
  const midi = props.contour?.midi
  if (midi) {
    for (let i = 0; i < midi.length; i++) {
      const value = midi[i]!
      if (!Number.isFinite(value)) continue
      low = Math.min(low, value)
      high = Math.max(high, value)
    }
  }
  if (!Number.isFinite(low)) return { low: 57, high: 72 }
  low = Math.floor(low) - 1
  high = Math.ceil(high) + 1
  const short = 13 - (high - low)
  if (short > 0) {
    low -= Math.floor(short / 2)
    high += Math.ceil(short / 2)
  }
  return { low, high }
}

function draw(): void {
  const c = ctx
  if (c === null || width === 0) return
  c.fillStyle = COLORS.sheet
  c.fillRect(0, 0, width, height)

  const { low, high } = pitchRange()
  const bottom = height - AXIS
  const lane = (bottom - TOP) / (high - low + 1)
  const y = (midi: number) => bottom - (midi - low + 0.5) * lane
  const from = offset.value
  const to = from + visible.value
  const right = width - 6
  const x = (t: number) => GUTTER + ((t - from) / (to - from)) * (right - GUTTER)

  c.save()
  c.beginPath()
  c.rect(GUTTER, 0, right - GUTTER, bottom)
  c.clip()

  // Semitones, octaves on C.
  for (let m = low; m <= high; m++) {
    c.fillStyle = m % 12 === 0 ? COLORS.octave : COLORS.lane
    c.fillRect(GUTTER, Math.round(y(m) + lane / 2), right - GUTTER, 1)
  }

  // Steps of the mode, dashed across.
  const scale = props.scale
  if (scale && scale.degrees.length) {
    c.setLineDash([5, 5])
    c.lineWidth = 1
    for (const degree of scale.degrees) {
      const off = degree - scale.tuning - Math.round((degree - scale.tuning) / 100) * 100
      c.strokeStyle = Math.abs(off) > 25 ? COLORS.offGrid : COLORS.degree
      for (let octave = Math.floor(low / 12) - 1; octave <= Math.ceil(high / 12); octave++) {
        const m = octave * 12 + degree / 100
        if (m < low - 0.5 || m > high + 0.5) continue
        c.beginPath()
        c.moveTo(GUTTER, y(m))
        c.lineTo(right, y(m))
        c.stroke()
      }
    }
    c.setLineDash([])
  }

  // Notes: bars on their tempered pitch, the glide into each dashed along the voice's way.
  const barHeight = Math.max(4, lane * 0.72)
  for (let i = 0; i < props.notes.length; i++) {
    const note = props.notes[i]!
    if (note.end < from || (note.slideIn ?? note.start) > to) continue
    const color = note.ornament ? COLORS.ornament : COLORS.note
    const x0 = x(note.start)
    const x1 = Math.max(x0 + 2, x(note.end))
    c.globalAlpha = 0.32
    c.fillStyle = color
    roundRect(c, x0, y(note.midi) - barHeight / 2, x1 - x0, barHeight, Math.min(4, barHeight / 3))
    c.fill()
    c.globalAlpha = 0.95
    c.strokeStyle = color
    c.lineWidth = 1.5
    c.stroke()
    if (note.slideIn !== undefined && note.bend) {
      c.setLineDash([4, 3])
      c.lineWidth = 2
      c.beginPath()
      let started = false
      for (const [t, cents] of note.bend) {
        if (t > 0) break
        const px = x(note.start + t)
        const py = y(note.midi + cents / 100)
        if (started) c.lineTo(px, py)
        else c.moveTo(px, py)
        started = true
      }
      c.lineTo(x0, y(note.midi))
      c.stroke()
      c.setLineDash([])
    }
    c.globalAlpha = 1
    const bar = x1 - x0
    if (bar > 26 && barHeight >= 9) {
      c.fillStyle = color
      c.font = `${Math.min(12, barHeight * 0.85)}px system-ui, sans-serif`
      c.textBaseline = 'bottom'
      c.textAlign = 'left'
      const name = NAMES[((note.midi % 12) + 12) % 12]!
      c.fillText(note.vibrato ? `${name} ∿` : name, x0 + 3, y(note.midi) - barHeight / 2 - 1)
    } else if (note.vibrato && bar > 10) {
      c.fillStyle = color
      c.font = '11px system-ui, sans-serif'
      c.textBaseline = 'bottom'
      c.textAlign = 'left'
      c.fillText('∿', x0 + 1, y(note.midi) - barHeight / 2 - 1)
    }
  }

  // The voice, coloured by what each frame is.
  const contour = props.contour
  if (contour) {
    const first = Math.max(0, Math.floor((from - contour.start) * contour.frameRate) - 1)
    const last = Math.min(
      contour.midi.length,
      Math.ceil((to - contour.start) * contour.frameRate) + 2,
    )
    const colorOf = (i: number) => {
      const kind = contour.classes?.[i]
      return kind === FRAME.SLIDE
        ? COLORS.slide
        : kind === FRAME.VIBRATO
          ? COLORS.vibrato
          : COLORS.voice
    }
    c.lineWidth = 2
    c.lineJoin = 'round'
    c.lineCap = 'round'
    for (let i = first + 1; i < last; i++) {
      const a = contour.midi[i - 1]!
      const b = contour.midi[i]!
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 3) continue
      c.strokeStyle = colorOf(i)
      c.beginPath()
      c.moveTo(x(contour.start + (i - 1) / contour.frameRate), y(a))
      c.lineTo(x(contour.start + i / contour.frameRate), y(b))
      c.stroke()
    }
  }

  if (props.now !== null && props.now >= from && props.now <= to) {
    c.fillStyle = COLORS.playhead
    c.fillRect(Math.round(x(props.now)), 0, 1.5, bottom)
  }
  c.restore()

  // Names of the notes down the left, seconds along the bottom.
  c.font = `${Math.max(9, Math.min(12, lane * 0.8))}px system-ui, sans-serif`
  c.textAlign = 'right'
  c.textBaseline = 'middle'
  const every = lane >= 11 ? 1 : lane >= 6 ? 2 : 12
  for (let m = low; m <= high; m++) {
    if (m % every !== 0 && m % 12 !== 0) continue
    c.fillStyle = m % 12 === 0 ? '#c9ccd2' : COLORS.text
    const name = NAMES[((m % 12) + 12) % 12]!
    c.fillText(m % 12 === 0 ? `${name}${Math.floor(m / 12) - 1}` : name, GUTTER - 6, y(m))
  }
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30]
  const perSecond = (right - GUTTER) / (to - from)
  const tick = steps.find((step) => step * perSecond >= 56) ?? 60
  c.textAlign = 'center'
  c.textBaseline = 'top'
  c.fillStyle = COLORS.text
  c.font = '11px system-ui, sans-serif'
  for (let t = Math.ceil(from / tick) * tick; t <= to; t += tick) {
    const px = x(t)
    c.fillRect(Math.round(px), bottom, 1, 4)
    c.fillText(tick < 1 ? t.toFixed(1) : `${Math.round(t)}`, px, bottom + 5)
  }
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

function resize(): void {
  const el = canvas.value
  if (el === null) return
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  width = rect.width
  height = rect.height
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  ctx = el.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  draw()
}

function onWheel(event: WheelEvent): void {
  const seconds = visible.value / Math.max(1, width - GUTTER)
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    const anchor = offset.value + (event.offsetX - GUTTER) * seconds
    zoomBy(Math.exp(-event.deltaY * 0.01), anchor)
    return
  }
  // Sideways (or shift+wheel) moves along time; a plain wheel is left to scroll the page.
  const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY)
  const delta = event.shiftKey ? event.deltaY || event.deltaX : sideways ? event.deltaX : 0
  if (delta === 0) return
  event.preventDefault()
  offset.value = clampOffset(offset.value + delta * seconds)
  draw()
}

let dragging: { x: number; offset: number } | null = null
function onDown(event: PointerEvent): void {
  if (zoom.value === 1) return
  dragging = { x: event.clientX, offset: offset.value }
  canvas.value?.setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent): void {
  if (!dragging) return
  const seconds = visible.value / Math.max(1, width - GUTTER)
  offset.value = clampOffset(dragging.offset - (event.clientX - dragging.x) * seconds)
  draw()
}
function onUp(): void {
  dragging = null
}

let observer: ResizeObserver | null = null
onMounted(() => {
  offset.value = props.span.from
  observer = new ResizeObserver(resize)
  if (canvas.value) observer.observe(canvas.value)
  resize()
})
onBeforeUnmount(() => observer?.disconnect())

watch(
  () => [props.notes, props.contour, props.scale],
  () => draw(),
)
watch(
  () => [props.span.from, props.span.to],
  () => {
    offset.value = clampOffset(offset.value)
    draw()
  },
)
// While playing, the view follows the playhead when it runs off the right.
watch(
  () => props.now,
  (now) => {
    if (now !== null && (now > offset.value + visible.value * 0.92 || now < offset.value))
      offset.value = clampOffset(now - visible.value * 0.1)
    draw()
  },
)

const ornaments = computed(() => props.notes.filter((n) => n.ornament).length)
const summary = computed(() => {
  const parts = [`${props.notes.length - ornaments.value} нот`]
  if (ornaments.value) parts.push(`${ornaments.value} украш.`)
  if (props.scale) {
    parts.push(`A4 ${props.scale.a4.toFixed(1)} Гц`)
    parts.push(props.scale.microtonal ? 'микротоны' : '12-TET')
  }
  return parts.join(' · ')
})
</script>

<template>
  <div class="part">
    <div class="part__bar">
      <span class="part__summary">{{ summary }}</span>
      <span class="part__legend" aria-hidden="true">
        <i style="--c: #3fbf7f" class="box" />нота <i style="--c: #5aa0ff" class="box" />украшение
        <i style="--c: #ff8a3d" />голос <i style="--c: #ffd166" />слайд
        <i style="--c: #ff6fa3" />вибрато
      </span>
      <span class="part__zoom">
        <button type="button" aria-label="Отдалить" @click="zoomBy(1 / 1.5)">−</button>
        <button type="button" aria-label="Приблизить" @click="zoomBy(1.5)">+</button>
        <button type="button" aria-label="Показать целиком" @click="fit">↔</button>
      </span>
    </div>
    <canvas
      ref="canvas"
      class="part__canvas"
      role="img"
      :aria-label="`${label}: ${summary}`"
      @wheel="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    />
  </div>
</template>

<style scoped>
.part {
  display: grid;
  grid-template-rows: auto 1fr;
  width: 100%;
  height: 100%;
  background: #16181b;
  color: #c9ccd2;
  font:
    12px system-ui,
    sans-serif;
}
.part__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 1rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}
.part__summary {
  font-variant-numeric: tabular-nums;
  color: #e8eaee;
}
.part__legend {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  color: #8d9096;
  flex: 1;
}
.part__legend i {
  display: inline-block;
  width: 14px;
  height: 2px;
  margin-left: 0.5rem;
  background: var(--c);
}
.part__legend i.box {
  height: 8px;
  border: 1px solid var(--c);
  background: color-mix(in srgb, var(--c) 35%, transparent);
  border-radius: 2px;
}
.part__zoom {
  display: inline-flex;
  gap: 0.25rem;
}
.part__zoom button {
  min-width: 2rem;
  min-height: 1.8rem;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 4px;
  background: transparent;
  color: #e8eaee;
  font: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}
.part__canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  touch-action: pan-y;
  cursor: grab;
}
</style>

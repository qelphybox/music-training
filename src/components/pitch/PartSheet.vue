<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  add,
  beatTime,
  join,
  move,
  noteAt,
  remove,
  resize,
  setOrnament,
  snap,
  split,
  transpose,
  type Grid,
} from '@/training/vocal/edit'
import { FRAME, type Scale } from '@/training/vocal/melisma'
import type { Contour, PartNote } from '@/training/vocal/part'

/**
 * A part the way MELISMA shows a transcription: on a dark sheet the voice runs as an orange line —
 * yellow where it slides, pink where it wobbles in vibrato — and the notes lie under it as green
 * bars, ornaments blue, each with its syllable. Each slide into a note is drawn as the note's glide,
 * dashed, the way the MIDI bend carries it. Dashed lines across are the steps of the mode the singer
 * used; orange when a step sits more than 25 cents off the semitone grid. With a beat grid, bars and
 * beats run down the sheet.
 *
 * A sideways swipe, shift+wheel or a drag on empty paper moves along time; ctrl+wheel (a pinch) and
 * the buttons zoom. A tap on the seconds below moves the cursor.
 *
 * `editable`: a note is picked by a tap, dragged up or down by semitones or along time, stretched by
 * its edges; a double tap on empty paper adds one. Keys: ↑↓ semitone, ←→ along time, Delete, S cut
 * where the pointer is, J join with the next, O ornament, ⌘Z / ⇧⌘Z undo and redo. Every finished
 * gesture is one `edit`; the page keeps the history.
 */
const props = withDefaults(
  defineProps<{
    notes: readonly PartNote[]
    contour: Contour | null
    scale?: Scale | null
    grid?: Grid | null
    /** The whole part's span, seconds. */
    span: { readonly from: number; readonly to: number }
    /** The cursor or the moment playing, seconds; null hides it. */
    now?: number | null
    /** The stretch on repeat, shaded. */
    loop?: { readonly from: number; readonly to: number } | null
    editable?: boolean
    /** The picked note's index. */
    selected?: number | null
    /** Edits snap to grid lines this many beats apart; null — free. */
    snapTo?: number | null
    label?: string
  }>(),
  {
    scale: null,
    grid: null,
    now: null,
    loop: null,
    editable: false,
    selected: null,
    snapTo: null,
    label: 'Партия',
  },
)
const emit = defineEmits<{
  edit: [notes: PartNote[], selected: number | null]
  'update:selected': [index: number | null]
  seek: [seconds: number]
  undo: []
  redo: []
}>()

const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си']
const COLORS = {
  sheet: '#16181b',
  lane: 'rgba(255,255,255,0.045)',
  octave: 'rgba(255,255,255,0.14)',
  bar: 'rgba(255,255,255,0.16)',
  beat: 'rgba(255,255,255,0.06)',
  text: '#8d9096',
  note: '#3fbf7f',
  ornament: '#5aa0ff',
  voice: '#ff8a3d',
  slide: '#ffd166',
  vibrato: '#ff6fa3',
  degree: 'rgba(200,205,215,0.45)',
  offGrid: '#ff8a3d',
  playhead: '#f4f4f4',
  loop: 'rgba(199,154,42,0.14)',
  lyric: '#e8eaee',
}
const GUTTER = 44
const AXIS = 22
const TOP = 8
/** Pixels from a note's edge that grab the edge rather than the note. */
const EDGE = 7

const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0

/** Seconds visible across the sheet, and the first of them. */
const zoom = ref(1)
const offset = ref(0)
const whole = computed(() => Math.max(0.5, props.span.to - props.span.from))
const visible = computed(() => whole.value / zoom.value)

/** Notes as drawn: the page's, or a gesture's draft while it is under way. */
const draft = ref<PartNote[] | null>(null)
const shown = computed(() => draft.value ?? props.notes)

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

/** The last drawing's geometry, for reading the pointer back into time and pitch. */
const view = {
  low: 57,
  high: 72,
  lane: 10,
  bottom: 100,
  from: 0,
  to: 1,
  right: 100,
  x: (t: number) => t,
  y: (m: number) => m,
  timeAt: (px: number) => px,
  midiAt: (py: number) => py,
}

function draw(): void {
  const c = ctx
  if (c === null || width === 0) return
  c.fillStyle = COLORS.sheet
  c.fillRect(0, 0, width, height)

  // The range is fixed while dragging, so a note pulled past the top does not move the floor.
  const { low, high } = draft.value ? { low: view.low, high: view.high } : pitchRange()
  const bottom = height - AXIS
  const lane = (bottom - TOP) / (high - low + 1)
  const y = (midi: number) => bottom - (midi - low + 0.5) * lane
  const from = offset.value
  const to = from + visible.value
  const right = width - 6
  const x = (t: number) => GUTTER + ((t - from) / (to - from)) * (right - GUTTER)
  Object.assign(view, {
    low,
    high,
    lane,
    bottom,
    from,
    to,
    right,
    x,
    y,
    timeAt: (px: number) => from + ((px - GUTTER) / (right - GUTTER)) * (to - from),
    midiAt: (py: number) => low - 0.5 + (bottom - py) / lane,
  })

  c.save()
  c.beginPath()
  c.rect(GUTTER, 0, right - GUTTER, bottom)
  c.clip()

  if (props.loop) {
    c.fillStyle = COLORS.loop
    c.fillRect(x(props.loop.from), 0, x(props.loop.to) - x(props.loop.from), bottom)
  }

  // Semitones, octaves on C.
  for (let m = low; m <= high; m++) {
    c.fillStyle = m % 12 === 0 ? COLORS.octave : COLORS.lane
    c.fillRect(GUTTER, Math.round(y(m) + lane / 2), right - GUTTER, 1)
  }

  // Bars and beats.
  const grid = props.grid
  if (grid) {
    const beat = 60 / grid.bpm
    const pixelsPerBeat = (beat / (to - from)) * (right - GUTTER)
    const first = Math.floor((from - grid.offset) / beat)
    for (let k = first; beatTime(grid, k) <= to; k++) {
      const isBar = ((k % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0
      if (!isBar && pixelsPerBeat < 8) continue
      c.fillStyle = isBar ? COLORS.bar : COLORS.beat
      c.fillRect(Math.round(x(beatTime(grid, k))), 0, 1, bottom)
    }
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
  const notes = shown.value
  const barHeight = Math.max(4, lane * 0.72)
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!
    if (note.end < from || (note.slideIn ?? note.start) > to) continue
    const color = note.ornament ? COLORS.ornament : COLORS.note
    const picked = props.editable && props.selected === i
    const x0 = x(note.start)
    const x1 = Math.max(x0 + 2, x(note.end))
    c.globalAlpha = picked ? 0.55 : 0.32
    c.fillStyle = color
    roundRect(c, x0, y(note.midi) - barHeight / 2, x1 - x0, barHeight, Math.min(4, barHeight / 3))
    c.fill()
    c.globalAlpha = 0.95
    c.strokeStyle = picked ? '#ffffff' : color
    c.lineWidth = picked ? 2 : 1.5
    c.stroke()
    if (note.slideIn !== undefined && note.bend) {
      c.strokeStyle = color
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
    if (note.lyric) {
      c.fillStyle = COLORS.lyric
      c.font = `600 ${Math.max(11, Math.min(14, lane * 0.9))}px system-ui, sans-serif`
      c.textBaseline = 'top'
      c.textAlign = 'left'
      c.fillText(note.lyric, x0 + 2, y(note.midi) + barHeight / 2 + 2)
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
    c.globalAlpha = props.editable ? 0.7 : 1
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
    c.globalAlpha = 1
  }

  if (props.now !== null && props.now >= from && props.now <= to) {
    c.fillStyle = COLORS.playhead
    c.fillRect(Math.round(x(props.now)), 0, 1.5, bottom)
  }
  c.restore()

  // Names of the notes down the left, seconds (or bars) along the bottom.
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
  c.fillStyle = '#1d2024'
  c.fillRect(GUTTER, bottom, right - GUTTER, AXIS)
  c.textAlign = 'center'
  c.textBaseline = 'top'
  c.fillStyle = COLORS.text
  c.font = '11px system-ui, sans-serif'
  if (grid) {
    const beat = 60 / grid.bpm
    const barSeconds = beat * grid.beatsPerBar
    const pixelsPerBar = (barSeconds / (to - from)) * (right - GUTTER)
    const step = Math.max(1, Math.ceil(36 / pixelsPerBar))
    const first = Math.ceil((from - grid.offset) / barSeconds)
    for (let bar = first; grid.offset + bar * barSeconds <= to; bar++) {
      if (bar % step !== 0) continue
      const px = x(grid.offset + bar * barSeconds)
      c.fillRect(Math.round(px), bottom, 1, 4)
      c.fillText(`${bar + 1}`, px, bottom + 6)
    }
  } else {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30]
    const perSecond = (right - GUTTER) / (to - from)
    const tick = steps.find((step) => step * perSecond >= 56) ?? 60
    for (let t = Math.ceil(from / tick) * tick; t <= to; t += tick) {
      const px = x(t)
      c.fillRect(Math.round(px), bottom, 1, 4)
      c.fillText(tick < 1 ? t.toFixed(1) : `${Math.round(t)}`, px, bottom + 6)
    }
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

function resizeCanvas(): void {
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

// ─── Pointer ──────────────────────────────────────────────────────────────────────────────────

/** A note under the pointer, and which part of it. */
function hit(px: number, py: number): { index: number; part: 'body' | 'start' | 'end' } | null {
  const half = Math.max(5, view.lane * 0.45)
  const notes = props.notes
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!
    const x0 = view.x(note.start)
    const x1 = Math.max(x0 + 2, view.x(note.end))
    if (Math.abs(py - view.y(note.midi)) > half || px < x0 - 3 || px > x1 + 3) continue
    if (x1 - x0 > 3 * EDGE && px - x0 < EDGE) return { index: i, part: 'start' }
    if (x1 - x0 > 3 * EDGE && x1 - px < EDGE) return { index: i, part: 'end' }
    return { index: i, part: 'body' }
  }
  return null
}

const snapTime = (t: number) =>
  props.grid && props.snapTo ? snap(t, props.grid, props.snapTo) : Math.round(t * 1000) / 1000

type Gesture =
  | { kind: 'pan'; x: number; offset: number }
  | { kind: 'seek' }
  | {
      kind: 'note'
      index: number
      part: 'body' | 'start' | 'end'
      x: number
      y: number
      /** Locked once the pointer has gone far enough one way. */
      axis: 'time' | 'pitch' | null
    }
let gesture: Gesture | null = null
/** Where the pointer last was over the sheet, seconds: where S cuts. */
let hoverTime: number | null = null
let lastTap = { at: 0, x: 0, y: 0 }

function onDown(event: PointerEvent): void {
  const px = event.offsetX
  const py = event.offsetY
  canvas.value?.focus({ preventScroll: true })
  if (py > view.bottom) {
    gesture = { kind: 'seek' }
    emit('seek', Math.max(props.span.from, view.timeAt(px)))
    canvas.value?.setPointerCapture(event.pointerId)
    return
  }
  const found = props.editable ? hit(px, py) : null
  if (found) {
    emit('update:selected', found.index)
    gesture = { kind: 'note', index: found.index, part: found.part, x: px, y: py, axis: null }
    canvas.value?.setPointerCapture(event.pointerId)
    return
  }
  if (props.editable) {
    emit('update:selected', null)
    const now = performance.now()
    const double = now - lastTap.at < 350 && Math.hypot(px - lastTap.x, py - lastTap.y) < 8
    lastTap = { at: now, x: px, y: py }
    if (double && px > GUTTER) {
      addAt(px, py)
      return
    }
  } else emit('seek', Math.max(props.span.from, view.timeAt(px)))
  if (zoom.value > 1) {
    gesture = { kind: 'pan', x: event.clientX, offset: offset.value }
    canvas.value?.setPointerCapture(event.pointerId)
  }
}

function addAt(px: number, py: number): void {
  const midi = Math.round(view.midiAt(py))
  const start = snapTime(view.timeAt(px))
  const length = props.grid ? (60 / props.grid.bpm) * (props.snapTo ?? 1) : 0.3
  const next = add(props.notes, midi, start, start + length)
  if (next.length === props.notes.length) return
  emit(
    'edit',
    next,
    next.findIndex((n) => n.midi === midi && Math.abs(n.start - Math.max(start, 0)) < 0.002),
  )
}

function onMove(event: PointerEvent): void {
  hoverTime = view.timeAt(event.offsetX)
  if (!gesture) {
    if (props.editable && canvas.value) {
      const found = event.offsetY <= view.bottom ? hit(event.offsetX, event.offsetY) : null
      canvas.value.style.cursor = !found
        ? 'crosshair'
        : found.part === 'body'
          ? 'grab'
          : 'ew-resize'
    }
    return
  }
  if (gesture.kind === 'seek') {
    emit('seek', Math.max(props.span.from, view.timeAt(event.offsetX)))
    return
  }
  if (gesture.kind === 'pan') {
    const seconds = visible.value / Math.max(1, width - GUTTER)
    offset.value = clampOffset(gesture.offset - (event.clientX - gesture.x) * seconds)
    draw()
    return
  }
  const dx = event.offsetX - gesture.x
  const dy = event.offsetY - gesture.y
  if (gesture.axis === null) {
    if (Math.hypot(dx, dy) < 5) return
    gesture.axis = gesture.part !== 'body' || Math.abs(dx) > Math.abs(dy) ? 'time' : 'pitch'
  }
  const notes = props.notes
  const note = notes[gesture.index]
  if (!note) return
  if (gesture.axis === 'pitch') {
    const semis = Math.round(-dy / view.lane)
    draft.value = semis ? transpose(notes, gesture.index, semis) : null
  } else if (gesture.part === 'body') {
    const dt = view.timeAt(event.offsetX) - view.timeAt(gesture.x)
    draft.value = move(notes, gesture.index, snapTime(note.start + dt) - note.start)
  } else {
    draft.value = resize(notes, gesture.index, gesture.part, snapTime(view.timeAt(event.offsetX)))
  }
  draw()
}

function onUp(): void {
  if (gesture?.kind === 'note' && draft.value) emit('edit', draft.value, gesture.index)
  draft.value = null
  gesture = null
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

// ─── Keys ─────────────────────────────────────────────────────────────────────────────────────

function onKey(event: KeyboardEvent): void {
  if (!props.editable) return
  const mod = event.metaKey || event.ctrlKey
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) emit('redo')
    else emit('undo')
    return
  }
  const i = props.selected
  if (i === null || !props.notes[i]) return
  const notes = props.notes
  const note = notes[i]!
  const step = props.grid && props.snapTo ? (60 / props.grid.bpm) * props.snapTo : 0.05
  let next: PartNote[] | null = null
  let picked: number | null = i
  switch (event.key) {
    case 'ArrowUp':
      next = transpose(notes, i, event.shiftKey ? 12 : 1)
      break
    case 'ArrowDown':
      next = transpose(notes, i, event.shiftKey ? -12 : -1)
      break
    case 'ArrowLeft':
      next = move(notes, i, -step)
      break
    case 'ArrowRight':
      next = move(notes, i, step)
      break
    case 'Delete':
    case 'Backspace':
      next = remove(notes, i)
      picked = Math.min(i, notes.length - 2)
      if (picked < 0) picked = null
      break
    case 's':
    case 'S':
    case 'ы':
    case 'Ы': {
      const at =
        hoverTime !== null && noteAt(notes, hoverTime) === i
          ? hoverTime
          : (note.start + note.end) / 2
      next = split(notes, i, snapTime(at))
      break
    }
    case 'j':
    case 'J':
    case 'о':
    case 'О':
      next = join(notes, i)
      break
    case 'o':
    case 'O':
    case 'щ':
    case 'Щ':
      next = setOrnament(notes, i, !note.ornament)
      break
    case 'Escape':
      emit('update:selected', null)
      return
    default:
      return
  }
  event.preventDefault()
  if (next) emit('edit', next, picked)
}

// ─── Life ─────────────────────────────────────────────────────────────────────────────────────

let observer: ResizeObserver | null = null
onMounted(() => {
  offset.value = props.span.from
  observer = new ResizeObserver(resizeCanvas)
  if (canvas.value) observer.observe(canvas.value)
  resizeCanvas()
})
onBeforeUnmount(() => observer?.disconnect())

watch(
  () => [
    props.notes,
    props.contour,
    props.scale,
    props.grid,
    props.selected,
    props.loop,
    props.editable,
  ],
  () => draw(),
)
watch(
  () => [props.span.from, props.span.to],
  () => {
    offset.value = clampOffset(offset.value)
    draw()
  },
)
// The view follows the cursor when it runs off either side.
watch(
  () => props.now,
  (now) => {
    if (
      now !== null &&
      !gesture &&
      (now > offset.value + visible.value * 0.92 || now < offset.value)
    )
      offset.value = clampOffset(now - visible.value * 0.1)
    draw()
  },
)

const ornaments = computed(() => props.notes.filter((n) => n.ornament).length)
const summary = computed(() => {
  const parts = [`${props.notes.length - ornaments.value} нот`]
  if (ornaments.value) parts.push(`${ornaments.value} украш.`)
  if (props.grid) parts.push(`${Math.round(props.grid.bpm * 10) / 10} BPM`)
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
      :class="{ editable }"
      role="img"
      tabindex="0"
      :aria-label="`${label}: ${summary}`"
      @wheel="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="hoverTime = null"
      @keydown="onKey"
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
  cursor: pointer;
  outline: none;
}
.part__canvas.editable {
  touch-action: none;
  cursor: crosshair;
}
.part__canvas:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(255 255 255 / 25%);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditMode } from '@/composables/usePartEditor'
import {
  add,
  beatTime,
  joinRange,
  moveBoundary,
  moveMany,
  resize,
  snap,
  split,
  touching,
  transposeMany,
  type Grid,
} from '@/training/vocal/edit'
import { FRAME, type Scale } from '@/training/vocal/melisma'
import type { Contour, PartNote } from '@/training/vocal/part'

/**
 * A part on a paper sheet, laid out like Vovious (docs/research/2026-11-25-vovious-editor.md): a
 * keyboard of notes down the left (tap one to hear it), the notes as gold bars with the voice over
 * them in ink — brown where it slides, plum in vibrato, hidden with `voice` off — a time bar on top (its upper half moves the
 * cursor, its lower half marks the stretch to repeat) and an overview of the whole part below (drag
 * the window to scroll, its edges to zoom). Bars and beats run down the sheet when there is a grid;
 * the lanes of the singer's mode are lighter.
 *
 * Editable, what a drag on a note does depends on the mode:
 * - pitch: the picked notes go up or down by semitones;
 * - time: the picked notes move along time; a boundary between notes is dragged (both notes
 *   stretch, or with `ripple` everything after moves along) and a double tap puts it on the beat;
 * - notes: a tap inside a note cuts it there, a tap on the line between two touching notes joins
 *   them; what would happen shows before the tap.
 * In every mode a drag on empty paper picks the notes inside the frame (⇧ adds), a long press on a
 * note adds or removes it from the pick (for touch, where there is no ⇧), and a double tap on empty
 * paper adds a note. Two fingers pan and pinch-zoom; ctrl+wheel zooms, a sideways swipe scrolls.
 * Every finished gesture is one `edit`.
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
    /** The stretch marked to repeat, and whether it repeats. */
    loop?: { readonly from: number; readonly to: number } | null
    looping?: boolean
    editable?: boolean
    mode?: EditMode
    ripple?: boolean
    selection?: readonly number[]
    /** Edits snap to grid lines this many beats apart; null — free. */
    snapTo?: number | null
    /** Bumped to fit the picked (or all) notes into view. */
    fitRequest?: number
    /** Bumped to zoom in time by `by`. */
    zoomRequest?: { readonly n: number; readonly by: number }
    /** Whether the sung line is drawn over the notes. */
    voice?: boolean
    label?: string
  }>(),
  {
    scale: null,
    grid: null,
    now: null,
    loop: null,
    looping: false,
    editable: false,
    mode: 'pitch',
    ripple: false,
    selection: () => [],
    snapTo: null,
    fitRequest: 0,
    zoomRequest: () => ({ n: 0, by: 1 }),
    voice: true,
    label: 'Партия',
  },
)
const emit = defineEmits<{
  edit: [notes: PartNote[], label: string, selection: number[]]
  select: [indices: number[]]
  seek: [seconds: number]
  loop: [range: { from: number; to: number } | null]
  'toggle-loop': []
  audition: [midi: number]
}>()

const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си']
const BLACK = new Set([1, 3, 6, 8, 10])
// Paper, like the student's sheet: gold notes, the voice in ink, the cursor in the seal's red.
const C = {
  sheet: '#f7f2e6',
  laneLight: '#f3ecdd',
  laneDark: '#ebe3d0',
  line: 'rgba(28,27,25,0.05)',
  octave: 'rgba(28,27,25,0.16)',
  bar: 'rgba(120,98,52,0.45)',
  beat: 'rgba(120,98,52,0.16)',
  text: '#6b665e',
  bright: '#1c1b19',
  note: '#ecd595',
  noteEdge: '#b8902f',
  noteName: '#7a6224',
  picked: '#d9b25a',
  pickedEdge: '#1c1b19',
  ornament: '#9ec0f0',
  ornamentEdge: '#3b6fd1',
  voice: 'rgba(28,27,25,0.55)',
  slide: '#b26b00',
  vibrato: '#8a3f8f',
  offGrid: '#b26b00',
  playhead: '#a8361c',
  loop: 'rgba(217,178,90,0.12)',
  loopDim: 'rgba(28,27,25,0.03)',
  loopBar: '#d9b25a',
  loopOff: 'rgba(28,27,25,0.18)',
  onBeat: '#2f7d4f',
  offBeat: '#b26b00',
  preview: '#1c1b19',
  band: 'rgba(28,27,25,0.55)',
  ruler: '#efe7d6',
  rulerLine: 'rgba(28,27,25,0.08)',
  overview: '#efe7d6',
  window: 'rgba(28,27,25,0.05)',
  windowEdge: 'rgba(28,27,25,0.5)',
  keyWhite: '#fbf8f1',
  keyWhiteOut: '#e9e2d2',
  keyBlack: '#3a3833',
  keyBlackOut: '#7c776e',
  keyText: '#1c1b19',
  keyTextBlack: '#e9e4d8',
}
const SANS = '"Golos Text Variable", system-ui, sans-serif'
const SERIF = '"Literata Variable", Georgia, serif'
const GUTTER = 46
const RULER = 30
const OVERVIEW = 34
/** A finger is not a mouse: what it grabs is wider. */
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const GRAB = coarse ? 16 : 6
const LONG_PRESS = 450

const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0

// ─── View: time window and pitch range ────────────────────────────────────────────────────────

const zoom = ref(1)
const offset = ref(0)
const whole = computed(() => Math.max(0.5, props.span.to - props.span.from))
const visible = computed(() => whole.value / zoom.value)
/** The pitch range drawn; fitted to the notes in view unless a gesture is under way. */
let pitchLow = 57
let pitchHigh = 72

function clampOffset(value: number): number {
  return Math.min(Math.max(props.span.from, value), props.span.from + whole.value - visible.value)
}
function setWindow(from: number, length: number): void {
  zoom.value = Math.min(60, Math.max(1, whole.value / Math.max(0.2, length)))
  offset.value = clampOffset(from)
}
function zoomBy(factor: number, anchor = offset.value + visible.value / 2): void {
  const share = (anchor - offset.value) / visible.value
  zoom.value = Math.min(60, Math.max(1, zoom.value * factor))
  offset.value = clampOffset(anchor - share * visible.value)
  draw()
}

/** Pitch range around the notes (and voice) between `from` and `to`, an octave at least. */
function fitPitch(from: number, to: number, only?: readonly PartNote[]): void {
  let low = Infinity
  let high = -Infinity
  for (const note of only ?? shown.value) {
    if (note.end < from || note.start > to) continue
    low = Math.min(low, note.midi)
    high = Math.max(high, note.midi)
  }
  const contour = props.contour
  if (contour && !only) {
    const a = Math.max(0, Math.floor((from - contour.start) * contour.frameRate))
    const b = Math.min(contour.midi.length, Math.ceil((to - contour.start) * contour.frameRate))
    for (let i = a; i < b; i++) {
      const v = contour.midi[i]!
      if (!Number.isFinite(v)) continue
      low = Math.min(low, v)
      high = Math.max(high, v)
    }
  }
  if (!Number.isFinite(low)) {
    if (!props.notes.length) {
      pitchLow = 57
      pitchHigh = 72
    }
    return
  }
  low = Math.floor(low) - 1
  high = Math.ceil(high) + 1
  const short = 13 - (high - low)
  if (short > 0) {
    low -= Math.floor(short / 2)
    high += Math.ceil(short / 2)
  }
  pitchLow = low
  pitchHigh = high
}

function fit(): void {
  const picked = props.selection.map((i) => props.notes[i]).filter((n): n is PartNote => !!n)
  if (picked.length) {
    const from = Math.min(...picked.map((n) => n.slideIn ?? n.start))
    const to = Math.max(...picked.map((n) => n.end))
    const pad = Math.max(0.3, (to - from) * 0.25)
    setWindow(from - pad, to - from + 2 * pad)
    fitPitch(from, to, picked)
  } else {
    zoom.value = 1
    offset.value = props.span.from
    fitPitch(props.span.from, props.span.to)
  }
  draw()
}

/** Notes as drawn: the page's, or a gesture's draft while it is under way. */
const draft = ref<PartNote[] | null>(null)
const shown = computed(() => draft.value ?? props.notes)

/** The last drawing's geometry, for reading the pointer back into time and pitch. */
const view = {
  top: RULER,
  bottom: 100,
  lane: 10,
  from: 0,
  to: 1,
  right: 100,
  x: (t: number) => t,
  y: (m: number) => m,
  timeAt: (px: number) => px,
  midiAt: (py: number) => py,
  overviewX: (t: number) => t,
  overviewTime: (px: number) => px,
}

// ─── Drawing ──────────────────────────────────────────────────────────────────────────────────

/** Pitch classes of the singer's mode, when one was found. */
const modeClasses = computed(() => {
  const degrees = props.scale?.degrees
  if (!degrees?.length) return null
  return new Set(degrees.map((d) => ((Math.round(d / 100) % 12) + 12) % 12))
})

function draw(): void {
  const c = ctx
  if (c === null || width === 0) return
  const top = RULER
  const bottom = height - OVERVIEW
  if (!gesture) fitPitch(offset.value, offset.value + visible.value)
  const low = pitchLow
  const high = pitchHigh
  const lane = (bottom - top) / (high - low + 1)
  const y = (midi: number) => bottom - (midi - low + 0.5) * lane
  const from = offset.value
  const to = from + visible.value
  const right = width - 4
  const x = (t: number) => GUTTER + ((t - from) / (to - from)) * (right - GUTTER)
  const spanLength = Math.max(0.1, props.span.to - props.span.from)
  Object.assign(view, {
    top,
    bottom,
    lane,
    from,
    to,
    right,
    x,
    y,
    timeAt: (px: number) => from + ((px - GUTTER) / (right - GUTTER)) * (to - from),
    midiAt: (py: number) => low - 0.5 + (bottom - py) / lane,
    overviewX: (t: number) => GUTTER + ((t - props.span.from) / spanLength) * (right - GUTTER),
    overviewTime: (px: number) => props.span.from + ((px - GUTTER) / (right - GUTTER)) * spanLength,
  })

  c.fillStyle = C.sheet
  c.fillRect(0, 0, width, height)

  // ── Main area ──
  c.save()
  c.beginPath()
  c.rect(GUTTER, top, right - GUTTER, bottom - top)
  c.clip()

  // Lanes: the mode's lighter, or piano keys.
  for (let m = low; m <= high; m++) {
    const pc = ((m % 12) + 12) % 12
    const light = modeClasses.value ? modeClasses.value.has(pc) : !BLACK.has(pc)
    c.fillStyle = light ? C.laneLight : C.laneDark
    c.fillRect(GUTTER, y(m) - lane / 2, right - GUTTER, lane)
    c.fillStyle = pc === 0 ? C.octave : C.line
    c.fillRect(GUTTER, Math.round(y(m) + lane / 2), right - GUTTER, 1)
  }

  if (props.loop) {
    c.fillStyle = props.looping ? C.loop : C.loopDim
    c.fillRect(x(props.loop.from), top, x(props.loop.to) - x(props.loop.from), bottom - top)
  }

  const grid = props.grid
  if (grid) {
    const beat = 60 / grid.bpm
    const pixelsPerBeat = (beat / (to - from)) * (right - GUTTER)
    for (let k = Math.floor((from - grid.offset) / beat); beatTime(grid, k) <= to; k++) {
      const isBar = ((k % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0
      if (!isBar && pixelsPerBeat < 8) continue
      c.fillStyle = isBar ? C.bar : C.beat
      c.fillRect(Math.round(x(beatTime(grid, k))), top, 1, bottom - top)
    }
  }

  const scale = props.scale
  if (scale && scale.degrees.length) {
    c.setLineDash([5, 5])
    c.lineWidth = 1
    for (const degree of scale.degrees) {
      const off = degree - scale.tuning - Math.round((degree - scale.tuning) / 100) * 100
      if (Math.abs(off) <= 25) continue // on the grid: the lane says it already
      c.strokeStyle = C.offGrid
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

  // Notes.
  const notes = shown.value
  const picked = new Set(props.selection)
  const barHeight = Math.max(5, lane * 0.74)
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!
    if (note.end < from || (note.slideIn ?? note.start) > to) continue
    const color = note.ornament ? C.ornamentEdge : C.noteEdge
    const on = props.editable && picked.has(i)
    const x0 = x(note.start)
    const x1 = Math.max(x0 + 2, x(note.end))
    c.fillStyle = on ? C.picked : note.ornament ? C.ornament : C.note
    roundRect(c, x0, y(note.midi) - barHeight / 2, x1 - x0, barHeight, Math.min(5, barHeight / 3))
    c.fill()
    c.strokeStyle = on ? C.pickedEdge : color
    c.lineWidth = on ? 2 : 1
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
    const bar = x1 - x0
    if (bar > 26 && barHeight >= 9) {
      c.fillStyle = note.ornament ? C.ornamentEdge : C.noteName
      c.font = `${Math.min(12, barHeight * 0.8)}px ${SERIF}`
      c.textBaseline = 'bottom'
      c.textAlign = 'left'
      const name = NAMES[((note.midi % 12) + 12) % 12]!
      c.fillText(note.vibrato ? `${name} ∿` : name, x0 + 3, y(note.midi) - barHeight / 2 - 1)
    }
    if (note.lyric) {
      c.fillStyle = C.bright
      c.font = `600 ${Math.max(12, Math.min(15, lane * 0.9))}px ${SERIF}`
      c.textBaseline = 'top'
      c.textAlign = 'left'
      c.fillText(note.lyric, x0 + 2, y(note.midi) + barHeight / 2 + 2)
    }
  }

  // The voice.
  const contour = props.contour
  if (contour && props.voice) {
    const first = Math.max(0, Math.floor((from - contour.start) * contour.frameRate) - 1)
    const last = Math.min(
      contour.midi.length,
      Math.ceil((to - contour.start) * contour.frameRate) + 2,
    )
    c.globalAlpha = 0.9
    c.lineWidth = 1.5
    c.lineJoin = 'round'
    c.lineCap = 'round'
    for (let i = first + 1; i < last; i++) {
      const a = contour.midi[i - 1]!
      const b = contour.midi[i]!
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 3) continue
      const kind = contour.classes?.[i]
      c.strokeStyle = kind === FRAME.SLIDE ? C.slide : kind === FRAME.VIBRATO ? C.vibrato : C.voice
      c.beginPath()
      c.moveTo(x(contour.start + (i - 1) / contour.frameRate), y(a))
      c.lineTo(x(contour.start + i / contour.frameRate), y(b))
      c.stroke()
    }
    c.globalAlpha = 1
  }

  // Time mode: the boundaries, green on the beat.
  if (props.editable && props.mode === 'time') {
    for (const b of boundaries(notes)) {
      const px = x(b.time)
      if (px < GUTTER || px > right) continue
      const onBeat = grid
        ? Math.abs(snap(b.time, grid, props.snapTo ?? 0.5) - b.time) < 0.015
        : true
      c.fillStyle = onBeat ? C.onBeat : C.offBeat
      const note = notes[b.index]!
      const yy = y(note.midi)
      c.fillRect(Math.round(px) - 1, yy - lane * 1.2, 2, lane * 2.4)
      c.beginPath()
      c.arc(px, yy - lane * 1.2, coarse ? 6 : 4, 0, Math.PI * 2)
      c.fill()
    }
  }

  // Notes mode: what a tap would do.
  if (props.editable && preview) {
    c.setLineDash([4, 3])
    c.strokeStyle = C.preview
    c.lineWidth = 2
    if (preview.kind === 'cut') {
      const note = notes[preview.index]
      if (note) {
        const px = x(preview.time)
        c.beginPath()
        c.moveTo(px, y(note.midi) - barHeight)
        c.lineTo(px, y(note.midi) + barHeight)
        c.stroke()
      }
    } else {
      const a = notes[preview.index]
      const b = notes[preview.index + 1]
      if (a && b) {
        const main = b.end - b.start > a.end - a.start ? b : a
        c.globalAlpha = 0.8
        roundRect(c, x(a.start), y(main.midi) - barHeight / 2, x(b.end) - x(a.start), barHeight, 4)
        c.stroke()
        c.globalAlpha = 1
      }
    }
    c.setLineDash([])
  }

  if (band) {
    c.strokeStyle = C.band
    c.lineWidth = 1
    c.setLineDash([3, 3])
    c.strokeRect(
      Math.min(band.x0, band.x1),
      Math.min(band.y0, band.y1),
      Math.abs(band.x1 - band.x0),
      Math.abs(band.y1 - band.y0),
    )
    c.setLineDash([])
  }

  if (props.now !== null && props.now >= from && props.now <= to) {
    c.fillStyle = C.playhead
    c.fillRect(Math.round(x(props.now)) - 1, top, 2, bottom - top)
  }
  c.restore()

  // ── Keyboard down the left ──
  for (let m = low; m <= high; m++) {
    const pc = ((m % 12) + 12) % 12
    const inMode = modeClasses.value ? modeClasses.value.has(pc) : true
    const black = BLACK.has(pc)
    c.fillStyle = black
      ? inMode
        ? C.keyBlack
        : C.keyBlackOut
      : inMode
        ? C.keyWhite
        : C.keyWhiteOut
    c.fillRect(0, y(m) - lane / 2 + 0.5, GUTTER - 2, Math.max(1, lane - 1))
    if (lane >= 9 || pc === 0) {
      c.fillStyle = black ? C.keyTextBlack : C.keyText
      c.font = `${Math.max(9, Math.min(12, lane * 0.75))}px ${SERIF}`
      c.textAlign = 'right'
      c.textBaseline = 'middle'
      c.fillText(pc === 0 ? `до${Math.floor(m / 12) - 1}` : NAMES[pc]!, GUTTER - 6, y(m))
    }
  }

  // ── Time bar on top: cursor in the upper half, the stretch to repeat in the lower ──
  c.fillStyle = C.ruler
  c.fillRect(0, 0, width, RULER)
  c.fillStyle = C.rulerLine
  c.fillRect(GUTTER, RULER / 2, right - GUTTER, 1)
  c.font = `11px ${SANS}`
  c.textBaseline = 'middle'
  c.textAlign = 'left'
  c.fillStyle = C.text
  if (grid) {
    const beat = 60 / grid.bpm
    const barSeconds = beat * grid.beatsPerBar
    const pixelsPerBar = (barSeconds / (to - from)) * (right - GUTTER)
    const every = Math.max(1, Math.ceil(40 / pixelsPerBar))
    for (
      let bar = Math.ceil((from - grid.offset) / barSeconds);
      grid.offset + bar * barSeconds <= to;
      bar++
    ) {
      if (bar % every !== 0) continue
      const px = x(grid.offset + bar * barSeconds)
      if (px < GUTTER) continue
      c.fillRect(Math.round(px), 2, 1, RULER / 2 - 2)
      c.fillText(`${bar + 1}`, px + 3, RULER / 4 + 1)
    }
  } else {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30]
    const perSecond = (right - GUTTER) / (to - from)
    const tick = steps.find((s) => s * perSecond >= 56) ?? 60
    for (let t = Math.ceil(from / tick) * tick; t <= to; t += tick) {
      const px = x(t)
      c.fillRect(Math.round(px), 2, 1, RULER / 2 - 2)
      c.fillText(tick < 1 ? t.toFixed(1) : `${Math.round(t)}`, px + 3, RULER / 4 + 1)
    }
  }
  if (props.loop) {
    const a = Math.max(GUTTER, x(props.loop.from))
    const b = Math.min(right, x(props.loop.to))
    if (b > a) {
      c.fillStyle = props.looping ? C.loopBar : C.loopOff
      c.fillRect(a, RULER / 2 + 4, b - a, RULER / 2 - 8)
    }
  }
  if (props.now !== null && props.now >= from && props.now <= to) {
    const px = x(props.now)
    c.fillStyle = C.playhead
    c.beginPath()
    c.moveTo(px - 5, 2)
    c.lineTo(px + 5, 2)
    c.lineTo(px, RULER / 2 - 1)
    c.closePath()
    c.fill()
  }

  // ── Overview below: the whole part, the window on it ──
  const oTop = bottom
  c.fillStyle = C.overview
  c.fillRect(0, oTop, width, OVERVIEW)
  const all = shown.value
  if (all.length) {
    const lo = Math.min(...all.map((n) => n.midi))
    const hi = Math.max(lo + 6, ...all.map((n) => n.midi))
    for (const note of all) {
      const oy = oTop + OVERVIEW - 6 - ((note.midi - lo) / (hi - lo)) * (OVERVIEW - 12)
      c.fillStyle = note.ornament ? C.ornamentEdge : C.noteEdge
      c.fillRect(
        view.overviewX(note.start),
        oy - 1,
        Math.max(1, view.overviewX(note.end) - view.overviewX(note.start)),
        2,
      )
    }
  }
  const wx0 = view.overviewX(from)
  const wx1 = view.overviewX(to)
  c.fillStyle = C.window
  c.fillRect(wx0, oTop + 2, wx1 - wx0, OVERVIEW - 4)
  c.strokeStyle = C.windowEdge
  c.lineWidth = 1.5
  c.strokeRect(wx0 + 0.75, oTop + 2.75, wx1 - wx0 - 1.5, OVERVIEW - 5.5)
  c.fillStyle = C.windowEdge
  c.fillRect(wx0, oTop + OVERVIEW / 2 - 6, 3, 12)
  c.fillRect(wx1 - 3, oTop + OVERVIEW / 2 - 6, 3, 12)
  if (props.now !== null) {
    c.fillStyle = C.playhead
    c.fillRect(Math.round(view.overviewX(props.now)), oTop, 1, OVERVIEW)
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

// ─── Hit tests ────────────────────────────────────────────────────────────────────────────────

/** Note bars' edges that can be dragged: every end, and starts with no note touching before. */
function boundaries(notes: readonly PartNote[]) {
  const out: { index: number; edge: 'start' | 'end'; time: number }[] = []
  notes.forEach((note, i) => {
    if (i === 0 || !touching(notes, i - 1)) out.push({ index: i, edge: 'start', time: note.start })
    out.push({ index: i, edge: 'end', time: note.end })
  })
  return out
}

function noteAtPoint(px: number, py: number): number {
  const half = Math.max(view.lane * 0.5, coarse ? 14 : 6)
  const notes = props.notes
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!
    if (Math.abs(py - view.y(note.midi)) > half) continue
    if (
      px >= view.x(note.start) - 2 &&
      px <= Math.max(view.x(note.start) + 3, view.x(note.end)) + 2
    )
      return i
  }
  return -1
}

function boundaryAt(px: number, py: number) {
  let best: { index: number; edge: 'start' | 'end'; time: number } | null = null
  let distance = GRAB
  for (const b of boundaries(props.notes)) {
    const note = props.notes[b.index]!
    if (Math.abs(py - view.y(note.midi)) > Math.max(view.lane * 1.5, coarse ? 28 : 14)) continue
    const d = Math.abs(px - view.x(b.time))
    if (d <= distance) {
      best = b
      distance = d
    }
  }
  return best
}

const snapTime = (t: number) =>
  props.grid && props.snapTo ? snap(t, props.grid, props.snapTo) : Math.round(t * 1000) / 1000

/** Notes mode: cutting inside a note, or joining at the line between two touching notes. */
type Preview = { kind: 'cut'; index: number; time: number } | { kind: 'join'; index: number }
let preview: Preview | null = null
function previewAt(px: number, py: number): Preview | null {
  const b = boundaryAt(px, py)
  if (b && b.edge === 'end' && touching(props.notes, b.index))
    return { kind: 'join', index: b.index }
  if (b && b.edge === 'start' && b.index > 0 && touching(props.notes, b.index - 1))
    return { kind: 'join', index: b.index - 1 }
  const i = noteAtPoint(px, py)
  if (i < 0) return null
  const note = props.notes[i]!
  const time = snapTime(view.timeAt(px))
  if (time - note.start < 0.03 || note.end - time < 0.03) return null
  return { kind: 'cut', index: i, time }
}

// ─── Gestures ─────────────────────────────────────────────────────────────────────────────────

type Gesture =
  | { kind: 'seek' }
  | { kind: 'loop'; from: number; moved: boolean; x: number }
  | { kind: 'overview'; edge: 'move' | 'left' | 'right'; grab: number }
  | { kind: 'pan'; x: number; offset: number }
  | { kind: 'band'; add: boolean }
  | { kind: 'pitch'; y: number; index: number; group: number[] }
  | { kind: 'move'; t: number; first: number; index: number; group: number[] }
  | { kind: 'boundary'; index: number; edge: 'start' | 'end' }
  | { kind: 'notes'; x: number; y: number }
  | { kind: 'pinch'; distance: number; mid: number; offset: number; zoom: number }
  | { kind: 'audition' }
let gesture: Gesture | null = null
let band: { x0: number; y0: number; x1: number; y1: number } | null = null
const pointers = new Map<number, { x: number; y: number }>()
let pressTimer = 0
let moved = false
let lastTap = { at: 0, x: 0, y: 0 }

function point(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function isDoubleTap(px: number, py: number): boolean {
  const at = performance.now()
  const double =
    at - lastTap.at < 350 && Math.hypot(px - lastTap.x, py - lastTap.y) < (coarse ? 24 : 8)
  lastTap = double ? { at: 0, x: 0, y: 0 } : { at, x: px, y: py }
  return double
}

/** A tap on a note picks it; with ⇧ or ⌘ (or a long press) it joins or leaves the pick. */
function pick(index: number, toggle: boolean): void {
  const current = props.selection
  if (toggle) {
    emit(
      'select',
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
    )
  } else if (!current.includes(index)) emit('select', [index])
}

function onDown(event: PointerEvent): void {
  const { x: px, y: py } = point(event)
  try {
    canvas.value?.setPointerCapture(event.pointerId)
  } catch {
    // A pointer the browser does not track (synthetic): no capture needed.
  }
  pointers.set(event.pointerId, { x: px, y: py })
  moved = false
  clearTimeout(pressTimer)

  if (pointers.size === 2) {
    // Two fingers: whatever one finger began is dropped; pan and pinch from here.
    draft.value = null
    band = null
    preview = null
    const [a, b] = [...pointers.values()]
    gesture = {
      kind: 'pinch',
      distance: Math.max(10, Math.abs(a!.x - b!.x)),
      mid: view.timeAt((a!.x + b!.x) / 2),
      offset: offset.value,
      zoom: zoom.value,
    }
    draw()
    return
  }
  if (pointers.size > 2) return

  // Time bar.
  if (py < RULER) {
    if (py < RULER / 2) {
      gesture = { kind: 'seek' }
      emit('seek', clampTime(view.timeAt(px)))
      return
    }
    if (event.button === 2) {
      emit('loop', null)
      return
    }
    const t = clampTime(view.timeAt(px))
    if (props.loop && t >= props.loop.from && t <= props.loop.to && isDoubleTap(px, py)) {
      emit('toggle-loop')
      return
    }
    gesture = { kind: 'loop', from: t, moved: false, x: px }
    // A long press on the bar clears the stretch: touch has no right button.
    pressTimer = window.setTimeout(() => {
      if (gesture?.kind === 'loop' && !gesture.moved) {
        emit('loop', null)
        gesture = null
      }
    }, LONG_PRESS + 150)
    return
  }

  // Overview.
  if (py > view.bottom) {
    const wx0 = view.overviewX(view.from)
    const wx1 = view.overviewX(view.to)
    const edgeGrab = coarse ? 14 : 6
    if (Math.abs(px - wx0) <= edgeGrab) gesture = { kind: 'overview', edge: 'left', grab: 0 }
    else if (Math.abs(px - wx1) <= edgeGrab) gesture = { kind: 'overview', edge: 'right', grab: 0 }
    else {
      if (px < wx0 || px > wx1) {
        offset.value = clampOffset(view.overviewTime(px) - visible.value / 2)
        draw()
      }
      gesture = { kind: 'overview', edge: 'move', grab: view.overviewTime(px) - offset.value }
    }
    return
  }

  // Keyboard: hear the note.
  if (px < GUTTER) {
    gesture = { kind: 'audition' }
    emit('audition', Math.round(view.midiAt(py)))
    return
  }

  if (!props.editable) {
    emit('seek', clampTime(view.timeAt(px)))
    if (zoom.value > 1) gesture = { kind: 'pan', x: event.clientX, offset: offset.value }
    return
  }

  const toggle = event.shiftKey || event.metaKey || event.ctrlKey
  if (props.mode === 'notes') {
    gesture = { kind: 'notes', x: px, y: py }
    preview = previewAt(px, py)
    draw()
    return
  }
  if (props.mode === 'time') {
    const b = boundaryAt(px, py)
    if (b) {
      if (isDoubleTap(px, py) && props.grid) {
        // On the beat.
        const at = snap(b.time, props.grid, props.snapTo ?? 1)
        const next =
          b.edge === 'end'
            ? moveBoundary(props.notes, b.index, at, props.ripple)
            : resize(props.notes, b.index, 'start', at)
        emit('edit', next, 'На долю', [...props.selection])
        return
      }
      gesture = { kind: 'boundary', index: b.index, edge: b.edge }
      return
    }
  }
  const index = noteAtPoint(px, py)
  if (index >= 0) {
    if (toggle) {
      pick(index, true)
      return
    }
    // The pick changes when the finger lifts or starts dragging, not on touching: a long press
    // must still be able to add this note to what was picked before.
    const group = props.selection.includes(index) ? [...props.selection] : [index]
    gesture =
      props.mode === 'time'
        ? { kind: 'move', t: view.timeAt(px), first: index, index, group }
        : { kind: 'pitch', y: py, index, group }
    pressTimer = window.setTimeout(() => {
      // Long press: add to (or take from) the pick, for fingers.
      if (!moved && gesture && (gesture.kind === 'pitch' || gesture.kind === 'move')) {
        gesture = null
        emit(
          'select',
          props.selection.includes(index)
            ? props.selection.filter((i) => i !== index)
            : [...props.selection, index],
        )
      }
    }, LONG_PRESS)
    return
  }
  // Empty paper.
  if (isDoubleTap(px, py) && props.mode === 'pitch') {
    addAt(px, py)
    return
  }
  band = { x0: px, y0: py, x1: px, y1: py }
  gesture = { kind: 'band', add: toggle }
}

function clampTime(t: number): number {
  return Math.min(props.span.to, Math.max(props.span.from, t))
}

function addAt(px: number, py: number): void {
  const midi = Math.round(view.midiAt(py))
  const start = snapTime(view.timeAt(px))
  const length = props.grid ? (60 / props.grid.bpm) * (props.snapTo ?? 1) : 0.3
  const next = add(props.notes, midi, start, start + length)
  if (next.length === props.notes.length) return
  const index = next.findIndex((n) => !props.notes.includes(n))
  emit('edit', next, 'Новая нота', index >= 0 ? [index] : [])
}

function onMove(event: PointerEvent): void {
  const p = point(event)
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p)
  const { x: px, y: py } = p

  if (!gesture) {
    // Hover (mouse): the notes mode shows what a click would do; the cursor shows what it grabs.
    if (!props.editable || !canvas.value) return
    let cursor = 'default'
    if (py < RULER) cursor = py < RULER / 2 ? 'pointer' : 'col-resize'
    else if (py > view.bottom) cursor = 'grab'
    else if (px < GUTTER) cursor = 'pointer'
    else if (props.mode === 'notes') {
      preview = previewAt(px, py)
      cursor = preview ? (preview.kind === 'cut' ? 'crosshair' : 'col-resize') : 'default'
      draw()
    } else if (props.mode === 'time' && boundaryAt(px, py)) cursor = 'ew-resize'
    else if (noteAtPoint(px, py) >= 0) cursor = props.mode === 'time' ? 'grab' : 'ns-resize'
    canvas.value.style.cursor = cursor
    return
  }
  switch (gesture.kind) {
    case 'pinch': {
      const [a, b] = [...pointers.values()]
      if (!a || !b) return
      const distance = Math.max(10, Math.abs(a.x - b.x))
      const factor = distance / gesture.distance
      zoom.value = Math.min(60, Math.max(1, gesture.zoom * factor))
      const midX = (a.x + b.x) / 2
      const share = (midX - GUTTER) / Math.max(1, view.right - GUTTER)
      offset.value = clampOffset(gesture.mid - share * visible.value)
      draw()
      return
    }
    case 'seek':
      emit('seek', clampTime(view.timeAt(px)))
      return
    case 'loop': {
      if (Math.abs(px - gesture.x) < 4 && !gesture.moved) return
      gesture.moved = true
      clearTimeout(pressTimer)
      const onGrid = (t: number) => (props.grid ? snap(t, props.grid, 1) : t)
      const a = onGrid(gesture.from)
      const b = onGrid(clampTime(view.timeAt(px)))
      if (Math.abs(b - a) > 0.05) emit('loop', { from: Math.min(a, b), to: Math.max(a, b) })
      return
    }
    case 'overview': {
      const t = view.overviewTime(px)
      if (gesture.edge === 'move') offset.value = clampOffset(t - gesture.grab)
      else if (gesture.edge === 'left') {
        const end = view.to
        setWindow(Math.min(t, end - 0.2), end - Math.min(t, end - 0.2))
      } else setWindow(view.from, Math.max(0.2, t - view.from))
      draw()
      return
    }
    case 'pan': {
      const seconds = visible.value / Math.max(1, width - GUTTER)
      offset.value = clampOffset(gesture.offset - (event.clientX - gesture.x) * seconds)
      draw()
      return
    }
    case 'band': {
      band!.x1 = px
      band!.y1 = py
      moved = true
      draw()
      return
    }
    case 'pitch': {
      const semis = Math.round((gesture.y - py) / view.lane)
      if (semis !== 0) moved = true
      if (moved) clearTimeout(pressTimer)
      if (moved && props.selection.join() !== gesture.group.join()) emit('select', gesture.group)
      draft.value = semis ? transposeMany(props.notes, gesture.group, semis) : null
      draw()
      return
    }
    case 'move': {
      const note = props.notes[gesture.first]
      if (!note) return
      const dt = view.timeAt(px) - gesture.t
      if (Math.abs(dt) * ((view.right - GUTTER) / (view.to - view.from)) > 3) moved = true
      if (!moved) return
      clearTimeout(pressTimer)
      if (props.selection.join() !== gesture.group.join()) emit('select', gesture.group)
      draft.value = moveMany(props.notes, gesture.group, snapTime(note.start + dt) - note.start)
      draw()
      return
    }
    case 'boundary': {
      moved = true
      const t = snapTime(view.timeAt(px))
      draft.value =
        gesture.edge === 'end'
          ? moveBoundary(props.notes, gesture.index, t, props.ripple)
          : resize(props.notes, gesture.index, 'start', t)
      draw()
      return
    }
    case 'notes': {
      if (Math.hypot(px - gesture.x, py - gesture.y) > (coarse ? 14 : 8)) moved = true
      preview = moved ? null : previewAt(px, py)
      draw()
      return
    }
  }
}

function onUp(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  clearTimeout(pressTimer)
  const g = gesture
  if (g?.kind === 'pinch') {
    // One finger still down: nothing more until both are up.
    if (pointers.size === 0) gesture = null
    return
  }
  gesture = null
  if (!g) return
  if (g.kind === 'band' && band) {
    const x0 = Math.min(band.x0, band.x1)
    const x1 = Math.max(band.x0, band.x1)
    const y0 = Math.min(band.y0, band.y1)
    const y1 = Math.max(band.y0, band.y1)
    const inside = props.notes
      .map((n, i) => ({ n, i }))
      .filter(
        ({ n }) =>
          view.x(n.end) >= x0 &&
          view.x(n.start) <= x1 &&
          view.y(n.midi) >= y0 &&
          view.y(n.midi) <= y1,
      )
      .map(({ i }) => i)
    if (moved) emit('select', g.add ? [...props.selection, ...inside] : inside)
    else if (!g.add) emit('select', [])
    band = null
  } else if (g.kind === 'notes') {
    if (!moved && preview) {
      if (preview.kind === 'cut')
        emit('edit', split(props.notes, preview.index, preview.time), 'Разрезать', [preview.index])
      else
        emit('edit', joinRange(props.notes, preview.index, preview.index + 1), 'Склеить', [
          preview.index,
        ])
    }
    preview = null
  } else if ((g.kind === 'pitch' || g.kind === 'move') && !moved && !draft.value) {
    // A tap: this note alone is picked.
    emit('select', [g.index])
  } else if (draft.value && (g.kind === 'pitch' || g.kind === 'move' || g.kind === 'boundary')) {
    const label = g.kind === 'pitch' ? 'Высота' : g.kind === 'move' ? 'Сдвиг' : 'Граница'
    emit('edit', draft.value, label, 'group' in g ? g.group : [...props.selection])
  }
  draft.value = null
  draw()
}

function onWheel(event: WheelEvent): void {
  const seconds = visible.value / Math.max(1, width - GUTTER)
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    zoomBy(Math.exp(-event.deltaY * 0.01), offset.value + (event.offsetX - GUTTER) * seconds)
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

// ─── Life ─────────────────────────────────────────────────────────────────────────────────────

let observer: ResizeObserver | null = null
onMounted(() => {
  offset.value = props.span.from
  observer = new ResizeObserver(resizeCanvas)
  if (canvas.value) observer.observe(canvas.value)
  resizeCanvas()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  clearTimeout(pressTimer)
})

watch(
  () => [
    props.notes,
    props.contour,
    props.scale,
    props.grid,
    props.selection,
    props.loop,
    props.looping,
    props.editable,
    props.mode,
    props.voice,
  ],
  () => {
    if (props.mode !== 'notes') preview = null
    draw()
  },
)
watch(
  () => [props.span.from, props.span.to],
  () => {
    offset.value = clampOffset(offset.value)
    draw()
  },
)
watch(() => props.fitRequest, fit)
watch(
  () => props.zoomRequest.n,
  () => zoomBy(props.zoomRequest.by),
)
// The view follows the cursor when it runs off either side.
watch(
  () => props.now,
  (now) => {
    if (
      now !== null &&
      !gesture &&
      (now > offset.value + visible.value * 0.95 || now < offset.value)
    )
      offset.value = clampOffset(now - visible.value * 0.1)
    draw()
  },
)

const ornaments = computed(() => props.notes.filter((n) => n.ornament).length)
const summary = computed(() => {
  const parts = [`${props.notes.length - ornaments.value} нот`]
  if (ornaments.value) parts.push(`${ornaments.value} украш.`)
  if (props.editable && props.selection.length) parts.push(`выбрано ${props.selection.length}`)
  if (props.grid) parts.push(`${Math.round(props.grid.bpm * 10) / 10} BPM`)
  if (props.scale) {
    parts.push(`A4 ${props.scale.a4.toFixed(1)} Гц`)
    parts.push(props.scale.microtonal ? 'микротоны' : '12-TET')
  }
  return parts.join(' · ')
})
defineExpose({ fit })
</script>

<template>
  <div class="part">
    <canvas
      ref="canvas"
      class="part__canvas"
      :class="{ editable }"
      role="img"
      :aria-label="`${label}: ${summary}`"
      @wheel="onWheel"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="!gesture && preview && ((preview = null), draw())"
      @contextmenu.prevent
    />
  </div>
</template>

<style scoped>
.part {
  width: 100%;
  height: 100%;
  background: #f7f2e6;
}
.part__canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  touch-action: pan-y;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
}
.part__canvas.editable {
  touch-action: none;
}
</style>

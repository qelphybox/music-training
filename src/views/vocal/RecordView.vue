<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import PartSheet from '@/components/pitch/PartSheet.vue'
import PlayerSettings from '@/components/pitch/PlayerSettings.vue'
import VocalIcon from '@/components/pitch/VocalIcon.vue'
import { usePartEditor, type EditorCommand } from '@/composables/usePartEditor'
import { useVocalPlayback, type PartSound } from '@/composables/useVocalPlayback'
import { detectPitch, FRAME_PERIOD, VOICED, type PitchFrames } from '@/lib/swiftf0'
import { saveVocalTraining, sharedStore } from '@/lib/vocalStore'
import { assignLyrics, estimateGrid, lyricsOf, quantize, setLyric } from '@/training/vocal/edit'
import { MELISMA_DEFAULTS, type Scale } from '@/training/vocal/melisma'
import { detectOnsets } from '@/training/vocal/onsets'
import {
  monoOf,
  noteName,
  spanOf,
  transcribe,
  transcribeFrames,
  transcribeMelisma,
  type Contour,
  type Tracker,
} from '@/training/vocal/part'
import './vocal.css'

// The teacher's side in three steps: sing the part (or bring a recording), put its notes right,
// and send the student a link. Every action of the editor stays; the rare ones fold away.

type Stage = 'idle' | 'recording' | 'reading' | 'ready' | 'send' | 'saving' | 'saved'
const stage = ref<Stage>('idle')
const error = ref<string | null>(null)
const title = ref('')
const contour = shallowRef<Contour | null>(null)
const scale = shallowRef<Scale | null>(null)
const recording = shallowRef<Blob | null>(null)
const elapsed = ref(0)
const link = ref('')
const copied = ref(false)
const sound = ref<PartSound>('recording')
const showVoice = ref(true)
const router = useRouter()
const player = useVocalPlayback()

/** Which of the three steps the page is on. */
const step = computed(() => {
  if (stage.value === 'ready') return 2
  if (stage.value === 'send' || stage.value === 'saving' || stage.value === 'saved') return 3
  return 1
})

// ─── Editing ──────────────────────────────────────────────────────────────────────────────────
// The editor (`usePartEditor`) holds the notes, the pick, the mode and the history; the sheet and
// the buttons below drive its commands. Once the part is edited by hand, the recognition knobs
// are locked: turning one would read the notes anew.
const editor = usePartEditor({
  cursor: () => player.now.value,
  togglePlay,
  setLoop: (range) => {
    player.settings.loop = range
    player.settings.looping = range !== null
  },
  toggleLoop: () => {
    if (player.settings.loop) player.settings.looping = !player.settings.looping
  },
  loopOn: () => player.settings.looping && player.settings.loop !== null,
})
const notes = editor.notes
const grid = editor.grid
const snapTo = editor.snapTo
const edited = editor.edited
const span = computed(() => spanOf(notes.value))
const lyrics = ref('')
const lyricsLeft = ref(0)

const byId = new Map(editor.commands.map((c) => [c.id, c]))
function cmd(id: string): EditorCommand {
  const found = byId.get(id)
  if (!found) throw new Error(`No editor command ${id}`)
  return found
}
const modes = [
  { id: 'mode-pitch', key: '1' },
  { id: 'mode-time', key: '2' },
  { id: 'mode-notes', key: '9' },
].map((m) => ({ ...m, command: cmd(m.id) }))
const modeHint = computed(() => {
  switch (editor.activeMode.value) {
    case 'pitch':
      return 'Тяни ноты вверх-вниз. Рамка по пустому месту — выбрать несколько, долгое нажатие — добавить к выбору.'
    case 'time':
      return 'Тяни ноту вбок или линию между нотами. Двойной тап по линии — на долю.'
    default:
      return 'Тап внутри ноты — разрезать, по линии между нотами — склеить. Пунктир показывает, что будет.'
  }
})

/** The one picked note, for its syllable. */
const single = computed(() =>
  editor.selection.value.length === 1 ? (notes.value[editor.selection.value[0]!] ?? null) : null,
)
function setSingleLyric(event: Event): void {
  const i = editor.selection.value[0]
  if (single.value && i !== undefined)
    editor.apply(setLyric(notes.value, i, (event.target as HTMLInputElement).value), 'Слог')
}
const pickedLabel = computed(() => {
  const n = editor.selection.value.length
  if (single.value) return noteName(single.value.midi).replace(/\d+$/, '')
  const tens = n % 100
  const ones = n % 10
  const word =
    tens >= 11 && tens <= 14 ? 'нот' : ones === 1 ? 'нота' : ones >= 2 && ones <= 4 ? 'ноты' : 'нот'
  return `${n} ${word}`
})
/** A pick in a pop-over menu closes it. */
function closeMenu(event: MouseEvent): void {
  if ((event.target as HTMLElement).closest('button'))
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}
function layLyrics(): void {
  const result = assignLyrics(notes.value, lyrics.value)
  lyricsLeft.value = result.left
  editor.apply(result.notes, 'Слова')
}

// The grid: guessed from the notes, set by hand, and the notes pulled onto it.
const bpmText = computed({
  get: () => (grid.value ? String(Math.round(grid.value.bpm * 10) / 10) : ''),
  set: (text: string) => {
    const bpm = Number(text.replace(',', '.'))
    if (grid.value && bpm >= 30 && bpm <= 300) grid.value = { ...grid.value, bpm }
  },
})
function scaleTempo(factor: number): void {
  if (grid.value)
    grid.value = { ...grid.value, bpm: Math.min(300, Math.max(30, grid.value.bpm * factor)) }
}
function guessGrid(): void {
  grid.value = estimateGrid(notes.value, grid.value?.beatsPerBar ?? 4)
}
function setMeter(beatsPerBar: number): void {
  if (grid.value) grid.value = { ...grid.value, beatsPerBar }
}
function downbeatHere(): void {
  if (grid.value) grid.value = { ...grid.value, offset: Math.round(player.now.value * 1000) / 1000 }
}
function quantizeAll(): void {
  if (grid.value)
    editor.apply(quantize(notes.value, grid.value, snapTo.value ?? 0.5), 'Подогнать к сетке', [])
}
const snapName = (value: number | null) =>
  value === 1 ? '1/4' : value === 0.5 ? '1/8' : value === 0.25 ? '1/16' : null
const rhythmSummary = computed(() => {
  if (!grid.value) return 'Сетки нет'
  const snapped = snapName(snapTo.value)
  return `${Math.round(grid.value.bpm)} BPM · ${grid.value.beatsPerBar}/4 · ${snapped ? `привязка ${snapped}` : 'без привязки'}`
})

function togglePlay(): void {
  if (player.playing.value) player.stop()
  else
    void player.play({ sound: sound.value, notes: notes.value, span: span.value, grid: grid.value })
}

// The sound is rendered while the teacher edits, not when play is pressed.
let prepareTimer = 0
watch([notes, sound, () => player.settings.rate], () => {
  clearTimeout(prepareTimer)
  if (!notes.value.length) return
  prepareTimer = window.setTimeout(() => void player.prepare(sound.value, notes.value), 400)
})
const loopLabel = computed(() => {
  const loop = player.settings.loop
  if (!loop || !grid.value) return 'Цикл'
  const bar = (60 / grid.value.bpm) * grid.value.beatsPerBar
  const a = Math.floor((loop.from - grid.value.offset) / bar + 0.01) + 1
  const b = Math.ceil((loop.to - grid.value.offset) / bar - 0.01)
  return b > a ? `Цикл · такты ${a}–${b}` : `Цикл · такт ${a}`
})
const clockOf = (t: number) => {
  const s = Math.max(0, t - span.value.from)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// Keys while the notes are on the page (not while typing in a field: the editor checks).
const keyDown = (event: KeyboardEvent) => stage.value === 'ready' && editor.onKeyDown(event)
const keyUp = (event: KeyboardEvent) => editor.onKeyUp(event)
onMounted(() => {
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keyDown)
  window.removeEventListener('keyup', keyUp)
})

// ─── Recording ────────────────────────────────────────────────────────────────────────────────

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let meterContext: AudioContext | null = null
let raf = 0
/** The last levels heard, newest last, for the bars while recording. */
const levels = ref<number[]>(Array.from({ length: 28 }, () => 0))

async function record(): Promise<void> {
  error.value = null
  player.stop()
  try {
    // The recording is the reference: no processing that would bend its pitch or level.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
  } catch {
    error.value = 'Микрофон не открылся — разреши доступ в браузере'
    return
  }
  const chunks: Blob[] = []
  const rec = new MediaRecorder(stream)
  recorder = rec
  rec.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  rec.onstop = () => void accept(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))

  meterContext = new AudioContext()
  const analyser = meterContext.createAnalyser()
  analyser.fftSize = 1024
  meterContext.createMediaStreamSource(stream).connect(analyser)
  const frame = new Float32Array(analyser.fftSize)
  const started = performance.now()
  levels.value = levels.value.map(() => 0)
  let frames = 0
  rec.start()
  stage.value = 'recording'
  const tick = () => {
    analyser.getFloatTimeDomainData(frame)
    let power = 0
    for (const value of frame) power += value * value
    const db = 10 * Math.log10(power / frame.length + 1e-12)
    const level = Math.min(1, Math.max(0, 1 + db / 60))
    if (++frames % 4 === 0) levels.value = [...levels.value.slice(1), level]
    elapsed.value = (performance.now() - started) / 1000
    raf = requestAnimationFrame(tick)
  }
  tick()
}

function stopRecording(): void {
  cancelAnimationFrame(raf)
  stage.value = 'reading'
  recorder?.stop()
  recorder = null
  releaseMic()
}

function releaseMic(): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  void meterContext?.close()
  meterContext = null
}

async function accept(blob: Blob): Promise<void> {
  stage.value = 'reading'
  error.value = null
  link.value = ''
  recording.value = blob
  let buffer: AudioBuffer
  try {
    buffer = await player.load(blob)
  } catch {
    error.value = 'Запись не читается — попробуй ещё раз или другой файл'
    stage.value = 'idle'
    return
  }
  samples = monoOf(buffer)
  sampleRate = buffer.sampleRate
  modelFrames = null
  onsets = null
  await read()
}

/** The decoded recording, kept to read it again another way without recording again. */
let samples: Float32Array | null = null
let sampleRate = 48000
/** SwiftF0's frames for it: turning a knob only segments them again. */
let modelFrames: PitchFrames | null = null
/** Its attacks, seconds: where a repeated note starts again. */
let onsets: number[] | null = null

/** The recording → notes with the chosen tracker. */
async function read(): Promise<void> {
  if (!samples) return
  player.stop()
  stage.value = 'reading'
  error.value = null
  link.value = ''
  try {
    let result
    if (tracker.value === 'melisma') {
      modelFrames ??= await detectPitch(samples, sampleRate)
      onsets ??= detectOnsets(samples, sampleRate)
      result = transcribeMelisma(
        modelFrames,
        FRAME_PERIOD,
        {
          ornament: ornamentMs.value / 1000,
          slide: slide.value,
          vibrato: vibrato.value,
          sensitivity: sensitivity.value,
          ornaments: ornaments.value,
        },
        onsets,
      )
    } else if (tracker.value === 'swiftf0') {
      modelFrames ??= await detectPitch(samples, sampleRate)
      result = transcribeFrames(modelFrames, FRAME_PERIOD, VOICED, fastNotes.value ? 40 : 80)
    } else {
      // Let the page say it is reading before the analysis holds the thread.
      await new Promise((resolve) => setTimeout(resolve, 50))
      result = transcribe(samples, sampleRate)
    }
    editor.reset(result.notes, estimateGrid(result.notes))
    contour.value = result.contour
    scale.value = result.scale ?? null
    lyrics.value = ''
    player.now.value = spanOf(result.notes).from
    stage.value = 'ready'
    if (result.notes.length === 0)
      error.value = 'Нот не нашлось — спой громче или ближе к микрофону'
  } catch (cause) {
    error.value = `Не получилось перегнать в ноты: ${cause instanceof Error ? cause.message : cause}`
    stage.value = contour.value ? 'ready' : 'idle'
  }
}

const tracker = ref<Tracker>('melisma')
/** Ornaments faster than 80 ms become notes of their own (vibrato may split). */
const fastNotes = ref(false)
// MELISMA's knobs (`@/training/vocal/melisma`).
const ornamentMs = ref(MELISMA_DEFAULTS.ornament * 1000)
const slide = ref(MELISMA_DEFAULTS.slide)
const vibrato = ref(MELISMA_DEFAULTS.vibrato)
const sensitivity = ref(MELISMA_DEFAULTS.sensitivity)
const ornaments = ref(MELISMA_DEFAULTS.ornaments)
watch([tracker, fastNotes, ornaments], () => void read())
// Sliders re-read once the hand stops, not on every step.
let knobTimer = 0
watch([ornamentMs, slide, vibrato, sensitivity], () => {
  clearTimeout(knobTimer)
  knobTimer = window.setTimeout(() => void read(), 150)
})
const trackers: { value: Tracker; name: string; tech: string }[] = [
  { value: 'melisma', name: 'Певческий', tech: 'MELISMA' },
  { value: 'swiftf0', name: 'Точный по кадрам', tech: 'SwiftF0' },
  { value: 'pyin', name: 'Старый', tech: 'pYIN' },
]
const trackerSummary = computed(() => {
  const name = trackers.find((t) => t.value === tracker.value)?.name ?? ''
  return edited.value ? `${name} · есть ручные правки` : name
})
/** Back to what the recognition gave, edits gone. */
function dropEdits(): void {
  if (!confirm('Ручные правки, сетка и слова пропадут. Распознать заново?')) return
  void read()
}
function resetKnobs(): void {
  ornamentMs.value = MELISMA_DEFAULTS.ornament * 1000
  slide.value = MELISMA_DEFAULTS.slide
  vibrato.value = MELISMA_DEFAULTS.vibrato
  sensitivity.value = MELISMA_DEFAULTS.sensitivity
  ornaments.value = MELISMA_DEFAULTS.ornaments
}

function pickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void accept(file)
}
const dragging = ref(false)
function dropFile(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (file && file.type.startsWith('audio/')) void accept(file)
  else if (file) error.value = 'Это не аудиофайл'
}

// ─── Sending ──────────────────────────────────────────────────────────────────────────────────

function toSend(): void {
  player.stop()
  error.value = null
  stage.value = link.value ? 'saved' : 'send'
}
function backToNotes(): void {
  error.value = null
  stage.value = 'ready'
}
// A change after the link was made needs a new link: the saved one keeps the old notes.
watch([notes, grid], () => {
  if (stage.value === 'ready') link.value = ''
})

async function save(): Promise<void> {
  if (!recording.value) return
  player.stop()
  stage.value = 'saving'
  error.value = null
  try {
    const id = await saveVocalTraining({
      title: title.value.trim(),
      notes: notes.value,
      grid: grid.value,
      audio: recording.value,
    })
    const href = router.resolve({ name: 'vocal-train', params: { id } }).href
    link.value = new URL(href, location.origin).href
    stage.value = 'saved'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не сохранилось'
    stage.value = 'send'
  }
}

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(link.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function again(): void {
  if (contour.value && !confirm('Запись, ноты и правки пропадут. Начать заново?')) return
  player.stop()
  editor.reset([], null)
  contour.value = null
  scale.value = null
  onsets = null
  recording.value = null
  samples = null
  modelFrames = null
  link.value = ''
  title.value = ''
  error.value = null
  stage.value = 'idle'
}

const clock = computed(() => {
  const s = Math.floor(elapsed.value)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  recorder?.stop()
  releaseMic()
})
</script>

<template>
  <main id="main" class="vocal rec">
    <header class="rec__head">
      <ol class="steps" aria-label="Шаги">
        <li>
          <button v-if="step > 1" type="button" class="done" @click="again">
            <VocalIcon name="check" />Запись
          </button>
          <span v-else aria-current="step">Запись</span>
          <VocalIcon name="next" class="sep" />
        </li>
        <li>
          <button v-if="step > 2" type="button" class="done" @click="backToNotes">
            <VocalIcon name="check" />Ноты
          </button>
          <span v-else :aria-current="step === 2 ? 'step' : undefined">Ноты</span>
          <VocalIcon name="next" class="sep" />
        </li>
        <li>
          <span :aria-current="step === 3 ? 'step' : undefined">Отправка</span>
        </li>
      </ol>
      <template v-if="step === 2">
        <label class="rec__title">
          <span class="visually-hidden">Название партии</span>
          <input
            v-model="title"
            class="serif"
            maxlength="120"
            placeholder="Название, например «Распевка на а»"
          />
        </label>
        <div class="rec__history">
          <button
            type="button"
            class="ib"
            :disabled="!cmd('undo').enabled.value"
            :aria-label="
              editor.past.value.length
                ? `Отменить: ${editor.past.value[editor.past.value.length - 1]!.label}`
                : 'Отменить'
            "
            @click="cmd('undo').run()"
          >
            <VocalIcon name="undo" />
          </button>
          <button
            type="button"
            class="ib"
            :disabled="!cmd('redo').enabled.value"
            aria-label="Вернуть"
            @click="cmd('redo').run()"
          >
            <VocalIcon name="redo" />
          </button>
        </div>
        <button type="button" class="btn primary" :disabled="!notes.length" @click="toSend">
          <span class="rec__send-long">Отправить ученику</span
          ><span class="rec__send-short">Дальше</span><VocalIcon name="later" />
        </button>
      </template>
    </header>

    <p v-if="error" class="error-text rec__error" role="alert">{{ error }}</p>

    <!-- ── Step 1: record or bring a file ── -->
    <section
      v-if="stage === 'idle'"
      class="rec__stage rec__drop"
      :class="{ over: dragging }"
      aria-labelledby="rec-start"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="dropFile"
    >
      <div class="rec__intro">
        <h1 id="rec-start" class="serif">Спой партию</h1>
        <p class="muted">
          Целиком и в своём темпе — так, как её должен спеть ученик. Ноты и ссылку я сделаю сам.
        </p>
      </div>
      <button type="button" class="rec__mic" @click="record">
        <VocalIcon name="mic" />
        <span>Записать</span>
      </button>
      <p class="muted rec__file">
        или перетащи сюда аудиофайл ·
        <label class="rec__file-pick">
          выбрать файл
          <input type="file" accept="audio/*" hidden @change="pickFile" />
        </label>
      </p>
    </section>

    <section v-else-if="stage === 'recording'" class="rec__stage rec__live" aria-live="polite">
      <p class="rec__on"><span aria-hidden="true" />Идёт запись</p>
      <p class="serif rec__clock num">{{ clock }}</p>
      <div class="level" role="img" aria-label="Уровень звука">
        <span
          v-for="(l, i) in levels"
          :key="i"
          :style="{ height: `${8 + l * 56}px`, opacity: 0.25 + l * 0.75 }"
        />
      </div>
      <button type="button" class="rec__stop" @click="stopRecording">
        <span aria-hidden="true" />Стоп
      </button>
      <p class="rec__after">После «Стоп» распознаю ноты — это несколько секунд.</p>
    </section>

    <section v-else-if="stage === 'reading'" class="rec__stage rec__reading" aria-live="polite">
      <p class="serif rec__reading-title">Распознаю ноты…</p>
      <div class="rec__progress" aria-hidden="true"><span /></div>
    </section>

    <!-- ── Step 2: the notes ── -->
    <div v-else-if="stage === 'ready' && contour" class="rec__editor">
      <div class="rec__main">
        <div class="rec__bar">
          <div class="seg rec__modes" role="group" aria-label="Режим правки">
            <button
              v-for="m in modes"
              :key="m.id"
              type="button"
              :aria-pressed="m.command.active?.value"
              :title="`${m.command.label} (${m.command.keys.join(' / ')})`"
              @click="m.command.run()"
            >
              {{ m.command.label }}<kbd>{{ m.key }}</kbd>
            </button>
          </div>
          <label v-if="editor.activeMode.value === 'time'" class="switch rec__ripple">
            <input
              type="checkbox"
              role="switch"
              :checked="cmd('ripple').active?.value"
              @change="cmd('ripple').run()"
            />Сдвигать остальное
          </label>
          <div class="rec__view">
            <button type="button" class="btn text small" @click="cmd('select-all').run()">
              Выбрать все
            </button>
            <button
              type="button"
              class="chip icon-only"
              :aria-pressed="showVoice"
              aria-label="Линия голоса"
              title="Линия голоса"
              @click="showVoice = !showVoice"
            >
              <VocalIcon name="voice" />
            </button>
            <button
              type="button"
              class="ib"
              aria-label="Подогнать по нотам"
              @click="cmd('fit').run()"
            >
              <VocalIcon name="fit" />
            </button>
            <button type="button" class="ib" aria-label="Мельче" @click="cmd('zoom-out').run()">
              <VocalIcon name="zoomOut" />
            </button>
            <button type="button" class="ib" aria-label="Крупнее" @click="cmd('zoom-in').run()">
              <VocalIcon name="zoomIn" />
            </button>
          </div>
        </div>

        <div class="rec__context">
          <p v-if="!editor.selection.value.length" class="muted rec__hint">{{ modeHint }}</p>
          <div
            v-if="editor.selection.value.length"
            class="picked"
            role="toolbar"
            :aria-label="single ? 'Выбранная нота' : 'Выбранные ноты'"
          >
            <span class="picked__name" :class="{ serif: single }">{{ pickedLabel }}</span>
            <button type="button" aria-label="Полутон вверх" @click="cmd('up').run()">
              <VocalIcon name="up" />
            </button>
            <button type="button" aria-label="Полутон вниз" @click="cmd('down').run()">
              <VocalIcon name="down" />
            </button>
            <button
              type="button"
              class="wide"
              aria-label="Октава вверх"
              @click="cmd('octave-up').run()"
            >
              <VocalIcon name="octaveUp" />
            </button>
            <button
              type="button"
              class="wide"
              aria-label="Октава вниз"
              @click="cmd('octave-down').run()"
            >
              <VocalIcon name="octaveDown" />
            </button>
            <span class="picked__sep wide" aria-hidden="true" />
            <button type="button" aria-label="Раньше" @click="cmd('earlier').run()">
              <VocalIcon name="earlier" />
            </button>
            <button type="button" aria-label="Позже" @click="cmd('later').run()">
              <VocalIcon name="later" />
            </button>
            <template v-if="single">
              <span class="picked__sep" aria-hidden="true" />
              <label class="picked__lyric">
                Слог
                <input
                  :key="editor.selection.value[0]"
                  class="serif"
                  :value="single.lyric ?? ''"
                  maxlength="20"
                  placeholder="ла"
                  @change="setSingleLyric"
                />
              </label>
            </template>
            <span class="picked__sep wide" aria-hidden="true" />
            <button
              type="button"
              class="wide"
              :disabled="!cmd('join').enabled.value"
              @click="cmd('join').run()"
            >
              <VocalIcon name="join" />Склеить
            </button>
            <button
              type="button"
              class="wide"
              :aria-pressed="cmd('ornament').active?.value"
              @click="cmd('ornament').run()"
            >
              <VocalIcon name="ornament" />Украшение
            </button>
            <button type="button" class="wide" @click="cmd('loop-picked').run()">
              <VocalIcon name="loop" />Повторять
            </button>
            <details class="pop picked__more">
              <summary aria-label="Ещё действия"><VocalIcon name="more" /></summary>
              <div class="pop-panel picked__menu" @click="closeMenu">
                <button type="button" class="narrow" @click="cmd('octave-up').run()">
                  <VocalIcon name="octaveUp" />Октава вверх
                </button>
                <button type="button" class="narrow" @click="cmd('octave-down').run()">
                  <VocalIcon name="octaveDown" />Октава вниз
                </button>
                <button
                  type="button"
                  class="narrow"
                  :disabled="!cmd('join').enabled.value"
                  @click="cmd('join').run()"
                >
                  <VocalIcon name="join" />Склеить
                </button>
                <button type="button" class="narrow" @click="cmd('ornament').run()">
                  <VocalIcon name="ornament" />Украшение
                </button>
                <button type="button" class="narrow" @click="cmd('loop-picked').run()">
                  <VocalIcon name="loop" />Повторять выбранное
                </button>
                <button
                  type="button"
                  :disabled="!cmd('cut').enabled.value"
                  @click="cmd('cut').run()"
                >
                  <VocalIcon name="cut" />Разрезать по курсору
                </button>
                <button type="button" @click="cmd('select-none').run()">
                  <VocalIcon name="close" />Снять выбор
                </button>
              </div>
            </details>
            <button type="button" aria-label="Удалить" @click="cmd('delete').run()">
              <VocalIcon name="trash" />
            </button>
          </div>
        </div>

        <div class="rec__sheet">
          <PartSheet
            :notes="notes"
            :contour="contour"
            :scale="scale"
            :grid="grid"
            :span="span"
            :now="player.now.value"
            :loop="player.settings.loop"
            :looping="player.settings.looping"
            :snap-to="snapTo"
            :mode="editor.activeMode.value"
            :ripple="editor.ripple.value"
            :selection="editor.selection.value"
            :fit-request="editor.fitRequest.value"
            :zoom-request="editor.zoomRequest.value"
            :voice="showVoice"
            editable
            label="Партия"
            @edit="(next, label, pick) => editor.apply(next, label, pick)"
            @select="editor.select"
            @seek="player.seek"
            @loop="
              (range) => {
                player.settings.loop = range
                player.settings.looping = range !== null
              }
            "
            @toggle-loop="player.settings.looping = !player.settings.looping"
            @audition="player.previewNote"
          />
        </div>

        <div class="rec__transport">
          <button
            type="button"
            class="rec__play"
            :aria-label="player.playing.value ? 'Стоп' : 'Играть'"
            @click="togglePlay"
          >
            <VocalIcon :name="player.playing.value ? 'pause' : 'play'" />
          </button>
          <button type="button" class="ib" aria-label="В начало" @click="player.seek(span.from)">
            <VocalIcon name="start" />
          </button>
          <span class="num rec__time"
            >{{ player.preparing.value ? 'готовлю…' : clockOf(player.now.value) }}
            <span class="muted">/ {{ clockOf(span.to) }}</span></span
          >
          <span class="rec__spacer" />
          <div class="seg" role="group" aria-label="Что играть">
            <button
              type="button"
              :aria-pressed="sound === 'recording'"
              @click="sound = 'recording'"
            >
              Запись
            </button>
            <button type="button" :aria-pressed="sound === 'notes'" @click="sound = 'notes'">
              Ноты
            </button>
          </div>
          <button
            type="button"
            class="btn quiet small"
            :aria-pressed="player.settings.looping"
            :disabled="!player.settings.loop"
            :title="player.settings.loop ? '' : 'Протяни по нижней половине линейки над листом'"
            @click="player.settings.looping = !player.settings.looping"
          >
            <VocalIcon name="loop" />{{ loopLabel }}
          </button>
          <details class="pop">
            <summary class="btn quiet small">
              <VocalIcon name="sliders" />Темп
              <b class="num">{{ Math.round(player.settings.rate * 100) }}%</b>
            </summary>
            <div class="pop-panel">
              <PlayerSettings
                :player="player"
                :grid="grid"
                loop-hint="протяни по нижней половине линейки; двойной тап — вкл/выкл"
              />
            </div>
          </details>
        </div>
      </div>

      <aside class="rec__aside" aria-label="Слова и настройки">
        <section class="rec__words">
          <div class="rec__words-head">
            <h2 class="serif">Слова</h2>
            <span v-if="notes.length && notes.every((n) => n.lyric)" class="rec__ok">
              <VocalIcon name="check" />на всех нотах
            </span>
          </div>
          <label>
            <span class="visually-hidden">Текст партии</span>
            <textarea
              v-model="lyrics"
              class="field serif"
              rows="3"
              placeholder="ма-ма мы-ла ра-му"
            />
          </label>
          <p class="muted rec__small">
            Дефис делит слоги, «_» тянет слог на следующую ноту. Слог одной ноты — в её панели.
          </p>
          <p v-if="lyricsLeft" class="notice">
            Слогов больше, чем нот: {{ lyricsLeft }} не досталось ноты.
          </p>
          <div class="rec__words-act">
            <button
              type="button"
              class="btn"
              :disabled="!notes.length || !lyrics.trim()"
              @click="layLyrics"
            >
              Разложить по нотам
            </button>
            <button
              v-if="notes.some((n) => n.lyric) && !lyrics"
              type="button"
              class="btn text small"
              @click="lyrics = lyricsOf(notes)"
            >
              Взять с нот
            </button>
          </div>
        </section>

        <details class="disc">
          <summary>
            <span class="rec__grow"
              ><span class="disc-title">Ритм и сетка</span
              ><span class="disc-sum">{{ rhythmSummary }}</span></span
            >
            <VocalIcon name="chevronDown" class="chev" />
          </summary>
          <div class="disc-body">
            <div class="rec__line">
              <label class="rec__line muted rec__small">
                Темп
                <input
                  v-model.lazy="bpmText"
                  class="field num rec__bpm"
                  inputmode="decimal"
                  :disabled="!grid"
                />
              </label>
              <span class="muted rec__small">BPM</span>
              <button
                type="button"
                class="btn quiet small"
                aria-label="Темп вдвое медленнее"
                :disabled="!grid"
                @click="scaleTempo(0.5)"
              >
                ÷2
              </button>
              <button
                type="button"
                class="btn quiet small"
                aria-label="Темп вдвое быстрее"
                :disabled="!grid"
                @click="scaleTempo(2)"
              >
                ×2
              </button>
              <button
                type="button"
                class="btn quiet small"
                :disabled="!notes.length"
                @click="guessGrid"
              >
                Угадать
              </button>
            </div>
            <div class="rec__field">
              <span class="muted rec__small">Размер</span>
              <div class="seg wide" role="group" aria-label="Размер">
                <button
                  v-for="beats in [2, 3, 4, 6]"
                  :key="beats"
                  type="button"
                  :aria-pressed="grid?.beatsPerBar === beats"
                  :disabled="!grid"
                  @click="setMeter(beats)"
                >
                  {{ beats }}/4
                </button>
              </div>
            </div>
            <button type="button" class="btn quiet small" :disabled="!grid" @click="downbeatHere">
              Первая доля — там, где курсор
            </button>
            <div class="rec__field">
              <span class="muted rec__small">Ноты прилипают к сетке</span>
              <div class="seg wide" role="group" aria-label="Привязка к сетке">
                <button
                  v-for="option in [
                    { value: null, name: 'Нет' },
                    { value: 1, name: '1/4' },
                    { value: 0.5, name: '1/8' },
                    { value: 0.25, name: '1/16' },
                  ]"
                  :key="option.name"
                  type="button"
                  :aria-pressed="snapTo === option.value"
                  @click="snapTo = option.value"
                >
                  {{ option.name }}
                </button>
              </div>
            </div>
            <button
              type="button"
              class="btn small"
              :disabled="!grid || !notes.length"
              @click="quantizeAll"
            >
              Выровнять все ноты по {{ snapName(snapTo) ?? '1/8' }}
            </button>
          </div>
        </details>

        <details class="disc">
          <summary>
            <span class="rec__grow"
              ><span class="disc-title">Распознавание</span
              ><span class="disc-sum">{{ trackerSummary }}</span></span
            >
            <VocalIcon name="chevronDown" class="chev" />
          </summary>
          <div class="disc-body">
            <div v-if="edited" class="notice rec__frozen">
              Ноты поправлены вручную, поэтому настройки ниже заморожены.
              <button type="button" class="btn quiet small" @click="dropEdits">
                Распознать заново, правки пропадут
              </button>
            </div>
            <fieldset class="rec__knobs" :disabled="edited">
              <legend class="muted rec__small">Способ</legend>
              <label v-for="t in trackers" :key="t.value" class="rec__radio">
                <input v-model="tracker" type="radio" name="tracker" :value="t.value" />
                {{ t.name }} <span class="muted rec__small">· {{ t.tech }}</span>
              </label>
              <label v-if="tracker === 'swiftf0'" class="switch">
                <input v-model="fastNotes" type="checkbox" role="switch" />
                <span>Быстрые ноты<span class="sub">мелизмы; вибрато может дробиться</span></span>
              </label>
              <template v-if="tracker === 'melisma'">
                <label class="knob">
                  <span
                    >Самая короткая нота · <b class="num">{{ ornamentMs }} мс</b></span
                  >
                  <input v-model.number="ornamentMs" type="range" min="30" max="200" step="5" />
                  <small>меньше — больше мелких нот</small>
                </label>
                <label class="knob">
                  <span
                    >Скольжение, а не нота · <b class="num">от {{ slide }} ¢/с</b></span
                  >
                  <input v-model.number="slide" type="range" min="60" max="400" step="10" />
                </label>
                <label class="knob">
                  <span
                    >Вибрато внутри ноты · <b class="num">{{ vibrato.toFixed(2) }}</b></span
                  >
                  <input v-model.number="vibrato" type="range" min="0" max="1" step="0.05" />
                  <small>больше — шире и медленнее качание остаётся одной нотой</small>
                </label>
                <label class="knob">
                  <span
                    >Отличать голос от шума · <b class="num">{{ sensitivity.toFixed(2) }}</b></span
                  >
                  <input
                    v-model.number="sensitivity"
                    type="range"
                    min="0.2"
                    max="0.8"
                    step="0.05"
                  />
                  <small>где кончается голос и начинается дыхание</small>
                </label>
                <div class="rec__line">
                  <label class="switch rec__grow">
                    <input v-model="ornaments" type="checkbox" role="switch" />
                    Украшения отдельными нотами
                  </label>
                  <button type="button" class="btn quiet small" @click="resetKnobs">
                    Как было
                  </button>
                </div>
              </template>
            </fieldset>
          </div>
        </details>

        <details class="disc">
          <summary>
            <span class="rec__grow"
              ><span class="disc-title">Клавиши и жесты</span
              ><span class="disc-sum">для мыши, клавиатуры и пальцев</span></span
            >
            <VocalIcon name="chevronDown" class="chev" />
          </summary>
          <dl class="disc-body rec__keys">
            <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>9</kbd></dt>
            <dd>Высота, Время, Ноты ± (или держи <kbd>N</kbd>)</dd>
            <dt><kbd>⌘A</kbd> <kbd>Esc</kbd></dt>
            <dd>выбрать все, снять выбор</dd>
            <dt><kbd>↑</kbd> <kbd>↓</kbd></dt>
            <dd>на полутон, с <kbd>⇧</kbd> — на октаву</dd>
            <dt><kbd>←</kbd> <kbd>→</kbd></dt>
            <dd>раньше, позже</dd>
            <dt><kbd>J</kbd> <kbd>O</kbd> <kbd>⌫</kbd></dt>
            <dd>склеить, украшение, удалить</dd>
            <dt><kbd>⌘Z</kbd> <kbd>⇧⌘Z</kbd></dt>
            <dd>отменить, вернуть</dd>
            <dt><kbd>Пробел</kbd></dt>
            <dd>играть, пауза</dd>
            <dt><kbd>A</kbd> <kbd>C</kbd></dt>
            <dd>повторять выбранное, цикл вкл/выкл</dd>
            <dt><kbd>Z</kbd> <kbd>⌘±</kbd></dt>
            <dd>по нотам, крупнее/мельче</dd>
            <dt>Жесты</dt>
            <dd>
              рамка — выбрать, долгое нажатие — добавить к выбору, двойной тап по пустому — новая
              нота, тап по клавише слева — услышать ноту, щипок — масштаб, два пальца — прокрутка
            </dd>
          </dl>
        </details>

        <p class="muted rec__small rec__foot">
          Ученик увидит ноты и слоги так же, как здесь. Линию голоса он не видит.
        </p>
      </aside>
    </div>

    <!-- ── Step 3: the link ── -->
    <section v-else-if="step === 3" class="rec__send" aria-labelledby="rec-send">
      <template v-if="stage !== 'saved'">
        <h1 id="rec-send" class="serif">Отправить ученику</h1>
        <label class="rec__field">
          <span class="muted rec__small">Название — его увидит ученик</span>
          <input
            v-model="title"
            class="field serif rec__send-title"
            maxlength="120"
            placeholder="Например, «Распевка на а»"
          />
        </label>
        <div class="rec__line">
          <button
            type="button"
            class="btn primary"
            :disabled="!notes.length || stage === 'saving'"
            @click="save"
          >
            {{ stage === 'saving' ? 'Сохраняю…' : 'Получить ссылку' }}
          </button>
          <button type="button" class="btn text" @click="backToNotes">К нотам</button>
        </div>
      </template>
      <template v-else>
        <h1 id="rec-send" class="serif">{{ title.trim() || 'Вокальная тренировка' }}</h1>
        <div class="rec__field">
          <span class="rec__saved"><VocalIcon name="check" />Сохранено. Ссылка для ученика:</span>
          <div class="rec__line">
            <input
              class="field num rec__link"
              :value="link"
              readonly
              aria-label="Ссылка для ученика"
            />
            <button type="button" class="btn primary" @click="copy">
              <VocalIcon name="copy" />{{ copied ? 'Скопировано' : 'Скопировать' }}
            </button>
          </div>
        </div>
        <div class="rec__line">
          <a class="btn" :href="link" target="_blank" rel="noopener"
            ><VocalIcon name="external" />Открыть как ученик</a
          >
          <span class="rec__spacer" />
          <button type="button" class="btn text" @click="backToNotes">К нотам</button>
          <button type="button" class="btn text" @click="again">Новая партия</button>
        </div>
        <p v-if="!sharedStore" class="notice">
          База не подключена: партия сохранена только в этом браузере, и ссылка откроется только
          здесь. Чтобы её открыл ученик, нужны ключи Supabase в <code>.env.local</code>.
        </p>
      </template>
    </section>
  </main>
</template>

<style scoped>
.rec {
  display: flex;
  flex-direction: column;
}
.rec__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 28px;
  min-height: 72px;
  padding: 8px 40px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
}
.rec__title {
  flex: 1;
  min-width: 14rem;
}
.rec__title input {
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  font-size: 24px;
  font-weight: 600;
}
.rec__title input:hover,
.rec__title input:focus {
  border-color: var(--control);
  background: var(--field);
}
.rec__history {
  display: flex;
  gap: 4px;
}
.rec__send-short {
  display: none;
}
.rec__error {
  padding: 12px 40px 0;
}

/* ── Step 1 ── */
.rec__stage {
  flex: 1;
  margin: 32px 40px 40px;
  min-height: 560px;
  border-radius: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  text-align: center;
}
.rec__drop {
  border: 1.5px dashed #c9c2b5;
}
.rec__drop.over {
  border-color: var(--ink);
  background: var(--surface);
}
.rec__intro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.rec__intro h1 {
  margin: 0;
  font-size: 40px;
  font-weight: 600;
  line-height: 1.1;
}
.rec__intro p {
  margin: 0;
  max-width: 34ch;
  font-size: 17px;
  line-height: 1.5;
  text-wrap: balance;
}
.rec__mic {
  width: 152px;
  height: 152px;
  border-radius: 50%;
  border: 0;
  background: var(--seal);
  color: var(--on-ink);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 600;
  box-shadow: 0 10px 24px rgb(120 38 20 / 22%);
}
.rec__mic .icon {
  width: 40px;
  height: 40px;
  stroke-width: 1.5;
}
.rec__file {
  margin: 0;
  font-size: 15px;
}
.rec__file-pick {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 4px;
  color: var(--ink);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.rec__live {
  background: var(--ink);
  color: var(--on-ink);
}
.rec__on {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #e9c3b6;
}
.rec__on span {
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background: #e0553a;
}
.rec__clock {
  margin: 0;
  font-size: 88px;
  font-weight: 500;
  line-height: 1;
}
.rec__stop {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 0 32px;
  border-radius: 30px;
  border: 0;
  background: var(--on-ink);
  color: var(--ink);
  font-size: 17px;
  font-weight: 600;
}
.rec__stop span {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--seal);
}
.rec__after {
  margin: 0;
  font-size: 14px;
  color: #b9b3a8;
}
.rec__reading-title {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
}
.rec__progress {
  width: min(320px, 80%);
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.rec__progress span {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: 3px;
  background: var(--ink);
  animation: reading 1.2s ease-in-out infinite alternate;
}
@keyframes reading {
  from {
    transform: translateX(-20%);
  }
  to {
    transform: translateX(170%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .rec__progress span {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}

/* ── Step 2 ── */
.rec__editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 40px;
  padding: 20px 40px 32px;
}
.rec__main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.rec__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.rec__ripple {
  font-size: 14px;
}
.rec__hint {
  margin: 0;
  max-width: 72ch;
  font-size: 14px;
}
.rec__view {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.rec__sheet {
  position: relative;
  height: clamp(380px, 58dvh, 600px);
  border-radius: 12px;
  overflow: hidden;
  background: var(--sheet);
}
.rec__context {
  display: flex;
  align-items: center;
  min-height: 48px;
}
.picked {
  position: relative;
  z-index: 5;
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  background: var(--ink);
  color: var(--on-ink);
  box-shadow: 0 6px 20px rgb(28 27 25 / 22%);
}
.picked button,
.picked summary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 40px;
  height: 40px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  white-space: nowrap;
  cursor: pointer;
}
.picked button:not(:disabled):hover,
.picked summary:hover {
  background: #3a3833;
}
.picked button[aria-pressed='true'] {
  background: #4a4842;
}
.picked button:disabled {
  opacity: 0.4;
  cursor: default;
}
.picked__name {
  padding: 0 10px 0 8px;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
}
.picked__sep {
  width: 1px;
  height: 24px;
  margin: 0 4px;
  background: #4a4842;
}
.picked__lyric {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  color: #d6d1c6;
  font-size: 14px;
}
.picked__lyric input {
  width: 52px;
  height: 32px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: #3a3833;
  color: var(--on-ink);
  font-size: 15px;
}
.picked__menu {
  top: calc(100% + 8px);
  bottom: auto;
  padding: 6px;
  gap: 0;
  width: 240px;
  color: var(--ink);
}
.picked__menu button {
  justify-content: flex-start;
  width: 100%;
  height: 44px;
}
.picked__menu button:not(:disabled):hover {
  background: var(--line-soft);
}
.picked__menu .narrow {
  display: none;
}
.rec__transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface);
}
.rec__play {
  width: 48px;
  height: 48px;
  flex: none;
  border-radius: 50%;
  border: 0;
  background: var(--ink);
  color: var(--on-ink);
  display: grid;
  place-items: center;
}
.rec__time {
  font-size: 14px;
  white-space: nowrap;
}
.rec__spacer {
  flex: 1;
}
.rec__aside {
  display: flex;
  flex-direction: column;
}
.rec__words {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
}
.rec__words-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 44px;
  padding-top: 8px;
}
.rec__words-head h2 {
  flex: 1;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.rec__ok {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--hit);
  font-size: 14px;
}
.rec__ok .icon {
  width: 16px;
  height: 16px;
}
.rec__words textarea {
  width: 100%;
  font-size: 17px;
  line-height: 1.45;
}
.rec__words-act {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rec__words-act .btn:first-child {
  flex: 1;
}
.rec__small {
  font-size: 14px;
}
.rec__grow {
  flex: 1;
}
.rec__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rec__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rec__bpm {
  width: 64px;
  min-height: 40px;
  padding: 0 8px;
}
.rec__frozen {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.rec__knobs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.rec__knobs:disabled {
  color: var(--faint);
}
.rec__knobs legend {
  padding: 0;
  margin-bottom: 4px;
}
.rec__radio {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.rec__radio input {
  accent-color: var(--ink);
}
.rec__keys {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: 14px;
}
.rec__keys dt {
  white-space: nowrap;
}
.rec__keys dd {
  margin: 0;
}
.rec__keys kbd {
  display: inline-block;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--line-soft);
  font: 13px var(--sans);
  text-align: center;
}
.rec__foot {
  margin: 20px 0 0;
  line-height: 1.5;
}

/* ── Step 3 ── */
.rec__send {
  width: min(640px, calc(100% - 32px));
  margin: 56px auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.rec__send h1 {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
  line-height: 1.15;
}
.rec__send-title {
  min-height: 56px;
  font-size: 24px;
  font-weight: 600;
}
.rec__saved {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hit);
  font-size: 14px;
}
.rec__saved .icon {
  width: 16px;
  height: 16px;
}
.rec__link {
  flex: 1;
  min-width: 12rem;
  min-height: 52px;
  font-size: 16px;
}

@media (max-width: 1100px) {
  .rec__editor {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
}
@media (max-width: 700px) {
  .rec__head {
    padding: 8px 16px;
    gap: 4px 8px;
  }
  .rec__title {
    order: 5;
    flex-basis: 100%;
  }
  .rec__title input {
    padding: 0;
    font-size: 22px;
  }
  .rec__history {
    margin-left: auto;
  }
  /* The step ahead is the «Дальше» button; the done one stays, it is the way to record again. */
  .rec__head .steps li:last-child:not(:has([aria-current])) {
    display: none;
  }
  .rec__head .btn.primary {
    min-height: 40px;
    padding: 0 14px;
  }
  .rec__head .btn.primary .icon,
  .rec__head .steps li:nth-child(2) .sep {
    display: none;
  }
  .rec__history .ib {
    width: 40px;
  }
  .rec__send-long {
    display: none;
  }
  .rec__send-short {
    display: inline;
  }
  .rec__error {
    padding: 12px 16px 0;
  }
  .rec__stage {
    margin: 16px;
    min-height: 480px;
  }
  .rec__intro h1 {
    font-size: 32px;
  }
  .rec__clock {
    font-size: 64px;
  }
  .rec__editor {
    padding: 12px 16px 96px;
  }
  .rec__modes {
    display: flex;
    width: 100%;
  }
  .rec__modes button {
    flex: 1;
  }
  .rec__modes kbd {
    display: none;
  }
  .rec__hint {
    font-size: 13px;
  }
  .rec__sheet {
    height: 420px;
  }
  /* On a phone the toolbar for the picked notes docks at the bottom, the rarer actions in ⋯. */
  .picked {
    position: fixed;
    left: 12px;
    right: 12px;
    top: auto;
    bottom: max(12px, env(safe-area-inset-bottom));
    z-index: 30;
  }
  .picked .wide {
    display: none;
  }
  .picked__name {
    flex: 1;
  }
  .picked__menu {
    top: auto;
    bottom: calc(100% + 8px);
  }
  .picked__menu .narrow {
    display: flex;
  }
  .picked__lyric {
    font-size: 0;
    gap: 0;
  }
  .picked__lyric input {
    width: 48px;
    font-size: 15px;
  }
  .rec__context {
    min-height: 0;
  }
  .rec__send {
    margin: 32px auto;
  }
}
</style>

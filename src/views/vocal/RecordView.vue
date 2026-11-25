<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import PartSheet from '@/components/pitch/PartSheet.vue'
import { useVocalPlayback, type PartSound } from '@/composables/useVocalPlayback'
import { detectPitch, FRAME_PERIOD, VOICED, type PitchFrames } from '@/lib/swiftf0'
import { saveVocalTraining, sharedStore } from '@/lib/vocalStore'
import { MELISMA_DEFAULTS, type Scale } from '@/training/vocal/melisma'
import { detectOnsets } from '@/training/vocal/onsets'
import {
  monoOf,
  spanOf,
  transcribe,
  transcribeFrames,
  transcribeMelisma,
  type Contour,
  type PartNote,
  type Tracker,
} from '@/training/vocal/part'
import './vocal.css'

// The teacher's side: sing the part (or bring a recording), see it turned into notes, hear it
// back, and get a link for the student.

type Stage = 'idle' | 'recording' | 'reading' | 'ready' | 'saving' | 'saved'
const stage = ref<Stage>('idle')
const error = ref<string | null>(null)
const title = ref('')
const notes = shallowRef<PartNote[]>([])
const contour = shallowRef<Contour | null>(null)
const scale = shallowRef<Scale | null>(null)
const recording = shallowRef<Blob | null>(null)
const elapsed = ref(0)
const meter = ref(0)
const link = ref('')
const copied = ref(false)
const listening = ref<PartSound | null>(null)
const router = useRouter()
const player = useVocalPlayback()

const span = computed(() => spanOf(notes.value))
const status = computed(() => {
  if (error.value) return error.value
  switch (stage.value) {
    case 'idle':
      return 'Спой партию целиком — так, как её должен спеть ученик'
    case 'recording':
      return 'Идёт запись'
    case 'reading':
      return 'Перегоняю запись в ноты…'
    case 'saving':
      return 'Сохраняю…'
    case 'saved':
      return 'Готово — отправь ссылку ученику'
    default:
      return `${notes.value.length} нот · проверь на слух и сохрани`
  }
})

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let meterContext: AudioContext | null = null
let raf = 0

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
  rec.start()
  stage.value = 'recording'
  const tick = () => {
    analyser.getFloatTimeDomainData(frame)
    let power = 0
    for (const value of frame) power += value * value
    const db = 10 * Math.log10(power / frame.length + 1e-12)
    meter.value = Math.min(1, Math.max(0, 1 + db / 60))
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
    notes.value = result.notes
    contour.value = result.contour
    scale.value = result.scale ?? null
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

async function listen(sound: PartSound): Promise<void> {
  if (listening.value === sound) {
    player.stop()
    return
  }
  listening.value = sound
  await player.play(sound, notes.value, span.value.from, span.value.to)
  if (listening.value === sound) listening.value = null
}

async function save(): Promise<void> {
  if (!recording.value) return
  player.stop()
  stage.value = 'saving'
  error.value = null
  try {
    const id = await saveVocalTraining({
      title: title.value.trim(),
      notes: notes.value,
      audio: recording.value,
    })
    const href = router.resolve({ name: 'vocal-train', params: { id } }).href
    link.value = new URL(href, location.origin).href
    stage.value = 'saved'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не сохранилось'
    stage.value = 'ready'
  }
}

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(link.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function again(): void {
  player.stop()
  notes.value = []
  contour.value = null
  scale.value = null
  onsets = null
  recording.value = null
  samples = null
  modelFrames = null
  link.value = ''
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
  <main id="main" class="vocal">
    <header class="top">
      <h1 class="title">Запись партии</h1>
      <p class="status" :class="{ error: error !== null }">{{ status }}</p>
    </header>

    <template v-if="stage === 'idle'">
      <p class="lead">
        Запиши партию с микрофона — приложение перегонит её в ноты и даст ссылку. Ученик по ссылке
        слушает твою запись или ноты, поёт и видит, где попал по высоте.
      </p>
      <div class="row">
        <button type="button" class="action big" @click="record">Записать</button>
        <label class="action ghost file">
          Загрузить файл
          <input type="file" accept="audio/*" hidden @change="pickFile" />
        </label>
      </div>
    </template>

    <div v-else-if="stage === 'recording'" class="row">
      <span class="clock">{{ clock }}</span>
      <span class="meter" aria-label="Уровень"><span :style="{ width: `${meter * 100}%` }" /></span>
      <button type="button" class="action big" @click="stopRecording">Стоп</button>
    </div>

    <template v-else-if="stage !== 'reading' && contour">
      <div class="sheet">
        <PartSheet
          :notes="notes"
          :contour="contour"
          :scale="scale"
          :span="span"
          :now="listening ? player.now.value : null"
          label="Партия"
        />
      </div>
      <div class="row">
        <span class="label">Послушать:</span>
        <button type="button" class="action ghost" @click="listen('recording')">
          {{ listening === 'recording' ? 'Стоп' : 'Запись' }}
        </button>
        <button
          type="button"
          class="action ghost"
          :disabled="!notes.length"
          @click="listen('notes')"
        >
          {{ listening === 'notes' ? 'Стоп' : 'Ноты' }}
        </button>
        <button type="button" class="action ghost" @click="again">Перезаписать</button>
      </div>
      <div class="row">
        <span class="label">Распознавание:</span>
        <div class="seg" role="group" aria-label="Распознавание">
          <button type="button" :aria-pressed="tracker === 'melisma'" @click="tracker = 'melisma'">
            Как MELISMA
          </button>
          <button type="button" :aria-pressed="tracker === 'swiftf0'" @click="tracker = 'swiftf0'">
            SwiftF0
          </button>
          <button type="button" :aria-pressed="tracker === 'pyin'" @click="tracker = 'pyin'">
            pYIN (старое)
          </button>
        </div>
        <label v-if="tracker === 'swiftf0'" class="label check">
          <input v-model="fastNotes" type="checkbox" />
          Быстрые ноты (мелизмы; вибрато может дробиться)
        </label>
      </div>
      <div v-if="tracker === 'melisma'" class="knobs">
        <label class="knob">
          <span
            >Украшение <b>{{ ornamentMs }} мс</b></span
          >
          <input v-model.number="ornamentMs" type="range" min="30" max="200" step="5" />
          <small>самая короткая нота: меньше — больше мелких нот</small>
        </label>
        <label class="knob">
          <span
            >Слайд <b>{{ slide }} ¢/с</b></span
          >
          <input v-model.number="slide" type="range" min="60" max="400" step="10" />
          <small>с какой скорости движение высоты — скольжение, а не нота</small>
        </label>
        <label class="knob">
          <span
            >Вибрато <b>{{ vibrato.toFixed(2) }}</b></span
          >
          <input v-model.number="vibrato" type="range" min="0" max="1" step="0.05" />
          <small>какое качание остаётся внутри ноты: больше — шире и медленнее</small>
        </label>
        <label class="knob">
          <span
            >Чувствительность <b>{{ sensitivity.toFixed(2) }}</b></span
          >
          <input v-model.number="sensitivity" type="range" min="0.2" max="0.8" step="0.05" />
          <small>где кончается голос и начинается дыхание и шум</small>
        </label>
        <div class="knob">
          <label class="label check">
            <input v-model="ornaments" type="checkbox" />
            Украшения отдельными нотами
          </label>
          <button type="button" class="action ghost small" @click="resetKnobs">Как было</button>
        </div>
      </div>

      <div v-if="stage !== 'saved'" class="row">
        <input
          v-model="title"
          class="field"
          maxlength="120"
          placeholder="Название, например «Распевка на а»"
          aria-label="Название"
        />
        <button
          type="button"
          class="action"
          :disabled="!notes.length || stage === 'saving'"
          @click="save"
        >
          Сохранить и получить ссылку
        </button>
      </div>
      <template v-else>
        <div class="row">
          <input class="field" :value="link" readonly aria-label="Ссылка для ученика" />
          <button type="button" class="action" @click="copy">
            {{ copied ? 'Скопировано' : 'Копировать' }}
          </button>
          <a class="action ghost open" :href="link" target="_blank" rel="noopener">Открыть</a>
        </div>
        <p v-if="!sharedStore" class="notice">
          База не подключена: тренировка сохранена только в этом браузере, и ссылка откроется только
          здесь. Чтобы её открыл ученик, нужны ключи Supabase в <code>.env.local</code>.
        </p>
      </template>
    </template>
  </main>
</template>

<style scoped>
.knobs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.6rem 1.2rem;
}
.knob {
  display: grid;
  gap: 0.2rem;
  align-content: start;
  font-size: 0.85rem;
}
.knob b {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.knob small {
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.3;
}
.knob input[type='range'] {
  width: 100%;
  accent-color: var(--ink);
}
.action.small {
  min-height: 2rem;
  justify-self: start;
  font-size: 0.85rem;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
}
.file,
.open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  box-sizing: border-box;
}
</style>

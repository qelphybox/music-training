<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { TakeSource } from '@/components/pitch/inkTake'
import InkScroll from '@/components/pitch/InkScroll.vue'
import { useExerciseSession } from '@/composables/useExerciseSession'
import { useVocalPlayback, type PartSound } from '@/composables/useVocalPlayback'
import { detectPitch, FRAME_PERIOD, VOICED } from '@/lib/swiftf0'
import { loadVocalTraining, type VocalTraining } from '@/lib/vocalStore'
import { noteName, spanOf, transcribeFrames, type Contour } from '@/training/vocal/part'
import { LEVELS, review, type Level, type Review } from '@/training/vocal/review'
import { contourSource, LiveTake } from './sources'
import './vocal.css'

// The student's side: hear the part (the teacher's recording or its notes), sing it — on your own
// by default, or along with it in headphones — and see where the pitch landed.

const props = defineProps<{ id: string }>()

type Stage =
  'loading' | 'missing' | 'ready' | 'listening' | 'headphones' | 'singing' | 'reviewing' | 'done'
const stage = ref<Stage>('loading')
const error = ref<string | null>(null)
const training = shallowRef<VocalTraining | null>(null)
const sound = ref<PartSound>('recording')
const along = ref(false)
const level = ref<Level>(15)
const result = shallowRef<Review | null>(null)
const now = ref(0)

const player = useVocalPlayback()
// The take's samples are kept so the review can read them with SwiftF0.
const session = useExerciseSession({ record: true })
const take = new LiveTake()
const source = shallowRef<TakeSource>(take)
/** Whether the take's clock has been pinned to the part's yet. */
let pinned = false
let headphonesConfirmed = false

const notes = computed(() => training.value?.notes ?? [])
const span = computed(() => spanOf(notes.value))

onMounted(async () => {
  try {
    const found = await loadVocalTraining(props.id)
    if (!found) {
      stage.value = 'missing'
      return
    }
    training.value = found
    const response = await fetch(found.audioUrl)
    await player.load(await response.arrayBuffer())
    now.value = span.value.from
    stage.value = 'ready'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Тренировка не загрузилась'
    stage.value = 'missing'
  }
})

const status = computed(() => {
  if (error.value) return error.value
  if (session.error.value) return session.error.value
  switch (stage.value) {
    case 'loading':
      return 'Загружаю…'
    case 'missing':
      return 'Такой тренировки нет — проверь ссылку'
    case 'listening':
      return 'Слушай, как звучит партия'
    case 'headphones':
      return 'Нужны наушники'
    case 'singing':
      return along.value
        ? 'Пой вместе с партией'
        : 'Пой — в своём темпе, нажми «Готово», когда закончишь'
    case 'reviewing':
      return 'Разбираю…'
    case 'done':
      return 'Разбор'
    default:
      return `${notes.value.length} нот · послушай, потом спой`
  }
})

async function listen(): Promise<void> {
  if (stage.value === 'listening') {
    player.stop()
    return
  }
  stage.value = 'listening'
  source.value = take
  take.clear()
  await player.play(sound.value, notes.value, span.value.from, span.value.to, (at) => {
    now.value = at
  })
  if (stage.value === 'listening') {
    now.value = span.value.from
    stage.value = result.value ? 'done' : 'ready'
    if (result.value) showResult(result.value)
  }
}

async function sing(): Promise<void> {
  if (along.value && !headphonesConfirmed) {
    stage.value = 'headphones'
    return
  }
  error.value = null
  try {
    await session.startListening()
  } catch {
    return
  }
  take.clear()
  pinned = false
  result.value = null
  source.value = take
  now.value = span.value.from
  stage.value = 'singing'
  if (along.value) {
    await player.play(sound.value, notes.value, span.value.from, span.value.to, (at) => {
      now.value = at
    })
    // The last note's frames are still on their way from the analysis.
    if (stage.value === 'singing') setTimeout(finish, 400)
  }
}

function confirmHeadphones(): void {
  headphonesConfirmed = true
  stage.value = 'ready'
  void sing()
}

watch(session.pitch, (trace) => {
  if (stage.value !== 'singing' || trace.length === 0) return
  const newest = take.push(trace)
  if (take.length() === 0) return
  if (!pinned) {
    // On its own the take starts where the part does; along with it, where the part is playing.
    take.shift = (along.value ? now.value : span.value.from) - newest
    pinned = true
  }
  if (!along.value) now.value = newest + take.shift
})

/**
 * The take is judged by SwiftF0 over its recorded samples — the same tracker that read the
 * teacher's part, so a bias between trackers cannot pass for cents off. The live pYIN contour only
 * draws while singing, and stands in if the model fails.
 */
async function finish(): Promise<void> {
  if (stage.value !== 'singing') return
  player.stop()
  stage.value = 'reviewing'
  let sung: Contour = take.contour()
  const span = take.traceSpan()
  try {
    const pcm = span && (await session.samplesBetween(span.from, span.to + TAIL_SECONDS))
    if (pcm && pcm.samples.length > 0) {
      const frames = await detectPitch(pcm.samples, pcm.sampleRate)
      const contour = transcribeFrames(frames, FRAME_PERIOD, VOICED).contour
      sung = { ...contour, start: pcm.start + take.shift }
    }
  } catch {
    // The live contour is still a fair take.
  }
  void session.stopListening()
  // Ornaments are drawn and heard, not judged: a 40 ms grace note is not a pitch to hold.
  const done = review(
    notes.value.filter((note) => !note.ornament),
    sung,
  )
  result.value = done
  showResult(done)
  stage.value = 'done'
}

/** Seconds of sound kept after the last frame heard: the end of the last note. */
const TAIL_SECONDS = 0.3

function showResult(done: Review): void {
  source.value = contourSource(done.warped)
  now.value = Infinity
}

function again(): void {
  result.value = null
  source.value = take
  take.clear()
  now.value = span.value.from
  stage.value = 'ready'
}

const verdict = computed(() => {
  const done = result.value
  if (!done) return ''
  if (!done.heard) return 'Не слышу голоса'
  const score = done.scores[level.value]
  if (score === 100) return 'Чисто'
  if (score >= 75) return 'Почти чисто'
  if (score >= 40) return 'Мелодию держишь, есть промахи'
  return 'Интонация плывёт — это тренируется'
})

type Mark = 'hit' | 'near' | 'miss' | 'skip'
function markOf(cents: number | null): Mark {
  if (cents === null) return 'skip'
  const off = Math.abs(cents)
  return off <= level.value ? 'hit' : off <= 50 ? 'near' : 'miss'
}
function centsText(cents: number | null): string {
  if (cents === null) return 'не спета'
  const off = Math.round(Math.abs(cents))
  if (off === 0) return 'точно'
  if (off >= 1200 && off % 1200 < 50)
    return `на ${off / 1200 > 1.5 ? 'две октавы' : 'октаву'} ${cents < 0 ? 'ниже' : 'выше'}`
  return `${cents < 0 ? '−' : '+'}${off} ¢`
}

const levelNames: Record<Level, string> = { 15: 'Легко ±15¢', 7: 'Средне ±7¢', 2: 'Строго ±2¢' }
const busy = computed(() => ['loading', 'missing', 'reviewing'].includes(stage.value))
</script>

<template>
  <main id="main" class="vocal">
    <header class="top">
      <h1 class="title">{{ training?.title || 'Вокальная тренировка' }}</h1>
      <p class="status" :class="{ error: error !== null || session.error.value !== null }">
        {{ status }}
      </p>
    </header>

    <template v-if="training">
      <div class="sheet">
        <InkScroll
          :source="source"
          :target="notes"
          :now="now"
          :mode="stage === 'done' ? 'card' : 'live'"
          :span="span"
          :voice="stage !== 'listening'"
          label="Ноты плывут к линии, голос — мазок на ней"
        />
      </div>

      <p v-if="stage === 'headphones'" class="notice">
        Петь вместе с партией можно только в наушниках — иначе микрофон услышит партию вместо тебя.
        <span class="row confirm">
          <button type="button" class="action" @click="confirmHeadphones">Наушники надел</button>
          <button type="button" class="action ghost" @click="stage = 'ready'">Отмена</button>
        </span>
      </p>

      <section v-if="stage === 'done' && result" class="result">
        <div class="score">
          <p class="verdict">{{ verdict }}</p>
          <div class="seal" aria-label="Оценка">{{ result.scores[level] }}</div>
        </div>
        <div class="seg" role="group" aria-label="Допуск">
          <button
            v-for="l in LEVELS"
            :key="l"
            type="button"
            :aria-pressed="level === l"
            @click="level = l"
          >
            {{ levelNames[l] }} · {{ result.scores[l] }}%
          </button>
        </div>
        <ol class="chips">
          <li v-for="(n, i) in result.notes" :key="i" :class="markOf(n.cents)">
            <span class="name">{{ noteName(n.note.midi) }}</span>
            <span class="cents">{{ centsText(n.cents) }}</span>
          </li>
        </ol>
        <p class="label">
          Золотом — партия, тушью — как спел ты, растянуто под партию. Ноты по порядку: время не
          оценивается.
        </p>
      </section>

      <div class="row">
        <span class="label">Слушать:</span>
        <div class="seg" role="group" aria-label="Что слушать">
          <button type="button" :aria-pressed="sound === 'recording'" @click="sound = 'recording'">
            Запись
          </button>
          <button type="button" :aria-pressed="sound === 'notes'" @click="sound = 'notes'">
            Ноты
          </button>
        </div>
        <span class="label">Петь:</span>
        <div class="seg" role="group" aria-label="Как петь">
          <button
            type="button"
            :aria-pressed="!along"
            :disabled="stage === 'singing'"
            @click="along = false"
          >
            Сам
          </button>
          <button
            type="button"
            :aria-pressed="along"
            :disabled="stage === 'singing'"
            @click="along = true"
          >
            С партией
          </button>
        </div>
      </div>

      <div class="row">
        <button
          type="button"
          class="action ghost big"
          :disabled="busy || stage === 'singing' || stage === 'headphones'"
          @click="listen"
        >
          {{ stage === 'listening' ? 'Стоп' : 'Послушать' }}
        </button>
        <button v-if="stage === 'singing'" type="button" class="action big" @click="finish">
          Готово
        </button>
        <button
          v-else
          type="button"
          class="action big"
          :disabled="
            busy ||
            stage === 'listening' ||
            stage === 'headphones' ||
            session.micState.value === 'starting'
          "
          @click="stage === 'done' ? (again(), sing()) : sing()"
        >
          {{ stage === 'done' ? 'Ещё раз' : 'Петь' }}
        </button>
      </div>
    </template>

    <p v-else-if="stage === 'missing'" class="lead">
      Попроси у педагога ссылку ещё раз.
      <RouterLink to="/vocal/new">Записать свою партию</RouterLink>
    </p>
  </main>
</template>

<style scoped>
.confirm {
  margin-top: 0.6rem;
}
.result {
  display: grid;
  gap: 0.6rem;
}
.score {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.verdict {
  margin: 0;
  flex: 1;
  font-family: Georgia, serif;
  font-size: 1.6rem;
  line-height: 1.1;
}
.seal {
  width: 3.2rem;
  height: 3.2rem;
  display: grid;
  place-items: center;
  background: var(--seal);
  color: #f3ebdd;
  font-weight: 600;
  font-size: 1.4rem;
  transform: rotate(-3deg);
  box-shadow:
    inset 0 0 0 3px var(--seal),
    inset 0 0 0 4px rgb(243 235 221 / 70%);
}
.result .seg {
  flex-wrap: wrap;
  width: fit-content;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chips li {
  display: grid;
  gap: 0.05rem;
  padding: 0.35rem 0.55rem;
  border-radius: 6px;
  border: 1px solid currentColor;
  font-size: 0.85rem;
  line-height: 1.15;
}
.chips .name {
  font-weight: 600;
}
.chips .cents {
  font-variant-numeric: tabular-nums;
}
.chips .hit {
  color: var(--hit);
}
.chips .near {
  color: var(--near);
}
.chips .miss {
  color: var(--seal);
}
.chips .skip {
  color: var(--muted);
  border-style: dashed;
}
</style>

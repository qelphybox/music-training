<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { TakeSource } from '@/components/pitch/inkTake'
import InkScroll from '@/components/pitch/InkScroll.vue'
import PartStrip from '@/components/pitch/PartStrip.vue'
import PlayerSettings from '@/components/pitch/PlayerSettings.vue'
import VocalIcon from '@/components/pitch/VocalIcon.vue'
import { useExerciseSession } from '@/composables/useExerciseSession'
import { useVocalPlayback, type PartSound } from '@/composables/useVocalPlayback'
import { detectPitch, FRAME_PERIOD, VOICED } from '@/lib/swiftf0'
import { loadVocalTraining, type VocalTraining } from '@/lib/vocalStore'
import { estimateGrid } from '@/training/vocal/edit'
import { noteName, spanOf, transcribeFrames, type Contour } from '@/training/vocal/part'
import { LEVELS, review, type Level, type Review } from '@/training/vocal/review'
import { contourSource, LiveTake } from './sources'
import './vocal.css'

// The student's side in three steps: hear the part (the teacher's recording or its notes), sing
// it — on your own by default, or along with it in headphones — and see where the pitch landed.

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
/** Whether the part has been heard once: then singing becomes the main thing to do. */
const listened = ref(false)

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
// Parts saved before grids get one guessed from their notes: the count-in and the clicks need it.
const grid = computed(() => training.value?.grid ?? estimateGrid(notes.value))

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
    player.now.value = span.value.from
    void player.prepare(sound.value, notes.value)
    stage.value = 'ready'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Тренировка не загрузилась'
    stage.value = 'missing'
  }
})

const step = computed(() => {
  if (stage.value === 'done' || stage.value === 'reviewing') return 3
  if (stage.value === 'singing' || stage.value === 'headphones') return 2
  return 1
})
const seconds = computed(() => Math.round(span.value.to - span.value.from))
const subtitle = computed(() => {
  if (session.error.value) return session.error.value
  switch (stage.value) {
    case 'loading':
      return 'Загружаю…'
    case 'listening':
      return player.settings.looping ? 'Играет кусок по кругу' : 'Слушай, как звучит партия'
    case 'headphones':
      return 'Нужны наушники'
    case 'singing':
      return along.value ? 'Пой вместе с партией' : 'Пой в своём темпе — ноты подождут'
    case 'reviewing':
      return 'Разбираю…'
    case 'done':
      return 'Разбор'
    default:
      return `${notes.value.length} нот · ${seconds.value} с`
  }
})

function listen(): void {
  if (player.playing.value) {
    player.stop()
    return
  }
  stage.value = 'listening'
  source.value = take
  take.clear()
  void player.play({
    sound: sound.value,
    notes: notes.value,
    span: span.value,
    grid: grid.value,
    onTick: (at) => (now.value = at),
  })
}

// Playing ends by itself, by «пауза» or by the strip: the page follows it.
// Render the other sound (or another speed) ahead, so play starts at once.
watch([sound, () => player.settings.rate], () => {
  if (training.value) void player.prepare(sound.value, notes.value)
})

watch(player.playing, (playing) => {
  if (playing) return
  if (stage.value === 'listening') {
    listened.value = true
    stage.value = result.value ? 'done' : 'ready'
    if (result.value) showResult(result.value)
    else now.value = player.now.value
  } else if (stage.value === 'singing' && along.value) {
    // The last note's frames are still on their way from the analysis.
    setTimeout(finish, 400)
  }
})

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
    void player.play({
      sound: sound.value,
      notes: notes.value,
      span: span.value,
      grid: grid.value,
      from: span.value.from,
      once: true,
      onTick: (at) => (now.value = at),
    })
  }
}

function confirmHeadphones(): void {
  headphonesConfirmed = true
  stage.value = 'ready'
  void sing()
}
function singAlone(): void {
  along.value = false
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

// ─── The review in words ──────────────────────────────────────────────────────────────────────

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
  return `${cents < 0 ? '−' : '+'}${off}¢`
}
const pitchName = (midi: number) => noteName(midi).replace(/\d+$/, '')
const markLabel: Record<Mark, string> = {
  hit: 'попал',
  near: 'близко',
  miss: 'мимо',
  skip: 'не спета',
}
/** «7 из 9 нот точно. Ниже: ми; выше: фа.» — the review in one breath. */
const summary = computed(() => {
  const done = result.value
  if (!done || !done.heard) return ''
  const total = done.notes.length
  const hits = done.notes.filter((n) => markOf(n.cents) === 'hit').length
  const low: string[] = []
  const high: string[] = []
  let skipped = 0
  for (const n of done.notes) {
    const mark = markOf(n.cents)
    if (mark === 'hit') continue
    if (mark === 'skip') skipped++
    else (n.cents! < 0 ? low : high).push(pitchName(n.note.midi))
  }
  const parts = [`${hits} из ${total} нот точно.`]
  const list = (names: string[]) => [...new Set(names)].slice(0, 3).join(', ')
  if (low.length) parts.push(`Ниже: ${list(low)}.`)
  if (high.length) parts.push(`Выше: ${list(high)}.`)
  if (skipped) parts.push(`Не спето: ${skipped}.`)
  return parts.join(' ')
})
const levelNames: Record<Level, string> = { 15: 'Легко', 7: 'Средне', 2: 'Строго' }

// ─── Settings: a sheet on a phone, a panel beside the part on a wide screen ────────────────────

const settingsDialog = ref<HTMLDialogElement | null>(null)
function openSettings(): void {
  settingsDialog.value?.showModal()
}
const busy = computed(() => ['loading', 'missing', 'reviewing'].includes(stage.value))
const locked = computed(
  () => busy.value || stage.value === 'singing' || stage.value === 'headphones',
)
const soundName = computed(() => (sound.value === 'recording' ? 'Голос педагога' : 'Ноты'))
</script>

<template>
  <main id="main" class="vocal train">
    <div class="train__wrap">
      <header class="train__head">
        <RouterLink to="/" class="ib train__back" aria-label="Все тренировки">
          <VocalIcon name="back" />
        </RouterLink>
        <div class="train__titles">
          <h1 class="serif">{{ training?.title || 'Вокальная тренировка' }}</h1>
          <p class="muted" :class="{ 'error-text': session.error.value }" aria-live="polite">
            {{ subtitle }}
          </p>
        </div>
        <ol v-if="training" class="steps train__steps" aria-label="Шаги">
          <li>
            <span
              v-if="step > 1 || listened"
              class="done"
              :aria-current="step === 1 ? 'step' : undefined"
              ><VocalIcon name="check" />Послушай</span
            >
            <span v-else aria-current="step">Послушай</span>
            <VocalIcon name="next" class="sep" />
          </li>
          <li>
            <span v-if="step > 2" class="done"><VocalIcon name="check" />Спой</span>
            <span v-else :aria-current="step === 2 ? 'step' : undefined">Спой</span>
            <VocalIcon name="next" class="sep" />
          </li>
          <li>
            <span :aria-current="step === 3 ? 'step' : undefined">Разбор</span>
          </li>
        </ol>
      </header>

      <div v-if="training" class="train__grid">
        <div class="train__left">
          <div class="train__sheet">
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
          <PartStrip
            :player="player"
            :notes="notes"
            :span="span"
            :grid="grid"
            :disabled="locked"
            hint="протяни — повтор куска"
          />
          <div class="train__chips">
            <button
              type="button"
              class="chip"
              :disabled="locked"
              :title="'Что звучит: ' + soundName"
              @click="sound = sound === 'recording' ? 'notes' : 'recording'"
            >
              {{ soundName }}
            </button>
            <button
              type="button"
              class="chip"
              :aria-pressed="player.settings.rate !== 1"
              @click="openSettings"
            >
              Темп {{ Math.round(player.settings.rate * 100) }}%
            </button>
            <button
              v-if="player.settings.loop"
              type="button"
              class="chip"
              :aria-pressed="player.settings.looping"
              @click="player.settings.looping = !player.settings.looping"
            >
              <VocalIcon name="loop" />Повтор
            </button>
            <button
              type="button"
              class="chip icon-only"
              aria-label="Звук и темп: все настройки"
              @click="openSettings"
            >
              <VocalIcon name="sliders" />
            </button>
          </div>
        </div>

        <div class="train__side">
          <section v-if="stage === 'done' && result" class="train__review" aria-label="Разбор">
            <div class="train__verdict">
              <div class="train__verdict-text">
                <h2 class="serif">{{ verdict }}</h2>
                <p v-if="summary" class="muted">{{ summary }}</p>
              </div>
              <p
                class="train__seal serif num"
                :aria-label="`Оценка ${result.scores[level]} процентов`"
              >
                {{ result.scores[level] }}
              </p>
            </div>
            <ol class="train__notes" aria-label="Ноты по порядку">
              <li v-for="(n, i) in result.notes" :key="i" :class="markOf(n.cents)">
                <VocalIcon
                  :name="
                    markOf(n.cents) === 'hit'
                      ? 'check'
                      : markOf(n.cents) === 'skip'
                        ? 'close'
                        : n.cents! < 0
                          ? 'lower'
                          : 'higher'
                  "
                  :label="markLabel[markOf(n.cents)]"
                />
                <b class="serif">{{ pitchName(n.note.midi) }}</b>
                <span class="num">{{ centsText(n.cents) }}</span>
              </li>
            </ol>
            <p class="muted train__foot">
              ¢ — сотая доля полутона. Ритм и украшения не оцениваются. Золотом — партия, тушью —
              как спето, растянуто под партию.
            </p>
            <div class="train__field">
              <span class="muted train__small">Как строго судить</span>
              <div class="seg wide train__levels" role="group" aria-label="Допуск">
                <button
                  v-for="l in LEVELS"
                  :key="l"
                  type="button"
                  :aria-pressed="level === l"
                  @click="level = l"
                >
                  <b>{{ levelNames[l] }}</b
                  ><span class="num">±{{ l }}¢ · {{ result.scores[l] }}%</span>
                </button>
              </div>
            </div>
          </section>

          <div v-if="stage === 'headphones'" class="notice train__phones" role="alert">
            <p>
              <b>Петь под партию — только в наушниках.</b> Иначе микрофон услышит партию вместо
              тебя.
            </p>
            <div class="train__phones-act">
              <button type="button" class="btn primary" @click="confirmHeadphones">
                <VocalIcon name="headphones" />Наушники надел
              </button>
              <button type="button" class="btn text" @click="singAlone">Петь без партии</button>
            </div>
          </div>

          <p v-if="stage === 'singing'" class="train__live" aria-live="polite">
            <span aria-hidden="true" />Слышу тебя
          </p>

          <div class="dock train__dock">
            <template v-if="stage === 'singing'">
              <button type="button" class="btn primary" @click="finish">
                <VocalIcon name="check" />Готово
              </button>
            </template>
            <template v-else-if="stage === 'reviewing'">
              <button type="button" class="btn primary" disabled>Разбираю…</button>
            </template>
            <template v-else-if="stage === 'done'">
              <button type="button" class="btn" @click="listen">
                <VocalIcon name="play" />Послушать
              </button>
              <button type="button" class="btn primary" @click="(again(), sing())">
                <VocalIcon name="retry" />Спеть ещё раз
              </button>
            </template>
            <template v-else-if="stage !== 'headphones'">
              <button
                type="button"
                class="btn"
                :class="{ primary: !listened || stage === 'listening' }"
                :style="{ order: listened && stage !== 'listening' ? 2 : 1 }"
                :disabled="busy"
                @click="listen"
              >
                <VocalIcon :name="stage === 'listening' ? 'pause' : 'play'" />{{
                  stage === 'listening' ? 'Пауза' : 'Послушать'
                }}
              </button>
              <button
                type="button"
                class="btn"
                :class="{ primary: listened && stage !== 'listening' }"
                :style="{ order: listened && stage !== 'listening' ? 1 : 2 }"
                :disabled="busy || stage === 'listening' || session.micState.value === 'starting'"
                @click="sing"
              >
                <VocalIcon name="mic" />Спеть
              </button>
            </template>
          </div>

          <section class="train__panel" aria-labelledby="train-sound">
            <h2 id="train-sound" class="serif">Звук и темп</h2>
            <div class="seg wide" role="group" aria-label="Что звучит">
              <button
                type="button"
                :aria-pressed="sound === 'recording'"
                :disabled="locked"
                @click="sound = 'recording'"
              >
                Голос педагога
              </button>
              <button
                type="button"
                :aria-pressed="sound === 'notes'"
                :disabled="locked"
                @click="sound = 'notes'"
              >
                Ноты
              </button>
            </div>
            <PlayerSettings
              :player="player"
              :grid="grid"
              :disabled="locked"
              loop-hint="протяни по полосе под партией"
            >
              <label class="switch train__along">
                <span class="train__grow"
                  >Петь под партию<span class="sub">только в наушниках</span></span
                >
                <input v-model="along" type="checkbox" role="switch" :disabled="locked" />
              </label>
            </PlayerSettings>
          </section>
        </div>
      </div>

      <section v-else-if="stage === 'missing'" class="train__missing">
        <h2 class="serif">Такой тренировки нет</h2>
        <p class="muted">{{ error ?? 'Проверь ссылку или попроси её у педагога ещё раз.' }}</p>
        <RouterLink class="btn" to="/vocal/new">Записать свою партию</RouterLink>
      </section>

      <p v-else class="muted train__loading" aria-live="polite">Загружаю…</p>
    </div>

    <dialog ref="settingsDialog" class="sheet-dialog" aria-labelledby="train-dialog">
      <form method="dialog" class="train__dialog">
        <span class="train__handle" aria-hidden="true" />
        <div class="train__dialog-head">
          <h2 id="train-dialog" class="serif">Звук и темп</h2>
          <button class="btn text">Готово</button>
        </div>
        <div class="train__field">
          <span class="muted train__small">Что звучит</span>
          <div class="seg wide" role="group" aria-label="Что звучит">
            <button
              type="button"
              :aria-pressed="sound === 'recording'"
              :disabled="locked"
              @click="sound = 'recording'"
            >
              Голос педагога
            </button>
            <button
              type="button"
              :aria-pressed="sound === 'notes'"
              :disabled="locked"
              @click="sound = 'notes'"
            >
              Ноты
            </button>
          </div>
        </div>
        <PlayerSettings
          :player="player"
          :grid="grid"
          :disabled="locked"
          loop-hint="протяни по полосе под партией"
        >
          <label class="switch train__along">
            <span class="train__grow"
              >Петь под партию<span class="sub"
                >только в наушниках, иначе микрофон услышит партию</span
              ></span
            >
            <input v-model="along" type="checkbox" role="switch" :disabled="locked" />
          </label>
        </PlayerSettings>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
.train__wrap {
  width: min(1360px, 100%);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 8px 40px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.train__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.train__back {
  margin-left: -10px;
  color: var(--ink);
}
.train__titles {
  flex: 1;
  min-width: 14rem;
}
.train__titles h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
  text-wrap: balance;
}
.train__titles p {
  margin: 2px 0 0;
  font-size: 14px;
}
.train__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 48px;
  align-items: start;
}
.train__left {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.train__sheet {
  height: clamp(320px, 56dvh, 520px);
  border-radius: 16px;
  overflow: hidden;
  background: var(--sheet);
}
.train__chips {
  display: none;
  gap: 8px;
  flex-wrap: wrap;
}
.train__side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.train__review {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.train__verdict {
  display: flex;
  align-items: center;
  gap: 16px;
}
.train__verdict-text {
  flex: 1;
}
.train__verdict h2 {
  margin: 0;
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
}
.train__verdict-text p {
  margin: 6px 0 0;
  font-size: 15px;
  text-wrap: pretty;
}
.train__seal {
  flex: none;
  width: 68px;
  height: 68px;
  margin: 0;
  display: grid;
  place-items: center;
  background: var(--seal);
  color: var(--on-ink);
  font-size: 26px;
  font-weight: 600;
  transform: rotate(-3deg);
  box-shadow:
    inset 0 0 0 3px var(--seal),
    inset 0 0 0 4px rgb(243 235 221 / 70%);
}
.train__notes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.train__notes li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 10px;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid currentColor;
  font-size: 14px;
}
.train__notes li .icon {
  width: 16px;
  height: 16px;
}
.train__notes li b {
  font-size: 15px;
  font-weight: 600;
}
.train__notes li span {
  margin-left: auto;
}
.train__notes .hit {
  color: var(--hit);
}
.train__notes .near {
  color: var(--near);
}
.train__notes .miss {
  color: var(--seal);
}
.train__notes .skip {
  color: var(--muted);
  border-style: dashed;
}
.train__foot {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.train__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.train__small {
  font-size: 14px;
}
.train__levels button {
  flex-direction: column;
  gap: 0;
  min-height: 52px;
  font-size: 13px;
  line-height: 1.25;
}
.train__levels b {
  font-size: 15px;
  font-weight: 600;
}
.train__phones {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.train__phones p {
  margin: 0;
}
.train__phones-act {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.train__live {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: 0;
}
.train__live span {
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background: #e0553a;
}
.train__panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.train__panel h2,
.train__dialog-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.train__along {
  border-top: 1px solid var(--line-soft);
}
.train__grow {
  flex: 1;
}
.train__missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 40px 0;
}
.train__missing h2 {
  margin: 0;
  font-size: 26px;
}
.train__missing p {
  margin: 0;
}
.train__loading {
  padding: 40px 0;
}
.train__dialog {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.train__handle {
  align-self: center;
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--control);
}
.train__dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: -6px;
}

@media (max-width: 1000px) {
  .train__wrap {
    padding: 0 16px 0;
    gap: 14px;
  }
  .train__head {
    padding: 8px 0 4px;
    border-bottom: 0;
  }
  .train__steps {
    flex-basis: 100%;
  }
  .train__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .train__sheet {
    height: min(46dvh, 360px);
  }
  .train__chips {
    display: flex;
  }
  .train__panel {
    display: none;
  }
  /* The main buttons stay under the thumb. */
  .train__dock {
    position: sticky;
    bottom: 0;
    margin: 0 -16px;
    padding: 12px 16px max(16px, env(safe-area-inset-bottom));
    background: linear-gradient(to bottom, rgb(236 233 227 / 0%), var(--paper) 24%);
  }
}
</style>

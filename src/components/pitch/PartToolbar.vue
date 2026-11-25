<script setup lang="ts">
import { computed } from 'vue'
import type { EditorCommand, PartEditor } from '@/composables/usePartEditor'

/**
 * The editor's commands as buttons: modes, undo, what to do with the picked notes. Every action of
 * the editor is here, so a phone without keys or hover reaches all of it; the keys are shown as
 * hints for the desktop. A redesign can lay the same `editor.commands` out differently.
 */
const props = defineProps<{ editor: PartEditor }>()

const groups = computed(() => {
  const by = (group: EditorCommand['group']) =>
    props.editor.commands.filter((c) => c.group === group)
  return {
    mode: by('mode'),
    history: by('history'),
    note: [...by('select'), ...by('note')],
    play: [...by('play'), ...by('view')],
  }
})

const hint = computed(() => {
  switch (props.editor.activeMode.value) {
    case 'pitch':
      return 'Тяни ноту вверх-вниз — по полутонам. Рамка по пустому месту — выбрать несколько, долгое нажатие — добавить к выбору. Двойной тап по пустому — новая нота.'
    case 'time':
      return 'Тяни ноту вбок — сдвиг, тяни линию между нотами — граница. Двойной тап по линии — на долю.'
    default:
      return 'Тап внутри ноты — разрезать здесь, тап по линии между нотами — склеить. Пунктир показывает, что будет.'
  }
})
</script>

<template>
  <div class="toolbar" role="toolbar" aria-label="Правка партии">
    <div class="toolbar__group seg-like" role="group" aria-label="Режим">
      <button
        v-for="c in groups.mode.slice(0, 3)"
        :key="c.id"
        type="button"
        :aria-pressed="c.active?.value"
        :title="`${c.label} (${c.keys.join(' / ')})`"
        @click="c.run()"
      >
        {{ c.label }}<kbd>{{ c.keys[0] }}</kbd>
      </button>
    </div>
    <button
      v-if="editor.activeMode.value === 'time'"
      type="button"
      class="toolbar__toggle"
      :aria-pressed="groups.mode[3]!.active?.value"
      @click="groups.mode[3]!.run()"
    >
      Сдвигать остальное
    </button>
    <div class="toolbar__group" role="group" aria-label="История">
      <button
        v-for="c in groups.history"
        :key="c.id"
        type="button"
        :disabled="!c.enabled.value"
        :title="`${c.label} (${c.keys.join(', ')})`"
        @click="c.run()"
      >
        {{ c.id === 'undo' ? '↶' : '↷' }} {{ c.label }}
      </button>
    </div>
    <div class="toolbar__group" role="group" aria-label="Выбранные ноты">
      <button
        v-for="c in groups.note"
        :key="c.id"
        type="button"
        :disabled="!c.enabled.value"
        :aria-pressed="c.active ? c.active.value : undefined"
        :title="c.keys.length ? `${c.label} (${c.keys.join(', ')})` : c.label"
        @click="c.run()"
      >
        {{ c.label }}<kbd v-if="c.keys.length">{{ c.keys[0] }}</kbd>
      </button>
    </div>
    <div class="toolbar__group" role="group" aria-label="Слушать и вид">
      <button
        v-for="c in groups.play"
        :key="c.id"
        type="button"
        :disabled="!c.enabled.value"
        :aria-pressed="c.active ? c.active.value : undefined"
        :title="`${c.label} (${c.keys.join(', ')})`"
        @click="c.run()"
      >
        {{ c.label }}<kbd v-if="c.keys.length">{{ c.keys[0] }}</kbd>
      </button>
    </div>
    <p class="toolbar__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  gap: 0.45rem 0.75rem;
}
.toolbar__group {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.toolbar button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 2.5rem;
  padding: 0 0.7rem;
  border: 1px solid rgb(28 27 25 / 35%);
  border-radius: 6px;
  background: transparent;
  color: var(--ink, #1c1b19);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  touch-action: manipulation;
}
.toolbar button[aria-pressed='true'] {
  background: var(--ink, #1c1b19);
  color: #f2efe9;
}
.toolbar button:disabled {
  opacity: 0.35;
  cursor: default;
}
.seg-like button {
  border-color: var(--ink, #1c1b19);
  font-weight: 600;
}
kbd {
  font: inherit;
  font-size: 0.7rem;
  opacity: 0.55;
}
.toolbar__toggle {
  border-style: dashed !important;
}
.toolbar__hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--muted, #6a665f);
  font-size: 0.75rem;
  line-height: 1.35;
}
/* Phones: no keyboard to hint at. */
@media (pointer: coarse) {
  kbd {
    display: none;
  }
}
/* Narrow screens: each group is one row that scrolls sideways, so the sheet stays in view. */
@media (max-width: 640px) {
  .toolbar {
    gap: 0.35rem;
  }
  .toolbar__group {
    flex-wrap: nowrap;
    overflow-x: auto;
    max-width: 100%;
    scrollbar-width: none;
  }
  .toolbar__group::-webkit-scrollbar {
    display: none;
  }
  .toolbar button {
    flex: none;
    white-space: nowrap;
  }
}
</style>

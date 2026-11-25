import { computed, ref, shallowRef, type ComputedRef } from 'vue'
import {
  joinRange,
  moveMany,
  removeMany,
  setOrnament,
  split,
  transposeMany,
  type Grid,
} from '@/training/vocal/edit'
import type { PartNote } from '@/training/vocal/part'

/**
 * The part editor without its looks: the notes, which of them are picked, the mode, the undo
 * history, and every action as a named command. The sheet (mouse, touch) and any toolbar — the
 * desktop one now, a phone one later — drive the same commands, so nothing the editor does is
 * reachable only by a key or only by a hover. Modes and keys follow Vovious
 * (docs/research/2026-11-25-vovious-editor.md).
 */

/** What dragging on a note does: its pitch, its time and edges, or cutting and joining notes. */
export type EditMode = 'pitch' | 'time' | 'notes'

export interface HistoryStep {
  /** The notes before the step. */
  readonly notes: PartNote[]
  readonly label: string
  /** Seconds of the recording where it happened. */
  readonly at: number
}

export interface EditorCommand {
  readonly id: string
  /** What a button says. */
  readonly label: string
  /** Key hints, as shown («1», «⌘Z»). */
  readonly keys: readonly string[]
  /** Buttons are grouped by this. */
  readonly group: 'mode' | 'history' | 'select' | 'note' | 'play' | 'view'
  readonly enabled: ComputedRef<boolean>
  /** For toggles and modes: whether it is on. */
  readonly active?: ComputedRef<boolean>
  run(): void
}

export interface PartEditorHooks {
  /** The moment the cursor is at, seconds: where «cut» cuts. */
  readonly cursor: () => number
  readonly togglePlay?: () => void
  /** Repeat this stretch (or stop repeating with null). */
  readonly setLoop?: (range: { from: number; to: number } | null) => void
  readonly toggleLoop?: () => void
  readonly loopOn?: () => boolean
}

export function usePartEditor(hooks: PartEditorHooks) {
  const notes = shallowRef<PartNote[]>([])
  const grid = shallowRef<Grid | null>(null)
  /** Indices of the picked notes, ascending. */
  const selection = shallowRef<number[]>([])
  const mode = ref<EditMode>('pitch')
  /** A mode held on a key (N for cutting and joining) over the chosen one. */
  const held = ref<EditMode | null>(null)
  const activeMode = computed(() => held.value ?? mode.value)
  /** Time mode: moving a shared boundary moves everything after it too. */
  const ripple = ref(false)
  /** Edits snap to lines this many beats apart (1 a quarter, 0.5 an eighth…); null — free. */
  const snapTo = ref<number | null>(null)
  const past = shallowRef<HistoryStep[]>([])
  const future = shallowRef<HistoryStep[]>([])
  /** Bumped to ask the sheet to fit the picked (or all) notes into view. */
  const fitRequest = ref(0)
  /** Bumped to ask the sheet to zoom in (+1) or out (−1) in time. */
  const zoomRequest = ref({ n: 0, by: 1 })

  const edited = computed(() => past.value.length > 0)
  const picked = computed(() => selection.value.map((i) => notes.value[i]).filter((n) => !!n))

  /** Starts over on freshly recognised notes: no history, nothing picked. */
  function reset(next: PartNote[], nextGrid: Grid | null): void {
    notes.value = next
    grid.value = nextGrid
    past.value = []
    future.value = []
    selection.value = []
  }

  /** One step of history: the notes become `next`. */
  function apply(next: PartNote[], label: string, pick: number[] = selection.value): void {
    const at = pick.length ? (next[pick[0]!]?.start ?? hooks.cursor()) : hooks.cursor()
    past.value = [...past.value, { notes: notes.value, label, at }]
    future.value = []
    notes.value = next
    select(pick)
  }

  function undo(): void {
    const step = past.value[past.value.length - 1]
    if (!step) return
    future.value = [{ ...step, notes: notes.value }, ...future.value]
    past.value = past.value.slice(0, -1)
    notes.value = step.notes
    select(selection.value)
  }

  function redo(): void {
    const step = future.value[0]
    if (!step) return
    past.value = [...past.value, { ...step, notes: notes.value }]
    future.value = future.value.slice(1)
    notes.value = step.notes
    select(selection.value)
  }

  /** Back (or forward) to the state before step `index` of the history. */
  function jumpTo(index: number): void {
    while (past.value.length > index) undo()
    while (past.value.length < index && future.value.length) redo()
  }

  function select(indices: readonly number[]): void {
    selection.value = [...new Set(indices)]
      .filter((i) => i >= 0 && i < notes.value.length)
      .sort((a, b) => a - b)
  }

  const has = computed(() => selection.value.length > 0)
  const step = () => (grid.value && snapTo.value ? (60 / grid.value.bpm) * snapTo.value : 0.05)

  function transposeBy(semitones: number): void {
    if (!has.value) return
    apply(transposeMany(notes.value, selection.value, semitones), semitones > 0 ? 'Выше' : 'Ниже')
  }
  function nudge(direction: 1 | -1): void {
    if (!has.value) return
    apply(
      moveMany(notes.value, selection.value, direction * step()),
      direction > 0 ? 'Позже' : 'Раньше',
    )
  }
  function removePicked(): void {
    if (!has.value) return
    const first = selection.value[0]!
    apply(removeMany(notes.value, selection.value), 'Удалить', [])
    if (notes.value[first]) select([first])
  }
  function cutPicked(): void {
    const i = selection.value[0]
    const note = i === undefined ? undefined : notes.value[i]
    if (i === undefined || !note) return
    const cursor = hooks.cursor()
    const at = cursor > note.start && cursor < note.end ? cursor : (note.start + note.end) / 2
    apply(split(notes.value, i, at), 'Разрезать', [i])
  }
  /** Joins the picked notes from the first to the last, or the one picked with the next. */
  function joinPicked(): void {
    const first = selection.value[0]
    if (first === undefined) return
    const last = Math.max(selection.value[selection.value.length - 1]!, first + 1)
    if (!notes.value[last]) return
    apply(joinRange(notes.value, first, last), 'Склеить', [first])
  }
  function toggleOrnament(): void {
    if (!has.value) return
    const on = !picked.value.every((n) => n.ornament)
    apply(
      selection.value.reduce((out, i) => setOrnament(out, i, on), notes.value),
      on ? 'Украшение' : 'Не украшение',
    )
  }
  /** Repeat the picked notes. */
  function loopPicked(): void {
    const first = picked.value[0]
    const last = picked.value[picked.value.length - 1]
    if (!first || !last) return
    hooks.setLoop?.({ from: first.slideIn ?? first.start, to: last.end })
  }

  const yes = computed(() => true)
  const commands: EditorCommand[] = [
    {
      id: 'mode-pitch',
      label: 'Высота',
      keys: ['1'],
      group: 'mode',
      enabled: yes,
      active: computed(() => activeMode.value === 'pitch'),
      run: () => (mode.value = 'pitch'),
    },
    {
      id: 'mode-time',
      label: 'Время',
      keys: ['2'],
      group: 'mode',
      enabled: yes,
      active: computed(() => activeMode.value === 'time'),
      run: () => (mode.value = 'time'),
    },
    {
      id: 'mode-notes',
      label: 'Ноты ±',
      keys: ['9', 'N'],
      group: 'mode',
      enabled: yes,
      active: computed(() => activeMode.value === 'notes'),
      run: () => (mode.value = 'notes'),
    },
    {
      id: 'ripple',
      label: 'Сдвигать остальное',
      keys: [],
      group: 'mode',
      enabled: computed(() => activeMode.value === 'time'),
      active: computed(() => ripple.value),
      run: () => (ripple.value = !ripple.value),
    },
    {
      id: 'undo',
      label: 'Отменить',
      keys: ['⌘Z'],
      group: 'history',
      enabled: computed(() => past.value.length > 0),
      run: undo,
    },
    {
      id: 'redo',
      label: 'Вернуть',
      keys: ['⇧⌘Z'],
      group: 'history',
      enabled: computed(() => future.value.length > 0),
      run: redo,
    },
    {
      id: 'select-all',
      label: 'Все ноты',
      keys: ['⌘A'],
      group: 'select',
      enabled: computed(() => notes.value.length > 0),
      run: () => select(notes.value.map((_, i) => i)),
    },
    {
      id: 'select-none',
      label: 'Снять выбор',
      keys: ['Esc'],
      group: 'select',
      enabled: has,
      run: () => select([]),
    },
    {
      id: 'up',
      label: 'Полутон вверх',
      keys: ['↑'],
      group: 'note',
      enabled: has,
      run: () => transposeBy(1),
    },
    {
      id: 'down',
      label: 'Полутон вниз',
      keys: ['↓'],
      group: 'note',
      enabled: has,
      run: () => transposeBy(-1),
    },
    {
      id: 'octave-up',
      label: 'Октава вверх',
      keys: ['⇧↑'],
      group: 'note',
      enabled: has,
      run: () => transposeBy(12),
    },
    {
      id: 'octave-down',
      label: 'Октава вниз',
      keys: ['⇧↓'],
      group: 'note',
      enabled: has,
      run: () => transposeBy(-12),
    },
    {
      id: 'earlier',
      label: 'Раньше',
      keys: ['←'],
      group: 'note',
      enabled: has,
      run: () => nudge(-1),
    },
    {
      id: 'later',
      label: 'Позже',
      keys: ['→'],
      group: 'note',
      enabled: has,
      run: () => nudge(1),
    },
    {
      id: 'cut',
      label: 'Разрезать',
      keys: [],
      group: 'note',
      enabled: computed(() => selection.value.length === 1),
      run: cutPicked,
    },
    {
      id: 'join',
      label: 'Склеить',
      keys: ['J'],
      group: 'note',
      enabled: computed(() => has.value && selection.value[0]! + 1 < notes.value.length),
      run: joinPicked,
    },
    {
      id: 'ornament',
      label: 'Украшение',
      keys: ['O'],
      group: 'note',
      enabled: has,
      active: computed(() => has.value && picked.value.every((n) => n.ornament)),
      run: toggleOrnament,
    },
    {
      id: 'delete',
      label: 'Удалить',
      keys: ['⌫'],
      group: 'note',
      enabled: has,
      run: removePicked,
    },
    {
      id: 'play',
      label: 'Играть / пауза',
      keys: ['Пробел'],
      group: 'play',
      enabled: computed(() => notes.value.length > 0),
      run: () => hooks.togglePlay?.(),
    },
    {
      id: 'loop-picked',
      label: 'Цикл на выбранное',
      keys: ['A'],
      group: 'play',
      enabled: has,
      run: loopPicked,
    },
    {
      id: 'loop',
      label: 'Цикл',
      keys: ['C'],
      group: 'play',
      enabled: yes,
      active: computed(() => hooks.loopOn?.() ?? false),
      run: () => hooks.toggleLoop?.(),
    },
    {
      id: 'fit',
      label: 'По нотам',
      keys: ['Z'],
      group: 'view',
      enabled: yes,
      run: () => fitRequest.value++,
    },
    {
      id: 'zoom-in',
      label: 'Крупнее',
      keys: ['⌘+'],
      group: 'view',
      enabled: yes,
      run: () => (zoomRequest.value = { n: zoomRequest.value.n + 1, by: 1.5 }),
    },
    {
      id: 'zoom-out',
      label: 'Мельче',
      keys: ['⌘−'],
      group: 'view',
      enabled: yes,
      run: () => (zoomRequest.value = { n: zoomRequest.value.n + 1, by: 1 / 1.5 }),
    },
  ]
  const byId = new Map(commands.map((c) => [c.id, c]))
  const run = (id: string) => {
    const command = byId.get(id)
    if (command?.enabled.value) command.run()
  }

  /** The keyboard, for a page to hang on `window` while the editor is open. */
  function onKeyDown(event: KeyboardEvent): void {
    const target =
      typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
    // A focused button takes Space and Enter itself.
    if (target?.closest('button') && (event.code === 'Space' || event.code === 'Enter')) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    const code = event.code
    const hit = (id: string) => {
      event.preventDefault()
      run(id)
    }
    if (mod && code === 'KeyZ') return hit(event.shiftKey ? 'redo' : 'undo')
    if (mod && code === 'KeyY') return hit('redo')
    if (mod && code === 'KeyA') return hit('select-all')
    if (mod && (key === '+' || key === '=')) return hit('zoom-in')
    if (mod && key === '-') return hit('zoom-out')
    if (mod || event.altKey) return
    switch (code) {
      case 'Digit1':
        return hit('mode-pitch')
      case 'Digit2':
        return hit('mode-time')
      case 'Digit9':
        return hit('mode-notes')
      case 'KeyN':
        event.preventDefault()
        if (!event.repeat) held.value = 'notes'
        return
      case 'Space':
        return hit('play')
      case 'KeyC':
        return hit('loop')
      case 'KeyA':
        return hit('loop-picked')
      case 'KeyZ':
        return hit('fit')
      case 'KeyJ':
        return hit('join')
      case 'KeyO':
        return hit('ornament')
      case 'Escape':
        return hit('select-none')
      case 'Delete':
      case 'Backspace':
        return hit('delete')
      case 'ArrowUp':
        return hit(event.shiftKey ? 'octave-up' : 'up')
      case 'ArrowDown':
        return hit(event.shiftKey ? 'octave-down' : 'down')
      case 'ArrowLeft':
        return hit('earlier')
      case 'ArrowRight':
        return hit('later')
    }
  }
  function onKeyUp(event: KeyboardEvent): void {
    if (event.code === 'KeyN') held.value = null
  }

  return {
    notes,
    grid,
    selection,
    picked,
    mode,
    activeMode,
    ripple,
    snapTo,
    past,
    future,
    edited,
    fitRequest,
    zoomRequest,
    commands,
    run,
    reset,
    apply,
    undo,
    redo,
    jumpTo,
    select,
    onKeyDown,
    onKeyUp,
  }
}

export type PartEditor = ReturnType<typeof usePartEditor>

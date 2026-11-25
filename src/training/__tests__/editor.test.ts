import { describe, expect, it } from 'vitest'
import { usePartEditor } from '@/composables/usePartEditor'
import type { PartNote } from '@/training/vocal/part'

const n = (midi: number, start: number, end: number): PartNote => ({ midi, start, end })

describe('part editor', () => {
  const make = () => {
    const editor = usePartEditor({ cursor: () => 0 })
    editor.reset([n(60, 0, 1), n(62, 1, 2), n(64, 2.5, 3)], null)
    return editor
  }

  it('runs commands on the pick and keeps a history to walk back and forth', () => {
    const editor = make()
    editor.select([0, 2])
    editor.run('up')
    expect(editor.notes.value.map((x) => x.midi)).toEqual([61, 62, 65])
    editor.run('delete')
    expect(editor.notes.value.map((x) => x.midi)).toEqual([62])
    expect(editor.past.value.map((s) => s.label)).toEqual(['Выше', 'Удалить'])
    editor.run('undo')
    editor.run('undo')
    expect(editor.notes.value.map((x) => x.midi)).toEqual([60, 62, 64])
    editor.jumpTo(2)
    expect(editor.notes.value.map((x) => x.midi)).toEqual([62])
  })

  it('leaves commands that need a pick off without one', () => {
    const editor = make()
    const del = editor.commands.find((c) => c.id === 'delete')!
    expect(del.enabled.value).toBe(false)
    editor.run('delete')
    expect(editor.notes.value).toHaveLength(3)
    editor.run('select-all')
    expect(del.enabled.value).toBe(true)
  })

  it('switches modes by keys and holds the notes mode on N', () => {
    const editor = make()
    const key = (code: string, type: 'down' | 'up' = 'down') =>
      (type === 'down' ? editor.onKeyDown : editor.onKeyUp)({
        code,
        key: '',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        target: null,
        preventDefault() {},
      } as unknown as KeyboardEvent)
    key('Digit2')
    expect(editor.activeMode.value).toBe('time')
    key('KeyN')
    expect(editor.activeMode.value).toBe('notes')
    key('KeyN', 'up')
    expect(editor.activeMode.value).toBe('time')
  })
})

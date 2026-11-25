import { supabase } from '@/lib/supabase'
import type { Json } from '@/lib/database.types'
import type { PartNote } from '@/training/vocal/part'

/**
 * Vocal trainings: a teacher's recording and the part taken from it, kept under an id the student
 * gets as a link. No accounts — anyone with the link opens it.
 *
 * With Supabase in the build they live in the `vocal_trainings` table and the `vocal-recordings`
 * bucket (supabase/migrations/20261124000001_vocal_trainings.sql). Without it, in this browser's
 * IndexedDB: the link then opens only here, which is enough to try the trainer alone.
 */
export interface VocalTraining {
  readonly id: string
  readonly title: string
  readonly notes: readonly PartNote[]
  /** Where the recording plays from. */
  readonly audioUrl: string
}

export interface NewVocalTraining {
  readonly title: string
  readonly notes: readonly PartNote[]
  readonly audio: Blob
}

/** Whether a saved training opens on other devices too. */
export const sharedStore = supabase !== null

const BUCKET = 'vocal-recordings'
const PART_VERSION = 1

export async function saveVocalTraining(training: NewVocalTraining): Promise<string> {
  const id = crypto.randomUUID()
  if (supabase === null) {
    await local('readwrite', (store) =>
      store.put({ id, title: training.title, notes: training.notes, audio: training.audio }),
    )
    return id
  }
  const path = `${id}.${extensionOf(training.audio.type)}`
  const upload = await supabase.storage
    .from(BUCKET)
    .upload(path, training.audio, { contentType: training.audio.type || 'audio/webm' })
  if (upload.error) throw new Error(`Запись не загрузилась: ${upload.error.message}`)
  const insert = await supabase.from('vocal_trainings').insert({
    id,
    title: training.title,
    part: { version: PART_VERSION, notes: training.notes } as unknown as Json,
    audio_path: path,
  })
  if (insert.error) throw new Error(`Тренировка не сохранилась: ${insert.error.message}`)
  return id
}

export async function loadVocalTraining(id: string): Promise<VocalTraining | null> {
  if (supabase === null) {
    const row = await local<StoredLocally | undefined>('readonly', (store) => store.get(id))
    if (!row) return null
    return { id, title: row.title, notes: row.notes, audioUrl: URL.createObjectURL(row.audio) }
  }
  const { data, error } = await supabase
    .from('vocal_trainings')
    .select('id, title, part, audio_path')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`Тренировка не загрузилась: ${error.message}`)
  if (!data) return null
  const part = data.part as unknown as { notes: PartNote[] }
  return {
    id,
    title: data.title,
    notes: part.notes,
    audioUrl: supabase.storage.from(BUCKET).getPublicUrl(data.audio_path).data.publicUrl,
  }
}

interface StoredLocally {
  readonly id: string
  readonly title: string
  readonly notes: PartNote[]
  readonly audio: Blob
}

function extensionOf(type: string): string {
  if (type.includes('mp4') || type.includes('aac')) return 'm4a'
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('wav')) return 'wav'
  if (type.includes('mpeg')) return 'mp3'
  return 'webm'
}

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('music-training-vocal', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('trainings', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return db
}

async function local<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const store = (await open()).transaction('trainings', mode).objectStore('trainings')
  return new Promise<T>((resolve, reject) => {
    const request = run(store)
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  })
}

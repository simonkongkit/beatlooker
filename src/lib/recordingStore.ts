/**
 * 把最后一段录音存在浏览器里（IndexedDB），刷新页面也还在。
 *
 * 为什么不用 localStorage：它只能存字符串，音频转 base64 会膨胀 33%，还有 5MB 硬上限，
 * 而且是同步 API（写的时候卡主线程）。IndexedDB 存 Blob 是原生的，容量按配额走。
 *
 * 存不下 / 读不到 / 被禁用，一律**静默降级** —— 录音是锦上添花，
 * 绝不能因为它让整个应用不可用（和草稿存储一个原则）。
 */

const DB_NAME = 'beatlooker'
const DB_VERSION = 1
const STORE = 'recordings'
const KEY = 'last'

export interface StoredRecording {
  blob: Blob
  seconds: number
  mimeType: string
  /** 存下来的时刻（毫秒时间戳），界面上可以显示"什么时候录的" */
  savedAt: number
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode)
      const req = run(t.objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(null)
      t.onabort = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function saveRecording(rec: StoredRecording): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  try {
    const ok = await tx(db, 'readwrite', (s) => s.put(rec, KEY) as IDBRequest<IDBValidKey>)
    return ok !== null
  } finally {
    db.close()
  }
}

export async function loadRecording(): Promise<StoredRecording | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const v = await tx<StoredRecording>(db, 'readonly', (s) => s.get(KEY) as IDBRequest<StoredRecording>)
    // 存坏了也不能把畸形数据放进来 —— 和草稿存储一个原则
    if (!v || !(v.blob instanceof Blob) || !(v.blob.size > 0)) return null
    return v
  } finally {
    db.close()
  }
}

export async function clearStoredRecording(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await tx(db, 'readwrite', (s) => s.delete(KEY) as unknown as IDBRequest<undefined>)
  } finally {
    db.close()
  }
}

/** 按 MIME 猜一个文件扩展名，下载的时候用 */
export function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a'
  if (mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  return 'bin'
}

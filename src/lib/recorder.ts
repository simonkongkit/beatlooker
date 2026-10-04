/**
 * 麦克风录音：只为了"回放自己刚弹的那一遍"，和分析链路完全独立。
 *
 * 为什么用 MediaRecorder 而不是自己存 PCM：
 *   · 压缩后一分钟才约 1MB，存 PCM 要 11MB/分钟
 *   · 回放直接交给 <audio>，播放/暂停/拖动进度条全都是现成的，手机上也是原生控件
 *   · 和分析并存没有冲突 —— 同一条 MediaStream 可以同时喂给 worklet 和 recorder
 *
 * ⚠️ 和分析对不齐是**必然**的：分析链路整体延迟 delaySeconds 秒（默认 1 秒），
 *    所以"图上第 t 秒"对应的其实是录音里的第 t − delay 秒。回放头必须减掉这个偏移，
 *    否则你听到的和看到的永远差一秒。这个换算在 App 里做（见 playheadAt)。
 */

export interface Recording {
  /** 可以直接喂给 <audio src> 的地址（blob URL） */
  url: string
  /** 原始 Blob。留着是为了能存进 IndexedDB（刷新后还在）和下载成文件 */
  blob: Blob
  /** 录了多久（秒） */
  seconds: number
  /** 压缩后多少字节 */
  bytes: number
  /** 实际用的 MIME 类型 */
  mimeType: string
}

/** 按优先级从高到低试。opus 在同等码率下音质最好，mp4 是 Safari 的兜底。 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg'
]

/**
 * 挑一个浏览器支持的录音格式。纯函数，方便单测 ——
 * MediaRecorder 本身在 node 里不存在，但"怎么挑"这件事是纯逻辑。
 */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (isSupported(t)) return t
    } catch {
      /* 某些实现对畸形字符串会抛，忽略继续试 */
    }
  }
  // 一个都不支持时返回空串：交给 MediaRecorder 用它自己的默认值
  return ''
}

export class MicRecorder {
  /** 录完之后回调，参数可以直接给 <audio> */
  onResult: ((r: Recording | null) => void) | null = null

  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private last: Recording | null = null

  /** 浏览器支不支持录音 */
  get supported(): boolean {
    return typeof MediaRecorder !== 'undefined'
  }

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording'
  }

  /** 已经录了多少秒 */
  get seconds(): number {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0
  }

  /** 上一次录完的结果（没有就是 null） */
  get result(): Recording | null {
    return this.last
  }

  /** 开始录。返回 false 表示没录成（不支持 / 没有流 / 已经有一份在录） */
  start(stream: MediaStream): boolean {
    if (!this.supported || this.recording) return false
    try {
      const mimeType = pickMimeType((t) =>
        typeof MediaRecorder.isTypeSupported === 'function'
          ? MediaRecorder.isTypeSupported(t)
          : false
      )
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      this.chunks = []
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data)
      }
      rec.onerror = () => {
        this.recorder = null
        this.chunks = []
      }
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(this.chunks, { type })
        this.chunks = []
        this.recorder = null
        if (blob.size === 0) {
          this.onResult?.(null)
          return
        }
        // 先放掉上一份的地址，否则连录几次会攒下一堆 blob 不放
        if (this.last) URL.revokeObjectURL(this.last.url)
        this.last = {
          url: URL.createObjectURL(blob),
          blob,
          seconds: (Date.now() - this.startedAt) / 1000,
          bytes: blob.size,
          mimeType: type
        }
        this.onResult?.(this.last)
      }
      // 每秒切一块：这样长时间录音也不会把整段攒在一个巨大的 Blob 里
      rec.start(1000)
      this.recorder = rec
      this.startedAt = Date.now()
      return true
    } catch {
      this.recorder = null
      this.chunks = []
      return false
    }
  }

  /** 停止录音。结果通过 onResult 回调给出（MediaRecorder 的 onstop 是异步的）。 */
  stop(): void {
    const rec = this.recorder
    if (!rec) return
    try {
      if (rec.state !== 'inactive') rec.stop()
    } catch {
      this.recorder = null
      this.chunks = []
    }
  }

  /** 丢掉当前录音（释放 blob URL） */
  clear(): void {
    this.stop()
    if (this.last) {
      URL.revokeObjectURL(this.last.url)
      this.last = null
    }
    this.onResult?.(null)
  }
}

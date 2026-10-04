import type { SpectralPeak } from './harmonic.ts'

/**
 * 谱峰日志：每列存下这一帧的**谱峰**（频率 + 幅度），而不是整条频谱。
 *
 * ## 为什么需要单独存
 *
 * 谐波求和要在"某个候选基频的各次谐波位置上"去查有没有峰 ✓
 * 而原有的 NoteLog 只存"每条频带的能量" ✗ 频带全音域只有 ~80 条，
 * 500Hz 以下每条覆盖 2~3 个半音 ✗ 中心频率离真实谐波位置太远 ✓
 *
 * 实测对比过（4 份录音 × 5 个音）：**频带版和谱峰版的结论 0/20 一致** ✗
 * 频带版报 E2、G#3、F#3，谱峰版报 G3、G2、C2、D4、F4 ✓ 后者才符合乐理 ✓
 * 所以这条捷径走不通，必须存峰。
 *
 * ## 为什么存峰而不是存频谱
 *
 * 一帧 1024 个 bin ✗ 每列 4KB ✗ 26 秒就是 10MB ✗
 * 一列峰通常十几到几十个 ✓ 取最强的 24 个就够 ✓ 每列约 200 字节 ✓ 省 20 倍 ✓
 */

const CHUNK = 4096

export class PeakLog {
  /** 列率（列/秒） */
  readonly rate: number
  /** 每列最多存几个峰 */
  readonly maxPeaks: number
  /** 记录上限（列数），0 = 不限 */
  readonly maxColumns: number

  private colChunks: Uint8Array[] = []
  private dataChunks: Float32Array[] = []
  private n = 0
  private scratch: SpectralPeak[] = []

  constructor(rate: number, opts: { maxPeaks?: number; maxColumns?: number } = {}) {
    this.rate = rate
    this.maxPeaks = Math.max(1, Math.min(64, Math.round(opts.maxPeaks ?? 24)))
    this.maxColumns = Math.max(0, Math.round(opts.maxColumns ?? 0))
  }

  get columns(): number {
    return this.n
  }

  get full(): boolean {
    return this.maxColumns > 0 && this.n >= this.maxColumns
  }

  /** 已用的字节数（估算，给界面显示占用） */
  get bytes(): number {
    return this.n * (this.maxPeaks * 8 + 1)
  }

  push(peaks: SpectralPeak[]): void {
    if (this.full) return
    const ci = Math.floor(this.n / CHUNK)
    if (!this.colChunks[ci]) {
      this.colChunks[ci] = new Uint8Array(CHUNK)
      this.dataChunks[ci] = new Float32Array(CHUNK * this.maxPeaks * 2)
    }
    const off = this.n % CHUNK
    const cnt = Math.min(this.maxPeaks, peaks.length)
    const cols = this.colChunks[ci]
    const d = this.dataChunks[ci]
    cols[off] = cnt

    // 只留最强的几个 —— 谐波求和要的是"这个位置有没有峰"，弱峰反而是噪声
    let list = peaks
    if (peaks.length > cnt) {
      list = peaks.slice().sort((a, b) => b.m - a.m)
    }
    const base = off * this.maxPeaks * 2
    for (let i = 0; i < cnt; i++) {
      d[base + i * 2] = list[i].f
      d[base + i * 2 + 1] = list[i].m
    }
    this.n++
  }

  /**
   * 第 col 列的峰。
   *
   * ⚠️ 复用同一个数组返回，**调用方不要存引用** —— 每列都新建对象的话，
   * 一帧几十个对象、每秒钟上百帧，GC 会很难看。
   */
  at(col: number): SpectralPeak[] {
    const out = this.scratch
    out.length = 0
    if (col < 0 || col >= this.n) return out
    const ci = Math.floor(col / CHUNK)
    const off = col % CHUNK
    const cnt = this.colChunks[ci][off]
    const base = off * this.maxPeaks * 2
    const d = this.dataChunks[ci]
    for (let i = 0; i < cnt; i++) {
      out.push({ f: d[base + i * 2], m: d[base + i * 2 + 1] })
    }
    return out
  }

  clear(): void {
    this.colChunks = []
    this.dataChunks = []
    this.n = 0
  }
}

/**
 * 音乐带能量日志：**每列存「每条带多少 dB」，一条带一个字节**。
 *
 * 为什么不像 EnergyLog 那样存 Float32：
 *   · 带的数量是几十条（按十二平均律切出来约 90 条），不是一条
 *   · 起点检测只关心「抬升了多少 dB」，0.4dB 的量化误差完全够用
 *   一个字节能把 -100 ~ +537dB 表示完，存 Float32 是四倍空间换用不上的精度。
 *
 * 时间轴同样不单独存：第 i 列就是 i / rate 秒，和 EnergyLog 一个约定。
 * 纯逻辑，不碰 DOM，可以用 node 跑测试。
 */

/** 可表示的最低 dB */
export const DB_FLOOR = -100
/** 一个字节代表多少 dB */
export const DB_PER_STEP = 2.5

export function encodeDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  const v = Math.round((db - DB_FLOOR) / DB_PER_STEP)
  return v < 0 ? 0 : v > 255 ? 255 : v
}

export function decodeDb(byte: number): number {
  return byte * DB_PER_STEP + DB_FLOOR
}

export class NoteLog {
  /** 每秒产出多少列 */
  readonly rate: number
  /** 每条带几个字节 = 每条带多少个音 */
  readonly bandCount: number

  private readonly chunkColumns: number
  private readonly maxColumns: number
  private chunks: Uint8Array[] = []
  private used = 0

  constructor(
    bandCount: number,
    rate: number,
    options: { chunkColumns?: number; maxColumns?: number } = {}
  ) {
    this.bandCount = Math.max(0, Math.round(bandCount))
    this.rate = rate > 0 ? rate : 1
    this.chunkColumns = Math.max(1, Math.round(options.chunkColumns ?? 2048))
    this.maxColumns = Math.max(0, Math.round(options.maxColumns ?? 0))
  }

  get columns(): number {
    return this.used
  }

  get seconds(): number {
    return this.used / this.rate
  }

  get full(): boolean {
    return this.maxColumns > 0 && this.used >= this.maxColumns
  }

  get bytes(): number {
    return this.chunks.length * this.chunkColumns * this.bandCount
  }

  /** 写入一列：每条带一个**能量**（线性），内部转成 dB 字节 */
  pushEnergies(energies: Float32Array | number[]): void {
    if (this.bandCount === 0) return
    if (this.full) return
    const index = this.used
    const chunkIndex = Math.floor(index / this.chunkColumns)
    let chunk = this.chunks[chunkIndex]
    if (!chunk) {
      chunk = new Uint8Array(this.chunkColumns * this.bandCount)
      this.chunks[chunkIndex] = chunk
    }
    const base = (index % this.chunkColumns) * this.bandCount
    for (let b = 0; b < this.bandCount; b++) {
      const v = energies[b] ?? 0
      chunk[base + b] = v > 0 ? encodeDb(10 * Math.log10(v)) : 0
    }
    this.used++
  }

  /** 某一列某条带的 dB；越界返回地板值 */
  at(column: number, band: number): number {
    if (column < 0 || column >= this.used || band < 0 || band >= this.bandCount) {
      return DB_FLOOR
    }
    const chunk = this.chunks[Math.floor(column / this.chunkColumns)]
    if (!chunk) return DB_FLOOR
    return decodeDb(chunk[(column % this.chunkColumns) * this.bandCount + band])
  }

  /**
   * 取出一条带的完整时间序列（dB）。
   * 检测是按带跑的，需要连续内存；所以这里复制一份出来（几十条 x 几千列，量很小）。
   */
  bandSeries(band: number, out?: Float32Array): Float32Array {
    const dst = out && out.length === this.used ? out : new Float32Array(this.used)
    for (let i = 0; i < dst.length; i++) dst[i] = this.at(i, band)
    return dst
  }

  clear(): void {
    this.chunks = []
    this.used = 0
  }
}

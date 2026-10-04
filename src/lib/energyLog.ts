/**
 * 能量读数日志：按时间顺序记录每一列的总能量，并隐含保存时间轴。
 *
 * 用分块 Float32Array 存储，每点 4 字节：
 *   48kHz / hop 512 → 93.75 个读数/秒 → 2 分钟约 1.1 万个读数 ≈ 45 KB
 * 分块不是为了省空间，而是避免单个大数组反复扩容时的整块拷贝。
 *
 * 时间轴不单独存：读数等间隔产出，第 i 个读数对应的时间就是 i / rate 秒。
 * 这样省掉一半空间，更重要的是保证时间轴和读数永远一一对应、不会错位。
 */
export class EnergyLog {
  /** 每秒产出多少个读数。构造后不变，它就是时间轴的刻度。 */
  readonly rate: number

  private used = 0
  private readonly chunkSize: number
  private readonly maxReadings: number
  private chunks: Float32Array[] = []
  /** 历史最大值，边写边更新，省得每次重排都全量扫一遍 */
  private peak = 0

  constructor(rate: number, options: { chunkSize?: number; maxReadings?: number } = {}) {
    this.rate = rate > 0 ? rate : 1
    // 下限只保证「至少一个读数一块」；默认 4096 块 ≈ 每 44 秒分配一次
    this.chunkSize = Math.max(1, Math.round(options.chunkSize ?? 4096))
    this.maxReadings = Math.max(0, Math.round(options.maxReadings ?? 0))
  }

  /** 已记录多少个读数 */
  get length(): number {
    return this.used
  }

  /** 已记录多少秒 */
  get seconds(): number {
    return this.used / this.rate
  }

  /** 是否已经写满上限 */
  get full(): boolean {
    return this.maxReadings > 0 && this.used >= this.maxReadings
  }

  /** 历史最大值，用来给所有行定同一个纵轴 */
  get max(): number {
    return this.peak
  }

  /** 当前实际占用的字节数（含未写满的最后一块） */
  get bytes(): number {
    return this.chunks.length * this.chunkSize * 4
  }

  /** 追加一个读数 */
  push(value: number): void {
    if (this.full) return

    const chunkIndex = (this.used / this.chunkSize) | 0
    if (chunkIndex === this.chunks.length) {
      this.chunks.push(new Float32Array(this.chunkSize))
    }
    this.chunks[chunkIndex][this.used % this.chunkSize] = value
    this.used++

    if (value > this.peak) this.peak = value
  }

  /** 按序号读一个读数；越界返回 0 */
  at(index: number): number {
    if (index < 0 || index >= this.used) return 0
    return this.chunks[(index / this.chunkSize) | 0][index % this.chunkSize]
  }

  /** 第 index 个读数对应的时间（秒，从开始记录算起） */
  timeAt(index: number): number {
    return index / this.rate
  }

  clear(): void {
    this.chunks = []
    this.used = 0
    this.peak = 0
  }
}

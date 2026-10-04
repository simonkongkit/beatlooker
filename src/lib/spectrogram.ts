/**
 * 频谱列环形缓冲。
 *
 * 音频侧不断产出「列」—— 一列的每个元素，是某个频率格的幅度；
 * 渲染侧按帧取走还没画的列，画到画布最右侧。
 *
 * 注意：这里不保存历史，只保存「还没画完的列」。渲染落后太多时
 * （典型场景：切到后台待了很久再切回来）会直接丢弃旧列，
 * 避免一次性补画几千列把页面卡死。
 */
export class Spectrogram {
  private readonly columns: Float32Array[]
  /** 每列的总能量，和 columns 一一对应，随 produce 一起写入 */
  private readonly energies: Float32Array
  private writeAt = 0
  /** consume() 刚取走的那一列的能量 */
  private lastEnergy = 0

  /** 累计产出过多少列（只增不减） */
  produced = 0
  /** 累计绘制过多少列 */
  consumed = 0

  constructor(capacity: number, numBins: number) {
    if (capacity <= 0 || numBins <= 0) {
      throw new Error('capacity / numBins 必须为正')
    }
    this.columns = Array.from({ length: capacity }, () => new Float32Array(numBins))
    this.energies = new Float32Array(capacity)
  }

  get capacity(): number {
    return this.columns.length
  }

  get numBins(): number {
    return this.columns[0].length
  }

  /** 还有多少列等着被画 */
  get pending(): number {
    return Math.max(0, this.produced - this.consumed)
  }

  /** 写入一列（连同它的总能量） */
  produce(src: Float32Array, energy: number): void {
    const col = this.columns[this.writeAt]
    col.set(src.length > col.length ? src.subarray(0, col.length) : src)
    this.energies[this.writeAt] = energy
    this.writeAt = (this.writeAt + 1) % this.capacity
    this.produced++

    // 覆盖到了还没消费的列，说明渲染跟不上了，把消费游标顶上去
    if (this.produced - this.consumed > this.capacity) {
      this.consumed = this.produced - this.capacity
    }
  }

  /** 取下一列；没有新列时返回 null */
  consume(): Float32Array | null {
    if (this.consumed >= this.produced) return null
    const slot = this.consumed % this.capacity
    this.lastEnergy = this.energies[slot]
    this.consumed++
    return this.columns[slot]
  }

  /**
   * 刚被 consume() 取走的那一列的总能量。
   *
   * 能量是引擎在产出那一列时算好的，画面和记录用的是同一个值，
   * 不会出现「图上画的和录下来的对不上」。
   */
  get consumedEnergy(): number {
    return this.lastEnergy
  }

  /** 丢弃 n 列不画 */
  skip(n: number): void {
    this.consumed = Math.min(this.produced, this.consumed + n)
  }

  reset(): void {
    this.produced = 0
    this.consumed = 0
    this.writeAt = 0
  }
}

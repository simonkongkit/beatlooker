/**
 * 环形缓冲：保存最近一段时间的音频样本，可以按「延迟 D 个样本」取出一个窗口。
 *
 * 纯计算、不碰 DOM / Web Audio，所以能直接用 node 跑测试
 * （见 tools/check-delay.mjs）。
 */
export class DelayLine {
  private buffer: Float32Array
  private writeIndex = 0
  private available = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('capacity 必须是正整数')
    }
    this.buffer = new Float32Array(capacity)
  }

  get capacity(): number {
    return this.buffer.length
  }

  /** 当前有效样本数（上限为容量） */
  get length(): number {
    return this.available
  }

  /** 写入一段连续样本 */
  push(samples: Float32Array): void {
    const cap = this.buffer.length
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i]
      this.writeIndex = (this.writeIndex + 1) % cap
      if (this.available < cap) this.available++
    }
  }

  /**
   * 取出一个窗口：窗口最后一个样本 = 「最新样本往前 delaySamples 个」。
   * 数据不够时返回 false，并把 out 全部清零（避免画出还没录到的假静音）。
   */
  readDelayed(delaySamples: number, out: Float32Array): boolean {
    const cap = this.buffer.length
    const len = out.length

    if (len === 0) return false
    if (delaySamples < 0 || this.available < delaySamples + len) {
      out.fill(0)
      return false
    }

    // writeIndex 指向下一个写入位置，所以最新样本在 writeIndex - 1。
    // 窗口是左闭右开的 [start, end)。
    const end = (((this.writeIndex - delaySamples) % cap) + cap) % cap
    const start = end - len

    for (let i = 0; i < len; i++) {
      const idx = (((start + i) % cap) + cap) % cap
      out[i] = this.buffer[idx]
    }
    return true
  }

  clear(): void {
    this.buffer.fill(0)
    this.writeIndex = 0
    this.available = 0
  }
}

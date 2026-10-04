/**
 * 定长 radix-2 FFT + 汉宁窗 + 单边幅度谱。
 *
 * 纯计算，不依赖 DOM / Web Audio，可以用 node 直接跑测试
 * （见 tools/check-spectrum.mjs）。
 */

/** 旋转因子查表缓存：key 是 FFT 点数，值是该点数下的 cos/sin 表 */
const twiddleCache = new Map<number, { re: Float32Array; im: Float32Array }>()

function getTwiddles(n: number) {
  let table = twiddleCache.get(n)
  if (!table) {
    const half = n >> 1
    const re = new Float32Array(half)
    const im = new Float32Array(half)
    for (let k = 0; k < half; k++) {
      const angle = (-2 * Math.PI * k) / n
      re[k] = Math.cos(angle)
      im[k] = Math.sin(angle)
    }
    table = { re, im }
    twiddleCache.set(n, table)
  }
  return table
}

/**
 * 原地 FFT（Cooley-Tukey，迭代版）。
 * re / im 必须等长且长度为 2 的幂。
 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n !== im.length || n < 2 || (n & (n - 1)) !== 0) {
    throw new Error('FFT 长度必须是 2 的幂，且 re / im 等长')
  }

  // 1) 位反转置换，把输入排成蝶形运算需要的顺序
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  // 2) 逐级蝶形：len 从 2 倍增到 n
  const tw = getTwiddles(n)
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len // 这一级相邻蝶形之间的旋转因子间隔
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const k = j * step
        const wr = tw.re[k]
        const wi = tw.im[k]

        const a = i + j
        const b = a + half
        const br = re[b]
        const bi = im[b]

        // 复数乘法 (br + i·bi) × (wr + i·wi)
        const vr = br * wr - bi * wi
        const vi = br * wi + bi * wr

        const ar = re[a]
        const ai = im[a]
        re[a] = ar + vr
        im[a] = ai + vi
        re[b] = ar - vr
        im[b] = ai - vi
      }
    }
  }
}

/** 分析窗形状 */
export type WindowType = 'hann' | 'sawtooth'

/**
 * 生成分析窗。
 *
 * · **hann**（默认）：对称、两侧平滑。频率分辨率好 —— 这是**分析音高 / 画频谱图**用的。
 * · **sawtooth**：**左高右低**的锯齿（线性从 1 降到 1/N），不是两侧平滑。
 *   专门给**起音检测**用：它把这一帧的重心压在前半段，于是起音发生时
 *   "窗的前半段还是安静的、后半段已经有声音"这个过渡会被放大成一次明显的台阶。
 *
 * ⚠️ 锯齿窗在左边界有一个跳变，频率分辨率很差、频谱会糊 —— 所以它**只能**用来
 * 提取"能量随时间怎么变"，不能用来认音高。这就是两条链路要分开的原因。
 */
export function makeWindow(type: WindowType, size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    // 锯齿：左端 1、右端趋近 0（保留 1/N 而不是 0，窗和才不会退化成 0）
    w[i] = type === 'sawtooth' ? 1 - i / size : 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  }
  return w
}

/**
 * 频谱分析器：负责加窗、FFT、幅度归一化。
 * 内部缓冲全部复用，每分析一帧不产生任何新对象。
 */
export class SpectrumAnalyser {
  readonly fftSize: number
  /** 单边谱的有效 bin 数 = fftSize / 2 */
  readonly numBins: number
  /** 最新一帧的幅度谱，元素约在 0..1 之间（满量程正弦 ≈ 1.0） */
  readonly magnitudes: Float32Array

  private readonly window: Float32Array
  private readonly windowSum: number
  private readonly re: Float32Array
  private readonly im: Float32Array

  /** 这一路用的窗形状 */
  readonly windowType: WindowType

  constructor(fftSize: number, windowType: WindowType = 'hann') {
    if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
      throw new Error('fftSize 必须是 2 的幂')
    }
    this.fftSize = fftSize
    this.windowType = windowType
    this.numBins = fftSize >> 1
    this.magnitudes = new Float32Array(this.numBins)
    this.re = new Float32Array(fftSize)
    this.im = new Float32Array(fftSize)

    // 顺便记下窗和，用于幅度归一化
    const window = makeWindow(windowType, fftSize)
    let sum = 0
    for (let i = 0; i < fftSize; i++) sum += window[i]
    this.window = window
    this.windowSum = sum
  }

  /**
   * 分析一帧时域样本，返回幅度谱（内部复用同一个 Float32Array）。
   * samples 至少要 fftSize 个。
   */
  analyse(samples: Float32Array): Float32Array {
    const n = this.fftSize
    const { re, im, window, magnitudes } = this

    for (let i = 0; i < n; i++) {
      re[i] = samples[i] * window[i]
      im[i] = 0
    }

    fftInPlace(re, im)

    // 单边谱：乘 2 补回负频率那半边，再除以窗和
    const scale = 2 / this.windowSum
    for (let k = 0; k < this.numBins; k++) {
      magnitudes[k] = Math.hypot(re[k], im[k]) * scale
    }
    return magnitudes
  }
}

/**
 * 一列频谱的总能量：所有 bin 的幅度平方和（正比于信号功率）。
 *
 * 恒 ≥ 0 且没有上界 —— 这正是「纵轴 0 到无穷」的含义，
 * 所以纵轴的满量程不能写死，必须由调用方自适应给出。
 */
/**
 * 对数频率轴的上下限。
 *
 * 放在这里（而不是 App.svelte）是因为**采集端也要用**：切音带时必须按同一个频率范围，
 * 否则检测结果和画面对不上。之前这两处各写了一份 50/16000。
 */
export const F_MIN = 50
export const F_MAX = 16000

export function columnEnergy(magnitudes: Float32Array): number {
  let sum = 0
  for (let k = 0; k < magnitudes.length; k++) {
    const m = magnitudes[k]
    sum += m * m
  }
  return sum
}

/**
 * 音高与频带：以 **A4 = 440Hz** 为基准的十二平均律，以及常见乐器的音域。
 * 纯逻辑，不碰 DOM，可以用 node 跑测试。
 *
 * 为什么要这个：只测总能量的跳跃，只能知道「有东西响了」，不知道「响的是哪个音」。
 * 把频谱切成一条条**音带**之后，就能检测「某个音上突然出现高能量」—— 既能给起点
 * 标上音名，也能发现总能量没怎么动、但某条带明显起来的音（轻奏、高音区）。
 *
 * ⚠️ 一个重要限制：能不能「一个半音一条带」由 FFT 分辨率决定，不由我们决定。
 *    间隔 = f × (2^(1/12) − 1) ≈ f × 5.95%；bin 宽 = 采样率 / FFT 长度。
 *    48kHz + 2048 点 → 23.4Hz/bin，于是：
 *      A4 (440Hz) 半音间隔 26Hz  → 勉强分得开
 *      C4 (262Hz) 半音间隔 16Hz  → 不到一个 bin
 *      E2 ( 82Hz) 半音间隔 4.9Hz → 差得远
 *    所以 buildBands() 会把落进同一个 bin 区间的相邻音**合并**成一条带，
 *    标签写成 "C2–D2" 这样的范围。假装能分开是骗自己。
 */

/** 标准音：A4 = 440Hz */
export const A4_HZ = 440
/** A4 的 MIDI 音高号（C-1 = 0，所以 A4 = 69） */
export const A4_MIDI = 69

export function midiToFreq(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12)
}

export function freqToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_HZ)
}

/** 十二个音名（用升号写法） */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 简谱唱名，和音名一一对应 */
export const SOLFEGE = ['1', '#1', '2', '#2', '3', '4', '#4', '5', '#5', '6', '#6', '7']

/** MIDI 号 -> "A4" 这样的音名 */
export function midiName(midi: number): string {
  const n = Math.round(midi)
  const pc = ((n % 12) + 12) % 12
  const octave = Math.floor(n / 12) - 1
  return NOTE_NAMES[pc] + octave
}

/** MIDI 号 -> 简谱写法（带八度点）。以中央 C（C4）为不带点的那一组。 */
export function midiSolfege(midi: number): string {
  const n = Math.round(midi)
  const pc = ((n % 12) + 12) % 12
  const octave = Math.floor(n / 12) - 1
  const base = SOLFEGE[pc]
  const shift = octave - 4
  if (shift === 0) return base
  // 简谱用上下点表示八度，这里用 ↑↓ 的文本近似（画到谱面上时才用真正的点）
  return shift > 0 ? base + '↑'.repeat(shift) : base + '↓'.repeat(-shift)
}

/** 两个音之间差几个半音 */
export function semitonesBetween(a: number, b: number): number {
  return Math.round(b) - Math.round(a)
}

/* ------------------------------ 常见乐器音域 ------------------------------ */

export interface Instrument {
  id: string
  name: string
  /** 音域下限的 MIDI 号（含） */
  minMidi: number
  /** 音域上限的 MIDI 号（含） */
  maxMidi: number
}

/** 音域按常见演奏范围给，不是理论极限。用户选一个来缩小检测范围，能显著减少误检。 */
export const INSTRUMENTS: Instrument[] = [
  { id: 'piano', name: '钢琴', minMidi: 21, maxMidi: 108 },
  { id: 'guitar', name: '吉他', minMidi: 40, maxMidi: 88 },
  { id: 'bass', name: '贝斯', minMidi: 28, maxMidi: 67 },
  { id: 'violin', name: '小提琴', minMidi: 55, maxMidi: 103 },
  { id: 'cello', name: '大提琴', minMidi: 36, maxMidi: 81 },
  { id: 'flute', name: '长笛', minMidi: 60, maxMidi: 98 },
  { id: 'clarinet', name: '单簧管', minMidi: 50, maxMidi: 94 },
  { id: 'sax', name: '萨克斯', minMidi: 49, maxMidi: 90 },
  { id: 'trumpet', name: '小号', minMidi: 52, maxMidi: 84 },
  { id: 'erhu', name: '二胡', minMidi: 62, maxMidi: 93 },
  { id: 'dizi', name: '竹笛', minMidi: 57, maxMidi: 93 },
  { id: 'guzheng', name: '古筝', minMidi: 38, maxMidi: 98 },
  { id: 'pipa', name: '琵琶', minMidi: 45, maxMidi: 88 },
  { id: 'vocal', name: '人声', minMidi: 40, maxMidi: 84 }
]

export const ALL_INSTRUMENTS: Instrument = {
  id: 'all',
  name: '不限定（全部）',
  minMidi: 28,
  maxMidi: 108
}

export function findInstrument(id: string): Instrument {
  if (id === ALL_INSTRUMENTS.id) return ALL_INSTRUMENTS
  return INSTRUMENTS.find((i) => i.id === id) ?? ALL_INSTRUMENTS
}

/* -------------------------------- 频带 -------------------------------- */

export interface Band {
  /** 这条带覆盖的最低 / 最高音（合并时两者不同） */
  minMidi: number
  maxMidi: number
  /** 代表音（合并时取最低音） */
  midi: number
  /** 中心频率，取代表音的频率 */
  freq: number
  /** 占用的 FFT bin 区间 [lo, hi) */
  lo: number
  hi: number
  /** 这条带是不是合并出来的（分不开的那些） */
  merged: boolean
  /** 展示用的标签："A4" 或 "C2–D2" */
  label: string
}

/**
 * 按十二平均律切频带。落在同一个 bin 区间的相邻音会被合并 —— 见文件头的说明。
 *
 * @param fMin 频率下限（低于它的音不建带）
 * @param fMax 频率上限
 */
export function buildBands(
  fMin: number,
  fMax: number,
  fftSize: number,
  sampleRate: number
): Band[] {
  if (!(fftSize > 0) || !(sampleRate > 0) || !(fMax > fMin)) return []
  const binHz = sampleRate / fftSize
  const half = Math.floor(fftSize / 2)

  const minMidi = Math.ceil(freqToMidi(Math.max(fMin, binHz)))
  const maxMidi = Math.floor(freqToMidi(fMax))

  // 第一步：每个半音归属**最近的 bin**。
  // 不能拿频率边界去四舍五入定 bin 区间 —— 当一个音比一个 bin 还窄时（低频区就是这样），
  // 那样算出来的区间会整个落到邻居的 bin 上，音名直接错两个半音。
  // 第一版就是这么错的：82.4Hz 的 E2 被标成了 F2–G#2。
  const groups: { bin: number; minMidi: number; maxMidi: number }[] = []
  for (let m = minMidi; m <= maxMidi; m++) {
    const bin = Math.round(midiToFreq(m) / binHz)
    if (bin < 1 || bin >= half) continue
    const last = groups[groups.length - 1]
    if (last && last.bin === bin) last.maxMidi = m
    else groups.push({ bin, minMidi: m, maxMidi: m })
  }

  // 第二步：每条带一直覆盖到**下一条带的起点**，中间的 bin 不会被丢掉
  return groups.map((g, i) => {
    const next = groups[i + 1]
    const lo = g.bin
    const hi = next ? next.bin : Math.min(half, g.bin + 1)
    const merged = g.maxMidi > g.minMidi
    return {
      minMidi: g.minMidi,
      maxMidi: g.maxMidi,
      midi: g.minMidi,
      freq: midiToFreq(g.minMidi),
      lo,
      hi: Math.max(lo + 1, hi),
      merged,
      label: merged ? `${midiName(g.minMidi)}–${midiName(g.maxMidi)}` : midiName(g.minMidi)
    }
  })
}

/** 这条带覆盖的音频范围（Hz），给界面显示用 */
export function bandRangeHz(band: Band): [number, number] {
  return [midiToFreq(band.minMidi), midiToFreq(band.maxMidi)]
}

/**
 * 把一列幅度谱压成每条带一个能量值（带内 |X[k]|² 求和）。
 * out 由调用方提供并复用，避免每列都分配内存。
 */
export function bandEnergies(
  magnitudes: Float32Array | number[],
  bands: Band[],
  out: Float32Array
): Float32Array {
  for (let i = 0; i < bands.length; i++) {
    const { lo, hi } = bands[i]
    let sum = 0
    for (let k = lo; k < hi && k < magnitudes.length; k++) {
      const v = magnitudes[k]
      sum += v * v
    }
    out[i] = sum
  }
  return out
}

/** 哪条带能量最高（用于把起点归到某个音上）。全为 0 时返回 -1。 */
export function dominantBand(energies: Float32Array | number[], bands: Band[]): number {
  let best = -1
  let bestV = 0
  for (let i = 0; i < bands.length; i++) {
    if (energies[i] > bestV) {
      bestV = energies[i]
      best = i
    }
  }
  return bestV > 0 ? best : -1
}

/** 在给定音域里挑出会被合并成"一组"的相邻音，界面用来解释为什么有的带那么宽 */
export function unresolvableCount(bands: Band[]): number {
  return bands.filter((b) => b.merged).length
}

/**
 * 把一列幅度谱变成一列像素。
 *
 * 画布纵向分三个区：
 *   [0, specRows)            频谱图：每行一个频段，颜色 = 该频段的能量
 *   [specRows, energyTop)    空隙，第一行画成分隔线
 *   [energyTop, totalRows)   能量图：从底部向上填充，高度 = 该列总能量 / 满量程
 *
 * 两个面板用的是同一列数据、同一个 x，所以横轴天然同步，不需要额外对齐逻辑。
 *
 * 纯计算，不依赖 DOM（只用 TypedArray），可以用 node 跑测试。
 */

export type ColorStop = [number, number, number]

/** 面板背景色，同时也是调色板的最低档 */
export const PANEL_BG: ColorStop = [8, 8, 20]

/** 幅度下限：-140dB 以下视作完全静音 */
export const DB_FLOOR = -140

/**
 * dB → 调色板索引（0..255）。-90dB 视作静音，-10dB 视作满格。
 *
 * 这里是全项目唯一一处「幅度怎么变成颜色」的定义，实时渲染和离线栅格都走它。
 */
export function dbToIndex(db: number): number {
  let v = (db + 90) / 80
  v = v < 0 ? 0 : v > 1 ? 1 : v
  return (v * 255) | 0
}

/**
 * 把一列幅度谱压成「每行一个 dB 字节」，用于离线存整首歌的频谱栅格。
 *
 * 刻意存 dB 而不是调色板索引：索引已经把 gainDb 烘进去了，之后一改灵敏度
 * 整首歌的栅格就废了；存 dB 则可以在显示时再套 gainDb。1 字节 = 1dB，
 * 范围 [-140, -5]dB，对频谱图来说绰绰有余（比 RGBA 省 4 倍）。
 */
export function rowDbBytes(magnitudes: Float32Array, rowMap: RowMap, out: Uint8Array): void {
  const rows = rowMap.start.length
  for (let y = 0; y < rows; y++) {
    const a = Math.min(rowMap.start[y], magnitudes.length - 1)
    const b = Math.max(a + 1, Math.min(rowMap.end[y], magnitudes.length))

    let sum = 0
    for (let k = a; k < b; k++) sum += magnitudes[k]

    const db = 20 * Math.log10(sum / (b - a) + 1e-7)
    const clamped = db < DB_FLOOR ? DB_FLOOR : db > -5 ? -5 : db
    out[y] = Math.round(clamped - DB_FLOOR)
  }
}

/** dB 字节 → 调色板索引；gainDb 在这一步才套上去 */
export function dbByteToIndex(dbByte: number, gainDb: number): number {
  return dbToIndex(dbByte + DB_FLOOR + gainDb)
}

/** 纵轴刻度。三种都满足 0 -> 0 且单调递增，区别只在弱音抬多高。 */
export type ScaleMode = 'linear' | 'sqrt' | 'db'

/** dB 模式下的动态范围（相对满量程） */
export const DB_RANGE = 60

/**
 * 把「能量 / 满量程」映射成 0..1 的高度比例。
 *
 * 实测（120BPM 鼓点 + 和声，3000 个读数）：中位数只有满量程的 3.25%，
 * 线性刻度下 90% 的时间曲线都在基线 2 像素以内 —— 等于看不见。
 * 所以默认用 db，另外两档留给想看重整比例的场景。
 */
export function applyScale(value: number, scale: number, mode: ScaleMode = 'linear'): number {
  if (!(value > 0) || !(scale > 0)) return 0
  const r = Math.min(1, value / scale)
  if (mode === 'sqrt') return Math.sqrt(r)
  if (mode === 'db') {
    const v = (20 * Math.log10(r) + DB_RANGE) / DB_RANGE
    return v < 0 ? 0 : v > 1 ? 1 : v
  }
  return r
}

/** applyScale 的逆：给定高度比例，反推它代表的能量值，用来标刻度 */
export function valueAtLevel(scale: number, level: number, mode: ScaleMode = 'linear'): number {
  const l = level < 0 ? 0 : level > 1 ? 1 : level
  if (mode === 'sqrt') return scale * l * l
  if (mode === 'db') return scale * Math.pow(10, (l * DB_RANGE - DB_RANGE) / 20)
  return scale * l
}

/** 每一行对应的 FFT bin 区间 [start, end) */
export interface RowMap {
  start: Uint16Array
  end: Uint16Array
}

/**
 * 建立「画布行 → 频率」的映射，对数频率轴。
 *
 * y = 0 在顶部（最高频），y = rows-1 在底部（最低频），
 * 这是频谱图的惯例：低频在下。
 */
export function buildRowMap(
  rows: number,
  sampleRate: number,
  fftSize: number,
  fMin = 50,
  fMax = 16000
): RowMap {
  const numBins = fftSize >> 1
  const binHz = sampleRate / fftSize
  const logRatio = Math.log(fMax / fMin)

  const start = new Uint16Array(rows)
  const end = new Uint16Array(rows)

  for (let y = 0; y < rows; y++) {
    // 第 y 行覆盖的频率区间（顶部行对应最高频段）
    const tHi = 1 - y / rows
    const tLo = 1 - (y + 1) / rows
    const fHi = fMin * Math.exp(logRatio * tHi)
    const fLo = fMin * Math.exp(logRatio * tLo)

    // 跳过 DC（bin 0 是直流分量，不是声音）
    let a = Math.max(1, Math.floor(fLo / binHz))
    let b = Math.ceil(fHi / binHz)
    a = Math.min(a, numBins - 1)
    b = Math.max(a + 1, Math.min(numBins, b))

    start[y] = a
    end[y] = b
  }

  return { start, end }
}

/** 按色标生成 256 级查找表：索引 0 是第一个色标，255 是最后一个 */
function buildGradient(stops: ColorStop[]): Uint8Array {
  const table = new Uint8Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    const seg = t * (stops.length - 1)
    const idx = Math.min(stops.length - 2, Math.floor(seg))
    const f = seg - idx
    for (let c = 0; c < 3; c++) {
      table[i * 3 + c] = Math.round(stops[idx][c] + (stops[idx + 1][c] - stops[idx][c]) * f)
    }
  }
  return table
}

/**
 * 频谱图调色板：静音 → 最强。
 *
 * stops 由主题给（见 theme.ts）。**不传就用原来的深色配色** ——
 * 这样自检和老调用方不用改，而换主题只是换一组色标。
 */
export function createPalette(stops?: ColorStop[]): Uint8Array {
  return buildGradient(
    stops ?? [
      PANEL_BG,
      [40, 20, 90],
      [110, 40, 180],
      [200, 70, 190],
      [250, 150, 120],
      [255, 240, 190]
    ]
  )
}

/** 能量图填充色的纵向渐变：索引 0 = 面板底部，255 = 顶部 */
export function createEnergyRamp(stops?: ColorStop[]): Uint8Array {
  return buildGradient(stops ?? [[58, 28, 110], [110, 50, 200], [34, 211, 238]])
}

/**
 * 把一列幅度谱渲染成 RGBA 像素，写进 into。
 *
 * @param gainDb 灵敏度补偿（dB）。幅度先转 dB 再映射到 [-90, -10] dB 这个窗口，
 *               gainDb 把整条曲线往上提，用于补偿偏小的麦克风信号。
 * @param width  一个时间格占多少像素（into 的宽）
 */
export function renderColumn(
  magnitudes: Float32Array,
  rowMap: RowMap,
  palette: Uint8Array,
  gainDb: number,
  into: Uint8ClampedArray,
  width: number
): void {
  const rows = rowMap.start.length

  for (let y = 0; y < rows; y++) {
    // 这一行对应的频段，取区间内所有 bin 的平均幅度
    const a = Math.min(rowMap.start[y], magnitudes.length - 1)
    const b = Math.max(a + 1, Math.min(rowMap.end[y], magnitudes.length))

    let sum = 0
    for (let k = a; k < b; k++) sum += magnitudes[k]
    const mag = sum / (b - a)

    const p = dbToIndex(20 * Math.log10(mag + 1e-7) + gainDb)
    const r = palette[p * 3]
    const g = palette[p * 3 + 1]
    const bl = palette[p * 3 + 2]

    let o = y * width * 4
    for (let x = 0; x < width; x++) {
      into[o] = r
      into[o + 1] = g
      into[o + 2] = bl
      into[o + 3] = 255
      o += 4
    }
  }
}

/** 把 [fromRow, toRow) 这些行填成纯色（面板空隙 / 分隔线用） */
export function fillRows(
  into: Uint8ClampedArray,
  width: number,
  fromRow: number,
  toRow: number,
  rgb: ColorStop
): void {
  const r = rgb[0]
  const g = rgb[1]
  const b = rgb[2]
  let o = fromRow * width * 4
  const end = toRow * width * 4
  for (; o < end; o += 4) {
    into[o] = r
    into[o + 1] = g
    into[o + 2] = b
    into[o + 3] = 255
  }
}

/**
 * 画一列能量：从面板底部向上填充到「能量 / 满量程」对应的高度。
 *
 * energy / energyScale 会被夹到 [0, 1]，所以能量再大也不会画出面板外，
 * 面板以上的行原样不动 —— 这样它才能和频谱图共用同一张 ImageData。
 *
 * @param ramp     256 级纵向渐变，索引 0 是面板底部，255 是面板顶部
 * @param capColor 柱子顶端那条描边的颜色
 */
export function renderEnergyColumn(
  energy: number,
  energyScale: number,
  mode: ScaleMode,
  into: Uint8ClampedArray,
  width: number,
  topRow: number,
  totalRows: number,
  ramp: Uint8Array,
  capColor: ColorStop
): void {
  const panelRows = totalRows - topRow
  if (panelRows <= 0) return

  const level = applyScale(energy, energyScale, mode)

  // 能量越大柱子越高，所以行号越小
  const levelRow = topRow + Math.round((1 - level) * (panelRows - 1))

  for (let y = topRow; y < totalRows; y++) {
    let r: number
    let g: number
    let b: number

    if (y < levelRow) {
      r = PANEL_BG[0]
      g = PANEL_BG[1]
      b = PANEL_BG[2]
    } else {
      // 渐变索引：越靠上越亮
      const t = panelRows > 1 ? (totalRows - 1 - y) / (panelRows - 1) : 0
      const i = Math.min(255, Math.max(0, Math.round(t * 255))) * 3
      r = ramp[i]
      g = ramp[i + 1]
      b = ramp[i + 2]
    }

    if (y === levelRow) {
      r = capColor[0]
      g = capColor[1]
      b = capColor[2]
    }

    let o = y * width * 4
    for (let x = 0; x < width; x++) {
      into[o] = r
      into[o + 1] = g
      into[o + 2] = b
      into[o + 3] = 255
      o += 4
    }
  }
}

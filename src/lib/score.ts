/**
 * 把能量读数按「小节」排版成一行行，像总谱那样横向铺开。
 *
 * 时间换算只有一条主线（BPM 按拍号分母的时值计，即 6/8 里一拍 = 八分音符）：
 *     每拍秒数   = 60 / bpm
 *     每小节秒数 = beatsPerBar * 每拍秒数
 *     每行秒数   = barsPerRow * 每小节秒数
 *     每行读数数 = 每行秒数 * rate          ← 可以是小数，不取整
 *
 * 行边界一律用 round(row * readingsPerRow) 现算，而不是逐行累加整数，
 * 这样行号再大也不会累积舍入误差（有测试专门盯这一点）。
 *
 * 纯计算 + TypedArray，不依赖 DOM，可以用 node 跑测试。
 */

// 显式带 .ts：score.ts 会被 node 直接加载（tools/check-score.mjs），
// 而 node 的原生类型剥离不做扩展名补全。Vite 侧同样认这个写法。
import { applyScale, type ColorStop, type ScaleMode } from './spectrumImage.ts'

export interface Meter {
  /** 每分钟拍数（按拍号分母的时值计） */
  bpm: number
  /** 拍号分子：每小节几拍 */
  beatsPerBar: number
  /** 拍号分母：以几分音符为一拍，只参与显示 */
  beatUnit: number
}

export interface ScoreLayout extends Meter {
  /** 每行排几小节 */
  barsPerRow: number
  /** 每秒多少个读数 */
  rate: number
  beatSeconds: number
  barSeconds: number
  rowSeconds: number
  /** 每行占多少个读数（可以是小数） */
  readingsPerRow: number
  /** 每行几拍 */
  beatsPerRow: number
}

/** 行背景色 */
export const ROW_BG: ColorStop = [12, 12, 20]
/** 柱顶描边色 */
export const ROW_CAP: ColorStop = [236, 254, 255]

export function makeLayout(meter: Meter, barsPerRow: number, rate: number): ScoreLayout {
  const bpm = Math.max(1, meter.bpm)
  const beatsPerBar = Math.max(1, Math.round(meter.beatsPerBar))
  const bars = Math.max(1, Math.round(barsPerRow))
  const safeRate = rate > 0 ? rate : 1

  const beatSeconds = 60 / bpm
  const barSeconds = beatsPerBar * beatSeconds
  const rowSeconds = bars * barSeconds

  return {
    bpm,
    beatsPerBar,
    beatUnit: meter.beatUnit,
    barsPerRow: bars,
    rate: safeRate,
    beatSeconds,
    barSeconds,
    rowSeconds,
    readingsPerRow: rowSeconds * safeRate,
    beatsPerRow: beatsPerBar * bars,
  }
}

/** 总共要排多少行 */
export function rowCount(layout: ScoreLayout, readings: number): number {
  if (layout.readingsPerRow <= 0 || readings <= 0) return 0
  return Math.ceil(readings / layout.readingsPerRow)
}

/**
 * 第 row 行覆盖的读数区间 [from, to)。
 * to 可能超过实际读数总数，渲染时自行钳制。
 */
export function rowRange(layout: ScoreLayout, row: number): [number, number] {
  const rpr = layout.readingsPerRow
  return [Math.round(row * rpr), Math.round((row + 1) * rpr)]
}

export interface ScoreRowStyle {
  /** 整个画布宽 */
  width: number
  /** 一行的高 */
  height: number
  /** 内容区左边距，留给文字标签 */
  contentLeft: number
  /** 一行几小节 */
  barsPerRow: number
  /** 一小节几拍 */
  beatsPerBar: number
  /** 一行几拍 */
  beatsPerRow: number
  /** 一行占多少个读数（可为小数） */
  readingsPerRow: number
  /** 纵轴满量程 */
  scale: number
  /** 纵轴刻度 */
  mode: ScaleMode
}

/** 把 over 上的像素按 alpha 混一点点 underlay 颜色进去 */
function mixPixel(
  into: Uint8ClampedArray,
  offset: number,
  rgb: ColorStop,
  alpha: number
): void {
  into[offset] = into[offset] + (rgb[0] - into[offset]) * alpha
  into[offset + 1] = into[offset + 1] + (rgb[1] - into[offset + 1]) * alpha
  into[offset + 2] = into[offset + 2] + (rgb[2] - into[offset + 2]) * alpha
}

/**
 * 画一行：能量面积从底部往上填，再叠上小节线和拍线。
 *
 * 每个像素列取该列覆盖范围内读数的**最大值**而不是平均值 ——
 * 缩得太小时平均值会把瞬态削平，而看这种图要的正是峰值。
 *
 * @param read  按序号读取数（越界应返回 0）
 * @param from  本行第一个读数在日志里的序号
 * @param total 日志里一共有多少个读数
 * @param into  尺寸 width x height 的 RGBA 缓冲
 */
export function renderScoreRow(
  read: (index: number) => number,
  from: number,
  total: number,
  style: ScoreRowStyle,
  ramp: Uint8Array,
  into: Uint8ClampedArray
): void {
  const {
    width,
    height,
    contentLeft,
    barsPerRow,
    beatsPerBar,
    beatsPerRow,
    readingsPerRow,
    scale,
    mode,
  } = style
  if (width <= 0 || height <= 0) return

  const contentW = Math.max(1, width - contentLeft)

  // 1) 铺底
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    into[o] = ROW_BG[0]
    into[o + 1] = ROW_BG[1]
    into[o + 2] = ROW_BG[2]
    into[o + 3] = 255
  }

  // 2) 能量面积
  const span = readingsPerRow > 0 ? readingsPerRow : 1
  const perPixel = span / contentW

  for (let x = 0; x < contentW; x++) {
    const a = from + Math.floor(x * perPixel)
    const b = Math.max(a + 1, from + Math.floor((x + 1) * perPixel))

    let peak = 0
    for (let i = a; i < b && i < total; i++) {
      const v = read(i)
      if (v > peak) peak = v
    }

    const level = applyScale(peak, scale, mode)
    const levelY = height - 1 - Math.round(level * (height - 1))

    const px = contentLeft + x
    for (let y = levelY; y < height; y++) {
      const t = height > 1 ? (height - 1 - y) / (height - 1) : 0
      const ri = Math.min(255, Math.max(0, Math.round(t * 255))) * 3
      const o = (y * width + px) * 4
      if (y === levelY) {
        into[o] = ROW_CAP[0]
        into[o + 1] = ROW_CAP[1]
        into[o + 2] = ROW_CAP[2]
      } else {
        into[o] = ramp[ri]
        into[o + 1] = ramp[ri + 1]
        into[o + 2] = ramp[ri + 2]
      }
      into[o + 3] = 255
    }
  }

  // 3) 小节线（亮）和拍线（暗）。
  //    beatsPerRow < 1 表示不要网格 —— 整曲概览就是拿这个函数当纯面积图画用的。
  if (beatsPerRow >= 1) {
    const perBar = Math.max(1, beatsPerBar)
    for (let beat = 0; beat <= beatsPerRow; beat++) {
      const isBar = beat % perBar === 0
      const x = Math.min(width - 1, contentLeft + Math.round((beat / beatsPerRow) * contentW))
      if (x < contentLeft) continue
      const alpha = isBar ? 0.34 : 0.13
      for (let y = 0; y < height; y++) {
        mixPixel(into, (y * width + x) * 4, [255, 255, 255], alpha)
      }
    }
  }
}

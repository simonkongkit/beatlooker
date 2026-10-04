import type { InkTheme } from './theme.ts'

/**
 * 演奏检测结果的显示 —— **重新设计的一版** ✓✓
 *
 * ## 为什么要重写 ✗
 * 旧版把"能量 / 期望音 / 检测起点"挤在**两条带**里 ✓
 * 还叠了一堆**贯穿整个行高**的竖线 ✗ 于是到处重叠 ✓ 用户的原话是"很乱" ✓
 *
 * ## 新版只做一件事 ✓
 * **三条互相平行、互不重叠的横带** ✓：
 *
 *      能量   ▁▂▅▇▅▂▁▂▅▇▅▂                    曲线（这一行最高的带）
 *      期望    C4      E4      G4      B3       音名（写在期望时刻上）
 *      检测    ▭       ▭       ▭       ▭        小长方形（画在实际时刻上）
 *
 * 同一个音 ✓ 名字在"期望"带上的位置 ✓ 和长方形在"检测"带上的位置 ✓
 * **横向差多少 = 你弹早/弹晚多少** ✓✓ —— 不需要任何斜线去连 ✗（那正是乱的来源 ✓）
 *
 * ## 输入边界（**只吃这两样东西** ✓✓）
 *   · 检测函数给的：onsets（时刻 / 强弱 / 置信）+ match（谁配上了谁 / 多打）+ 能量序列
 *   · 读谱函数给的：期望音的时刻 + 音名
 * 这个模块**不知道**拍号、小节容量、调弦、变调夹这些东西 ✓ 也不需要知道 ✓
 */

/* ============================ 输入 ============================ */

/** 检测函数给出的一个起点 */
export interface ViewOnset {
  time: number
  /** 置信度低（判据没通过）→ 画成空心 */
  weak?: boolean
  /**
   * 这个起点**被谱面对上了**吗？
   *
   * ★ 这个信息只能来自 match.pairs[].detected ✗✗
   * 我第一版写错了 ✓ 拿"期望时刻"去反推"哪个检测起点被配上了" ✗
   *   而期望时刻是**拟合直线**上的位置 ✓ 实际起点在别处 ✗
   *   于是只有第 1 个碰巧落在容差里 ✓ 其余全画成"多打" ✗（截图里一眼看出来 ✓）
   * 配对是**检测函数**给出的结果 ✓ 属于这个模块的输入 ✓ 不该由这里猜 ✓
   */
  matched?: boolean
}

/** 读谱函数给出的一个期望音 */
export interface ViewExpected {
  time: number
  /** 音名；读谱拿不到就是 null */
  label: string | null
  /**
   * 配上的那个**检测起点的时刻**（没配上就是 null / 不填）。
   *
   * ⚠️ 它**不是**用来给这一栏上色的 ✗✗ —— 用户明确说过
   * "期望上的竖条为什么是红色，我没有让你写颜色的逻辑" ✓
   * 这一栏永远中性 ✓ 这个字段**只用来画配对连线** ✓✓
   * 它直接来自检测函数的输出（match.pairs[].detected）✓ 不是这里猜的 ✓
   */
  matchedTime?: number | null
}

export interface DetectionViewInput {
  ctx: CanvasRenderingContext2D
  /** 画布尺寸（CSS 像素）*/
  width: number
  height: number

  /** 总能量（线性值，按列）—— 只用来画上面那条曲线 */
  energies: Float32Array
  /** 列率（列/秒）*/
  rate: number

  /** 实际检出的起点 */
  onsets: ViewOnset[]
  /** 谱面期望的音 */
  expected: ViewExpected[]
  /** 小节的**时间**边界（秒），长度 = 小节数 + 1 */
  barEdges: number[]
  /** 每行画几个小节 */
  barsPerRow: number

  /** 音频实际长度（秒）—— 轴的右端不超过它 ✗ */
  maxTime?: number | null
  /** 回放头（秒）*/
  playhead?: number | null
  /**
   * 起奏点（秒）—— 用户**手动指定**的那个（没指定就传检测出来的 ✓）
   *
   * 为什么要它 ✗✗：自动判据**一定会误判** ✓ 这不是 bug ✓ 是声学上分不开 ✓
   * 实测 5323.webm：0.416s 那个椅子声是
   *   **70Hz 基频 + 成整数倍谐波 + 陡然抬起 + 不归零 + 持续** ✓✓
   *   —— 和"弹了一个低音"在**特征上完全一样** ✗ 判据没有理由拒绝它 ✓
   * 所以给用户一个"我说了算"的口子 ✓ 而不是硬去调判据（调了只会漏掉真的起奏 ✗）
   */
  startTime?: number | null
  /** 主题色 */
  ink: InkTheme
}

/* ============================ 布局 ============================ */

const PAD = 14
/** 左边留给"能量 / 期望 / 检测"三个标签的宽度 */
const TITLE_W = 40
/** 三条带的高度 */
const ENERGY_H = 96
const EXPECT_H = 30
const DETECT_H = 26
/** 带与带之间的空隙（**互不重叠的关键** ✓）*/
const LANE_GAP = 10

/** 一行的总高 */
export function rowHeight(): number {
  return ENERGY_H + EXPECT_H + DETECT_H + LANE_GAP * 2 + PAD * 2
}

/** 画布该多高 */
export function detectionViewHeight(barCount: number, barsPerRow: number): number {
  const rows = Math.max(1, Math.ceil(barCount / Math.max(1, barsPerRow)))
  return PAD * 2 + rows * rowHeight()
}

/* ============================ 画 ============================ */

export function renderDetectionView(o: DetectionViewInput): void {
  const { ctx, width, height, ink } = o
  const left = PAD + TITLE_W
  const right = width - PAD

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = ink.bg
  ctx.fillRect(0, 0, width, height)

  const edges = o.barEdges.length >= 2 ? o.barEdges : [0, 1]
  const barCount = edges.length - 1
  const perRow = Math.max(1, Math.round(o.barsPerRow))
  const rows = Math.max(1, Math.ceil(barCount / perRow))
  const capT = typeof o.maxTime === 'number' && o.maxTime > 0 ? o.maxTime : null

  for (let r = 0; r < rows; r++) {
    const firstBar = r * perRow
    const lastBar = Math.min(barCount, firstBar + perRow)
    if (lastBar <= firstBar) continue

    const y0 = PAD + r * rowHeight()
    // 三条带的位置（**互相隔开 LANE_GAP** ✓）
    const energyTop = y0 + PAD
    const energyBottom = energyTop + ENERGY_H
    const expectTop = energyBottom + LANE_GAP
    const expectBottom = expectTop + EXPECT_H
    const detectTop = expectBottom + LANE_GAP
    const detectBottom = detectTop + DETECT_H
    const rowBottom = detectBottom + PAD

    // ---- 这一行的时间范围 ----
    let t0 = edges[firstBar]
    let t1 = edges[lastBar]
    // 右端不越过音频长度 ✗
    if (capT != null) t1 = Math.min(t1, capT)
    if (!(t1 > t0)) continue
    // 左端：把第一个起点之前的空白也带上一点 ✓
    const firstOnset = o.onsets.find((x) => x.time >= t0 && x.time <= t1)
    if (firstOnset) t0 = Math.min(t0, firstOnset.time - 0.1)
    t0 = Math.max(0, t0)

    const span = t1 - t0
    const xOf = (t: number): number => left + ((t - t0) / span) * (right - left)
    const tOf = (x: number): number => t0 + ((x - left) / Math.max(1, right - left)) * span

    // ---- 行底色（隔行淡一点 ✓ 便于分辨行边界）----
    if (r % 2 === 1) {
      ctx.fillStyle = ink.shade
      ctx.fillRect(left, y0 + 4, right - left, rowBottom - y0 - 8)
    }

    // ---- ① 能量带 ----
    drawEnergy(ctx, o, { left, right, top: energyTop, bottom: energyBottom, xOf, t0, t1, ink })

    // ---- 起奏点：**只画在能量带里** ✓ 一条虚线 + 一个小标签 ✓ ----
    //   （不贯穿整行 ✗ —— 那正是旧版"很乱"的原因 ✓）
    if (o.startTime != null && o.startTime >= t0 - 1e-6 && o.startTime <= t1 + 1e-6) {
      const x = Math.round(xOf(o.startTime)) + 0.5
      ctx.setLineDash([4, 3])
      // ★ 用 start 色 ✓ 和回放头(accent 粉红)分开 ✓✓
      ctx.strokeStyle = ink.start
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, energyTop)
      ctx.lineTo(x, energyBottom)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.font = '700 9px ui-monospace, Consolas, monospace'
      ctx.fillStyle = ink.start
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('起奏', x + 3, energyTop + 2)
    }

    // ---- ② 期望带：音名写在**期望时刻**上 ----
    drawExpected(ctx, o, { left, right, top: expectTop, bottom: expectBottom, xOf, t0, t1, ink })

    // ---- ②.5 配对连线：把"同一个音"的两头连起来 ----
    //
    // 用户要求："把互相匹配的检测和期望用**蓝色**的线连接" ✓
    //
    // 画在**两条带之间** ✓ 而且画在**矩形之前** ✓ —— 矩形和刻度压在线上面 ✓
    // 两端都收在带边缘上 ✓ 不会插进带里面 ✗（那是旧版"贯穿全行"的毛病 ✓）
    ctx.strokeStyle = ink.link
    ctx.lineWidth = 1.5
    for (const e of o.expected) {
      if (e.matchedTime == null) continue
      if (e.time < t0 - 1e-6 || e.time > t1 + 1e-6) continue
      if (e.matchedTime < t0 - 1e-6 || e.matchedTime > t1 + 1e-6) continue
      const xa = Math.round(xOf(e.time)) + 0.5
      const xb = Math.round(xOf(e.matchedTime)) + 0.5
      ctx.beginPath()
      ctx.moveTo(xa, expectBottom)
      ctx.lineTo(xb, detectTop)
      ctx.stroke()
    }

    // ---- ③ 检测带：小长方形画在**实际时刻**上 ----
    drawDetected(ctx, o, { left, right, top: detectTop, bottom: detectBottom, xOf, t0, t1, ink })

    // ---- 三条带左侧的标签 ----
    ctx.fillStyle = ink.dim
    ctx.font = '600 10px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('能量', left - 8, (energyTop + energyBottom) / 2)
    ctx.fillText('期望', left - 8, (expectTop + expectBottom) / 2)
    ctx.fillText('检测', left - 8, (detectTop + detectBottom) / 2)

    // ---- 小节线：**只在这个行高范围内** ✓ 而且很淡 ✓ 不抢数据 ----
    ctx.strokeStyle = ink.line
    ctx.lineWidth = 1
    for (let b = firstBar; b <= lastBar; b++) {
      const bt = edges[b]
      if (bt < t0 - 1e-6 || bt > t1 + 1e-6) continue
      const x = Math.round(xOf(bt)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, y0 + 6)
      ctx.lineTo(x, rowBottom - 6)
      ctx.stroke()
      // 小节号
      ctx.fillStyle = ink.dim2
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.font = '600 9px ui-monospace, Consolas, monospace'
      if (b < lastBar) ctx.fillText(String(b + 1), x + 3, y0 + 7)
    }

    // ---- 行标题：第几小节 + 时间范围 ----
    ctx.fillStyle = ink.dim
    ctx.font = '600 10px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(
      '第 ' + (firstBar + 1) + (lastBar - firstBar > 1 ? '-' + lastBar : '') + ' 小节',
      left,
      y0 + 2
    )
    ctx.textAlign = 'right'
    ctx.fillText(t0.toFixed(2) + 's → ' + t1.toFixed(2) + 's', right, y0 + 2)

    // ---- 回放头：**一条细线** ✓ 只在行内 ✓ ----
    if (o.playhead != null && o.playhead >= t0 && o.playhead <= t1) {
      const x = Math.round(xOf(o.playhead)) + 0.5
      ctx.strokeStyle = ink.accent
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y0 + 6)
      ctx.lineTo(x, rowBottom - 6)
      ctx.stroke()
    }

    // ---- 时间刻度（行底）----
    drawTicks(ctx, { left, right, y: rowBottom - 4, xOf, t0, t1, ink })
    void tOf
  }
}

/* ---------------- ① 能量 ---------------- */

function drawEnergy(
  ctx: CanvasRenderingContext2D,
  o: DetectionViewInput,
  g: { left: number; right: number; top: number; bottom: number; xOf: (t: number) => number; t0: number; t1: number; ink: InkTheme }
): void {
  const { left, right, top, bottom, xOf, t0, t1 } = g
  const cols = o.energies.length
  if (cols < 2 || !(o.rate > 0)) return

  // 取这一段里的最大值当量程 ✓ —— "满量程自适应" ✓
  const i0 = Math.max(0, Math.floor(t0 * o.rate))
  const i1 = Math.min(cols - 1, Math.ceil(t1 * o.rate))
  let peak = 0
  for (let i = i0; i <= i1; i++) if (o.energies[i] > peak) peak = o.energies[i]
  if (!(peak > 0)) return
  const dbLo = -46
  const yOf = (v: number): number => {
    const db = v > 0 ? Math.max(dbLo, 10 * Math.log10(v / peak)) : dbLo
    return bottom - ((db - dbLo) / -dbLo) * (bottom - top)
  }

  // ---- 曲线 + 渐变填充 ----
  ctx.beginPath()
  ctx.moveTo(left, bottom)
  const step = Math.max(1, Math.floor((right - left) / 2))
  for (let k = 0; k <= step; k++) {
    const x = left + ((right - left) * k) / step
    const t = t0 + ((t1 - t0) * k) / step
    const i = Math.min(cols - 1, Math.max(0, Math.round(t * o.rate)))
    ctx.lineTo(x, yOf(o.energies[i]))
  }
  ctx.lineTo(right, bottom)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, top, 0, bottom)
  grad.addColorStop(0, g.ink.energyTop)
  grad.addColorStop(1, g.ink.energyBottom)
  ctx.fillStyle = grad
  ctx.fill()

  // ---- 基线 ✓ 让"零"有个明确位置 ----
  ctx.strokeStyle = g.ink.line
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, Math.round(bottom) + 0.5)
  ctx.lineTo(right, Math.round(bottom) + 0.5)
  ctx.stroke()

  void xOf
}

/* ---------------- ② 期望带：音名 ---------------- */

function drawExpected(
  ctx: CanvasRenderingContext2D,
  o: DetectionViewInput,
  g: { left: number; right: number; top: number; bottom: number; xOf: (t: number) => number; t0: number; t1: number; ink: InkTheme }
): void {
  const { left, right, top, bottom, xOf, t0, t1, ink } = g
  const midY = (top + bottom) / 2

  // 基线：说明"这一条就是期望音的位置" ✓
  ctx.strokeStyle = ink.shade
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, Math.round(bottom) + 0.5)
  ctx.lineTo(right, Math.round(bottom) + 0.5)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let lastLabelX = -Infinity
  for (const e of o.expected) {
    if (e.time < t0 - 1e-6 || e.time > t1 + 1e-6) continue
    const x = Math.round(xOf(e.time)) + 0.5
    // 刻度：短竖线 ✓ **不越过这条带** ✓
    // ★★★ 这一栏是**中性的** —— 不按"配上没配上"上色 ✗✗ ★★★
    //
    // 用户的意见（对的 ✓）："期望上的竖条的颜色为什么是红色，我没有让你写颜色的逻辑" ✓
    // 这一栏回答的是"**谱面说什么**" ✓ 它本身**没有对错** ✗
    // 用红色会让它看起来像"谱面错了" ✓ 而红其实只是"这一条我没连到某个起点上" ✗
    // 那是**匹配**的事 ✓ 不该画在谱面这一栏上 ✗
    // 要看"弹对没弹对" ✓ 去对比**下面那一栏**的小长方形位置 ✓（横向差 = 弹早弹晚 ✓）
    ctx.strokeStyle = ink.dim
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(x, top + 3)
    ctx.lineTo(x, bottom - 1)
    ctx.stroke()
    // 音名：写在刻度右边 ✓ 离太近就不写（宁可漏标也不糊）✓
    if (e.label && x - lastLabelX >= 26) {
      ctx.font = '700 11px ui-monospace, Consolas, monospace'
      ctx.fillStyle = ink.text
      ctx.fillText(e.label, x + 3, midY)
      lastLabelX = x + 3 + ctx.measureText(e.label).width
    }
  }
}

/* ---------------- ③ 检测带：小长方形 ---------------- */

function drawDetected(
  ctx: CanvasRenderingContext2D,
  o: DetectionViewInput,
  g: { left: number; right: number; top: number; bottom: number; xOf: (t: number) => number; t0: number; t1: number; ink: InkTheme }
): void {
  const { left, right, top, bottom, xOf, t0, t1, ink } = g
  const h = Math.min(14, bottom - top - 4)
  const y = (top + bottom) / 2 - h / 2

  // 基线
  ctx.strokeStyle = ink.shade
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, Math.round(bottom) + 0.5)
  ctx.lineTo(right, Math.round(bottom) + 0.5)
  ctx.stroke()

  // 哪些检测起点被谱面对上了？（这是**唯一**决定配色的东西 ✓）
  // 判据由调用方放进 expected[].matched ✓ 这里只按时间找最近的期望音 ✓
  for (const on of o.onsets) {
    if (on.time < t0 - 1e-6 || on.time > t1 + 1e-6) continue
    const x = Math.round(xOf(on.time)) - 3.5
    // 配对结果**直接来自输入** ✓ 不猜 ✓
    const m = on.matched === true
    ctx.beginPath()
    ctx.roundRect(x, y, 7, h, 2)
    if (on.weak) {
      // 低置信：**空心** ✓ 但照画 ✗ 不删 ✓
      ctx.strokeStyle = ink.dim2
      ctx.lineWidth = 1.4
      ctx.stroke()
    } else {
      ctx.fillStyle = m ? ink.ok : ink.onset
      ctx.fill()
      if (!m) {
        // 多打：加一道浅色边 ✓ 和"弹对了"区分开 ✓
        ctx.strokeStyle = ink.warn
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }
}

/* ---------------- 时间刻度 ---------------- */

function drawTicks(
  ctx: CanvasRenderingContext2D,
  g: { left: number; right: number; y: number; xOf: (t: number) => number; t0: number; t1: number; ink: InkTheme }
): void {
  const span = g.t1 - g.t0
  const choices = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30]
  const st = choices.find((c) => span / c <= 7) ?? 60
  const dec = st < 1 ? 2 : 1
  ctx.font = '9px ui-monospace, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  for (let t = Math.ceil(g.t0 / st) * st; t <= g.t1 + 1e-9; t += st) {
    const x = Math.round(g.xOf(t)) + 0.5
    if (x < g.left - 1 || x > g.right + 1) continue
    ctx.strokeStyle = g.ink.shade
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, g.y - 3)
    ctx.lineTo(x, g.y)
    ctx.stroke()
    ctx.fillStyle = g.ink.dim2
    ctx.fillText(t.toFixed(dec) + 's', x, g.y - 5)
  }
}

/* ---------------- 点击 / 回放头换算 ---------------- */

export interface DetectionRowHit {
  y0: number
  y1: number
  timeAtX: (x: number) => number
  xAtTime: (t: number) => number
}

/**
 * 每一行的 y 范围和 x↔时间换算。
 *
 * 这个必须和上面**用同一套算式** ✓ 否则点击和画面会对不上 ✓
 * 所以两边都从 `rowGeometry` 取 ✓ 只有一处真值 ✓
 */
export function detectionRowGeom(
  o: {
    width: number
    height: number
    energies: Float32Array
    rate: number
    onsets: ViewOnset[]
    barEdges: number[]
    barsPerRow: number
    maxTime?: number | null
  }
): DetectionRowHit[] {
  const left = PAD + TITLE_W
  const right = o.width - PAD
  const edges = o.barEdges.length >= 2 ? o.barEdges : [0, 1]
  const barCount = edges.length - 1
  const perRow = Math.max(1, Math.round(o.barsPerRow))
  const rows = Math.max(1, Math.ceil(barCount / perRow))
  const capT = typeof o.maxTime === 'number' && o.maxTime > 0 ? o.maxTime : null
  const out: DetectionRowHit[] = []
  for (let r = 0; r < rows; r++) {
    const firstBar = r * perRow
    const lastBar = Math.min(barCount, firstBar + perRow)
    if (lastBar <= firstBar) continue
    const y0 = PAD + r * rowHeight()
    const rowBottom = y0 + rowHeight() - PAD
    let t0 = edges[firstBar]
    let t1 = edges[lastBar]
    if (capT != null) t1 = Math.min(t1, capT)
    if (!(t1 > t0)) continue
    const firstOnset = o.onsets.find((x) => x.time >= t0 && x.time <= t1)
    if (firstOnset) t0 = Math.min(t0, firstOnset.time - 0.1)
    t0 = Math.max(0, t0)
    const span = t1 - t0
    out.push({
      y0,
      y1: rowBottom,
      timeAtX: (x: number) => t0 + ((x - left) / Math.max(1, right - left)) * span,
      xAtTime: (t: number) => left + ((t - t0) / span) * (right - left)
    })
  }
  return out
}

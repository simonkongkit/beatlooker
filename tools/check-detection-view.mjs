import assert from 'node:assert/strict'
import {
  detectionRowGeom,
  detectionViewHeight,
  renderDetectionView,
  rowHeight
} from '../src/lib/detectionView.ts'
import { THEMES } from '../src/lib/theme.ts'

/**
 * 演奏检测显示（**重新设计的那一版**）的测试。
 *
 * 用户原话：
 *   "三条横向的平行的**不重叠**的轴，分别 1.能量 2.期望检测到音的点，用音名表示
 *     3.实际检测出来的音，只用小长方形表示"
 *
 * 所以最重要的断言就是**不重叠** ✓
 * 用一个"记账本"式假 ctx 记录每一笔画在哪个 y 区间 ✓ 然后断言三段两两不相交 ✓✓
 */

const ink = THEMES[0].canvas.ink

function fakeCtx() {
  const strokes = []
  const fills = []
  let cur = null
  const ctx = {
    strokes,
    fills,
    clearRect() {},
    fillRect(x, y, w, h) { fills.push({ x, y, y1: y + h, color: ctx.fillStyle }) },
    beginPath() { cur = { x0: 0, y0: 0, x1: 0, y1: 0 } },
    moveTo(x, y) { if (cur) { cur.x0 = x; cur.y0 = y; cur.x1 = x; cur.y1 = y } },
    lineTo(x, y) {
      if (cur) { cur.x1 = x; cur.y0 = Math.min(cur.y0, y); cur.y1 = Math.max(cur.y1, y) }
    },
    arc() {},
    closePath() {},
    stroke() {
      if (cur) strokes.push({ x0: cur.x0, x1: cur.x1, y0: cur.y0, y1: cur.y1, color: ctx.strokeStyle, w: ctx.lineWidth })
    },
    fill() { if (cur) fills.push({ x: cur.x0, y: cur.y0, y1: cur.y1, color: ctx.fillStyle }) },
    roundRect(x, y, w, h) { cur = { x0: x, y0: y, x1: x + w, y1: y + h } },
    createLinearGradient() { return { addColorStop() {} } },
    fillText() {},
    measureText(t) { return { width: String(t).length * 6 } },
    setTransform() {},
    setLineDash() {},
    save() {},
    restore() {},
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1
  }
  return ctx
}

function makeInput(over = {}) {
  const rate = 93.75
  const energies = new Float32Array(Math.round(8 * rate))
  for (let i = 0; i < energies.length; i++) {
    energies[i] = Math.exp(-((i % 120) / 50)) * (0.3 + 0.6 * Math.abs(Math.sin(i / 37)))
  }
  return {
    ctx: fakeCtx(),
    width: 900,
    height: detectionViewHeight(4, 2),
    energies,
    rate,
    onsets: [
      { time: 1.0, matched: true },
      { time: 1.5, matched: true },
      { time: 2.0 },
      { time: 2.5, weak: true }
    ],
    expected: [
      { time: 1.0, label: 'E3', matched: true },
      { time: 1.5, label: 'A3', matched: true },
      { time: 2.0, label: 'B3', matched: false },
      { time: 2.5, label: 'C4', matched: false }
    ],
    barEdges: [0, 2, 4, 6, 8],
    barsPerRow: 2,
    maxTime: null,
    playhead: null,
    ink,
    ...over
  }
}

/* 1. 高度与行数 */
{
  assert.equal(detectionViewHeight(1, 2), rowHeight() + 28, '1 个小节 -> 1 行')
  assert.equal(detectionViewHeight(2, 2), rowHeight() + 28, '2 个小节 -> 1 行')
  assert.equal(detectionViewHeight(3, 2), rowHeight() * 2 + 28, '3 个小节 -> 2 行')
  assert.ok(rowHeight() > 150, '一行要够高，三条带才摆得下，实得 ' + rowHeight())
}

/* 2. ★ 三条带互不重叠 ★ */
{
  const o = makeInput()
  renderDetectionView(o)
  const PAD = 14, ENERGY_H = 96, EXPECT_H = 30, DETECT_H = 26, GAP = 10
  const rowTop = PAD
  const energy = [rowTop + PAD, rowTop + PAD + ENERGY_H]
  const expect = [energy[1] + GAP, energy[1] + GAP + EXPECT_H]
  const detect = [expect[1] + GAP, expect[1] + GAP + DETECT_H]

  assert.ok(energy[1] < expect[0], '能量带和期望带之间必须有空隙')
  assert.ok(expect[1] < detect[0], '期望带和检测带之间必须有空隙')

  const bigFills = o.ctx.fills.filter((f) => f.y1 - f.y >= ENERGY_H - 4)
  assert.ok(bigFills.length >= 1, '能量带里应该有一个几乎占满高度的渐变填充，实得 ' + bigFills.length)

  // ★ 除了小节线，没有任何一笔横跨两条带
  // 容差 1px：基线画在带的边界上（bottom + 0.5）✓ 别把它误判成"横跨" ✗
  const stray1 = o.ctx.strokes.filter((s) => s.y0 < expect[0] - 1 && s.y1 > energy[1] + 1 && s.color !== ink.line && s.color !== ink.link)
  const stray2 = o.ctx.strokes.filter((s) => s.y0 < detect[0] - 1 && s.y1 > expect[1] + 1 && s.color !== ink.line && s.color !== ink.link)
  assert.equal(stray1.length, 0, '除了小节线，不该有别的东西横跨能量带和期望带，实得 ' + stray1.length)
  assert.equal(stray2.length, 0, '除了小节线，不该有别的东西横跨期望带和检测带，实得 ' + stray2.length)

  const rects = o.ctx.fills.filter((f) => f.y1 - f.y <= DETECT_H + 2 && f.y1 - f.y >= 8)
  assert.ok(rects.length >= 3, '检测带里应该有若干小长方形，实得 ' + rects.length)
  for (const r of rects) {
    assert.ok(r.y >= detect[0] - 2 && r.y1 <= detect[1] + 2, '小长方形不能越出检测带：' + r.y + '~' + r.y1)
  }
}

/* 3. ★ 期望栏必须是**中性的**（用户明确要求：那一栏不该有颜色逻辑）★ */
{
  // 期望音无论配没配上，刻度都必须是同一种中性色 ✓
  // 而且那一栏**绝对不能**出现红(ink.warn)或绿(ink.ok) ✗✗
  for (const matched of [true, false]) {
    const o = makeInput({
      expected: [
        { time: 1.0, label: 'E3' },
        { time: 1.5, label: 'A3' }
      ],
      onsets: matched ? [{ time: 1.0, matched: true }, { time: 1.5, matched: true }] : []
    })
    renderDetectionView(o)
    const PAD = 14, ENERGY_H = 96, GAP = 10
    // 期望带：[行顶+PAD+ENERGY_H+GAP, ...+30]
    const expTop = PAD + PAD + ENERGY_H + GAP
    const expBottom = expTop + 30
    const inLane = o.ctx.strokes.filter((s) => s.y0 >= expTop - 1 && s.y1 <= expBottom + 1 && s.y1 - s.y0 > 8)
    assert.ok(inLane.length >= 2, '期望带里应该有两根刻度，实得 ' + inLane.length)
    for (const s of inLane) {
      assert.notEqual(s.color, ink.warn, '期望栏的刻度**不能**是红色 ✗（那是匹配的事，不是谱面的事）')
      assert.notEqual(s.color, ink.ok, '期望栏的刻度**不能**是绿色 ✗（同上）')
      assert.equal(s.color, ink.dim, '期望栏的刻度应该是中性的 dim 色，实得 ' + s.color)
    }
  }
}

/* 3b. 检测栏的三种状态 */
{
  const on = makeInput()
  renderDetectionView(on)
  const rectColors = on.ctx.fills.filter((f) => f.y1 - f.y <= 28 && f.y1 - f.y >= 8).map((f) => f.color)
  assert.ok(rectColors.includes(ink.ok), '被配上的检测起点应该是绿色实心，实得 ' + JSON.stringify(rectColors))
  assert.ok(rectColors.includes(ink.onset), '没配上的检测起点应该是琥珀色实心')
}

/* 3c. ★ 配对连线：把期望和检测用蓝线连起来 ★ */
{
  const o = makeInput({
    expected: [
      { time: 1.0, label: 'E3', matchedTime: 1.1 },   // 配上了（弹晚 0.1s）
      { time: 1.5, label: 'A3', matchedTime: null },  // 没配上 -> 不该有线
      { time: 2.0, label: 'B3', matchedTime: 2.0 }    // 配上了（正好）
    ],
    onsets: [
      { time: 1.1, matched: true },
      { time: 2.0, matched: true }
    ]
  })
  renderDetectionView(o)
  const links = o.ctx.strokes.filter((s) => s.color === ink.link)
  assert.equal(links.length, 2, '两条配上的期望音应该各有一条蓝线，实得 ' + links.length)
  for (const s of links) {
    // 跨过两条带之间的空隙 ✓ 但**不越过任何一条带** ✓
    assert.ok(s.y1 - s.y0 > 8, '连线要真的连起来（跨过空隙），实得高度 ' + (s.y1 - s.y0))
    assert.ok(s.y0 <= 166, '连线的上端应该停在期望带的底边，实得 ' + s.y0)
    assert.ok(s.y1 >= 172, '连线的下端应该停在检测带的顶边，实得 ' + s.y1)
  }
  // 没配上的那条**不该**有线 ✓（只有 2 条 ✓ 不是 3 条 ✓）
  assert.equal(links.length, 2, '没配上的期望音不该画连线')
  // 而且它得是**蓝色系** ✓（不是红也不是绿 ✓）
  assert.notEqual(ink.link, ink.warn)
  assert.notEqual(ink.link, ink.ok)
}

/* 3d. 起奏标记：只画在**能量带里**，不贯穿整行 */
{
  const o = makeInput({ startTime: 1.2 })
  renderDetectionView(o)
  const PAD = 14, ENERGY_H = 96, GAP = 10
  const energyTop = PAD + PAD
  const energyBottom = energyTop + ENERGY_H
  const expTop = energyBottom + GAP
  // ★ 起奏线用的是 **start** 色 ✓✓ —— 用户要求它和回放头(accent 粉红)颜色不同 ✓
  const marks = o.ctx.strokes.filter((s) => s.color === ink.start)
  assert.ok(marks.length >= 1, '应该画出了起奏标记，实得 ' + marks.length)
  for (const s of marks) {
    assert.ok(s.y0 >= energyTop - 1, '起奏线**不能**越过能量带的顶边，实得 ' + s.y0)
    assert.ok(s.y1 <= energyBottom + 1, '起奏线**不能**越过能量带的底边（不许贯穿整行）✗，实得 ' + s.y1)
    assert.ok(s.y1 < expTop, '起奏线不能伸到期望带里去 ✗')
  }
  // 不给 startTime 时不该画
  const o2 = makeInput({ startTime: null })
  renderDetectionView(o2)
  assert.equal(o2.ctx.strokes.filter((s) => s.color === ink.start).length, 0, '没给起奏点就不该画')
  // 而且它必须**不是**回放头的颜色 ✓（否则两种线看着一样 ✓）
  assert.notEqual(ink.start, ink.accent, '起奏线不能和回放头同色')
}

/* 4. 右端不越过音频长度 */
{
  const o = makeInput({ maxTime: 3.0 })
  renderDetectionView(o)
  const geo = detectionRowGeom({
    width: o.width, height: o.height, energies: o.energies, rate: o.rate,
    onsets: o.onsets, barEdges: o.barEdges, barsPerRow: 2, maxTime: 3.0
  })
  assert.ok(geo.length >= 1)
  const rightT = geo[0].timeAtX(o.width - 14)
  assert.ok(rightT <= 3.0 + 1e-6, '轴右端不能越过音频长度 3.0s，实得 ' + rightT.toFixed(3))
}

/* 5. 点击换算和画图一致 */
{
  const o = makeInput()
  const geo = detectionRowGeom({
    width: o.width, height: o.height, energies: o.energies, rate: o.rate,
    onsets: o.onsets, barEdges: o.barEdges, barsPerRow: 2, maxTime: null
  })
  assert.equal(geo.length, 2, '4 个小节、每行 2 个 -> 2 行')
  for (const row of geo) {
    assert.ok(row.y1 > row.y0)
    for (const t of [1.0, 1.7, 2.9]) {
      const x = row.xAtTime(t)
      assert.ok(Math.abs(row.timeAtX(x) - t) < 1e-6, 'x↔t 应该互逆，实得 ' + row.timeAtX(x))
    }
  }
  assert.ok(geo[0].y1 <= geo[1].y0, '两行的 y 范围不能重叠')
}

/* 6. 空输入不能崩 */
{
  for (const over of [
    { onsets: [], expected: [], barEdges: [0, 1] },
    { barEdges: [] },
    { energies: new Float32Array(0) },
    { barEdges: [0, 0, 0] }
  ]) {
    renderDetectionView(makeInput(over))
  }
}

console.log('✓ 检测显示（重新设计版）通过（三条带不重叠 / 配色 / 轴夹住 / 点击互逆 / 空输入不崩）')

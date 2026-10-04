/**
 * 记谱布局的独立自检：node tools/check-notation.mjs
 *
 * 只测**纯布局数学**（layoutStaff / layoutJianpu）—— 落笔部分依赖 Path2D，
 * 在 node 里跑不了，靠浏览器截图验证。
 */
import assert from 'node:assert/strict'
import { makeNote } from '../src/lib/notation/rhythm.ts'
import { layoutJianpu, layoutStaff, pendingPreviewX } from '../src/lib/notation/render.ts'
import { GLYPHS } from '../src/lib/notation/glyphs.ts'

const q = (d) => makeNote('quarter', { dotted: d })
const e = (d) => makeNote('eighth', { dotted: d })
const h = () => makeNote('half')
const w = () => makeNote('whole')
const s = () => makeNote('sixteenth')

const X0 = 54
const X1 = 900

// 1) 三小节全满：宽度等分，分隔线正好铺满 [x0, x1]
{
  const bars = [[q(), q(), q(), q()], [h(), h()], [w()]]
  const lay = layoutStaff(bars, 4, 4, X0, X1)

  assert.equal(lay.bars.length, 3)
  assert.equal(lay.dividers.length, 4, '3 小节有 4 条线（含终止线）')
  assert.equal(lay.dividers[0], X0, '第一条线应在内容区左边')
  assert.ok(Math.abs(lay.dividers[3] - X1) < 1e-6, '最后一条线应在内容区右边')

  const widths = lay.bars.map((b) => b.width)
  for (const wd of widths) assert.ok(Math.abs(wd - widths[0]) < 1e-6, '等时值的小节宽度应相等')

  // 分隔线必须单调递增且首尾相接
  for (let i = 1; i < lay.dividers.length; i++) {
    assert.ok(lay.dividers[i] > lay.dividers[i - 1], '分隔线必须递增')
  }
  for (let i = 1; i < lay.bars.length; i++) {
    assert.ok(
      Math.abs(lay.bars[i].x - (lay.bars[i - 1].x + lay.bars[i - 1].width)) < 1e-6,
      '小节之间不能有缝或重叠'
    )
  }
}

// 2) 五线谱：音符落在各自时值格的中心
{
  const bar = [q(), q(), q(), q()]
  const lay = layoutStaff([bar], 4, 4, X0, X1)
  const b = lay.bars[0]
  const want = [1 / 8, 3 / 8, 5 / 8, 7 / 8]
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(b.notes[i].x - (b.x + b.width * want[i])) < 1e-6,
      `第 ${i + 1} 个四分音符应在 ${want[i]} 处`
    )
  }

  // 长短音符的间距要成比例：二分音符的中心应在 1/4 处
  const lay2 = layoutStaff([[h(), q(), q()]], 4, 4, X0, X1)
  const b2 = lay2.bars[0]
  assert.ok(Math.abs(b2.notes[0].x - (b2.x + b2.width * 0.25)) < 1e-6, '二分音符中心在 1/4')
  assert.ok(Math.abs(b2.notes[1].x - (b2.x + b2.width * 0.625)) < 1e-6, '第二个四分在 5/8')
}

// 3) 弱起小节自然变窄（宽度 ∝ 实际时值）
{
  const bars = [[q()], [w()], [w()]]
  const lay = layoutStaff(bars, 4, 4, X0, X1)
  const [a, b, c] = lay.bars.map((x) => x.width)
  assert.ok(a < b, '弱起小节应比满小节窄')
  assert.ok(Math.abs(b - c) < 1e-6, '两个满小节应等宽')
  assert.ok(Math.abs(a / b - 0.25) < 1e-6, '1 拍 : 4 拍 应为 1:4')
}

// 4) 空小节不能把宽度算成 0 或 NaN
{
  const lay = layoutStaff([[], [w()], [w()]], 4, 4, X0, X1)
  for (const b of lay.bars) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.width), '空小节不能产生 NaN')
    assert.ok(b.width > 0, '空小节也要留一点宽度')
  }
  assert.ok(lay.bars[0].width < lay.bars[1].width, '空小节应比满小节窄')
}

// 5) 简谱：一个音符占 1 + 破折号数 个字符格
{
  const bars = [[w()], [h(), q(), q()], [q(), q(), q(), q()]]
  const lay = layoutJianpu(bars, 4, 4, X0, X1)

  // 全音符 = 1 + 3 = 4 格；二分+四分+四分 = 2+1+1 = 4 格；四个四分 = 4 格
  const ws = lay.bars.map((b) => b.width)
  for (const wd of ws) assert.ok(Math.abs(wd - ws[0]) < 1e-6, '格数相同的小节宽度应相同')

  // 全音符的破折号位置：数字后面连着 3 格
  const b0 = lay.bars[0]
  const per = b0.width / 4
  assert.ok(Math.abs(b0.notes[0].x - (b0.x + per * 0.5)) < 1e-6, '数字应在第一格中心')
}

// 6) 简谱格数换算必须和 dashes 一致
{
  const notes = [w(), h(), q(), e(), s()]
  const lay = layoutJianpu([notes], 4, 4, X0, X1)
  const slots = notes.reduce((a, n) => a + 1 + n.dashes, 0)
  assert.equal(slots, 4 + 2 + 1 + 1 + 1, '全4 + 二分2 + 四分1 + 八分1 + 十六分1 = 9 格')
  const per = lay.bars[0].width / slots
  let cum = 0
  for (const n of notes) {
    const idx = notes.indexOf(n)
    assert.ok(
      Math.abs(lay.bars[0].notes[idx].x - (lay.bars[0].x + per * (cum + 0.5))) < 1e-6,
      '每个数字应落在自己那一格的中心'
    )
    cum += 1 + n.dashes
  }
}

// 7) 两种布局都要铺满且不越界
{
  const bars = [[q(), e(), e()], [h(), h()], [w()]]
  for (const [name, lay] of [['staff', layoutStaff(bars, 4, 4, X0, X1)], ['jianpu', layoutJianpu(bars, 4, 4, X0, X1)]]) {
    assert.ok(Math.abs(lay.dividers[0] - X0) < 1e-6, name + ' 左边界')
    assert.ok(Math.abs(lay.dividers[lay.dividers.length - 1] - X1) < 1e-6, name + ' 右边界')
    for (let i = 1; i < lay.dividers.length; i++) {
      assert.ok(lay.dividers[i] > lay.dividers[i - 1], name + ' 分隔线递增')
    }
  }
}

// 8) 记号注册表：rhythm.ts 用到的每个 glyph 都必须存在
{
  const needed = ['whole', 'half', 'quarter', 'eighth', 'sixteenth',
                  'restWhole', 'restHalf', 'restQuarter', 'restEighth', 'restSixteenth', 'dot']
  for (const k of needed) {
    assert.ok(GLYPHS[k], '缺少 glyph: ' + k)
    assert.ok(GLYPHS[k].shapes.length > 0, k + ' 不能没有形状')
  }
  // 每个 glyph 都要能序列化成非空 path 串
  const { toD } = await import('../src/lib/notation/glyphs.ts')
  for (const k of needed) {
    for (const sh of GLYPHS[k].shapes) {
      const d = toD(sh.cmds)
      assert.ok(d.length > 4, k + ' 的 path 串太短')
      assert.ok(!d.includes('NaN'), k + ' 的 path 串里有 NaN')
    }
  }
}

console.log('✓ 记谱布局全部通过（五线谱比例 / 简谱字符格 / 弱起 / 空小节 / glyph 完整性）')

// ============ 输入预览必须落在**目标小节**里 ============
//
// 用户报的 bug：打品号时预览画在"最后一个小节的右端" ✗
// 所以目标小节**不是最后一小节**时才看得出来 ✓ 下面的用例就是这么设计的 ✓
{
  const bars = [
    [q(), q(), q(), q()],
    [q(), q()], // 第 2 小节只填了 2 拍 —— 新音要落在第 3 拍
    [h(), h()]
  ]
  const lay = layoutStaff(bars, 4, 4, 100, 700)
  const b0 = lay.bars[0]
  const b1 = lay.bars[1]
  const b2 = lay.bars[2]

  const x = pendingPreviewX(lay, { bar: 1, value: 1, notes: [] })

  // ① 必须落在第 2 小节的范围里
  assert.ok(
    x >= b1.x && x <= b1.x + b1.width,
    '预览必须落在目标小节内：x=' + x.toFixed(1) + '，第2小节 [' + b1.x.toFixed(1) + ', ' + (b1.x + b1.width).toFixed(1) + ']'
  )

  // ② ★ 不能跑到最后一小节的右端（这正是原来那个 bug）
  assert.ok(
    x < b2.x + b2.width - 1,
    '预览绝不能被画到最后一小节的右端'
  )
  assert.ok(x < b2.x, '目标小节在第2节时，预览不该越到第3小节去')

  // ③ 第 2 小节已填 2 拍、新音 1 拍 -> 落点应在该小节约 83% 处
  //    （center = 2 + 0.5 = 2.5，分母 = 3）
  const frac = (x - b1.x) / b1.width
  assert.ok(
    Math.abs(frac - 2.5 / 3) < 0.02,
    '落点应在小节内 83% 处，实得 ' + (frac * 100).toFixed(1) + '%'
  )

  // ④ 空小节：插入一个音之后，"这一格"就是整小节 ✓ 所以中心必然在 50% ✓
  //    （插入十六分也还是 50% —— 单个音永远在自己那一格里居中 ✓
  //      我一开始以为"空小节的预览该靠开头" ✗ 那是错的 ✓）
  const emptyLay = layoutStaff([[], [q()]], 4, 4, 100, 700)
  const ex = pendingPreviewX(emptyLay, { bar: 0, value: 1, notes: [] })
  const e0 = emptyLay.bars[0]
  assert.ok(ex >= e0.x && ex <= e0.x + e0.width, '空小节的预览也要落在本小节内')
  assert.ok(
    Math.abs((ex - e0.x) / e0.width - 0.5) < 0.02,
    '空小节里唯一的音应居中在 50%，实得 ' + (((ex - e0.x) / e0.width) * 100).toFixed(1) + '%'
  )

  // ⑤ 越界的小节号要被夹住，不能返回 NaN
  const huge = pendingPreviewX(lay, { bar: 99, value: 1, notes: [] })
  assert.ok(Number.isFinite(huge), '越界小节号不能算出 NaN')
  const neg = pendingPreviewX(lay, { bar: -5, value: 1, notes: [] })
  assert.ok(Number.isFinite(neg) && neg >= b0.x, '负数小节号应夹到第 1 小节')

  // ⑥ 真实契约：预览遵循和 layoutStaff **完全一样**的"格子中心"公式
  //
  //    这套布局把音符画在"它自己时值格的**中心**" ✓ 而不是起点 ✓
  //    所以"时值越长越靠右"是**错的** ✗（分母也变大 ✓
  //      二分音符的中心甚至会和前一个四分的中心重合 ✓）
  //    我连写错两次 ✓ 所以这里直接对着公式验 ✓ 不再靠直觉 ✓
  const total1 = 2 // 第 2 小节已有 2 拍
  for (const v of [0.25, 0.5, 1, 2]) {
    const xx = pendingPreviewX(lay, { bar: 1, value: v, notes: [] })
    const want = b1.x + (b1.width * (total1 + v / 2)) / (total1 + v)
    assert.ok(
      Math.abs(xx - want) < 1e-6,
      '时值 ' + v + ' 的落点应等于格子中心公式：实得 ' + xx.toFixed(2) + '，应为 ' + want.toFixed(2)
    )
    assert.ok(xx >= b1.x && xx <= b1.x + b1.width, '时值 ' + v + ' 的落点也要在小节内')
  }
}

console.log('✓ 输入预览位置通过（落在目标小节内 / 不跑到最后小节右端 / 落点比例正确 / 空小节 / 越界夹住）')

/**
 * 节奏模型与校验的独立自检：node tools/check-rhythm.mjs
 *
 * 重点盯需求里那条容易做错的规则：
 *   第 1 小节**允许不足**（弱起），但**超出仍然要报错**；
 *   第 2、3 小节必须严丝合缝。
 */
import assert from 'node:assert/strict'
import {
  DURATIONS,
  allPass,
  barCapacity,
  barTotal,
  checkBars,
  makeNote
} from '../src/lib/notation/rhythm.ts'

// 注意：makeNote 的第二个参数是选项对象，不是布尔值。
// 写成 makeNote.bind(null, 'eighth')(true) 会静默丢掉附点 —— 第一版就栽在这。
const q = (dotted) => makeNote('quarter', { dotted })
const e = (dotted) => makeNote('eighth', { dotted })
const s = (dotted) => makeNote('sixteenth', { dotted })
const h = (dotted) => makeNote('half', { dotted })
const w = (dotted) => makeNote('whole', { dotted })
const rq = makeNote('quarter', { rest: true })

// 1) 拍号 → 一小节容量（四分音符为单位）
{
  assert.equal(barCapacity(4, 4), 4, '4/4 = 4 个四分')
  assert.equal(barCapacity(3, 4), 3, '3/4 = 3 个四分')
  assert.equal(barCapacity(2, 4), 2, '2/4 = 2 个四分')
  assert.equal(barCapacity(6, 8), 3, '6/8 = 6 个八分 = 3 个四分')
  assert.equal(barCapacity(12, 8), 6, '12/8 = 6 个四分')
  assert.equal(barCapacity(2, 2), 4, '2/2 = 2 个二分 = 4 个四分')
  assert.equal(barCapacity(3, 8), 1.5, '3/8 = 3 个八分 = 1.5 个四分')
  // 非法输入要被夹住，不能返回 0 或负数
  assert.ok(barCapacity(0, 0) > 0)
}

// 2) 附点 / 休止符
{
  assert.equal(q(false).value, 1)
  assert.equal(q(true).value, 1.5, '附点四分 = 1.5 个四分')
  assert.equal(makeNote('half', { dotted: true }).value, 3)
  assert.equal(makeNote('whole', { dotted: true }).value, 6)
  assert.equal(e(true).value, 0.75)
  assert.equal(s(true).value, 0.375)

  assert.equal(q(false).glyph, 'quarter')
  assert.equal(rq.glyph, 'restQuarter', '休止符要换成对应的 rest glyph')
  assert.equal(makeNote('whole', { rest: true }).glyph, 'restWhole')
  assert.equal(rq.rest, true)

  // 简谱记号：八分 1 条下划线、十六分 2 条；二分 1 个破折号、全音符 3 个
  assert.equal(e(false).lines, 1)
  assert.equal(s(false).lines, 2)
  assert.equal(makeNote('half').dashes, 1)
  assert.equal(makeNote('whole').dashes, 3)
  assert.equal(makeNote('sixteenth', { rest: true }).lines, 2, '休止符的简谱下划线不能丢')
}

// 3) 时值求和，且在同一拍号下能拼满
{
  assert.equal(barTotal([q(), q(), q(), q()]), 4, '4 个四分 = 4')
  assert.equal(barTotal([h(), q(), e(), e()]), 4, '二分+四分+八分+八分 = 4')
  assert.equal(barTotal([q(true), e(), e()]), 2.5)
  // 所有可输入时值都是 k/8，二进制精确，不存在浮点误差
  assert.equal(barTotal([s(), s(), s(), s()]), 1)
  assert.equal(barTotal([e(true), e(true), q()]), 2.5)
}

// 4) 三条规则：第 1 小节宽松、超出报错、后面严格
{
  const cap44 = [4, 4]

  // 全对
  let bars = [[q(), q(), q(), q()], [h(), q(), e(), e()], [w()]]
  let checks = checkBars(bars, ...cap44)
  assert.deepEqual(checks.map((c) => c.status), ['ok', 'ok', 'ok'])
  assert.equal(allPass(checks), true)

  // 第 1 小节弱起：只有 1 拍 —— 允许
  bars = [[q()], [w()], [w()]]
  checks = checkBars(bars, ...cap44)
  assert.equal(checks[0].status, 'pickup', '第 1 小节不足要算弱起而不是错')
  assert.equal(allPass(checks), true, '弱起必须判定为通过')
  assert.ok(checks[0].message.includes('弱起'))

  // 第 1 小节超出：必须报错（"不检查第 1 小节"是错的）
  bars = [[w(), q()], [w()], [w()]]
  checks = checkBars(bars, ...cap44)
  assert.equal(checks[0].status, 'long', '第 1 小节超出必须报错')
  assert.equal(allPass(checks), false)
  assert.equal(checks[0].delta, 1, '超出量要算准')

  // 第 2 小节不足：报错
  bars = [[w()], [h(), q()], [w()]]
  checks = checkBars(bars, ...cap44)
  assert.equal(checks[1].status, 'short')
  assert.equal(allPass(checks), false)
  assert.equal(checks[1].delta, -1, '缺口要算准')
  assert.ok(checks[1].message.includes('还差'))

  // 第 3 小节超出：报错
  bars = [[w()], [w()], [w(), e()]]
  checks = checkBars(bars, ...cap44)
  assert.equal(checks[2].status, 'long')
  assert.equal(allPass(checks), false)

  // 空小节
  bars = [[], [w()], [w()]]
  checks = checkBars(bars, ...cap44)
  assert.equal(checks[0].status, 'empty')
  assert.equal(allPass(checks), false)
}

// 5) 换个拍号，同一份输入的对错要跟着变
{
  // 6/8：容量 3 个四分 = 6 个八分
  const sixEight = [q(), q(), q()]
  assert.equal(allPass(checkBars([sixEight, sixEight, sixEight], 6, 8)), true, '3 个四分正好填满 6/8')

  // 同样的输入在 4/4 下就是不足
  const checks44 = checkBars([sixEight, sixEight, sixEight], 4, 4)
  assert.equal(checks44[0].status, 'pickup', '第 1 小节不足 -> 弱起')
  assert.equal(checks44[1].status, 'short', '第 2 小节不足 -> 报错')
  assert.equal(allPass(checks44), false)

  // 3/4：容量 3
  assert.equal(allPass(checkBars([sixEight, sixEight, sixEight], 3, 4)), true)
}

// 6) 休止符和音符等价计时
{
  const withRest = [rq, rq, rq, rq]
  assert.equal(barTotal(withRest), 4)
  assert.equal(allPass(checkBars([withRest, withRest, withRest], 4, 4)), true, '休止符要照常计入时值')
}

// 7) 按钮表本身要自洽
{
  assert.ok(DURATIONS.length >= 5)
  for (const d of DURATIONS) {
    assert.ok(d.value > 0, d.id + ' 时值必须为正')
    assert.ok(d.glyph, d.id + ' 必须有五线谱 glyph')
    assert.equal(d.dashes > 0 && d.lines > 0, false, d.id + ' 不能同时又破折号又下划线')
  }
  const ids = DURATIONS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复')
}

// ============ 末小节允许不足（用户实际演奏是「4 小节 + 一个附点四分」）============
{
  const q = makeNote('quarter')
  const h = makeNote('half')
  const dq = makeNote('quarter', { dotted: true })

  // 中间小节不足 -> 报错
  const mid = checkBars([[q], [q], [q]], 4, 4)
  assert.equal(mid[1].status, 'short', '中间小节不足应报 short，实得 ' + mid[1].status)
  assert.equal(allPass(mid), false, '中间小节不足不该通过')

  // 用户实际演奏的结构：弱起 + 4 个满小节 + 一个附点四分音符收尾
  const tail = checkBars([[q], [q, q, q, q], [q, q, q, q], [q, q, q, q], [q, q, q, q], [dq]], 4, 4)
  assert.equal(tail[5].status, 'pickup', '最后小节不足应按收尾处理，实得 ' + tail[5].status)
  assert.equal(allPass(tail), true, '弱起 + 4 满小节 + 收尾应该通过')

  // 末小节超出 -> 照样报错
  const over = checkBars(
    [[q], [q, q, q, q], [q, q, q, q], [q, q, q, q], [q, q, q, q], [h, h, q]],
    4,
    4
  )
  assert.equal(over[5].status, 'long', '最后小节超出仍要报错，实得 ' + over[5].status)
  assert.equal(allPass(over), false)

  // 只有一个小节时，它既是第 1 也是最后 —— 不该被当成"中间"
  const single = checkBars([[q]], 4, 4)
  assert.equal(single[0].status, 'pickup', '单小节时应按弱起处理，实得 ' + single[0].status)
  assert.equal(allPass(single), true)
}

console.log('✓ 节奏模型与校验全部通过（拍号容量 / 附点 / 弱起 / 严格校验 / 换拍号 / 末小节收尾）')

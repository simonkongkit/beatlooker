import assert from 'node:assert/strict'
import {
  findLoopPeriod,
  foldScore,
  phaseDistance,
  foldEnvelope,
  pickFoldEvents,
  foldEventTimes
} from '../src/lib/loop.ts'

// ============ 1. 有明确循环时能找回正确的周期 ============
{
  const P = 6.7
  const offsets = [0, 0.6, 1.05, 1.8, 2.4, 3.0, 3.9, 4.6, 5.6]
  const times = []
  for (let lap = 0; lap < 5; lap++) for (const o of offsets) times.push(2.0 + lap * P + o)

  const info = findLoopPeriod(times)
  assert.ok(info, '应该能找到周期')
  assert.ok(Math.abs(info.period - P) < 0.08, '周期应接近 ' + P + '，实得 ' + info.period.toFixed(2))
  assert.ok(info.score > 1.3, '结构清晰时打分应明显高于随机，实得 ' + info.score.toFixed(2))
  // 跨度 = 4*P + 5.6 = 32.4，除以 P 得 4.84
  assert.ok(Math.abs(info.laps - 4.84) < 0.3, '遍数应约 4.84，实得 ' + info.laps.toFixed(2))
}

// ============ 2. ⚠️ 随机数据也会搜出"周期" —— 所以这个分数不能当开关 ============
// 这条断言记录的是一个**限制**，不是功能。它防止以后有人拿打分去自动筛起点。
{
  let seed = 999
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const times = []
  for (let i = 0; i < 40; i++) times.push(2 + i * 0.5 + rnd() * 0.2)

  const info = findLoopPeriod(times)
  assert.ok(info, '随机数据同样会搜出某个周期（这正是问题所在）')
  assert.ok(info.score > 1.25, '随机数据的打分也能到 1.25 以上，实得 ' + info.score.toFixed(2))
}

// ============ 3. 环形相位差 ============
{
  assert.equal(phaseDistance(0.1, 0.2, 6.7), 0.1)
  assert.ok(Math.abs(phaseDistance(0.1, 6.6, 6.7) - 0.2) < 1e-9, '跨越周期边界时要取近的那边')
  assert.ok(Math.abs(phaseDistance(0, 3.3, 6.6) - 3.3) < 1e-9)
}

// ============ 4. 太少点时不硬猜 ============
{
  assert.equal(findLoopPeriod([]), null)
  assert.equal(findLoopPeriod([1, 2, 3]), null)
  assert.equal(foldScore([1, 2], 3, 0.1), 0)
}

console.log('✓ 循环诊断通过（找回周期 / 记录"随机也能搜出周期"这个限制 / 相位差 / 点数不足）')

// ============ 5. 折叠平均检测：能找回事件，且抑制不重复的起伏 ============
{
  const rate = 93.75 // 列/秒，和 App 里一致（48000/512）
  const P = 6.7
  const phases = [0.1, 0.35, 1.3, 2.2, 3.2, 3.85, 4.4, 5.1, 5.8] // 一遍里 9 个事件
  const laps = 4
  const cols = Math.round(laps * P * rate)
  const env = new Float64Array(cols)

  // 底噪
  let seed = 424242
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < cols; i++) env[i] = 1e-7 * (0.5 + rnd())

  // 9 个事件：每个是一段指数衰减（模拟拨弦）
  for (let lap = 0; lap < laps; lap++) {
    for (const ph of phases) {
      const s = Math.round((lap * P + ph) * rate)
      for (let k = 0; s + k < cols && k < rate * 1.5; k++) {
        env[s + k] += 0.5 * Math.exp(-k / (rate * 0.25))
      }
    }
  }
  // 每遍都不同的干扰（模拟泛音拍频）：相位随机，幅度不小
  for (let i = 0; i < cols; i++) {
    env[i] *= 1 + 0.8 * Math.sin(i * 0.7 + rnd() * 6.28)
  }

  const fold = foldEnvelope(env, rate, P)
  assert.ok(fold, '应该能折叠')
  assert.equal(fold.laps, 4, '应有 4 个完整遍')

  const ev = pickFoldEvents(fold, { expectedCount: 9 })
  assert.equal(ev.length, 9, '应找到 9 个事件，实得 ' + ev.length)
  for (const ph of phases) {
    const hit = ev.find((e) => Math.abs(e.phase - ph) < 0.15)
    assert.ok(hit, '相位 ' + ph + 's 处的事件应被找到，实得 ' + ev.map((e) => e.phase.toFixed(2)).join(','))
  }

  // 展开成绝对时刻：每遍 9 个，共 4 遍 = 36 个
  const times = foldEventTimes(fold, ev)
  assert.equal(times.length, 36, '应展开出 36 个时刻，实得 ' + times.length)
  for (const t of times) {
    const lap = Math.floor(t / P)
    const ph = t - lap * P
    assert.ok(phases.some((q) => Math.abs(q - ph) < 0.15), '展开的时刻应落在事件相位上，实得 ' + ph.toFixed(3))
  }
}

// ============ 6. 只弹一遍时不能硬报（至少要有 2 个完整遍）============
{
  const rate = 93.75
  const env = new Float64Array(Math.round(5 * rate))
  for (let i = 0; i < env.length; i++) env[i] = 1e-7
  assert.equal(foldEnvelope(env, rate, 6.7), null, '不足两遍时必须返回 null')
  assert.equal(foldEnvelope(null, rate, 6.7), null)
  assert.equal(foldEnvelope(env, rate, 0), null)
}

console.log('✓ 折叠平均检测通过（找回 9 个事件 / 展开成绝对时刻 / 不足两遍拒绝）')


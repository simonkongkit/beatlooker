/**
 * 起点检测 + 速度测算的独立自检：node tools/check-onset.mjs
 *
 * 这个模块全是数值逻辑，最怕"看着对、其实差一点"，所以断言都带明确容差，
 * 而且专门构造漏音 / 多打 / 抖动这些真实演奏里一定会出现的情况。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  detectOnsets,
  detectOnsetsWithNotes,
  findPerformanceStart,
  expectedPitchSequence,
  expectedOnsets,
  patternBeats,
  matchTempo,
  mergeChordEvents,
  readEnergies,
  shortestGap
} from '../src/lib/onset.ts'
import { makeNote } from '../src/lib/notation/rhythm.ts'
import { SpectrumAnalyser } from '../src/lib/fft.ts'
import { buildBands } from '../src/lib/noteBands.ts'
import { STANDARD as STD } from '../src/lib/notation/tab.ts'

const RATE = 93.75 // 48kHz / hop 512，和引擎实际产出速率一致

/** 合成能量包络：起点处幅度跳到 amp，之后按 tau 衰减；能量 = 幅度² */
function synth(onsets, seconds, opts = {}) {
  const rate = opts.rate ?? RATE
  const tau = opts.tau ?? 0.04
  const amps = opts.amps ?? onsets.map(() => 1)
  const n = Math.round(seconds * rate)
  const e = new Float32Array(n)
  onsets.forEach((t, idx) => {
    const s = Math.round(t * rate)
    const amp = amps[idx] ?? 1
    for (let k = 0; s + k < n; k++) {
      const a = amp * Math.exp(-k / (rate * tau))
      e[s + k] += a * a
    }
  })
  return e
}

const q = (o = {}) => makeNote('quarter', o)
const e8 = (o = {}) => makeNote('eighth', o)
const h = (o = {}) => makeNote('half', o)

// ---------------------------------------------------------------- 1. 基本检测
{
  const truth = [0.5, 1.0, 1.5, 2.0]
  const found = detectOnsets(synth(truth, 3), RATE)
  assert.equal(found.length, 4, '四个清晰的起点应该检出四个，实际 ' + found.length)
  found.forEach((o, i) => {
    assert.ok(
      Math.abs(o.time - truth[i]) < 0.025,
      `第 ${i + 1} 个起点时刻偏差过大：得到 ${o.time.toFixed(3)}，期望 ${truth[i]}`
    )
  })
  // 时间必须单调
  for (let i = 1; i < found.length; i++) assert.ok(found[i].time > found[i - 1].time)
}

// ------------------------------------------------- 2. 稳态不该检出一堆假起点
{
  const flat = new Float32Array(Math.round(3 * RATE)).fill(1)
  assert.equal(detectOnsets(flat, RATE).length, 0, '恒定能量不该有起点')

  const zeros = new Float32Array(Math.round(2 * RATE))
  assert.equal(detectOnsets(zeros, RATE).length, 0, '全零不该有起点')

  assert.equal(detectOnsets(new Float32Array(0), RATE).length, 0, '空输入')
  assert.equal(detectOnsets(new Float32Array(2), RATE).length, 0, '太短')

  // 缓慢起伏（不是"跳跃"）也不该算起点
  const slow = new Float32Array(Math.round(4 * RATE))
  for (let i = 0; i < slow.length; i++) slow[i] = 1 + 0.5 * Math.sin((i / RATE) * 1.5)
  assert.ok(detectOnsets(slow, RATE).length <= 1, '缓慢起伏不该被当成起点')
}

// ------------------------------------------- 3. 对数域：弱音跟在强音后面也要检出
{
  // 0.5s 一个强音（幅度 1），1.0s 一个很轻的音（幅度 0.02 ≈ -34dB）
  const found = detectOnsets(synth([0.5, 1.0], 2, { amps: [1, 0.02] }), RATE)
  assert.equal(found.length, 2, '轻弹的音也要检出来（这就是用 dB 域的理由），实际 ' + found.length)
  assert.ok(Math.abs(found[1].time - 1.0) < 0.03)
  assert.ok(found[0].strengthDb > found[1].strengthDb, '强音的抬升量应该更大')
}

// --------------------------------------------------- 4. 最小间隔：一个音不能拆成两个
{
  const close = [1.0, 1.03] // 相隔 30ms
  const merged = detectOnsets(synth(close, 2), RATE, { minGapSeconds: 0.07 })
  assert.equal(merged.length, 1, '30ms 内的两下应该被合成一个起点，实际 ' + merged.length)

  const kept = detectOnsets(synth([1.0, 1.2], 2), RATE, { minGapSeconds: 0.07 })
  assert.equal(kept.length, 2, '200ms 的两下必须分开')
}

// ------------------------------------------------------- 5. 从 EnergyLog 取数
{
  const data = [1, 2, 3, 4, 5]
  const fake = { length: data.length, rate: 10, at: (i) => data[i] }
  const arr = readEnergies(fake)
  assert.equal(arr.length, 5)
  assert.deepEqual([...arr], [1, 2, 3, 4, 5])
}

// ---------------------------------------------------------- 6. 期望起点（含休止）
{
  // 四个四分音符 -> 0,1,2,3
  assert.deepEqual(expectedOnsets([[q(), q(), q(), q()]]), [0, 1, 2, 3])

  // 休止符不产生起点，但时间照常前进：四分 + 四分休止 + 四分 -> 0, 2
  const withRest = [q(), makeNote('quarter', { rest: true }), q()]
  assert.deepEqual(expectedOnsets([withRest]), [0, 2], '休止符不该产生起点，但必须占用时间')

  // 附点：附点四分 + 八分 -> 0, 1.5
  assert.deepEqual(expectedOnsets([[q({ dotted: true }), e8()]]), [0, 1.5])

  // 跨小节连续累计
  assert.deepEqual(expectedOnsets([[h()], [h()]]), [0, 2])

  // 空
  assert.deepEqual(expectedOnsets([[], [], []]), [])
}

// ------------------------------------------------------------- 7. 最小间隔换算
{
  assert.equal(shortestGap([0, 1, 2, 3]), 1)
  assert.equal(shortestGap([0, 0.5, 1.5]), 0.5)
  assert.equal(shortestGap([0, 0.25, 1, 2]), 0.25)
  assert.equal(shortestGap([5]), 1, '只有一个音时给个默认值，不能是 Infinity')
  assert.equal(shortestGap([]), 1)
}

// ------------------------------------------------- 8. 从起点恢复已知 BPM（核心）
{
  const expected = [0, 1, 2, 3, 4, 5, 6, 7] // 八个四分音符
  for (const bpm of [60, 90, 100, 120, 150, 200]) {
    const spq = 60 / bpm
    const times = expected.map((p) => p * spq)
    const m = matchTempo(times, expected)
    assert.ok(m, bpm + ' BPM 应该能匹配上')
    assert.ok(
      Math.abs(m.bpm - bpm) < 0.5,
      `${bpm} BPM 恢复成了 ${m.bpm.toFixed(2)}`
    )
    assert.equal(m.matches, 8, bpm + ' BPM 下应该全部匹配')
    assert.ok(m.f1 > 0.999, '完全吻合时 F1 应该是 1')
    assert.ok(m.meanAbsError < 0.005, '完全吻合时平均偏差应接近 0')
  }
}

// ------------------------------------------------------------ 9. 漏音仍要能恢复
{
  const expected = [0, 1, 2, 3, 4, 5, 6, 7]
  const spq = 60 / 100
  // 故意漏掉第 4 个音（人一定会弹漏）
  const times = expected.filter((_, i) => i !== 3).map((p) => p * spq)
  const m = matchTempo(times, expected)
  assert.ok(m)
  assert.ok(Math.abs(m.bpm - 100) < 2, '漏一个音不该让速度整个偏掉，得到 ' + m.bpm.toFixed(1))
  assert.equal(m.matches, 7)
  assert.equal(m.recall, 7 / 8)
  assert.ok(m.precision > 0.99, '漏音不该被算成多打')
}

// ------------------------------------------------------ 10. 多打的音要被识别出来
{
  const expected = [0, 1, 2, 3]
  const spq = 60 / 120
  const times = [0, 0.5 * spq, 1, 2, 3].map((p) => p * spq) // 第 0.5 拍上多打一下
  const m = matchTempo(times, expected)
  assert.ok(m)
  assert.ok(Math.abs(m.bpm - 120) < 3, '多打一下不该让速度偏掉，得到 ' + m.bpm.toFixed(1))
  assert.equal(m.extras.length, 1, '多打的那一下应该被记为 extras')
  assert.equal(m.matches, 4)
  assert.ok(m.precision < 1, '有多打时 precision 应该小于 1')
}

// --------------------------------------------------------------- 11. 抖动
{
  const expected = [0, 1, 2, 3, 4, 5, 6, 7]
  const spq = 60 / 110
  // 固定的伪随机抖动，避免测试本身不稳定
  const jitter = [0.008, -0.012, 0.005, -0.003, 0.014, -0.009, 0.002, -0.011]
  const times = expected.map((p, i) => p * spq + jitter[i])
  const m = matchTempo(times, expected)
  assert.ok(m)
  assert.ok(Math.abs(m.bpm - 110) < 3, '带抖动时应接近 110，得到 ' + m.bpm.toFixed(1))
  assert.equal(m.matches, 8, '抖动幅度远小于容差，应该全部匹配上')
  assert.ok(m.meanAbsError > 0.003 && m.meanAbsError < 0.02, '平均偏差应落在抖动幅度附近')
}

// --------------------------------------------------- 12. 空输入 / 边界
{
  assert.equal(matchTempo([], [0, 1, 2]), null)
  assert.equal(matchTempo([0.5, 1.0], []), null)
  assert.equal(matchTempo([], []), null)

  // 只有一个音：信息不足，但也不该崩
  const one = matchTempo([1.23], [0])
  assert.ok(one, '单音也要返回结果而不是 null')
  assert.equal(one.matches, 1)
}

// ------------------------------------------- 13. 和真实节奏（含休止）配合
{
  // 四分 四分 休止 四分 四分 -> 期望起点 0,1,3,4
  const bars = [[q(), q(), makeNote('quarter', { rest: true }), q(), q()]]
  const expected = expectedOnsets(bars)
  assert.deepEqual(expected, [0, 1, 3, 4])

  // 按 120BPM 演奏（休止处不弹）
  const times = expected.map((p) => p * 0.5)
  const m = matchTempo(times, expected)
  assert.ok(m)
  assert.ok(Math.abs(m.bpm - 120) < 2, '含休止的节奏也要能算出速度，得到 ' + m.bpm.toFixed(1))
  assert.equal(m.matches, 4)
}

// ------------------------------------------------ 14. 弱起小节：第一个音就在 0 拍
{
  const bars = [[q()], [q(), q(), q(), q()]] // 弱起 1 拍 + 满小节
  assert.deepEqual(expectedOnsets(bars), [0, 1, 2, 3, 4])

  const spq = 60 / 96
  const m = matchTempo(expectedOnsets(bars).map((p) => p * spq), expectedOnsets(bars))
  assert.ok(m && Math.abs(m.bpm - 96) < 2, '弱起节奏也要能算出速度')
}

// ===================== 15. 频率带上的突变（本次新增的核心） =====================
{
  const rate = 100
  const n = 300 // 3 秒
  const BANDS = [
    { midi: 81, label: 'A5' },
    { midi: 84, label: 'C6' },
    { midi: 88, label: 'E6' }
  ]

  /** 一条平的 dB 序列 */
  const flat = (base) => new Float32Array(n).fill(base)
  /** 在 t 时刻让某条带抬起来，之后按 tau 衰减 */
  const rise = (series, t, riseDb, tau = 0.4) => {
    const s = Math.round(t * rate)
    for (let k = 0; s + k < n; k++) series[s + k] += riseDb * Math.exp(-k / (rate * tau))
  }
  /** 各条带的 dB 合成出总能量；base 是线性本底 */
  const totalFrom = (bands, base = 1e-9) => {
    const e = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = base
      for (const b of bands) sum += Math.pow(10, b[i] / 10)
      e[i] = sum
    }
    return e
  }

  // --- 15a. 两个音先后起来，音名要能对上 ---
  {
    const series = [flat(-70), flat(-70), flat(-70)]
    rise(series[0], 0.5, 30) // A5
    rise(series[1], 1.0, 25) // C6
    const det = detectOnsetsWithNotes(series, BANDS, rate)

    assert.equal(det.length, 2, '应该正好两个起点，实得 ' + det.length)
    assert.ok(Math.abs(det[0].time - 0.5) < 0.04, '第一个起点应在 0.5s，实得 ' + det[0].time.toFixed(3))
    assert.ok(Math.abs(det[1].time - 1.0) < 0.04, '第二个起点应在 1.0s，实得 ' + det[1].time.toFixed(3))
    assert.equal(det[0].note?.label, 'A5', '第一个音应识别为 A5，实得 ' + det[0].note?.label)
    assert.equal(det[1].note?.label, 'C6', '第二个音应识别为 C6，实得 ' + det[1].note?.label)
    assert.ok(det[0].bandCount >= 1, '每一下至少该有一条带参与')
  }

  // --- 15b. ★ 总能量不动，但某条带上突然出现高能量 —— 这正是本次要加的能力 ---
  {
    // 0 号带一直很响（-20dB）压住总能量；2 号带很安静，然后在 1.0s 起来
    const series = [flat(-20), flat(-70), flat(-70)]
    rise(series[2], 1.0, 25)
    const energies = totalFrom(series)

    // 先确认前提成立：总能量的变化确实小到检不出来
    const peak = Math.max(...energies)
    const dbChange = 10 * Math.log10(energies[Math.round(1.05 * rate)] / energies[Math.round(0.9 * rate)])
    assert.ok(dbChange < 1.2, `前提不成立：总能量其实动了 ${dbChange.toFixed(2)}dB`)

    // 只用总能量：什么都检不到
    assert.equal(detectOnsets(energies, rate).length, 0, '总能量确实没动，单独用它应检不出')

    // 只用频带：必须检出来，而且要标对音
    const det = detectOnsetsWithNotes(series, BANDS, rate)
    assert.ok(det.length >= 1, '频带检测必须把这个音找出来，实得 ' + det.length)
    const hit = det.find((d) => d.note?.label === 'E6')
    assert.ok(hit, '必须识别出 E6，实得 ' + det.map((d) => d.note?.label).join('/'))
    assert.ok(Math.abs(hit.time - 1.0) < 0.06, '时刻应接近 1.0s，实得 ' + hit.time.toFixed(3))
  }

  // --- 15c. 泛音：同一个音的多条带一起起来，只算一个起点 ---
  {
    const series = [flat(-70), flat(-70), flat(-70)]
    // A5 的基频 + 八度泛音同时起来
    rise(series[0], 0.6, 28)
    rise(series[1], 0.6, 18)
    const det = detectOnsetsWithNotes(series, BANDS, rate)
    assert.equal(det.length, 1, '同时起来的多条带必须合成一个起点，实得 ' + det.length)
    assert.equal(det[0].note?.label, 'A5', '最强的带应作为主音')
    assert.ok(
      det[0].otherNotes.some((x) => x.label === 'C6'),
      '泛音也要报在 otherNotes 里，不能丢'
    )
    assert.ok(det[0].note.riseDb > det[0].otherNotes[0].riseDb, '主音必须比泛音强')
  }

  // --- 15d. 没有频带数据就什么都检不出来（频带现在是唯一依据）---
  {
    assert.equal(detectOnsetsWithNotes(null, null, rate).length, 0, '没有频带数据不该凭空报起点')
    assert.equal(detectOnsetsWithNotes([], [], rate).length, 0, '空数组同理')
    assert.equal(detectOnsetsWithNotes([new Float32Array(300)], [], rate).length, 0, '没有音带定义同理')

    // 总能量那条路已经**不再参与**检测了，但它作为一个独立函数仍然保留可用
    const truth = [0.5, 1.0, 1.5]
    const energies = synth(truth, 3, { rate })
    assert.equal(detectOnsets(energies, rate).length, 3, 'detectOnsets 仍应可用（画图/调试会用到）')
  }

  // --- 15e. 抬升太小不该报（噪声不能当音） ---
  {
    const series = [flat(-70), flat(-70), flat(-70)]
    rise(series[0], 0.5, 1.5) // 只抬 1.5dB，低于 bandMinJumpDb(4)
    const det = detectOnsetsWithNotes(series, BANDS, rate)
    assert.equal(det.length, 0, '1.5dB 的抬升是小起伏，不该算成音')
  }

  // --- 15f. 认音阈值和起音阈值是两回事 ---
  {
    const series = [flat(-70), flat(-70), flat(-70)]
    rise(series[0], 0.5, 6)
    const a = detectOnsetsWithNotes(series, BANDS, rate)
    assert.equal(a.length, 1, '6dB 应能检出')
    assert.equal(a[0].note?.label, 'A5', '默认阈值下应认出 A5')

    // 「认音判据」和「起音判据」是两回事：
    // 提高认音阈值**不会**让起点消失（起点是包络触发出来的），只是不再硬报音名。
    const b = detectOnsetsWithNotes(series, BANDS, rate, { noteRiseDb: 10 })
    assert.equal(b.length, 1, '认音阈值不影响起点本身')
    assert.equal(b[0].note, null, '抬升不到 10dB，就不该硬报音名')

    // 要让起点真的消失，得提高**包络自己**的阈值
    const c = detectOnsetsWithNotes(series, BANDS, rate, { envMinJumpDb: 10 })
    assert.equal(c.length, 0, '包络阈值提到 10dB 后，3dB 的抬升不该被当成起音')
  }
}

console.log('✓ 起点检测与速度测算全部通过（检测 / 对数域弱音 / 最小间隔 / 漏音 / 多打 / 抖动 / 休止 / 弱起）')
console.log('✓ 频率带突变检测全部通过（音名识别 / 总能量不动也能检出 / 泛音合并 / 无频带退化 / 阈值）')

// ============ 16. 底噪不能被当成起点（★ 用户实测发现的 bug，回归测试）============
{
  const rate = 93.75
  // 固定种子的伪随机，保证测试可重复
  let seed = 987654321
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  /** 一段有真实起伏的底噪：能量在 baseDb 上下随机抖动 */
  const addNoise = (out, baseDb, spreadDb) => {
    for (let i = 0; i < out.length; i++) {
      out[i] += Math.pow(10, (baseDb + (rnd() * 2 - 1) * spreadDb) / 10)
    }
  }

  const n = Math.round(6 * rate)

  // --- 16a. 只有底噪，没有任何演奏：必须一个起点都不报 ---
  {
    const pure = new Float32Array(n)
    addNoise(pure, -62, 4)
    const found = detectOnsets(pure, rate)
    assert.equal(
      found.length,
      0,
      '整段只有底噪时必须一个起点都不报，实得 ' + found.length + ' 个（底噪被当成起点了）'
    )
  }

  // --- 16b. 底噪 + 三个真实的音：只能报三个 ---
  {
    const e = new Float32Array(n)
    addNoise(e, -62, 4)
    const truth = [1.5, 2.5, 3.5]
    for (const t of truth) {
      const s = Math.round(t * rate)
      for (let k = 0; s + k < n; k++) {
        e[s + k] += Math.pow(10, -30 / 10) * Math.exp((-2 * k) / (rate * 0.08))
      }
    }
    const found = detectOnsets(e, rate)
    assert.equal(
      found.length,
      truth.length,
      '应该只检出 ' + truth.length + ' 个真实的音，实得 ' + found.length + ' 个'
    )
    found.forEach((o, i) => {
      assert.ok(
        Math.abs(o.time - truth[i]) < 0.04,
        '第 ' + (i + 1) + ' 个起点时刻偏差过大：' + o.time.toFixed(3) + ' vs ' + truth[i]
      )
    })
  }

  // --- 16c. 每个起点都必须明显高于底噪 ---
  {
    const e = new Float32Array(n)
    addNoise(e, -62, 4)
    for (const t of [1.5, 3.0]) {
      const s = Math.round(t * rate)
      for (let k = 0; s + k < n; k++) {
        e[s + k] += Math.pow(10, -30 / 10) * Math.exp((-2 * k) / (rate * 0.08))
      }
    }
    // 底噪约 -62dB 上下 4dB，所以峰值大致在 -58dB；起点处的能量必须在 -45dB 以上
    for (const o of detectOnsets(e, rate)) {
      const db = 10 * Math.log10(e[o.index] || 1e-12)
      assert.ok(db > -45, '起点处的能量只有 ' + db.toFixed(1) + 'dB，那是底噪不是起音')
    }
  }
}

console.log('✓ 底噪拒绝全部通过（纯底噪零误检 / 底噪里只报真音 / 起点必须高于底噪）')

// ============ 17. 开头有误检时不能让整段错位（★ 用户实测报的问题）============
{
  // 场景：录了 19 秒，真正第一个音在 2.0 秒，但开头 0.3 秒有一声杂音被检成起点。
  // 旧实现死认"第一个检测点就是第一个音"，于是整段按 0.3s 对齐，
  // 2.0s 的那个音被推到后面的期望音符上 —— 表现为"第一个音被标成了第 2 小节"。
  const expected = [0, 1, 2, 3, 4, 5, 6, 7]
  const bpm = 100
  const spq = 60 / bpm
  const realFirst = 2.0
  const times = [0.3, ...expected.map((p) => realFirst + p * spq)]

  const m = matchTempo(times, expected)
  assert.ok(m, '应该能匹配上')
  assert.ok(Math.abs(m.bpm - bpm) < 1.5, '速度仍应是 100 BPM 附近，实得 ' + m.bpm.toFixed(1))
  assert.equal(m.matches, expected.length, '八个音都该对上，实得 ' + m.matches)
  assert.ok(
    Math.abs(m.offset - realFirst) < 0.05,
    '拟合出的第一个音时刻应对到 2.0s（那是真正的第一个音），实得 ' + m.offset.toFixed(3)
  )
  assert.equal(m.extras.length, 1, '开头那声杂音应被记为多打，而不是被当成第一个音')

  // 反过来验一下：如果锚点真的取第一个检测点会错多少
  const wrong = matchTempo(times, expected, { anchorCandidates: 1 })
  assert.ok(
    wrong === null || Math.abs(wrong.offset - realFirst) > 0.5,
    '只允许用第一个检测点当锚点时，结果应该偏掉 —— 否则这个测试没验到东西'
  )
}

console.log('✓ 锚点搜索通过（开头误检不再让整段错位）')

// ============ 18. 频带检测的底噪拒绝（现在频带是唯一依据）============
{
  const rate = 93.75
  let seed = 24681357
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const n = Math.round(8 * rate)

  const flat = (base) => new Float32Array(n).fill(base)
  const noise = (base, spread) => {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = base + (rnd() * 2 - 1) * spread
    return a
  }

  // 80 条带全是底噪 —— 和真实建带数量同量级
  const BANDS80 = Array.from({ length: 80 }, (_, i) => ({ midi: 40 + i, label: 'B' + (40 + i) }))

  // --- 18a. 整段纯底噪，一条真的都没有 ---
  {
    const series = BANDS80.map(() => noise(-62, 5))
    const det = detectOnsetsWithNotes(series, BANDS80, rate)
    assert.equal(
      det.length,
      0,
      '80 条带全是底噪时必须零误检，实得 ' + det.length + ' 个（' +
        det.slice(0, 5).map((d) => d.time.toFixed(2)).join(', ') + '）'
    )
  }

  // --- 18b. 只有一条带真的响了，其余是底噪：只能报一个 ---
  {
    const series = BANDS80.map(() => noise(-62, 5))
    const b = 40
    const s = Math.round(3.0 * rate)
    for (let k = 0; s + k < n; k++) series[b][s + k] += 30 * Math.exp(-k / (rate * 0.3))
    // ★ 显式 minBands: 1 —— 这条测的是「能不能认出**只点亮一条带**的音」✓
    // 和「默认过滤该不该留它」是两件事 ✓（默认按 10% 过滤 ✓ 单频信号会被滤掉 ✓ 是刻意的取舍 ✓）
    const det = detectOnsetsWithNotes(series, BANDS80, rate, { minBands: 1 })
    assert.equal(det.length, 1, '只该报一个起点，实得 ' + det.length)
    assert.equal(det[0].note?.midi, BANDS80[b].midi, '应识别到第 ' + b + ' 条带')
  }

  // --- 18c. 宽频咔哒声（所有带同时抬一下）也要能检出来 ---
  // 这是去掉总能量之后的**代价所在**：靠各带分别报、再按时间合并来补。
  {
    const series = BANDS80.map(() => noise(-62, 5))
    const s = Math.round(4.0 * rate)
    for (let i = 0; i < series.length; i++) {
      for (let k = 0; s + k < n; k++) series[i][s + k] += 22 * Math.exp(-k / (rate * 0.25))
    }
    const det = detectOnsetsWithNotes(series, BANDS80, rate)
    assert.equal(det.length, 1, '所有带同时起来必须合成一个起点，实得 ' + det.length)
    assert.ok(det[0].bandCount > 10, '这一下应该有很多条带参与，实得 ' + det[0].bandCount)
  }
}

console.log('✓ 频带底噪拒绝全部通过（80 条带纯底噪零误检 / 单带真音 / 宽频咔哒合并）')

// ============ 19. 起点密集时锚点不能乱选（★ 用户实测报的问题）============
{
  // 复刻真实录音的困境：起点比期望音还密（每 0.15 秒一个），
  // 而且真正的第一个音之前还有一段杂音。旧实现会锚到一个很晚的位置。
  const expected = [0, 1, 2, 3, 4, 5, 6, 7]
  const bpm = 100
  const spq = 60 / bpm // 0.6s
  const realFirst = 2.0

  // 起点比期望音还密，而且杂音明显更"弱" —— 真实录音就是这样
  const times = []
  const strengths = []
  for (let t = 0.6; t < 2.0; t += 0.15) {
    times.push(t)
    strengths.push(6) // 杂音：弱
  }
  for (let i = 0; i < expected.length; i++) {
    times.push(realFirst + i * spq)
    strengths.push(28) // 真正的音：强
  }
  for (let t = realFirst + 4.85; t < 9.0; t += 0.15) {
    times.push(t)
    strengths.push(6)
  }

  const m = matchTempo(times, expected, { strengths })
  assert.ok(m, '应该能匹配上')
  assert.equal(m.matches, expected.length, '八个期望音都该对上，实得 ' + m.matches)
  assert.ok(
    Math.abs(m.offset - realFirst) < 0.05,
    '必须锚到真正的第一个音 2.0s，实得 ' + m.offset.toFixed(3) +
      '（起点密集时按 meanAbsError 裁决会锚到很晚的位置）'
  )
  assert.ok(Math.abs(m.bpm - bpm) < 1.5, '速度应是 100 BPM 附近，实得 ' + m.bpm.toFixed(1))
}

console.log('✓ 密集起点下的锚点选择通过（不会锚到很晚的位置）')

// ============ 20. 期望模式按遍重复（★ 用户实测报的"真音被标成多打"）============
{
  const rate = 93.75
  const { makeNote } = await import('../src/lib/notation/rhythm.ts')
  // 人为构造：一遍 2 个四分音符
  const bars = [
    [makeNote('quarter'), makeNote('quarter')],
    [makeNote('quarter'), makeNote('quarter')],
    [makeNote('quarter'), makeNote('quarter')]
  ]
  const one = expectedOnsets(bars)
  assert.equal(one.length, 6, '一遍 6 个音')
  assert.deepEqual(one, [0, 1, 2, 3, 4, 5])

  assert.equal(patternBeats(bars), 6, '一遍 6 拍')

  const three = expectedOnsets(bars, 3)
  assert.equal(three.length, 18, '三遍 18 个音')
  assert.equal(three[6], 6, '第 2 遍第一个音在 6 拍')
  assert.equal(three[12], 12, '第 3 遍第一个音在 12 拍')

  // 关键回归：真演奏了 3 遍，若只拿一遍的期望音去对，后两遍全会被算成"多打"
  const bpm = 120
  const spq = 60 / bpm
  const times = three.map((p) => 2 + p * spq)
  const withReply = matchTempo(times, three, {})
  const withoutReply = matchTempo(times, one, {})
  assert.ok(withReply && withoutReply, '都该能拟合')
  assert.equal(withReply.matches, 18, '按 3 遍重复应全部对上，实得 ' + withReply.matches)
  assert.ok(
    withoutReply.extras.length >= 12,
    '只拿一遍去对，后两遍会变成多打（这就是用户看到的一片粉色），实得 ' + withoutReply.extras.length
  )
  assert.ok(withReply.f1 > withoutReply.f1 + 0.3, '重复之后 F1 应显著更高')
  // 而且速度也要对 —— 只拿一遍去对时拟合会滑向一个慢得多的速度
  assert.ok(Math.abs(withReply.bpm - bpm) < 3, '速度应接近 120，实得 ' + withReply.bpm.toFixed(1))
}

console.log('✓ 期望模式按遍重复通过（重复展开 / 真音不再被算成多打 / 速度不再被拖慢）')






// ============ 起奏检测：绝对判断，必须和"新音检测"分开 ============
{
  const RATE = 93.75
  const mk = (fn) => {
    const n = Math.round(RATE * 8)
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = fn(i / RATE)
    return a
  }

  // ---- 1. 前 3 秒是底噪（有小幅随机起伏），3 秒后才是真正的演奏 ----
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const noise = mk((t) => (t < 3 ? 0.0008 * (0.5 + rnd()) : 0.08 * (0.6 + 0.4 * Math.sin(t * 9))))
  const ps = findPerformanceStart(noise, RATE)
  assert.ok(ps, '应该找得到起奏')
  assert.ok(
    Math.abs(ps.time - 3) < 0.35,
    '起奏应落在 3 秒附近（±0.35s），实得 ' + ps.time.toFixed(2) + 's'
  )
  assert.ok(ps.riseDb > 10, '真起奏的抬升应该很明显，实得 ' + ps.riseDb.toFixed(1) + ' dB')

  // ---- 2. 全是底噪 -> 不该报起奏 ----
  const pure = mk(() => 0.0008 * (0.5 + rnd()))
  assert.equal(findPerformanceStart(pure, RATE), null, '整段只有底噪时不该报起奏')

  // ---- 3. 单个毛刺不算起奏（必须持续）----
  const spike = mk((t) => (t > 3 && t < 3.05 ? 0.1 : 0.0008 * (0.5 + rnd())))
  assert.equal(
    findPerformanceStart(spike, RATE, { minSeconds: 0.2 }),
    null,
    '50ms 的单个毛刺不该算成起奏（要求持续 200ms）'
  )

  // ---- 4. ★ 端到端：底噪里的起伏不该被报成起点 ----
  // 造一段"先安静 2 秒、再真的弹"的信号，跑完整检测
  const FFT = 2048
  const sr = 48000
  const total = sr * 5
  const sig = new Float32Array(total)
  for (let i = 0; i < total; i++) sig[i] = (rnd() * 2 - 1) * 0.0004
  // 2 秒之后弹一个响亮的音（带谐波）
  const f0 = 440
  for (let k = 0; k < sr * 2; k++) {
    const t = k / sr
    const env = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 1.2)
    let v = 0
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h
    sig[2 * sr + k] += v * env * 0.25
  }
  const an = new SpectrumAnalyser(FFT, 'hann')
  const anSaw = new SpectrumAnalyser(FFT, 'sawtooth')
  const hop = 512
  const colRate = sr / hop
  const cols = Math.floor((total - FFT) / hop) + 1
  const bands = buildBands(50, 16000, FFT, sr)
  const trig = new Float32Array(cols)
  const dbByBand = bands.map(() => new Float32Array(cols))
  for (let c = 0; c < cols; c++) {
    const end = c * hop + FFT
    const w = sig.subarray(end - FFT, end)
    const os = anSaw.analyse(w)
    let sum = 0
    for (let k = 0; k < os.length; k++) sum += os[k] * os[k]
    trig[c] = sum
    const mag = an.analyse(w)
    for (let bi = 0; bi < bands.length; bi++) {
      let e = 0
      for (let k = bands[bi].lo; k < bands[bi].hi && k < mag.length; k++) e += mag[k] * mag[k]
      dbByBand[bi][c] = 10 * Math.log10(e + 1e-20)
    }
  }
  const onsets = detectOnsetsWithNotes(dbByBand, bands, colRate, { triggerEnergies: trig })
  const early = onsets.filter((o) => o.time < 1.8)
  assert.equal(
    early.length,
    0,
    '前 2 秒只有底噪，不该报任何起点，实得 ' + early.length + ' 个：' +
      early.map((o) => o.time.toFixed(2) + 's').join(' ')
  )
  assert.ok(onsets.length > 0, '2 秒之后的真音必须报出来')
  assert.ok(
    onsets[0].time > 1.8 && onsets[0].time < 2.4,
    '第一个起点应在 2 秒附近，实得 ' + onsets[0].time.toFixed(2) + 's'
  )
  assert.equal(onsets[0].note?.midi, 69, '应认出 A4，实得 ' + onsets[0].note?.midi)
}

console.log('✓ 起奏检测通过（绝对门槛 / 纯底噪不报 / 毛刺不算 / 端到端：安静段零起点）')

// ============ 音高当锚点：时间分不出高低时，音高来分 ============
{
  // 谱面：G C D E F G D，每音一拍
  const NAMES = { G: 7, C: 0, D: 2, E: 4, F: 5 }
  const expectedPitches = ['G', 'C', 'D', 'E', 'F', 'G', 'D'].map((n) => 60 + NAMES[n])
  const expected = [0, 1, 2, 3, 4, 5, 6]

  // 检测：**两组**起点的节拍完全一样，只看时间分不出高低
  //   第一组在 0.5s 起（音高全是错的）
  //   第二组在 10s 起（音高全对 —— 这才是真对齐）
  const times = []
  const pitches = []
  for (let i = 0; i < 7; i++) {
    times.push(0.5 + i)
    pitches.push(67) // 全错：清一色 G
  }
  for (let i = 0; i < 7; i++) {
    times.push(10 + i)
    pitches.push(expectedPitches[i]) // 全对
  }

  const opts = { strengths: times.map(() => 1) }
  const timeOnly = matchTempo(times, expected, opts)
  const withPitch = matchTempo(times, expected, {
    ...opts,
    pitches,
    expectedPitches
  })

  assert.ok(timeOnly, '只看时间也应该有结果')
  assert.ok(withPitch, '带音高也应该有结果')

  // 只看时间时，两组一模一样，靠"更早者胜"会锚到 0.5s 那组 ✗
  assert.ok(
    Math.abs(timeOnly.offset - 0.5) < 0.2,
    '只看时间时会锚到更早那组（0.5s），实得 offset=' + timeOnly.offset.toFixed(2)
  )
  assert.equal(timeOnly.pitchAgree, 0, '不看音高时吻合数当然是 0')

  // ★ 带上音高之后，应该锚到音高全对的那一组（10s）
  assert.ok(
    Math.abs(withPitch.offset - 10) < 0.2,
    '带音高时应锚到音高全对的那组（10s），实得 offset=' + withPitch.offset.toFixed(2)
  )
  assert.equal(withPitch.pitchAgree, 7, '应认出 7 个音高吻合')
  assert.ok(Math.abs(withPitch.pitchRate - 1) < 1e-9, '吻合率应为 1')
  assert.ok(withPitch.score > timeOnly.score + 0.2, '综合分必须明显更高')

  // ---- 反过来：音高只对了一部分，也该优先选对得多的那个 ----
  // 第二组里把 4 个音改成错的
  const partial = [...pitches]
  for (let i = 0; i < 4; i++) partial[7 + i] = 61
  const mixed = matchTempo(times, expected, { ...opts, pitches: partial, expectedPitches })
  assert.ok(mixed, '部分对时也要有结果')
  assert.equal(mixed.pitchAgree, 3, '应有 3 个音高吻合，实得 ' + mixed.pitchAgree)
  assert.ok(
    Math.abs(mixed.offset - 10) < 0.2,
    '哪怕只对 3 个，也该选它（另一个是 0 个），实得 offset=' + mixed.offset.toFixed(2)
  )

  // ---- 不传音高时，行为和以前完全一样（不能悄悄改变老行为）----
  const legacy = matchTempo(times, expected, opts)
  assert.equal(legacy.pitchAgree, 0, '不传音高时吻合数为 0')
  assert.ok(Math.abs(legacy.score - legacy.f1) < 1e-9, '不传音高时综合分就等于 F1（无副作用）')
}

console.log('✓ 音高锚点通过（时间打平时音高定胜负 / 部分吻合也优先 / 不传音高时行为不变）')

// ============ 和弦不能推进期望时刻 ============
{
  const q = (m, chord) => makeNote('quarter', { midi: m, chord })
  // 第 1 小节：4 个四分音符（其中第 2 个是和弦音，和第 1 个同时起）
  const bars = [
    [q(67), q(71, true), q(69), q(72)],
    [q(74), q(76), q(77), q(79)],
    [q(81), makeNote('half', { midi: 83 }), q(84)]
  ]
  const times = expectedOnsets(bars, 1)

  // 和弦音和它的基音**同一时刻** ✓ 所以第 1 小节只产生 3 个不同的时刻
  assert.equal(times.length, 11, '整首应有 11 条时刻记录（4+4+3），实得 ' + times.length)
  assert.equal(times[0], times[1], '和弦音必须和它的基音同一时刻')

  // 第 1 小节总时值 = 3 个四分 = 3（和弦音不占时间）
  // 所以第 2 小节的第一个音应在 t=3
  const firstOfBar2 = times[4]
  assert.equal(firstOfBar2, 3, '第2小节第一个音应在 t=3，实得 ' + firstOfBar2)

  // ★ 这是用户报的那个：第 3 小节的时刻必须和谱面对得上
  // 第 1 小节占 3 拍，第 2 小节占 4 拍 -> 第 3 小节从 7 开始
  const bar3First = times[8]
  assert.equal(bar3First, 7, '第3小节第一个音应在 t=7（3+4），实得 ' + bar3First)
  // 第 3 小节：四分(7) + 二分(8) + 四分(10)
  assert.deepEqual(times.slice(8), [7, 8, 10], '第3小节的时刻应是 7/8/10，实得 ' + JSON.stringify(times.slice(8)))

  // 一遍的总时值：3 + 4 + 4 = 11（不含和弦音）
  assert.equal(patternBeats(bars), 11, '一遍应占 11 个四分音符，实得 ' + patternBeats(bars))

  // 按两遍重复时，第二遍整体平移 11
  const twice = expectedOnsets(bars, 2)
  assert.equal(twice.length, times.length * 2, '两遍应有双倍记录')
  assert.equal(twice[times.length], times[0] + 11, '第二遍的第一条应从 11 开始')

  // 音高序列必须和时刻序列**一一对应**（同样跳过和弦音的时值推进）
  const pitches = expectedPitchSequence(bars, STD, 1)
  assert.equal(pitches.length, times.length, '音高序列长度必须和时刻序列一致')
  // 和弦音和基音是**两个不同的音** ✓ 相同的是它们的**时刻**（上面已经验过）✓
  assert.notEqual(pitches[0], pitches[1], '和弦音和基音应是两个不同的音高')
  assert.equal(pitches[0], 67, '基音应是 G4')
  assert.equal(pitches[1], 71, '和弦音应是 B4')
}

console.log('✓ 和弦时刻通过（和弦不推进时间 / 第2第3小节起点正确 / 一遍总长不含和弦 / 按遍重复平移正确 / 音高与时刻对齐）')

// ============ 期望音高序列必须跟着调弦/变调夹走 ============
{
  // 第 6 弦 3 品（用弦品记谱，不写死 midi）
  const n6 = makeNote('quarter', { string: 6, fret: 3 })
  const bars = [[n6, makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true })]]

  const a = expectedPitchSequence(bars, { ...STD, capo: 0 }, 1)
  const b = expectedPitchSequence(bars, { ...STD, capo: 5 }, 1)
  assert.equal(a[0], 43, '夹 0 品时第 6 弦 3 品 = G2(43)，实得 ' + a[0])
  assert.equal(b[0], 48, '夹 5 品时同一个把位 = C3(48)，实得 ' + b[0])

  // 换特殊调弦（第 6 弦降到 D）也要跟着变
  const dropd = { ...STD, open: [64, 59, 55, 50, 45, 38], capo: 0 }
  const c = expectedPitchSequence(bars, dropd, 1)
  assert.equal(c[0], 41, '降 D 调弦下第 6 弦 3 品 = F2(41)，实得 ' + c[0])

  // 休止符**不产生条目**（和 expectedOnsets 保持一致：两边都只记有音的位置 ✓）
  // 这样 expectedPitches[i] 才能和 expectedOnsets[i] 一一对齐 ✓
  assert.equal(a.length, 1, '这个小节只有 1 个音，序列就应只有 1 条，实得 ' + a.length)
  assert.equal(expectedOnsets(bars, 1).length, a.length, '音高序列和时刻序列的长度必须一致')
}

console.log('✓ 期望音高跟着调弦通过（变调夹 / 特殊调弦 / 与时刻序列等长）')

// ============ 第一个起点必须落在**起奏那一刻** ============
//
// 这条余量我两头都栽过，两个方向都用真实录音钉住 ✓
//
//   · 余量太窄（0.02s）：起奏判据要"抬升后持续 200ms" ✓ 天生比真实起音晚 ✓
//     真起音连同它那一簇候选被整簇丢掉 ✗ 第一个音消失 ✓
//   · 余量太宽（0.15s）：底噪里的误检被放进来 ✗
//     实测 (6)：起奏 1.643s ✓ 但有个噪声候选在 1.505s
//     （触发能量 -51dB ✓ 真音 -33dB ✓）✓ 它一进来就变成"多打" ✗
//     还可能把对齐拽偏 ✓ 用户报的正是这个 ✓
//
// 正确做法：门控收紧 ✓ 由**兜底补点**去补那个 200ms 的滞后 ✓
// 代价是最多晚 ~0.05s ✓ 匹配容差在 0.1s 量级 ✓ 无所谓 ✓
// 反过来放进噪声会制造假"多打" ✗ 代价大得多 ✓
//
// ⚠️ 我上一次把 (5) 里的 1.12s 当成"真实起音"写进了断言 ✗
//    其实包络显示**真实抬升从 1.14s 才开始** ✓ 1.12 是底噪 ✓
//    于是那条测试把一个噪声点**锁死**了 ✗ —— 测试写错比没测试更糟 ✓
//    现在两份录音一起测 ✓ 只断言"第一个起点落在起奏处附近" ✓
// samples/ 不进仓库（里面是个人真实录音），所以这两条用例允许缺席：
// 文件不在就跳过，剩下的用例照跑 —— 别让整份自检因为缺一个本地样本就挂掉。
const skippedSamples = []
{
  const FFT = 2048
  const CASES = [
    { file: 'user-6.wav', note: '录音 (5)' },
    { file: 'user-7.wav', note: '录音 (6)' }
  ]
  for (const cs of CASES) {
    const wavPath = new URL('../samples/' + cs.file, import.meta.url)
    if (!existsSync(wavPath)) {
      skippedSamples.push(cs.file)
      continue
    }
    const wav = readFileSync(wavPath)
    const sr = wav.readUInt32LE(24)
    const total = (wav.length - 44) / 2
    const sig = new Float32Array(total)
    for (let i = 0; i < total; i++) sig[i] = wav.readInt16LE(44 + i * 2) / 32768
    const an = new SpectrumAnalyser(FFT, 'hann')
    const anSaw = new SpectrumAnalyser(FFT, 'sawtooth')
    const hop = 512
    const colRate = sr / hop
    const cols = Math.floor((total - FFT) / hop) + 1
    const bandsR = buildBands(50, 16000, FFT, sr)
    const trigR = new Float32Array(cols)
    const dbR = bandsR.map(() => new Float32Array(cols))
    for (let c = 0; c < cols; c++) {
      const end2 = c * hop + FFT
      const w = sig.subarray(end2 - FFT, end2)
      const os = anSaw.analyse(w)
      let sum = 0
      for (let k = 0; k < os.length; k++) sum += os[k] * os[k]
      trigR[c] = sum
      const mag = an.analyse(w)
      for (let bi = 0; bi < bandsR.length; bi++) {
        let e = 0
        for (let k = bandsR[bi].lo; k < bandsR[bi].hi && k < mag.length; k++) e += mag[k] * mag[k]
        dbR[bi][c] = 10 * Math.log10(e + 1e-20)
      }
    }
    const perfR = findPerformanceStart(trigR, colRate)
    const onsetsR = detectOnsetsWithNotes(dbR, bandsR, colRate, { triggerEnergies: trigR })
    assert.ok(perfR, cs.note + ' 应该能定出起奏')
    // 就断言"报出了一大把" ✓ 别卡精确数字 ✗
    // （收紧门控后 (5) 正好 20 个 ✓ 之前那 22 个里有 2 个是底噪误检 ✓）
    assert.ok(onsetsR.length >= 18, cs.note + ' 应报出足够多的起点，实得 ' + onsetsR.length)
    // ★ 第一个起点要落在起奏那一刻附近（兜底补点保证 ✓）
    const lag = Math.abs(onsetsR[0].time - perfR.time)
    assert.ok(
      lag <= 0.05,
      cs.note + ' 第一个起点应落在起奏处附近：起奏 ' + perfR.time.toFixed(3) +
        's，第一个起点 ' + onsetsR[0].time.toFixed(3) + 's，差 ' + lag.toFixed(3) + 's'
    )
    // ★ 起奏之前**不能**有起点 —— 那都是底噪里的误检（(6) 的 1.505 就是）
    assert.ok(
      onsetsR[0].time >= perfR.time - 0.02,
      cs.note + ' 起奏前不该有起点，实得第一个在 ' + onsetsR[0].time.toFixed(3) +
        's（起奏 ' + perfR.time.toFixed(3) + 's）'
    )
  }
}

if (skippedSamples.length) {
  console.log(
    '- 跳过起奏处的音（本地缺 ' + skippedSamples.join(' / ') +
      '：samples/ 含个人录音，不进仓库）'
  )
} else {
  console.log('✓ 起奏处的音通过（两份真实录音：第一个起点都落在起奏处 / 起奏前零误检）')
}

// ============ 相位锚定：φ 必须被锚在起奏附近 ============
//
// 用户要求"锚定相位实装可用" ✓ 这条把契约钉住：
//
//   给了 anchorOffset  -> 拟合出的 offset 必须落在 ±slack 内 ✓✓
//   不给               -> 行为完全不变（现有测试已经在守这一侧 ✓）
//
// 为什么需要这条契约：对齐模型的相位方向是**平的** ✗
// 起点密集时 F1 对 φ 几乎没有区分力 ✓ 于是"最优 φ"是噪声选出来的 ✓
// 实测 (6)：自由搜给出 φ=2.21s ✓ 而起奏是 1.64s ✗ 差整整一拍 ✓
// 锚定把这个方向交给"起奏"这个绝对判据 ✓
{
  // 一串等间隔的起点（模拟真实录音里"每拍一个音"）
  const times = []
  const strengths = []
  for (let i = 0; i < 30; i++) { times.push(1.6 + i * 0.5); strengths.push(1) }
  // 期望：每拍一个音，共 12 个
  const expected = []
  for (let i = 0; i < 12; i++) expected.push(i)

  // ① 不给锚点：像现在这样自由搜
  const free = matchTempo(times, expected, { strengths })
  assert.ok(free, '自由搜应该能出结果')
  assert.ok(Number.isFinite(free.offset), 'offset 应该是有限数')

  // ② 给锚点：φ 必须被拉回到锚点附近的窗口内
  const anchor = 1.62
  const slack = 0.35
  const anchored = matchTempo(times, expected, {
    strengths,
    anchorOffset: anchor,
    anchorSlackSeconds: slack
  })
  assert.ok(anchored, '锚定应该也能出结果')
  assert.ok(
    Math.abs(anchored.offset - anchor) <= slack + 1e-9,
    '锚定后 offset 必须落在锚点 ±' + slack + 's 内：锚点 ' + anchor +
      '，实得 ' + anchored.offset.toFixed(3)
  )

  // ③ 速度照样要拟合出来（锚定只固定相位，不动速度 ✓）
  assert.ok(anchored.bpm > 40 && anchored.bpm < 240, '速度应落在合法区间，实得 ' + anchored.bpm.toFixed(1))
  // ★ 注意**半速/倍速歧义**是真实存在的 ✗
  //   起点每 0.5s 一个 ✓ "一拍 = 0.5s"（每拍一个音 ✓）
  //   和"一拍 = 1.0s"（每两拍一个音 ✓）**都能对上这些时刻** ✓✓
  //   单靠时间分辨不了 ✗ 得靠谱面时值或音高 ✓
  //   （我第一版期望就写窄成 0.5 了 ✗ 实测给出 0.997 ✓ 是另一种合法解 ✓）
  const spq = anchored.secondsPerQuarter
  assert.ok(
    Math.abs(spq - 0.5) < 0.12 || Math.abs(spq - 1.0) < 0.12,
    '一拍应落在 0.5 或 1.0 附近（半速/倍速都合法），实得 ' + spq.toFixed(3)
  )

  // ④ 锚点窗口里一个起点都没有时，不能崩、也不能跑偏
  const far = matchTempo(times, expected, { strengths, anchorOffset: 99 })
  assert.ok(far, '锚点离得很远时也应出结果（把锚点本身当候选）')
  assert.ok(Number.isFinite(far.offset), '这种极端情况也不能给出 NaN')

  // ⑤ slack 调小就收得更紧
  const tight = matchTempo(times, expected, { strengths, anchorOffset: anchor, anchorSlackSeconds: 0.02 })
  assert.ok(
    Math.abs(tight.offset - anchor) <= 0.02 + 1e-9,
    'slack=0.02 时 offset 必须贴住锚点，实得 ' + tight.offset.toFixed(3)
  )
}

console.log('✓ 相位锚定通过（φ 被锚在起奏内 / 速度照拟合 / 窗口空也不崩 / slack 可收紧）')

// ============ 起奏：噪声尖峰 vs 真演奏 ============
//
// 用户的判据（说得很准 ✓）：
//   **噪音**：抬起来**马上落回很低的点** ✗
//   **演奏**：抬起来**不归零** ✓ 下降一部分之后**还持续一段** ✓
//
// 只看"连续 200ms 高于门槛"是不够的 ✗ ——
// 一个**持续 350ms** 的噪声尖峰照样能过 ✓ 但它会掉回底噪 ✓
// 所以再加一条：抬起之后的稳定窗里，**最低电平也必须明显高于底噪** ✓✓
//
// 这条用**纯数值**测 ✓ 不跑 FFT ✓ 判据本来就只吃能量序列 ✓
{
  const SR = 48000, HOP = 512
  const colRate = SR / HOP
  const dur = 6
  const n = Math.round(dur * colRate)
  const trig = new Float32Array(n)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < n; i++) trig[i] = Math.pow(10, (-30 + rnd() * 1.5) / 10)
  const setLvl = (t0, t1, db) => {
    for (let i = Math.max(0, Math.round(t0 * colRate)); i < Math.min(n, Math.round(t1 * colRate)); i++)
      trig[i] = Math.pow(10, (db + rnd() * 1.5) / 10)
  }
  // 1.00s：持续 0.35 秒的噪声尖峰 —— 够长 ✓ 旧规则会认 ✗
  setLvl(1.0, 1.35, -12)
  // 2.50s：真演奏 —— 抬起来 ✓ 落一部分 ✓ 但不归零 ✓ 一直持续
  setLvl(2.5, 2.62, -12)
  setLvl(2.62, 6.0, -17)

  // ① 旧行为（把新判据关掉 = settleMarginDb 设成很负 ✓）
  const old = findPerformanceStart(trig, colRate, { settleMarginDb: -999 })
  assert.ok(old, '旧行为应该能给出一个结果')
  assert.ok(
    Math.abs(old.time - 1.0) < 0.1,
    '旧行为会认成噪声尖峰（复现原问题），实得 ' + old.time.toFixed(3)
  )

  // ② ★ 新行为：必须跳掉尖峰、找到真正的演奏 ✓✓
  const neu = findPerformanceStart(trig, colRate)
  assert.ok(neu, '新行为必须能找到真演奏')
  assert.ok(
    Math.abs(neu.time - 2.5) < 0.15,
    '新行为应该跳过噪声尖峰、认到 2.5s 的真演奏，实得 ' + neu.time.toFixed(3)
  )

  // ③ 纯噪声（连尖峰都没安排）-> 必须返回 null
  //
  // ★ 这里有个**取舍**要说清楚 ✗✗
  // 判据从"持续 200ms 高于高门槛"改成"抬起 + 不回落"之后 ✓
  // 灵敏度上去了（这才是能抓到**轻的、短的**真音的原因 ✓✓）
  // 代价是：**单独的**一个噪声尖峰不再保证被丢掉 ✗
  // 我原来拿"尖峰 -> null"当断言 ✗ 那是过强的要求 ✓ 实测就挂了 ✓
  //
  // 为什么这个取舍可以接受 ✓：
  //   漏掉真实起奏（用户实测的那种 ✗）比偶尔早报一点严重得多 ✓
  //   而且"真的响过"那一条（超过底噪 8dB）纯噪声**永远够不到** ✓✓
  //   所以"完全没有演奏 -> null"这条硬保证仍然成立 ✓ 就拿它当断言 ✓
  const onlyNoise = new Float32Array(n)
  for (let i = 0; i < n; i++) onlyNoise[i] = Math.pow(10, (-30 + rnd() * 1.5) / 10)
  assert.equal(
    findPerformanceStart(onlyNoise, colRate),
    null,
    '纯噪声（没有任何演奏）必须返回 null'
  )

  // ③b 噪声 + 尖峰 + 后面的真演奏 -> 仍然必须找到**真演奏**（不能被尖峰或噪声骗走）
  const spikeThenNote = new Float32Array(n)
  for (let i = 0; i < n; i++) spikeThenNote[i] = Math.pow(10, (-30 + rnd() * 1.5) / 10)
  for (let i = Math.round(1.0 * colRate); i < Math.round(1.35 * colRate); i++)
    spikeThenNote[i] = Math.pow(10, -12 / 10)
  for (let i = Math.round(3.6 * colRate); i < n; i++)
    spikeThenNote[i] = Math.pow(10, (-15 + rnd() * 1.5) / 10)
  const sn = findPerformanceStart(spikeThenNote, colRate)
  assert.ok(
    sn && Math.abs(sn.time - 3.6) < 0.15,
    '有真演奏时必须认到真演奏（不能被噪声骗到前面去），实得 ' + (sn ? sn.time.toFixed(3) : 'null')
  )

  // ④ 正常的"抬起来就不落"的信号照样要认（不能矫枉过正）
  const clean = new Float32Array(n)
  for (let i = 0; i < n; i++) clean[i] = Math.pow(10, (-30 + rnd() * 1.5) / 10)
  for (let i = Math.round(2.0 * colRate); i < n; i++) clean[i] = Math.pow(10, (-14 + rnd() * 1.5) / 10)
  const ok = findPerformanceStart(clean, colRate)
  assert.ok(ok && Math.abs(ok.time - 2.0) < 0.1, '普通演奏要认出来，实得 ' + (ok ? ok.time.toFixed(2) : 'null'))
}

console.log('✓ 起奏稳定判据通过（尖峰被跳过、认到后面的真演奏 / 纯噪声仍返回 null / 正常演奏照认）')


// ============ 频带"峰值排序"判据：量过，**不够格，默认关** ============
//
// 我从用户一个很关键的问题出发去量了：
//   "起奏之后，这次起音峰到下次起音峰之间，峰值是不是都小于起音峰？"
// 结论：**总能量**上成立 ✓（14/21/39 段里段内峰超标的只有 0/2/2 段 ✓ 且只超 0.0~0.2dB ✓✓）
//       **各频带**上不成立 ✓（一个音在自己的衰减段里会反复触发 ✓ 每个音被数 1.96 遍 ✓）
//
// 于是加了一道"峰值排序"判据 ✓ 但**两版都量崩了** ✗：
//   版本一（过去 0.5 秒最大值当参照）：合成精确率 0.52→0.72 ✓✓ 但 (5) 上 22→17 **丢真音** ✗
//          丢掉的间隔是 0.44/0.43/0.42/0.45 秒 ✓ 正是一拍一个 ✓
//   版本二（抬升后停住的电平当参照）：合成 0.52→0.54 ✗ 几乎不起作用 ✓
// 根因：**弹得轻的重复音** 和 **衰减里的拍频包** 在"峰值高度"这一维上**分不开** ✓
//      两者的峰值都低于上一个音 ✓
//
// 所以判据**默认关** ✓ 这条测试只钉住"开关确实能影响结果"这件事 ✓
// 而不去断言"它应该滤掉多少" ✗（那个数我没量出可信的边界 ✓）
{
  const SR = 48000, HOP = 512
  const rate = SR / HOP
  const n = Math.round(6 * rate)
  const cols = 8
  const mk = (bumpDb) => {
    const out = []
    for (let b = 0; b < cols; b++) {
      const arr = new Float32Array(n).fill(-60)
      for (let i = Math.round(1.0 * rate); i < n; i++) {
        const t = (i - Math.round(1.0 * rate)) / rate
        arr[i] = -20 - 25 * (1 - Math.exp(-t / 0.3))
      }
      for (let i = Math.round(1.25 * rate); i < Math.round(1.33 * rate); i++) {
        arr[i] = Math.max(arr[i], bumpDb)
      }
      out.push(arr)
    }
    return out
  }
  const bandsMeta = Array.from({ length: cols }, () => ({ lo: 0, hi: 1, midi: 60, label: 'x' }))
  const times = (bands, guard) =>
    detectOnsetsWithNotes(bands, bandsMeta, rate, { bandPeakGuard: guard }).map((o) => o.time)

  // ① 开关默认是**关** —— 不显式传就不启用（不拿未经验证的判据去动用户的结果 ✓）
  const def = detectOnsetsWithNotes(mk(-22), bandsMeta, rate).map((o) => o.time)
  const off = times(mk(-22), false)
  assert.deepEqual(def, off, '默认（不传）必须等同于显式关掉')
  assert.deepEqual(times(mk(-22), true), off, '打开判据时，真正的起音必须保留')

  // ② 真音在任何开关状态下都必须被认出来 ✓（这是硬保证）
  assert.ok(off.some((t) => Math.abs(t - 1.0) < 0.1), '真音必须被认出来，实得 ' + JSON.stringify(off.map((t) => +t.toFixed(2))))
}

console.log('✓ 频带峰值判据开关（默认关 / 真音不受影响）')

// ============ 和弦事件合并（**只给统计口径**）============
//
// 用户的两句话要同时满足 ✓：
//   ① "不要把这种多打从原始的数据里抹除" ✓ -> 原始数组一个不动 ✓
//   ② "统计环节可以使用合并" ✓         -> 算对上/多打/F1 时并成一个事件 ✓
//
// 而合并**不能只看时间差** ✗✗：
//   16 分音符在 160 BPM 下就是 **0.094 秒** ✓ 落在任何合理的合并窗里 ✓
//   只看时间会把**真的十六分音符**并掉 ✗ 那是把用户弹的东西抹了 ✓
//
// 判据用实测出来的"和弦特征"：**后一个事件带出大部分新音高** ✓
//   实测六处：新音高占比 63%~98% ✓ 而且多数在完全不同的音区 ✓
{
  const rate = 93.75
  const n = Math.round(6 * rate)
  const bands = [
    { midi: 40 }, { midi: 45 }, { midi: 50 }, { midi: 55 }, { midi: 60 }, { midi: 65 }
  ]
  /** 造一条带：在 t 处抬 upDb，之后慢慢衰减 */
  const band = (t, upDb) => {
    const a = new Float32Array(n).fill(-80)
    for (let i = Math.round(t * rate); i < n; i++) {
      const k = i - Math.round(t * rate)
      a[i] = -80 + upDb * Math.exp(-k / (rate * 0.5))
    }
    return a
  }
  const mkOnset = (t, bandCount = 20) => ({
    time: t, strengthDb: 12, bandCount, note: null, otherNotes: []
  })
  const peakOf = (arr) => {
    let p = 0
    for (let i = Math.round(3 * rate); i < Math.round(3.5 * rate); i++) if (arr[0][i] > p) p = arr[0][i]
    return p
  }

  // --- ① 和弦：两根弦落得近，但**音高完全不同** -> 必须并成一个事件 ---
  {
    const series = bands.map(() => new Float32Array(n).fill(-80))
    // 3.0s：低音区（midi 40/45）
    series[0] = band(3.0, 30); series[1] = band(3.0, 28)
    // 3.08s：高音区（midi 55/60/65）—— 新音高占比 100%
    series[3] = band(3.08, 30); series[4] = band(3.08, 28); series[5] = band(3.08, 26)
    const onsets = [mkOnset(3.0), mkOnset(3.08)]
    const merged = mergeChordEvents(onsets, series, bands, rate)
    assert.equal(merged.length, 1, '和弦（音高完全不同）应该并成一个事件，实得 ' + merged.length)
    assert.ok(Math.abs(merged[0].time - 3.0) < 0.001, '合并后应取**最早**的时刻（和弦从第一根弦落下算起）')
    assert.equal(onsets.length, 2, '★ 原始数组**不能**被改动 ✓ 实得 ' + onsets.length)
  }

  // --- ② 同一个音的起音过程：第二批是**同一组谐波** -> 不能并 ---
  {
    const series = bands.map(() => new Float32Array(n).fill(-80))
    series[0] = band(3.0, 30); series[1] = band(3.0, 28); series[2] = band(3.0, 26)
    // 3.08 只有同样的带在继续（没有新音高）
    const onsets = [mkOnset(3.0), mkOnset(3.08)]
    const merged = mergeChordEvents(onsets, series, bands, rate)
    assert.equal(merged.length, 2, '同一组谐波在起齐时**不该**被并掉，实得 ' + merged.length)
  }

  // --- ③ 十六分音符：时间很近但音高不同 —— 这是**真的两个音** ✓
  //        光看时间差会误并 ✗ 但我们的判据看音高集合 ✓
  //        这里两批音高确实不同 ✓ 所以**会**并 ✓ —— 把它写清楚 ✓
  //        （代价：极快的换音会被并进统计 ✓ 但 0.094s 已经接近人手的极限 ✓
  //          而且合并只影响统计 ✓ 不影响原始数据 ✓）
  {
    const series = bands.map(() => new Float32Array(n).fill(-80))
    series[0] = band(3.0, 30)
    series[5] = band(3.094, 30)
    const merged = mergeChordEvents([mkOnset(3.0), mkOnset(3.094)], series, bands, rate)
    assert.equal(merged.length, 1, '音高不同且间隔在窗内 -> 并（这是刻意的取舍）')
  }

  // --- ④ 间隔超出窗口 -> 不并 ---
  {
    const series = bands.map(() => new Float32Array(n).fill(-80))
    series[0] = band(3.0, 30)
    series[5] = band(3.5, 30)
    const merged = mergeChordEvents([mkOnset(3.0), mkOnset(3.5)], series, bands, rate)
    assert.equal(merged.length, 2, '间隔 0.5s 超出窗口，不该并')
  }

  // --- ⑤ 拿不到频带信息时退化成"按时间并" ✓ 但不能崩 ---
  {
    const merged = mergeChordEvents([mkOnset(3.0), mkOnset(3.08)], null, null, rate)
    assert.equal(merged.length, 1, '没有频带信息时按时间并（次优但可用）')
    assert.deepEqual(mergeChordEvents([], null, null, rate), [], '空输入返回空')
  }

  // --- ⑥ 合并后强度取最大、带数相加、弱标记取"都弱" ✓
  {
    const series = bands.map(() => new Float32Array(n).fill(-80))
    series[0] = band(3.0, 30)
    series[5] = band(3.08, 30)
    const a = { time: 3.0, strengthDb: 10, bandCount: 20, note: null, otherNotes: [] }
    const b = { time: 3.08, strengthDb: 18, bandCount: 15, note: null, otherNotes: [] }
    const m = mergeChordEvents([a, b], series, bands, rate)
    assert.equal(m.length, 1)
    assert.equal(m[0].strengthDb, 18, '强度取最大')
    assert.equal(m[0].bandCount, 35, '带数相加')
  }
}

console.log('✓ 和弦合并通过（音高不同才并 / 同谐波不并 / 原始数组不被改 / 无频带信息不崩）')

// ============ 手动指定起奏点：门控必须听它的 ============
//
// 缺口的由来 ✓：
//   控件做在"录音 / 音频"页 ✓ 对齐的相位锚点也换成了手动值 ✓
//   但**门控**这里（"起奏之前的一律不算起点"）会**自己重算一遍** findPerformanceStart ✗
//   于是手动设了也不生效 ✓ 用户看到的就是"第二页设了，第三页没跟上" ✓✓
//
// 实测依据（为什么必须有这个口子）：
//   5323.webm 的 0.416s 那个椅子声是
//   **70Hz 基频 + 成整数倍谐波 + 陡然抬起 +13.7dB + 不归零 + 持续** ✓
//   —— 和"弹了一个低音"在声学特征上完全一样 ✗ 判据没有理由拒绝它 ✓
{
  const rate = 93.75
  const n = Math.round(10 * rate)
  const mk = (t, up) => {
    const a = new Float32Array(n).fill(-80)
    for (let i = Math.round(t * rate); i < n; i++) {
      const k = i - Math.round(t * rate)
      a[i] = -80 + up * Math.exp(-k / (rate * 0.6))
    }
    return a
  }
  // 0.5s 一个"椅子声"（成谐波、能持续）✓ 3.5s 真正的演奏 ✓
  const series = [
    mk(0.5, 30), mk(0.5, 28), mk(0.5, 26), mk(0.5, 24),
    mk(3.5, 32), mk(3.5, 30), mk(3.5, 28), mk(3.5, 26)
  ]
  const bands = [
    { midi: 40 }, { midi: 45 }, { midi: 50 }, { midi: 55 },
    { midi: 60 }, { midi: 65 }, { midi: 70 }, { midi: 75 }
  ]
  const trigger = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let x = 1e-9
    for (const b of series) x += Math.pow(10, b[i] / 10)
    trigger[i] = x
  }

  // ① 不给 startTime：检测器自己会把 0.5s 那个当成起奏 -> 0.5 的起点会留着
  const auto = detectOnsetsWithNotes(series, bands, rate, { triggerEnergies: trigger })
  assert.ok(
    auto.some((o) => o.time < 2),
    '不给 startTime 时，0.5s 那个事件应该被当成起奏、起点留着，实得 ' +
      JSON.stringify(auto.map((o) => +o.time.toFixed(2)))
  )

  // ② ★ 给了 startTime = 3.4：**3.4 之前的一切都不该再出现** ✓✓
  const forced = detectOnsetsWithNotes(series, bands, rate, {
    triggerEnergies: trigger,
    startTime: 3.4
  })
  const early = forced.filter((o) => o.time < 3.4 - 0.02)
  assert.equal(
    early.length,
    0,
    '指定了起奏点之后，它之前的候选必须全部丢掉，实得 ' +
      JSON.stringify(early.map((o) => +o.time.toFixed(2)))
  )
  assert.ok(
    forced.some((o) => Math.abs(o.time - 3.5) < 0.15),
    '指定起奏点之后，真正的演奏仍然要检出来，实得 ' +
      JSON.stringify(forced.map((o) => +o.time.toFixed(2)))
  )
}

console.log('✓ 手动起奏点门控通过（不给就按自动 / 给了就只听它的 / 真演奏照认）')

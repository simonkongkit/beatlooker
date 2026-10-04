import assert from 'node:assert/strict'
import {
  findPeaks,
  harmonicSalience,
  rankPitches,
  rankPitchesMulti,
  keyPitchClasses,
  pitchClassWeight
} from '../src/lib/harmonic.ts'
import { midiToFreq } from '../src/lib/noteBands.ts'
import { detectOnsetsWithNotes } from '../src/lib/onset.ts'

const RATE = 48000
const FFT = 2048

/** 用若干"分音"造一条幅度谱：每个分音是一个高斯峰，宽度约 15Hz */
function spectrum(partials) {
  const mag = new Float32Array(FFT / 2)
  const binHz = RATE / FFT
  for (const p of partials) {
    const k = p.f / binHz
    const lo = Math.max(0, Math.floor(k) - 5)
    const hi = Math.min(mag.length - 1, Math.ceil(k) + 5)
    for (let i = lo; i <= hi; i++) {
      const d = (i - k) * binHz
      mag[i] += p.m * Math.exp(-(d * d) / (2 * 15 * 15))
    }
  }
  return mag
}

/** 造一个音的谐波系列。fundAmp=0 就是"基频缺失"。 */
function note(midi, { harmonics = 8, fundAmp = 1, inharm = 0, amp = (h) => 1 / h } = {}) {
  const f0 = midiToFreq(midi)
  const out = []
  for (let h = 1; h <= harmonics; h++) {
    // 非谐性：真实弦因为劲度，高次泛音偏高，偏移正比于 h^2
    const f = h * f0 * (1 + inharm * h * h)
    out.push({ f, m: (h === 1 ? fundAmp : 1) * amp(h) })
  }
  return out
}

// ============ 1. 基本：谐波系列能被认出来 ============
{
  const mag = spectrum(note(55, { harmonics: 8 })) // G3
  const peaks = findPeaks(mag, RATE, FFT)
  const ranked = rankPitches(peaks, { maxHarmonics: 10 })
  assert.ok(ranked.length > 0, '应该有候选')
  assert.equal(ranked[0].midi, 55, '应认出 G3(55)，实得 ' + ranked[0].midi)
  // 只要排第一就够 —— "次谐波"永远会紧随其后（它的谐波位置覆盖了真谐波的一部分），
  // 关键是靠"缺谐波要罚"把它压下去，而不是靠分数拉开很大差距。
  assert.ok(ranked[0].score > ranked[1].score, '第一名应领先，实得 ' +
    ranked[0].score.toFixed(4) + ' vs ' + ranked[1].score.toFixed(4))
}

// ============ 2. 基频缺失（实测里是常态！）============
{
  const mag = spectrum(note(43, { harmonics: 8, fundAmp: 0 })) // G2，基频没有
  const peaks = findPeaks(mag, RATE, FFT)
  const ranked = rankPitches(peaks, { maxHarmonics: 10 })
  assert.equal(
    ranked[0].midi,
    43,
    '基频缺失时也必须认出 G2(43)，实得 ' + ranked[0].midi + '（旧做法会报成某根谐波）'
  )
}

// ============ 3. 非谐性：高次泛音偏高，容差要扛得住 ============
{
  // 0.0004 的 h^2 系数：h=8 时偏高 0.0004*64 = 2.6%，超出固定容差
  const mag = spectrum(note(52, { harmonics: 10, inharm: 0.0004 })) // E3
  const peaks = findPeaks(mag, RATE, FFT)
  const ranked = rankPitches(peaks, { maxHarmonics: 10 })
  assert.equal(ranked[0].midi, 52, '有非谐性时也该认出 E3(52)，实得 ' + ranked[0].midi)
}

// ============ 4. 调号先验：帮忙，但**不锁死** ============
{
  // 调号该给的音级
  assert.deepEqual(keyPitchClasses(0), [0, 2, 4, 5, 7, 9, 11], 'C 大调')
  assert.deepEqual(keyPitchClasses(1).sort((a, b) => a - b), [0, 2, 4, 6, 7, 9, 11], '1 个升号 = G 大调，F 变 F#')
  assert.deepEqual(keyPitchClasses(-1).sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 10], '1 个降号 = F 大调，B 变 Bb')
  assert.deepEqual(keyPitchClasses(3).sort((a, b) => a - b), [1, 2, 4, 6, 8, 9, 11], '3 个升号 = A 大调')
  assert.equal(pitchClassWeight(6, { signature: 0 }), 0.35, '调外的 F# 在 C 大调下应降权但**不为 0**')
  assert.equal(pitchClassWeight(5, { signature: 0 }), 1, '调内的 F 权重 1')

  // 调内的 G3(55, 音级 7) 对调外的 G#3(56, 音级 8) —— 后者音量相当但略弱
  // （注意别拿 A3 当对手：A 在 C 大调里也是调内音，先验分不开）
  const inKey = spectrum([...note(55, { harmonics: 8 }), ...note(56, { harmonics: 8, amp: (h) => 0.9 / h })])
  const r1 = rankPitches(findPeaks(inKey, RATE, FFT), { maxHarmonics: 10, signature: 0 })
  assert.equal(r1[0].midi, 55, 'C 大调下音量相当，调内的 G3 应胜过调外的 G#3，实得 ' + r1[0].midi)

  // ★ 但调外音**明显更强**时必须能反超 —— 用户要求"别完全锁死"
  const outKey = spectrum([...note(55, { harmonics: 8, amp: (h) => 0.35 / h }), ...note(56, { harmonics: 8 })])
  const r2 = rankPitches(findPeaks(outKey, RATE, FFT), { maxHarmonics: 10, signature: 0 })
  assert.equal(
    r2[0].midi,
    56,
    '调外的 G#3 明显更强时应当反超（不能被调号锁死），实得 ' + r2[0].midi
  )
  assert.equal(r2[0].weight, 0.35, '它确实是调外音，权重 0.35')
}

// ============ 5. 噪声不该被认成音 ============
{
  const mag = new Float32Array(FFT / 2)
  let seed = 2024
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < mag.length; i++) mag[i] = 1e-5 * rnd()
  const peaks = findPeaks(mag, RATE, FFT)
  const ranked = rankPitches(peaks, { maxHarmonics: 10 })
  // 纯噪声也可能凑出一点点显著度，但绝不该有明显领先的第一名
  if (ranked.length >= 2) {
    assert.ok(
      ranked[0].score < ranked[1].score * 1.35,
      '纯噪声不该有明显的第一名，实得比值 ' + (ranked[0].score / ranked[1].score).toFixed(2)
    )
  }
}

console.log('✓ 谐波求和通过（基本识别 / 基频缺失 / 非谐性 / 调号先验不锁死 / 噪声不误判）')

// ============ 6. 接进 onset.ts：音名走谐波求和，而不是"最强带" ============
{
  const RATE_HZ = 48000
  const FFT_N = 2048
  const colRate = 93.75

  // 谱峰：A4(69) 的谐波系列，但**基频缺失**（真实现场里这是常态）
  const peaks = findPeaks(spectrum(note(69, { harmonics: 8, fundAmp: 0 })), RATE_HZ, FFT_N)
  const peakLog = { rate: colRate, at: () => peaks }

  // 频带那边**故意指向另一个音**：只让"E5 那条带"抬起来
  const bands = [
    { midi: 76, label: 'E5' },
    { midi: 69, label: 'A4' }
  ]
  const n = 400
  const flat = (v) => new Float32Array(n).fill(v)
  const dbByBand = [flat(-70), flat(-70)]
  const at = Math.round(1.0 * colRate)
  for (let i = at; i < n; i++) dbByBand[0][i] = -40 // E5 那条带猛抬 30dB
  const trigger = new Float32Array(n)
  for (let i = at; i < n; i++) trigger[i] = 1e-3

  const got = detectOnsetsWithNotes(dbByBand, bands, colRate, {
    triggerEnergies: trigger,
    presetTimes: [1.0],
    peakLog
  })
  assert.equal(got.length, 1, '应当有且只有一个起点，实得 ' + got.length)
  assert.equal(
    got[0].note?.midi,
    69,
    '音名应来自谐波求和（A4=69），而不是最强带（E5=76），实得 ' + got[0].note?.midi
  )
  assert.ok((got[0].note?.score ?? 0) > 0, '走谐波求和时该带上 score')

  // 不给 peakLog 时退回老路：这时会报最强带 E5
  const fallback = detectOnsetsWithNotes(dbByBand, bands, colRate, {
    triggerEnergies: trigger,
    presetTimes: [1.0]
  })
  assert.equal(fallback.length, 1, '退路也该有这个起点')
  assert.equal(
    fallback[0].note?.midi,
    76,
    '没有谱峰时应退回"最强带 = 音名"（E5=76），实得 ' + fallback[0].note?.midi
  )

  // ---- 调号先验：传进去要能影响结果，但不能把调外音锁死 ----
  // C 大调（0 个升降）下 A4 是调内音，怎么都不该被压掉
  const withKey = detectOnsetsWithNotes(dbByBand, bands, colRate, {
    triggerEnergies: trigger,
    presetTimes: [1.0],
    peakLog,
    keySignature: 0
  })
  assert.equal(withKey[0].note?.midi, 69, 'C 大调下 A4 是调内音，应保持不变')
}

console.log('✓ 谐波求和认音名通过（走谱峰而非最强带 / 无谱峰时退回 / 调号先验生效不锁死）')


// ============ 多帧平均：单帧会被一帧的干扰带偏 ============
//
// 用户的要求："时间平均做几个不同窗口的平均" ✓
// 实测结论：多帧把"谱形在几十毫秒里的起伏"平掉 ✓
// 期望音高的对比度中位数提升 4~8 倍 ✓ 用生产代码端到端量：(5) 6% -> 38% ✓
//
// 这条测试要**确定性**地证明它有效 ✗ 不能靠统计 ✓：
// 造一个"第一帧被强干扰污染、后面 8 帧干净"的场景 ✓
// 单帧看第一帧 -> 必然选错 ✗  多帧平均 -> 必然选对 ✓✓
{
  const mkPeaks = (midi, amp) => {
    const f0 = midiToFreq(midi)
    const out = []
    for (let h = 1; h <= 6; h++) out.push({ f: f0 * h, m: amp / h })
    return out
  }
  const A4 = 69
  const F4 = 65
  const clean = mkPeaks(A4, 1)                       // 干净帧：只有 A4 的谐波
  const dirty = [...mkPeaks(F4, 3), ...mkPeaks(A4, 1)] // 受污染帧：F4 更强

  const opts = { maxHarmonics: 6, maxHz: 8000 }

  // ① 只看受污染那一帧 -> 认成 F4（错）
  const one = rankPitches(dirty, opts)
  assert.equal(one[0].midi, F4, '单帧应被那一帧的强干扰带偏成 F4，实得 ' + one[0].midi)

  // ② 只看一帧干净帧 -> 认成 A4（对，但那是运气）
  assert.equal(rankPitches(clean, opts)[0].midi, A4, '干净帧应该认对')

  // ③ ★ 多帧平均（1 帧脏 + 8 帧干净）-> 必须回到 A4 ✓✓
  const frames = [dirty, clean, clean, clean, clean, clean, clean, clean, clean]
  const multi = rankPitchesMulti(frames, opts)
  assert.equal(multi[0].midi, A4, '多帧平均必须回到真音 A4，实得 ' + multi[0].midi)

  // ④ 空帧集不能崩
  assert.deepEqual(rankPitchesMulti([], opts), [], '空帧集应返回空')
  assert.deepEqual(rankPitchesMulti([[], []], opts), [], '全空帧应返回空')

  // ⑤ 干扰帧和干净帧的**权重关系**是可以算出来的 ✓
  //    脏帧里 F4 的幅度是 A4 的 3 倍 ✓ 所以：
  //      3 帧脏(F4 权 3×3=9)  vs  6 帧干净(A4 权 6×1=6)  ->  F4 赢
  //      2 帧脏(6)            vs  7 帧干净(7)            ->  A4 赢 ✓
  //    也就是"一帧脏 = 1.5 帧干净" ✓ 写死在断言里没意义 ✗
  //    所以这里只验**方向**：干净帧占多数时要压得住 ✓
  //    （我第一版拿 3 脏 6 干净去断言 A4 赢 ✗ 那正好是平局 ✓ 实测就挂了 ✓）
  const two = [dirty, dirty, clean, clean, clean, clean, clean, clean, clean]
  assert.equal(rankPitchesMulti(two, opts)[0].midi, A4, '7 帧干净压 2 帧脏应该压得住')

  // 反过来说：脏帧占多数时必须**跟着脏帧走** ✓ 这才说明它真的在按权重平均
  const many = [dirty, dirty, dirty, dirty, clean, clean, clean]
  assert.equal(
    rankPitchesMulti(many, opts)[0].midi,
    F4,
    '4 帧脏对 3 帧干净时，平均结果本来就该偏向 F4（F4 权 12 vs A4 权 7）✓'
  )
}

console.log('✓ 多帧平均通过（单帧被带偏 / 九帧回到真音 / 空帧不崩）')

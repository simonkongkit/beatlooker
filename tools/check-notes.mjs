/**
 * 音高与频带的自检：node tools/check-notes.mjs
 *
 * 重点验两件事：
 *   1. 十二平均律的换算必须精确（440Hz 是基准，错一点都不行）
 *   2. **分辨率限制必须被如实反映** —— 高频能一个半音一条带，低频必须合并，
 *      而且合并后的带要能正确接住那个音的能量
 */
import assert from 'node:assert/strict'
import {
  A4_HZ,
  INSTRUMENTS,
  buildBands,
  bandEnergies,
  dominantBand,
  findInstrument,
  freqToMidi,
  midiName,
  midiSolfege,
  midiToFreq
} from '../src/lib/noteBands.ts'

const RATE = 48000
const FFT = 2048
const BIN_HZ = RATE / FFT // 23.4375

// ------------------------------------------------------- 1. 十二平均律换算
{
  assert.equal(A4_HZ, 440, '标准音必须是 440Hz')
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9, 'A4 = MIDI 69 = 440Hz')

  // 几个必须背下来的频率
  const known = [
    [21, 27.5, 'A0'],
    [28, 41.203, 'E1'],
    [40, 82.407, 'E2'],
    [48, 130.813, 'C3'],
    [57, 220, 'A3'],
    [60, 261.626, 'C4（中央C）'],
    [69, 440, 'A4'],
    [81, 880, 'A5'],
    [108, 4186.009, 'C8']
  ]
  for (const [midi, hz, label] of known) {
    assert.ok(
      Math.abs(midiToFreq(midi) - hz) < 0.01,
      `${label} 应为 ${hz}Hz，实得 ${midiToFreq(midi).toFixed(3)}`
    )
  }

  // 往返
  for (const m of [21, 40, 60, 69, 88, 108]) {
    assert.ok(Math.abs(freqToMidi(midiToFreq(m)) - m) < 1e-9, 'MIDI 往返')
  }

  // 八度就是频率翻倍
  assert.ok(Math.abs(midiToFreq(69 + 12) / midiToFreq(69) - 2) < 1e-9, '八度 = 2 倍频')
  // 半音就是 2^(1/12)
  assert.ok(
    Math.abs(midiToFreq(70) / midiToFreq(69) - Math.pow(2, 1 / 12)) < 1e-9,
    '半音 = 2^(1/12)'
  )
}

// ------------------------------------------------------------- 2. 音名 / 唱名
{
  assert.equal(midiName(69), 'A4')
  assert.equal(midiName(60), 'C4')
  assert.equal(midiName(21), 'A0')
  assert.equal(midiName(61), 'C#4')
  assert.equal(midiName(108), 'C8')
  assert.equal(midiName(0), 'C-1')

  assert.equal(midiSolfege(60), '1', '中央C 唱名是 1')
  assert.equal(midiSolfege(62), '2')
  assert.equal(midiSolfege(67), '5')
  assert.equal(midiSolfege(72), '1↑', '高八度要有记号')
  assert.equal(midiSolfege(48), '1↓', '低八度要有记号')
}

// ------------------------------------------------------------------ 3. 乐器表
{
  const ids = INSTRUMENTS.map((i) => i.id)
  assert.equal(new Set(ids).size, ids.length, '乐器 id 不能重复')
  for (const ins of INSTRUMENTS) {
    assert.ok(ins.minMidi < ins.maxMidi, ins.name + ' 的音域上下限反了')
    assert.ok(ins.minMidi >= 12 && ins.maxMidi <= 120, ins.name + ' 的音域超出合理范围')
  }
  // 钢琴必须覆盖标准 88 键
  const piano = findInstrument('piano')
  assert.equal(piano.minMidi, 21, '钢琴最低 A0')
  assert.equal(piano.maxMidi, 108, '钢琴最高 C8')
  assert.equal(findInstrument('不存在的').id, 'all', '找不到就退化成不限定')
}

// --------------------------------------------------- 4. 频带：分辨率限制必须如实
{
  const bands = buildBands(50, 16000, FFT, RATE)
  assert.ok(bands.length > 20, '应该切出足够多的带，实得 ' + bands.length)

  // bin 区间必须递增且不重叠 —— 否则一个 bin 会算进两条带，能量重复计数
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i].lo >= bands[i - 1].hi, `第 ${i} 条带和上一条重叠了`)
    assert.ok(bands[i].hi > bands[i].lo, '空带')
  }

  // 高频区（A5 = 880Hz 附近）必须是一条带就是一个音
  const a5 = bands.find((b) => b.label === 'A5')
  assert.ok(a5, '必须存在标签为 A5 的带')
  assert.equal(a5.merged, false, 'A5 在 880Hz，分辨率完全够，不该被合并')
  assert.equal(a5.minMidi, a5.maxMidi)

  // 低频区必须出现合并带，而且标签写成范围
  const merged = bands.filter((b) => b.merged)
  assert.ok(merged.length > 0, '低频区必须出现合并带（一个 bin 比一个半音还宽）')
  for (const b of merged) {
    assert.ok(b.maxMidi > b.minMidi, '合并带的音域必须是跨音的')
    assert.ok(b.label.includes('–'), '合并带的标签要写成范围，实得 ' + b.label)
  }

  // 交叉验证「分不开」这个结论：E2 的半音间隔确实小于一个 bin
  const e2 = midiToFreq(40)
  const semitoneAtE2 = midiToFreq(41) - e2
  assert.ok(semitoneAtE2 < BIN_HZ, `E2 的半音间隔 ${semitoneAtE2.toFixed(1)}Hz 应该小于 bin 宽 ${BIN_HZ}`)
  // 而 A5 的半音间隔远大于一个 bin
  const a5f = midiToFreq(81)
  assert.ok(midiToFreq(82) - a5f > BIN_HZ, 'A5 的半音间隔必须大于一个 bin')

  // FFT 越大，能分辨的音越多（合并带变少）
  const finer = buildBands(50, 16000, 8192, RATE)
  assert.ok(
    finer.filter((b) => b.merged).length < merged.length,
    'FFT 加大之后合并带必须变少'
  )

  // 音域限定要生效
  const limited = buildBands(midiToFreq(60), midiToFreq(72), FFT, RATE)
  assert.ok(limited.length > 0 && limited.length < bands.length, '限定音域后带数要变少')
  assert.ok(limited.every((b) => b.midi >= 59 && b.midi <= 73), '限定后不该出现音域外的带')
}

// --------------------------------------------------- 5. 带能量：能量要落对地方
{
  const bands = buildBands(50, 16000, FFT, RATE)
  const half = FFT / 2

  /** 造一列只有某个频率有能量的幅度谱 */
  function spectrumAt(freq) {
    const mags = new Float32Array(half)
    const bin = Math.round(freq / BIN_HZ)
    mags[bin] = 1
    return mags
  }

  const out = new Float32Array(bands.length)

  // A5 = 880Hz：分辨率够，必须精确落到 A5 这条带上
  bandEnergies(spectrumAt(880), bands, out)
  const iA5 = bands.findIndex((b) => b.label === 'A5')
  assert.equal(dominantBand(out, bands), iA5, '880Hz 必须落在 A5 带上')

  // C6 = 1046.5Hz
  bandEnergies(spectrumAt(1046.5), bands, out)
  assert.equal(bands[dominantBand(out, bands)].label, 'C6', '1046.5Hz 必须落在 C6 带上')

  // 低频：E2 = 82.4Hz 分不开，但能量必须被**某条覆盖它的带**接住
  bandEnergies(spectrumAt(82.407), bands, out)
  const iLow = dominantBand(out, bands)
  assert.ok(iLow >= 0, '低频也要有条带接住')
  const low = bands[iLow]
  assert.ok(
    low.minMidi <= 40 && low.maxMidi >= 40,
    `82.4Hz(E2) 应该落进覆盖 E2 的带，实得 ${low.label}`
  )

  // 带内求和：两个 bin 都有能量时应该叠加
  const two = new Float32Array(half)
  const b0 = Math.round(880 / BIN_HZ)
  two[b0] = 1
  bandEnergies(two, bands, out)
  const one = out[iA5]
  two[b0 + 1] = 1
  bandEnergies(two, bands, out)
  assert.ok(out[iA5] > one, '带内多一个 bin 有能量，总能量必须变大')

  // 全零谱：不该选出任何带
  bandEnergies(new Float32Array(half), bands, out)
  assert.equal(dominantBand(out, bands), -1, '没有能量时不该硬选一条带')
}

console.log('✓ 音高与频带全部通过（十二平均律 / 音名唱名 / 乐器音域 / 分辨率合并 / 带能量落点）')

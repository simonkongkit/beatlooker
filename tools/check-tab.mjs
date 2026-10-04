import assert from 'node:assert/strict'
import {
  STANDARD,
  TUNING_PRESETS,
  stringFretToMidi,
  midiToFret,
  validateTuning,
  MAX_FRET
} from '../src/lib/notation/tab.ts'
import { midiName } from '../src/lib/noteBands.ts'

// render.ts 画符头用 Path2D，node 里没有
globalThis.Path2D = class {
  constructor(d) { this.d = d }
}
const { renderRhythm } = await import('../src/lib/notation/render.ts')
const { makeNote } = await import('../src/lib/notation/rhythm.ts')

// ============ 1. 标准调弦的空弦音 ============
{
  const expect = [
    [1, 64, 'E4'],
    [2, 59, 'B3'],
    [3, 55, 'G3'],
    [4, 50, 'D3'],
    [5, 45, 'A2'],
    [6, 40, 'E2']
  ]
  for (const [s, midi, name] of expect) {
    assert.equal(stringFretToMidi(STANDARD, s, 0), midi, '第 ' + s + ' 弦空弦应是 ' + name)
    assert.equal(midiName(midi), name, '音名应是 ' + name)
  }
}

// ============ 2. 品位 = 半音 ============
{
  // 第 6 弦第 3 品 = G2
  assert.equal(stringFretToMidi(STANDARD, 6, 3), 43, '第 6 弦 3 品 = G2')
  assert.equal(midiName(stringFretToMidi(STANDARD, 6, 3)), 'G2')
  // 第 1 弦第 12 品 = 高八度 E5
  assert.equal(stringFretToMidi(STANDARD, 1, 12), 76, '第 1 弦 12 品 = E5')
  // 越界的品要夹住
  assert.equal(stringFretToMidi(STANDARD, 1, 999), stringFretToMidi(STANDARD, 1, MAX_FRET), '品数要夹到上限')
  assert.equal(stringFretToMidi(STANDARD, 1, -5), stringFretToMidi(STANDARD, 1, 0), '负数品要夹到 0')
}

// ============ 3. 变调夹：所有弦一起升高 ============
{
  const capo2 = { ...STANDARD, capo: 2 }
  for (let s = 1; s <= 6; s++) {
    assert.equal(
      stringFretToMidi(capo2, s, 0),
      stringFretToMidi(STANDARD, s, 0) + 2,
      '夹 2 品后第 ' + s + ' 弦空弦应升 2 个半音'
    )
  }
  // 夹了 2 品之后，第 6 弦"第 0 品"其实等于原来的第 2 品
  assert.equal(stringFretToMidi(capo2, 6, 0), stringFretToMidi(STANDARD, 6, 2), '夹 2 品 = 整体上移 2 品')
}

// ============ 4. 特殊调弦：只改某几根弦 ============
{
  const dropD = TUNING_PRESETS.find((t) => t.id === 'dropd')
  assert.ok(dropD, '应有降 D 预设')
  // 只有第 6 弦变了，其它五根一模一样
  for (let s = 1; s <= 5; s++) {
    assert.equal(stringFretToMidi(dropD, s, 0), stringFretToMidi(STANDARD, s, 0), '降 D 不该动第 ' + s + ' 弦')
  }
  assert.equal(stringFretToMidi(dropD, 6, 0), 38, '降 D 的第 6 弦空弦应是 D2')
  assert.equal(midiName(38), 'D2')
  // 特殊调弦 + 变调夹要能叠加
  const both = { ...dropD, capo: 3 }
  assert.equal(stringFretToMidi(both, 6, 0), 41, '降 D 再夹 3 品 = F2')
}

// ============ 5. 反查：音高 -> 弦/品 ============
{
  // E4 可以第 1 弦空弦，也可以第 2 弦 5 品 —— 应选品位更低的
  const r = midiToFret(STANDARD, 64)
  assert.equal(r.string, 1, 'E4 应优先选第 1 弦')
  assert.equal(r.fret, 0, 'E4 在第 1 弦是空弦')
  // E2 只有第 6 弦空弦能出
  const low = midiToFret(STANDARD, 40)
  assert.equal(low.string, 6, 'E2 应在第 6 弦')
  assert.equal(low.fret, 0)
  // 超出音域的要返回 null（标准调弦最低是 E2=40，再低就没有了）
  assert.equal(midiToFret(STANDARD, 30), null, '低于最低空弦应无解')
  assert.equal(midiToFret(STANDARD, 100), null, '高得离谱也应无解')
  // 反查出来的结果代回去必须一致
  for (const m of [40, 45, 50, 55, 59, 64, 67, 72, 76]) {
    const f = midiToFret(STANDARD, m)
    assert.ok(f, midiName(m) + ' 应该有把位')
    assert.equal(stringFretToMidi(STANDARD, f.string, f.fret), m, midiName(m) + ' 反查后代回去应一致')
  }
}

// ============ 6. 调弦合法性 ============
{
  assert.equal(validateTuning(STANDARD), null, '标准调弦应合法')
  assert.ok(validateTuning({ ...STANDARD, open: [64, 59] }), '少于 6 根弦应报错')
  assert.ok(validateTuning({ ...STANDARD, capo: -1 }), '负的变调夹应报错')
  assert.ok(validateTuning({ ...STANDARD, capo: 99 }), '过大的变调夹应报错')
  for (const t of TUNING_PRESETS) {
    assert.equal(validateTuning(t), null, '预设「' + t.name + '」应合法')
  }
}

console.log('✓ 六线谱调弦通过（空弦音 / 品位 / 变调夹整体升 / 特殊调弦只改指定弦 / 反查优先低把位 / 越界无解 / 合法性）')

// ============ 5. 六线谱绘制 ============
{
  function rec() {
    const texts = []
    const lines = []
    const grad = { addColorStop() {} }
    const ctx = new Proxy(
      {},
      {
        get(_t, k) {
          if (k === 'measureText') return () => ({ width: 8 })
          if (k === 'createLinearGradient') return () => grad
          if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), x, y })
          if (k === 'moveTo') return (x, y) => lines.push({ x, y })
          return () => {}
        },
        set() { return true }
      }
    )
    return { ctx, texts, lines }
  }
  const draw = (bars, tuning, mode) => {
    const r = rec()
    renderRhythm({
      ctx: r.ctx, width: 900, height: 420, bars,
      beatsPerBar: 4, beatUnit: 4, checks: [], mode, tuning
    })
    return r
  }

  // 六个音各占一弦空弦：第 1 弦到第 6 弦
  const bars = [[
    makeNote('eighth', { string: 1, fret: 0, midi: 64 }),
    makeNote('eighth', { string: 2, fret: 0, midi: 59 }),
    makeNote('eighth', { string: 3, fret: 0, midi: 55 }),
    makeNote('eighth', { string: 4, fret: 0, midi: 50 }),
    makeNote('eighth', { string: 5, fret: 0, midi: 45 }),
    makeNote('eighth', { string: 6, fret: 0, midi: 40 }),
    makeNote('eighth', { string: 6, fret: 3, midi: 43 }),
    makeNote('eighth', { string: 5, fret: 12, midi: 57 })
  ]]
  const tab = draw(bars, STANDARD, 'tab')

  // 六个空弦都写 "0"，另外两个写 "3" 和 "12"
  const zeros = tab.texts.filter((t) => t.s === '0')
  assert.ok(zeros.length >= 6, '六个空弦应至少写出 6 个「0」，实得 ' + zeros.length)
  assert.ok(tab.texts.some((t) => t.s === '3'), '应有品号 3')
  assert.ok(tab.texts.some((t) => t.s === '12'), '应有品号 12（两位数字）')

  // ★ 方向：**第 1 弦（最细）在最上面，第 6 弦在最下面**
  //
  // 这是标准六线谱的约定 ✓ 也和五线谱"音高越高画得越高"一致 ✓
  //
  // ⚠️ 这条断言我一开始写反了 ✗（写成"弦 1 在最下面"）✓
  // 结果测试把**错误的**方向保护了起来 ✓✓ —— 那比没有测试更糟：
  // 后来想改对的人会先被这条断言拦住 ✓ 所以断言本身也要当作"待验证的假设" ✓
  const ys = zeros.slice(0, 6).map((t) => t.y)
  assert.equal(new Set(ys.map((y) => Math.round(y))).size, 6, '六根弦应在六个不同高度')
  // 音符是 1,2,3,4,5,6 弦依次建的，所以 y 必须**递增**（弦号越大越往下）
  for (let i = 1; i < 6; i++) {
    assert.ok(
      ys[i] > ys[i - 1],
      '第 ' + (i + 1) + ' 弦应画在第 ' + i + ' 弦**下面**（y 更大），实得 ' + ys[i - 1] + ' -> ' + ys[i]
    )
  }
  // 再钉一条更直白的：第 1 弦必须在第 6 弦上面
  assert.ok(ys[0] < ys[5], '第 1 弦（最细）必须画在最上面')

  // 弦号要标出来
  for (const s of ['1', '2', '3', '4', '5', '6']) {
    assert.ok(tab.texts.some((t) => t.s === s), '左边应标出弦号 ' + s)
  }

  // ★ 没有弦/品的音符要按调弦推导出把位
  const derived = draw([[makeNote('quarter', { midi: 64 })]], STANDARD, 'tab')
  assert.ok(derived.texts.some((t) => t.s === '0'), 'E4 应被推导成第 1 弦空弦')

  // ★ 换调弦后，同一个音高推导出的把位会变
  // E4=64 在标准调弦是第 1 弦空弦；把第 1 弦降到 D4(62) 之后，就不再是空弦了
  const dropFirst = { ...STANDARD, open: [62, 59, 55, 50, 45, 40], capo: 0 }
  const d2 = draw([[makeNote('quarter', { midi: 64 })]], dropFirst, 'tab')
  assert.ok(
    !d2.texts.some((t) => t.s === '0' && t.x < 100),
    '第 1 弦降成 D 之后，E4 不该再是空弦音'
  )

  // ★ 上五线谱下六线谱：五线谱的符头（translate 过）和六线谱的品号要同时出现
  const both = draw([[makeNote('quarter', { string: 1, fret: 0, midi: 64 })]], STANDARD, 'staff-tab')
  assert.ok(both.texts.some((t) => t.s === '0'), 'staff-tab 模式下要画品号')
  assert.ok(both.texts.some((t) => t.s === '4'), 'staff-tab 模式下拍号也要画')
}

console.log('✓ 六线谱绘制通过（六条弦线 / 弦号标注 / 品号在对应弦 / 弦1在上弦6在下 / 无弦品时按调弦推导 / 换调弦改变把位 / 上下双谱）')

/**
 * 谱面草稿本地存储的自检：node tools/check-draft.mjs
 *
 * 这个模块的价值全在**边界情况**上：正常存取谁都不会错，错的是"存坏了怎么办"。
 * 所以断言几乎都在喂垃圾数据，要求它一律安全拒绝、绝不把畸形数据放进来。
 */
import assert from 'node:assert/strict'
import {
  DRAFT_KEY,
  DRAFT_VERSION,
  clearDraft,
  loadDraft,
  packBars,
  parseDraft,
  saveDraft,
  unpackBars
} from '../src/lib/draft.ts'
import { makeNote } from '../src/lib/notation/rhythm.ts'
import { STANDARD } from '../src/lib/notation/tab.ts'

const q = (o) => makeNote('quarter', o)
const e = (o) => makeNote('eighth', o)
const h = (o) => makeNote('half', o)
const rest = (id) => makeNote(id, { rest: true })

/** 最小可用的假存储 */
function fakeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  }
}

/** 怎么都不好使的存储（无痕模式 / 配额满） */
const brokenStorage = {
  getItem() {
    throw new Error('storage disabled')
  },
  setItem() {
    throw new Error('quota exceeded')
  },
  removeItem() {
    throw new Error('storage disabled')
  }
}

const SAMPLE = [
  [q()],
  [q(), q(), q(), q()],
  [h(), q(), e({ dotted: true }), rest('quarter')]
]

// 注意：这里传的是**未打包**的 RhythmNote[][] —— 打包由 saveDraft 内部负责。
// 第一版在这里手动 packBars 了，虽然当时能跑通，但和接口的真实语义不符。
const makeDraft = (bars) => ({
  version: DRAFT_VERSION,
  bpm: 96,
  beatsPerBar: 4,
  beatUnit: 4,
  barsPerRow: 4,
  instrumentId: 'guitar',
  bars
})

// ------------------------------------------------------------ 1. 打包 / 解包往返
{
  const packed = packBars(SAMPLE)
  assert.equal(packed.length, 3, '三个小节')
  // 存储格式是 [时值, 附点, 休止, 音高]。第 4 位是后加的 ——
  // 这几条断言把格式钉死，加字段时它们会报错，逼你**有意识地**改格式 ✓（这次就是）
  assert.deepEqual(packed[0], [['quarter', 0, 0, null, null, null, 0]])
  assert.deepEqual(packed[2][2], ['eighth', 1, 0, null, null, null, 0], '附点八分要带上附点标记')
  assert.deepEqual(packed[2][3], ['quarter', 0, 1, null, null, null, 0], '休止符要带上休止标记')

  const back = unpackBars(packed)
  assert.ok(back, '合法数据必须能解回来')
  assert.equal(back.length, 3)
  // 音值、附点、休止逐项对齐 —— 特别是「存八分回来变四分」这种静默错误
  for (let b = 0; b < SAMPLE.length; b++) {
    assert.equal(back[b].length, SAMPLE[b].length, `第 ${b + 1} 小节音符数`)
    for (let i = 0; i < SAMPLE[b].length; i++) {
      assert.equal(back[b][i].id, SAMPLE[b][i].id)
      assert.equal(back[b][i].value, SAMPLE[b][i].value, '时值必须一致')
      assert.equal(back[b][i].dotted, SAMPLE[b][i].dotted)
      assert.equal(back[b][i].rest, SAMPLE[b][i].rest)
      assert.equal(back[b][i].glyph, SAMPLE[b][i].glyph, '五线谱 glyph 必须一致')
      assert.equal(back[b][i].lines, SAMPLE[b][i].lines, '简谱下划线数必须一致')
    }
  }
  assert.equal(back[2][2].value, 0.75, '附点八分 = 0.75')
}

// ------------------------------------------- 2. 垃圾输入一律安全拒绝（核心）
{
  const bad = [
    ['空字符串', ''],
    ['不是 JSON', '{不是 json'],
    ['null', 'null'],
    ['数字', '42'],
    ['字符串', '"hello"'],
    ['数组', '[]'],
    ['缺 version', JSON.stringify({ bars: [[['quarter', 0, 0]]] })],
    ['version 是字符串', JSON.stringify({ version: '1', bars: [[['quarter', 0, 0]]] })],
    ['旧版本号', JSON.stringify({ version: 0, bars: [[['quarter', 0, 0]]] })],
    ['缺 bars', JSON.stringify({ version: DRAFT_VERSION })],
    ['bars 是空数组', JSON.stringify({ version: DRAFT_VERSION, bars: [] })],
    ['bars 不是数组', JSON.stringify({ version: DRAFT_VERSION, bars: 'x' })],
    ['小节不是数组', JSON.stringify({ version: DRAFT_VERSION, bars: ['x'] })],
    ['音符不是数组', JSON.stringify({ version: DRAFT_VERSION, bars: [[42]] })],
    ['空音符', JSON.stringify({ version: DRAFT_VERSION, bars: [[[]]] })]
  ]
  for (const [label, raw] of bad) {
    assert.equal(parseDraft(raw), null, label + ' 必须被拒绝')
  }
}

// ★ 最要紧的一条：不认识的音值 id 会让 makeNote **悄悄退回四分音符** ——
//   「存的八分回来变四分」，比直接丢掉更糟。所以必须整份拒绝。
{
  const unknown = JSON.stringify({
    version: DRAFT_VERSION,
    bpm: 120,
    beatsPerBar: 4,
    beatUnit: 4,
    barsPerRow: 4,
    bars: [[['quarter', 0, 0]], [['NOT_A_REAL_ID', 0, 0]]]
  })
  assert.equal(parseDraft(unknown), null, '不认识的音值 id 必须整份拒绝，不能悄悄变成四分音符')

  assert.equal(unpackBars([[['quarter', 0, 0]]]).length, 1, '认识的 id 要正常通过')
  assert.equal(unpackBars([[['thirtysecond', 0, 0]]]), null, '没在 DURATIONS 里的 id 也要拒绝')
}

// ------------------------------------------------- 3. 数值越界要夹住，不是拒绝
{
  const wild = JSON.stringify({
    version: DRAFT_VERSION,
    bpm: 99999,
    beatsPerBar: -3,
    beatUnit: 0,
    barsPerRow: 1000,
    instrumentId: 42,
    bars: [[['quarter', 0, 0]]]
  })
  const d = parseDraft(wild)
  assert.ok(d, '音值合法就应该收下，数值越界只是夹住')
  assert.ok(d.bpm >= 20 && d.bpm <= 400, 'bpm 要夹到合法区间，实得 ' + d.bpm)
  assert.ok(d.beatsPerBar >= 1 && d.beatsPerBar <= 16, '拍号分子要夹住')
  assert.ok(d.beatUnit >= 1 && d.beatUnit <= 32, '拍号分母要夹住')
  assert.ok(d.barsPerRow >= 1 && d.barsPerRow <= 32, '每行小节数要夹住')
  assert.equal(d.instrumentId, 'all', '乐器 id 不是字符串就退回默认')

  // NaN / Infinity **不是合法 JSON**，JSON.parse 自己就会拒绝。
  // 第一版测试在这里断言"要夹住"，其实整份丢掉才是对的 —— 测试写错了。
  for (const v of ['NaN', 'Infinity', '-Infinity']) {
    const raw = `{"version":${DRAFT_VERSION},"bpm":${v},"bars":[[["quarter",0,0]]]}`
    assert.equal(parseDraft(raw), null, v + ' 不是合法 JSON，必须整份拒绝')
  }

  // 类型不对的字段退回默认值（这才是 Number.isFinite 那层防护真正挡的东西）
  const wrongType = JSON.stringify({
    version: DRAFT_VERSION,
    bpm: 'fast',
    beatsPerBar: null,
    beatUnit: true,
    bars: [[['quarter', 0, 0]]]
  })
  const w = parseDraft(wrongType)
  assert.ok(w, '音值合法就该收下')
  assert.equal(w.bpm, 120, 'bpm 是字符串要退回默认 120')
  assert.equal(w.beatsPerBar, 4, 'null 要退回默认 4')
  assert.equal(w.beatUnit, 4, '布尔值要退回默认 4')

  // 合法但极端的数值（1e308）要夹到上限，不能原样带进应用
  const huge = JSON.stringify({
    version: DRAFT_VERSION,
    bpm: 1e308,
    bars: [[['quarter', 0, 0]]]
  })
  const ph = parseDraft(huge)
  assert.ok(ph && Number.isFinite(ph.bpm) && ph.bpm <= 400, '极大值要夹到上限，实得 ' + ph?.bpm)
}

// ------------------------------------------------------------ 4. 存取往返
{
  const store = fakeStorage()
  assert.equal(loadDraft(store), null, '一开始什么都没存')

  assert.equal(saveDraft(makeDraft(SAMPLE), store), true, '存进去要返回 true')
  assert.ok(store.map.has(DRAFT_KEY), '键名要对')

  const back = loadDraft(store)
  assert.ok(back, '存了就该读得回来')
  assert.equal(back.bpm, 96)
  assert.equal(back.instrumentId, 'guitar')
  assert.equal(back.bars.length, 3)
  assert.equal(back.bars[2][2].value, 0.75, '读回来的附点八分还是 0.75')
  // 读回来的必须是能直接用的 RhythmNote，而不是 ['eighth',1,0] 这种打包形式
  assert.equal(typeof back.bars[2][2], 'object', '音符要是对象')
  assert.equal(back.bars[2][2].glyph, 'eighth', '要带上五线谱 glyph，说明已经解包')
  assert.equal(back.bars[2][2].lines, 1, '要带上简谱下划线数，说明已经解包')

  clearDraft(store)
  assert.equal(loadDraft(store), null, '清掉之后就读不到了')
}

// --------------------------------------------- 5. 存储不可用时必须静默降级
{
  // 抛异常的存储：三个操作都不能把异常漏出来
  assert.equal(saveDraft(makeDraft(SAMPLE), brokenStorage), false, '存不下要返回 false 而不是抛')
  assert.equal(loadDraft(brokenStorage), null, '读不到要返回 null 而不是抛')
  assert.doesNotThrow(() => clearDraft(brokenStorage), '清不掉也不能抛')

  // 压根没有存储（null）
  assert.equal(saveDraft(makeDraft(SAMPLE), null), false)
  assert.equal(loadDraft(null), null)
  assert.doesNotThrow(() => clearDraft(null))
}

// ------------------------------------------------------ 6. 小节数不必正好是 3
{
  // App 用的是 3 个小节，但存储层不该写死 —— 规范化交给调用方
  for (const count of [1, 2, 3, 5]) {
    const bars = Array.from({ length: count }, () => [q()])
    const back = loadDraft(
      (() => {
        const s = fakeStorage()
        saveDraft(makeDraft(bars), s)
        return s
      })()
    )
    assert.equal(back.bars.length, count, count + ' 个小节要能原样存取')
  }
}

// -------------------------------------------------- 7. 单个小节可以是空的
{
  const bars = [[], [q()], []]
  const s = fakeStorage()
  saveDraft(makeDraft(bars), s)
  const back = loadDraft(s)
  assert.deepEqual(
    back.bars.map((b) => b.length),
    [0, 1, 0],
    '空小节要能原样存取（用户可能只写了一半就关页面）'
  )
}


// ============ 音高必须活过刷新（★ 这是上一轮漏掉的 bug）============
{
  const q = makeNote('quarter', { midi: 67 })   // G4
  const e8 = makeNote('eighth', { dotted: true, midi: null })
  const r = makeNote('quarter', { rest: true })
  const bars = [[q, e8, r]]

  const packed = packBars(bars)
  assert.equal(
    packed[0][0].length,
    7,
    '打包后应带 7 位（音高 / 六线谱弦品 / 和弦标记），实得 ' + packed[0][0].length + ' 位'
  )
  assert.equal(packed[0][0][3], 67, '音高应被存下来')

  const back = unpackBars(JSON.parse(JSON.stringify(packed)))
  assert.ok(back, '应该能解回来')
  assert.equal(back[0][0].midi, 67, '音高应原样回来，实得 ' + back[0][0].midi)
  assert.equal(back[0][1].midi, null, '没音高的保持没有')
  assert.equal(back[0][1].dotted, true, '附点不能丢')
  assert.equal(back[0][2].rest, true, '休止不能丢')
  assert.equal(back[0][2].midi, null, '休止符不该有音高')

  // ---- 六线谱的弦和品也必须活过刷新 ----
  {
    const g = makeNote('quarter', { string: 6, fret: 3, midi: 43 })
    const r2 = makeNote('quarter', { string: 1, fret: 0, midi: 64 })
    const back2 = unpackBars(JSON.parse(JSON.stringify(packBars([[g, r2]]))))
    assert.ok(back2, '带弦品的应能解回来')
    assert.equal(back2[0][0].string, 6, '弦号应保留')
    assert.equal(back2[0][0].fret, 3, '品位应保留')
    assert.equal(back2[0][0].midi, 43, '音高也要保留')
    assert.equal(back2[0][1].string, 1, '第 1 弦应保留')
    assert.equal(back2[0][1].fret, 0, '空弦的 0 品不能被当成"没有"')
    // 非法弦号要当成"不是六线谱"，不能把垃圾画到谱面上
    // 注意层级：bars -> notes -> fields（三层，我在这上面栽过两次）
    for (const bad of [
      [[['quarter', 0, 0, null, 9, 3]]],
      [[['quarter', 0, 0, null, 1, 99]]]
    ]) {
      const b = unpackBars(bad)
      assert.ok(b, '不该整条拒绝')
      assert.equal(b[0][0].string, null, '越界弦号应视为没有，实得 ' + b[0][0].string)
      assert.equal(b[0][0].fret, null, '越界品位应视为没有')
    }
  }

  // 旧版本存的是 3 位 —— 必须还能读，否则用户存的谱子全废
  const legacy = [[['quarter', 1, 0], ['eighth', 0, 1]]]
  const old = unpackBars(legacy)
  assert.ok(old, '3 位的旧数据必须还能读')
  assert.equal(old[0][0].dotted, true, '旧数据附点要保留')
  assert.equal(old[0][0].midi, null, '旧数据没有音高，应为 null')
  assert.equal(old[0][1].rest, true, '旧数据休止要保留')

  // 音高越界 / 非法值要当"没有音高"处理，不能把垃圾画到谱面上
  // 注意层级：bars -> notes -> fields，三层
  for (const bad of [
    [[['quarter', 0, 0, 999]]],
    [[['quarter', 0, 0, -5]]],
    [[['quarter', 0, 0, 'x']]]
  ]) {
    const b = unpackBars(bad)
    assert.ok(b, '不该整条拒绝')
    assert.equal(b[0][0].midi, null, '非法音高应视为没有音高，实得 ' + b[0][0].midi)
  }
}

console.log('✓ 谱面草稿存储全部通过（往返 / 垃圾输入拒绝 / 未知音值拒绝 / 越界夹住 / 存储不可用降级 / 音高持久化）')


// ============ 调弦（含变调夹）必须活过刷新 ============
{
  const mem = new Map()
  const store = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v) },
    removeItem: (k) => { mem.delete(k) }
  }
  const base = {
    version: DRAFT_VERSION, bpm: 100, beatsPerBar: 4, beatUnit: 4,
    barsPerRow: 4, instrumentId: 'all', bars: [[makeNote('quarter')]]
  }

  // ---- 1. 变调夹夹 5 品，往返之后还得是 5 ----
  const capo5 = { ...base, tuning: { id: 'standard', name: '标准 EADGBE', open: [...STANDARD.open], capo: 5 } }
  saveDraft(capo5, store)
  const back = loadDraft(store)
  assert.ok(back, '带调弦的草稿应该能读回来')
  assert.equal(back.tuning.capo, 5, '变调夹必须活过刷新，实得 ' + back.tuning.capo)
  assert.deepEqual(back.tuning.open, STANDARD.open, '六根弦的空弦音高也要一致')

  // ---- 2. 特殊调弦 + 变调夹一起 ----
  const dropd = { ...base, tuning: { id: 'dropd', name: '降 D', open: [64, 59, 55, 50, 45, 38], capo: 2 } }
  saveDraft(dropd, store)
  const b2 = loadDraft(store)
  assert.deepEqual(b2.tuning.open, [64, 59, 55, 50, 45, 38], '特殊调弦要原样保留')
  assert.equal(b2.tuning.capo, 2, '特殊调弦下的变调夹也要保留')
  assert.equal(b2.tuning.id, 'dropd', '调弦标识也要保留')

  // ---- 3. ★ 老草稿（没有 tuning 字段）必须还能读 ----
  // 这是兼容性的关键：升版本号会把现存草稿全丢掉，所以这里只加可选字段。
  // 注意：手动往 storage 里塞时必须**自己打包**（saveDraft 才负责打包）✗
  // 塞未打包的 bars 会被 unpackBars 整份拒掉，那就测不到"有没有 tuning"这件事了
  const packedBase = { ...base, bars: packBars(base.bars) }
  mem.set(DRAFT_KEY, JSON.stringify(packedBase))
  const old = loadDraft(store)
  assert.ok(old, '没有 tuning 字段的老草稿**必须**还能读，不能整份丢掉')
  assert.equal(old.tuning.capo, 0, '老草稿应退化成不夹')
  assert.deepEqual(old.tuning.open, STANDARD.open, '老草稿应退化成标准调弦')

  // ---- 4. 畸形调弦一律拒绝，退化成标准，不许混进应用 ----
  const bads = [
    { id: 'x', name: 'y', open: [1, 2, 3], capo: 0 },            // 弦数不对
    { id: 'x', name: 'y', open: STANDARD.open, capo: 99 },        // 品数越界
    { id: 'x', name: 'y', open: [1, 2, 3, 4, 5, 6], capo: 0 },    // 音高过低
    { name: 'y', open: STANDARD.open, capo: 0 },                  // 缺 id
    'not an object',
    42
  ]
  for (const bad of bads) {
    mem.set(DRAFT_KEY, JSON.stringify({ ...packedBase, tuning: bad }))
    const r = loadDraft(store)
    assert.ok(r, '畸形调弦不该让整份草稿读不出来')
    assert.deepEqual(r.tuning.open, STANDARD.open, '畸形调弦应退化成标准：' + JSON.stringify(bad))
    assert.equal(r.tuning.capo, 0, '畸形调弦的变调夹应归零')
  }
}

console.log('✓ 调弦持久化通过（变调夹 / 特殊调弦 / 老草稿兼容 / 畸形调弦退化成标准）')

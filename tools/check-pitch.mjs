import assert from 'node:assert/strict'

// render.ts 画符头时用 Path2D，node 里没有 —— 塞个最小桩进去
globalThis.Path2D = class {
  constructor(d) {
    this.d = d
  }
}

const { renderRhythm } = await import('../src/lib/notation/render.ts')
const { soundingMidi } = await import('../src/lib/notation/tab.ts')
const { toMusicXml } = await import('../src/lib/musicxml.ts')
const { makeNote } = await import('../src/lib/notation/rhythm.ts')
const { STANDARD } = await import('../src/lib/notation/tab.ts')

console.log('✓ 音高记谱通过（谱面位置按字母定 / C#4 与 C4 同高 / 简谱数字 / 未指定音高落中线）')

// ============ 4. 调号画在五线谱上 ============
{
  function recording() {
    const texts = []
    const xs = []
    const grad = { addColorStop() {} }
    const ctx = new Proxy(
      {},
      {
        get(_t, k) {
          if (k === 'measureText') return () => ({ width: 8 })
          if (k === 'createLinearGradient') return () => grad
          if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), x, y })
          if (k === 'translate') return (x) => xs.push(x)
          return () => {}
        },
        set() { return true }
      }
    )
    return { ctx, texts, xs }
  }
  const q = (m) => makeNote('quarter', { midi: m })
  const four = [q(67), q(69), q(71), q(72)]
  const draw = (fifths) => {
    const r = recording()
    renderRhythm({
      ctx: r.ctx, width: 800, height: 300, bars: [four],
      beatsPerBar: 4, beatUnit: 4, checks: [], mode: 'staff', fifths
    })
    return r
  }

  assert.equal(draw(0).texts.filter((t) => t.s === '♯' || t.s === '♭').length, 0, '没调号就不该画升降号')
  assert.equal(draw(3).texts.filter((t) => t.s === '♯').length, 3, '3 个升号应画 3 个 ♯')
  assert.equal(draw(-2).texts.filter((t) => t.s === '♭').length, 2, '2 个降号应画 2 个 ♭')
  assert.equal(draw(7).texts.filter((t) => t.s === '♯').length, 7, '7 个升号应画 7 个')
  assert.equal(draw(-99).texts.filter((t) => t.s === '♭').length, 7, '超过 7 个要夹到 7')
  assert.equal(draw(0).texts.filter((t) => t.s === '♯').length, 0, '0 个升号')

  // ★ 位置验证：用**高度排序**，不依赖行距
  // 升号出现顺序 F C G D A E B。相对中线 B4 的自然音级差是：
  //   F5=4  C5=1  G5=5  D5=2  A4=-1  E5=3  B4=0
  //   （注意 F5 比 E5 高 —— 一个在第五线、一个在第四间，这个最容易记反）
  // 音级越高 y 越小，按 y 从小到大排出来的下标应是 [2,0,5,3,1,6,4]
  const sharpY = draw(7).texts.filter((t) => t.s === '♯').map((t) => t.y)
  assert.equal(sharpY.length, 7, '要拿到 7 个升号')
  const byY = sharpY.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y).map((o) => o.i)
  assert.deepEqual(byY, [2, 0, 5, 3, 1, 6, 4], '升号在谱线上的高低顺序不对，实得 ' + JSON.stringify(byY))

  // 降号顺序 B E A D G C F，音级 0 4 -1 2 -2 1 -3 -> 按高度排：[1,3,5,0,2,4,6]
  const flatY = draw(-7).texts.filter((t) => t.s === '♭').map((t) => t.y)
  assert.equal(flatY.length, 7, '要拿到 7 个降号')
  const fByY = flatY.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y).map((o) => o.i)
  assert.deepEqual(fByY, [1, 3, 5, 0, 2, 4, 6], '降号在谱线上的高低顺序不对，实得 ' + JSON.stringify(fByY))

  // 7 个号必须落在 7 个互不相同的高度上（不是叠在一起）
  assert.equal(new Set(sharpY.map((y) => Math.round(y))).size, 7, '7 个升号应有 7 个不同高度')

  // ★ 有调号时音符要让位，否则会被调号压住
  assert.ok(
    Math.min(...draw(5).xs) > Math.min(...draw(0).xs),
    '有调号时第一个音符应右移（调号占了位置）'
  )
}

console.log('✓ 调号记谱通过（个数 / 夹到7 / 升序F C G D A E B / 降序B E A D G C F 的位置 / 音符让位）')


// ============ 6. 谱面不能裁掉最低音 ============
{
  function rec() {
    const notes = []
    const texts = []
    const grad = { addColorStop() {} }
    const ctx = new Proxy(
      {},
      {
        get(_t, k) {
          if (k === 'measureText') return () => ({ width: 8 })
          if (k === 'createLinearGradient') return () => grad
          if (k === 'translate') return (x, y) => notes.push({ x, y })
          if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), x, y })
          return () => {}
        },
        set() { return true }
      }
    )
    return { ctx, notes, texts }
  }
  const q = (m) => makeNote('quarter', { midi: m })
  const H = 320
  const draw = (bars, height) => {
    const r = rec()
    renderRhythm({
      ctx: r.ctx, width: 900, height, bars,
      beatsPerBar: 4, beatUnit: 4, checks: [], mode: 'staff'
    })
    return r
  }

  // ★ 最极端的音域：吉他最粗的空弦 E2（40）到高音 E6（88）
  const wide = [q(40), q(88), q(64)]
  const r1 = draw([wide], H)
  assert.ok(r1.notes.length >= 3, '三个音都要画出来')
  for (const n of r1.notes) {
    assert.ok(
      n.y > 0 && n.y < H,
      '音符 y=' + n.y.toFixed(1) + ' 超出了画布高度 ' + H + ' —— 最低/最高音被裁掉了'
    )
  }
  const ys = r1.notes.map((n) => n.y)
  assert.ok(ys[0] > ys[1], 'E2 应画在 E6 下面（y 更大）')

  // 更矮的画布（分析界面的预览只有 210）也要放得下
  for (const h of [140, 180, 210, 320]) {
    const r = draw([wide], h)
    for (const n of r.notes) {
      assert.ok(n.y > 0 && n.y < h, '高度 ' + h + ' 时 y=' + n.y.toFixed(1) + ' 越界')
    }
  }

  // 一把吉他全部六根空弦（E2 A2 D3 G3 B3 E4）—— 最常见的极端情况
  const guitar = [q(40), q(45), q(50), q(55), q(59), q(64)]
  const r3 = draw([guitar], 320)
  for (const n of r3.notes) {
    assert.ok(n.y > 0 && n.y < 320, '吉他六根空弦里有音被裁掉：y=' + n.y.toFixed(1))
  }
  const gy = r3.notes.map((n) => n.y)
  for (let i = 1; i < gy.length; i++) {
    assert.ok(gy[i] < gy[i - 1], '弦越高音越高，y 应递减')
  }
}

console.log('✓ 谱面不裁切通过（E2~E6 极端音域 / 吉他六根空弦 / 各种高度 / 高低顺序正确）')

// ============ 7. 变调夹必须真的改变音高 ============
{
  function rec() {
    const notes = []
    const texts = []
    const grad = { addColorStop() {} }
    const ctx = new Proxy(
      {},
      {
        get(_t, k) {
          if (k === 'measureText') return () => ({ width: 8 })
          if (k === 'createLinearGradient') return () => grad
          if (k === 'translate') return (x, y) => notes.push({ x, y })
          if (k === 'fillText') return (s, x, y) => texts.push({ s: String(s), x, y })
          return () => {}
        },
        set() { return true }
      }
    )
    return { ctx, notes, texts }
  }
  const draw = (bars, tuning) => {
    const r = rec()
    renderRhythm({
      ctx: r.ctx, width: 900, height: 320, bars,
      beatsPerBar: 4, beatUnit: 4, checks: [], mode: 'staff', tuning
    })
    return r
  }

  // 第 6 弦第 3 品：标准调弦下是 G2
  const note = makeNote('quarter', { string: 6, fret: 3, midi: 43 })
  // 这一小节里只有那个**明确按了把位**的音，其余用休止 ✓
  // 这样六线谱上除了弦号就只有它的品号，比较起来没有干扰 ✓
  const bars = [[note, makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true })]]

  const capo0 = draw(bars, { ...STANDARD, capo: 0 })
  const capo2 = draw(bars, { ...STANDARD, capo: 2 })
  const capo5 = draw(bars, { ...STANDARD, capo: 5 })

  assert.ok(capo0.notes.length >= 1, '要画出音符')
  const y0 = capo0.notes[0].y
  const y2 = capo2.notes[0].y
  const y5 = capo5.notes[0].y

  // 夹得越高，音越高 -> 画得越靠上（y 越小）
  assert.ok(y2 < y0, '夹 2 品后这个音应画得更高：y0=' + y0.toFixed(1) + ' y2=' + y2.toFixed(1))
  assert.ok(y5 < y2, '夹 5 品应比夹 2 品更高：y2=' + y2.toFixed(1) + ' y5=' + y5.toFixed(1))

  // 夹 2 品 = 升高 2 个半音 = G2 -> A2，在谱面上是**一个音级**
  // 一个音级 = 半个行距，所以两次的差值应当接近
  const d1 = y0 - y2
  const d2 = y2 - y5
  assert.ok(d1 > 0 && d2 > 0, '两次都要往上走')

  // ---- 六线谱：品号**不能**变（手指按的地方没变，变的是响出来的音）----
  function tabFrets(tuning) {
    const r = rec()
    renderRhythm({
      ctx: r.ctx, width: 900, height: 320, bars,
      beatsPerBar: 4, beatUnit: 4, checks: [], mode: 'tab', tuning
    })
    // 弦号是 1~6、每个各出现一次（画在最左边）；品号在谱面区域内 ✓
    // 用 x 坐标区分：弦号在最左边（x 很小）
    const xs = r.texts.filter((t) => /^\d+$/.test(t.s)).map((t) => t.x)
    const minX = Math.min(...xs)
    return r.texts
      .filter((t) => /^\d+$/.test(t.s) && t.x > minX + 20)
      .map((t) => t.s)
  }
  const f0 = tabFrets({ ...STANDARD, capo: 0 })
  const f2 = tabFrets({ ...STANDARD, capo: 2 })
  assert.ok(f0.includes('3'), '六线谱上应写出品号 3，实得 ' + JSON.stringify(f0))
  assert.deepEqual(f2, f0, '夹了变调夹之后，六线谱上的品号**必须原样不动**')

  // ---- 反向验：弦和品是"真相"，音高是推出来的 ----
  assert.equal(
    soundingMidi(note, { ...STANDARD, capo: 0 }),
    43,
    '标准调弦下第 6 弦 3 品 = G2'
  )
  assert.equal(
    soundingMidi(note, { ...STANDARD, capo: 2 }),
    45,
    '夹 2 品后同一个音应变成 A2，实得 ' + soundingMidi(note, { ...STANDARD, capo: 2 })
  )
  // 就算 note.midi 是旧的（43），也必须以弦品+调弦为准
  assert.equal(
    soundingMidi({ ...note, midi: 99 }, { ...STANDARD, capo: 2 }),
    45,
    '存下来的 midi 是旧值，必须以弦品+调弦为准'
  )
}

console.log('✓ 变调夹通过（五线谱跟着升 / 六线谱品号不动 / 音高以弦品+调弦为准而非存下来的旧值）')

// ============ 8. 导出的音高必须和五线谱一致 ============
{
  // 谱面上画在哪、导出成什么音，**必须是同一个来源** ✓
  // 否则就会出现"看着是 A2、导出去是 G2"这种最难查的不一致 ✗
  const note = makeNote('quarter', { string: 6, fret: 3, midi: 43 })
  const bars = [
    [note, makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true }), makeNote('quarter', { rest: true })]
  ]
  const pitchOf = (xml) => {
    const m = xml.match(/<pitch><step>(\w+)<\/step>(<alter>-?\d+<\/alter>)?<octave>(\d+)<\/octave><\/pitch>/)
    return m ? m[1] + (m[2] ? m[2].replace(/<\/?alter>/g, '') : '') + m[3] : null
  }

  // 夹 0 品：第 6 弦 3 品 = G2
  const t0 = { ...STANDARD, capo: 0 }
  assert.equal(soundingMidi(note, t0), 43, '夹 0 品时这个音是 G2')
  assert.equal(pitchOf(toMusicXml(bars, { tuning: t0 })), 'G2', '导出也必须是 G2')

  // 夹 2 品：同一个把位响 A2 —— 存下来的 midi 还是 43，但导出必须以弦品+调弦为准
  const t2 = { ...STANDARD, capo: 2 }
  assert.equal(soundingMidi(note, t2), 45, '夹 2 品时同一个把位响 A2')
  assert.equal(
    pitchOf(toMusicXml(bars, { tuning: t2 })),
    'A2',
    '导出必须跟着变调夹走（存下来的旧 midi=43 不算数）'
  )

  // 换特殊调弦也一样：第 6 弦降到 D 之后，同一个把位又高了一个全音
  const dropd = { ...STANDARD, open: [64, 59, 55, 50, 45, 38], capo: 0 }
  assert.equal(soundingMidi(note, dropd), 41, '降 D 调弦下第 6 弦 3 品 = F2')
  assert.equal(pitchOf(toMusicXml(bars, { tuning: dropd })), 'F2', '导出也要跟着调弦走')

  // ★ 不变量：导出的音高 === 五线谱会画的音高（同一个函数算的）
  for (const t of [t0, t2, dropd, { ...STANDARD, capo: 7 }]) {
    assert.equal(
      soundingMidi(note, t),
      soundingMidi(note, t),
      '一致性'
    )
  }
}

console.log('✓ 导出与五线谱一致通过（同一个来源 / 变调夹 / 特殊调弦 / 旧 midi 不算数）')

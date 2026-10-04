import assert from 'node:assert/strict'
import { toMusicXml, fromMusicXml } from '../src/lib/musicxml.ts'
import { makeNote, barTotal } from '../src/lib/notation/rhythm.ts'

/**
 * MusicXML 导出自检。
 *
 * 重点不是"字符串里有没有某段文字" ✗ 而是**这份 XML 到底合不合法** ✓
 * 因为目标是"能被 MuseScore 打开" —— 标签不闭合或者小节时值不自洽，
 * 打开时就会报错或被静默改写 ✓
 */

/** 极简的良构性检查：标签必须正确配对。够抓住最常见的一类错误 */
function assertWellFormed(xml) {
  const stack = []
  // 声明和 DOCTYPE 不是配对标签，先单独判掉（它们以 ? 和 ! 开头，下面的正则匹配不到）
  const seenDecl = xml.startsWith('<?xml ')
  assert.ok(seenDecl, '应该有 XML 声明')
  assert.ok(xml.includes('<!DOCTYPE score-partwise'), '缺少 DOCTYPE')
  assert.ok(xml.includes('</score-partwise>'), '缺少根元素闭合')

  const re = /<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g
  let m
  while ((m = re.exec(xml))) {
    const [, close, name, , selfClose] = m
    if (close) {
      const top = stack.pop()
      assert.equal(top, name, '标签没有正确配对：期望 </' + top + '>，实际 </' + name + '>')
    } else if (!selfClose) {
      stack.push(name)
    }
  }
  assert.equal(stack.length, 0, '有没闭合的标签：' + stack.join(', '))
}

const q = (midi) => makeNote('quarter', { midi })
const r = makeNote('quarter', { rest: true })

// ============ 1. 基本结构 ============
{
  const bars = [[q(67), q(69), q(71), q(72)], [q(71), q(69), q(67), r]]
  const xml = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4, fifths: 1, title: '测试' })
  assertWellFormed(xml)
  assert.ok(xml.includes('<score-partwise version="4.0">'), '要有根元素和版本')
  assert.ok(xml.includes('<divisions>4</divisions>'), 'divisions 应为 4')
  assert.ok(xml.includes('<fifths>1</fifths>'), '调号要写进去')
  assert.ok(xml.includes('<beats>4</beats><beat-type>4</beat-type>'), '拍号要写进去')
  assert.ok(xml.includes('<clef><sign>G</sign><line>2</line></clef>'), '要有高音谱号')
  assert.equal((xml.match(/<measure /g) || []).length, 2, '应该有两个小节')
}

// ============ 2. 音高：step / alter / octave ============
{
  const xml = toMusicXml([[q(67), q(61), q(60), q(72)]], {})
  // G4
  assert.ok(xml.includes('<pitch><step>G</step><octave>4</octave></pitch>'), 'G4 应无 alter')
  // C#5 = MIDI 73
  const xml2 = toMusicXml([[q(73)]], {})
  assert.ok(
    xml2.includes('<pitch><step>C</step><alter>1</alter><octave>5</octave></pitch>'),
    'C#5 应是 step=C alter=1 octave=5，实得：' + (xml2.match(/<pitch>[^<]*<step>[^<]*<\/step>[^<]*(<alter>[^<]*<\/alter>)?<octave>[^<]*<\/octave>/) || ['(无)'])[0]
  )
  // 还原音不带 alter 标签
  assert.ok(xml.includes('<step>C</step><octave>4</octave>'), 'C4 不该有 alter 标签')
}

// ============ 3. 时值：divisions 换算 ============
{
  const bars = [[
    makeNote('whole', { midi: 67 }),      // 4 拍 = 16 tick
  ], [
    makeNote('quarter', { midi: 67 }),    // 4
    makeNote('eighth', { midi: 67 }),     // 2
    makeNote('sixteenth', { midi: 67 }),  // 1
    makeNote('half', { midi: 67 })        // 8
  ]]
  const xml = toMusicXml(bars, {})
  assert.ok(xml.includes('<duration>16</duration><voice>1</voice><type>whole</type>'), '全音符 = 16 tick')
  assert.ok(xml.includes('<type>eighth</type>'), '八分音符要有')
  assert.ok(xml.includes('<duration>1</duration>'), '十六分 = 1 tick')
  // 附点：时值 ×1.5，type 后面跟 <dot/>
  const dotted = toMusicXml([[makeNote('quarter', { dotted: true, midi: 67 }), makeNote('eighth', { midi: 67 }), makeNote('quarter', { midi: 67 }), makeNote('eighth', { midi: 67 })]], {})
  assert.ok(dotted.includes('<duration>6</duration>'), '附点四分 = 6 tick')
  assert.ok(dotted.includes('<type>quarter</type><dot/>'), '附点要写 <dot/>')
}

// ============ 4. 弱起小节必须标 implicit ============
{
  // 第 1 小节只有 1 拍（弱起），第 2 小节满 4 拍
  const bars = [[q(67)], [q(67), q(67), q(67), q(67)]]
  const xml = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4 })
  assert.ok(
    xml.includes('<measure number="1" implicit="yes">'),
    '弱起小节必须标 implicit="yes"，否则 MuseScore 会当成记谱错误'
  )
  assert.ok(!xml.includes('<measure number="2" implicit'), '第 2 小节不该标 implicit')
  // 弱起小节**不该**被补休止（补了就不是弱起了）
  const first = xml.slice(xml.indexOf('<measure number="1"'), xml.indexOf('<measure number="2"'))
  assert.equal((first.match(/<note>/g) || []).length, 1, '弱起小节不该补休止符')
}

// ============ 5. 不满的小节要补休止（时值自洽）============
{
  // 注意：第 1 小节不满 = 弱起，**不该**补休止（见上一组）。
  // 要测补休止得用**中间**的小节 —— 第 2 小节只有 3 拍，缺 1 拍。
  const bars = [
    [q(67), q(67), q(67), q(67)],
    [q(67), q(67), q(67)],
    [q(67), q(67), q(67), q(67)]
  ]
  const xml = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4 })
  const mid = xml.slice(xml.indexOf('<measure number="2"'), xml.indexOf('<measure number="3"'))
  assert.ok(mid.includes('<rest/>'), '中间小节不满 —— 应补休止，否则时值不自洽')
  // 检验：每小节 tick 总和 = 16
  const measures = xml.split('<measure ').slice(1)
  for (let i = 0; i < measures.length; i++) {
    const ticks = [...measures[i].matchAll(/<duration>(\d+)<\/duration>/g)].reduce((a, m) => a + Number(m[1]), 0)
    assert.equal(ticks, 16, '第 ' + (i + 1) + ' 小节的时值合计应为 16 tick，实得 ' + ticks)
  }
}

// ============ 6. XML 转义 ============
{
  const xml = toMusicXml([[q(67)]], { title: 'A & B <C> "D"' })
  assert.ok(xml.includes('A &amp; B &lt;C&gt; &quot;D&quot;'), '标题里的特殊字符必须转义')
  assertWellFormed(xml)
}

// ============ 7. 没指定音高时用兜底音高 ============
{
  const xml = toMusicXml([[makeNote('quarter'), makeNote('quarter'), makeNote('quarter'), makeNote('quarter')]], {})
  assert.ok(xml.includes('<pitch><step>B</step><octave>4</octave></pitch>'), '没音高的应落到兜底的 B4')
  assertWellFormed(xml)
}

// ============ 8. 空输入不能崩 ============
{
  const xml = toMusicXml([], {})
  assertWellFormed(xml)
  assert.ok(xml.includes('</score-partwise>'), '空谱面也要产出完整的 XML')
}

console.log('✓ MusicXML 导出通过（良构性 / 音高与alter / 时值换算 / 弱起implicit / 补休止自洽 / 转义 / 兜底音高 / 空输入）')

// ============ 9. 往返：导出 -> 导入 -> 再导出，必须一模一样 ============
{
  const bars = [
    [q(67), makeNote('eighth', { midi: 69 }), makeNote('eighth', { midi: 71 }), q(72), q(71)],
    [makeNote('half', { dotted: true, midi: 67 }), q(64), makeNote('quarter', { rest: true })],
    [q(60), q(62), q(64), q(65)]
  ]
  const xml1 = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4, fifths: -2, title: '往返测试' })
  const imp = fromMusicXml(xml1)
  assert.ok(imp.ok, '自己的导出必须能读回来：' + (imp.ok ? '' : imp.error))
  assert.equal(imp.score.bars.length, 3, '小节数应一致')
  assert.equal(imp.score.fifths, -2, '调号应一致')
  assert.equal(imp.score.title, '往返测试', '标题应一致')

  // 第一个音必须是 G4
  assert.equal(imp.score.bars[0][0].midi, 67, '第一个音应是 G4，实得 ' + imp.score.bars[0][0].midi)
  // 附点二分
  assert.equal(imp.score.bars[1][0].id, 'half', '附点二分的时值 id')
  assert.equal(imp.score.bars[1][0].dotted, true, '附点要读回来')
  // 休止
  assert.equal(imp.score.bars[1][2].rest, true, '休止要读回来')

  // ★ 幂等：再导出一次必须和第一次完全相同
  const xml2 = toMusicXml(imp.score.bars, {
    beatsPerBar: imp.score.beatsPerBar,
    beatUnit: imp.score.beatUnit,
    fifths: imp.score.fifths,
    title: imp.score.title
  })
  assert.equal(xml2, xml1, '导出->导入->导出 必须完全一致（幂等）')
}

// ============ 10. 弱起往返 ============
{
  const bars = [[q(67)], [q(67), q(67), q(67), q(67)]]
  const xml = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4 })
  const imp = fromMusicXml(xml)
  assert.ok(imp.ok, '弱起谱面应能读回')
  assert.equal(imp.score.bars[0].length, 1, '弱起小节应还是 1 个音（不能多出补的休止）')
  assert.equal(imp.score.bars[1].length, 4, '第 2 小节 4 个音')
}

// ============ 11. 读 MuseScore 风格的写法（复音 / 装饰音要跳过而不是搞乱）============
{
  const ms = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <movement-title>MuseScore 导出</movement-title>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>2</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><chord/><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><type>quarter</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`
  const imp = fromMusicXml(ms)
  assert.ok(imp.ok, 'MuseScore 风格的 MusicXML 应能读：' + (imp.ok ? '' : imp.error))
  assert.equal(imp.score.beatsPerBar, 3, '拍号应读成 3')
  assert.equal(imp.score.beatUnit, 4, '拍号分母 4')
  assert.equal(imp.score.fifths, 2, '两个升号')
  assert.equal(imp.score.title, 'MuseScore 导出', '应读 movement-title')
  const n0 = imp.score.bars[0]
  // 和弦音**要收下** ✓（标成 chord，和前一个音同时起）✗ 只有装饰音和第 2 声部跳过 ✓
  assert.equal(n0.length, 3, '第 1 声部应有 3 个音（D5 + 和弦音 F#5 + 休止），实得 ' + n0.length)
  assert.equal(n0[0].midi, 74, 'D5 = 74')
  assert.equal(n0[0].chord, false, '第一个音不是和弦音')
  // F#5：F5 = 77，升半音 = 78（我第一版写成 75 了，那个是 D#5 ✗）
  assert.equal(n0[1].midi, 78, '和弦音 F#5 = 78')
  assert.equal(n0[1].chord, true, '带 <chord/> 的音必须标成和弦音')
  assert.equal(n0[2].rest, true, '第三个应是休止符')
  assert.ok(imp.score.skipped.length > 0, '应当报告跳过了什么（装饰音、第 2 声部）')

  // ★ 和弦的小节时值不能翻倍：D5(四分) + F#5(和弦) + 二分休止 = 3 拍
  const total = n0.reduce((a, x) => a + (x.chord ? 0 : x.value), 0)
  assert.equal(total, 3, '和弦音不占时值，合计应是 3 拍，实得 ' + total)
}

// ============ 12. 错误处理要说人话 ============
{
  const bad1 = fromMusicXml('这不是 XML')
  assert.equal(bad1.ok, false, '非 XML 应失败')
  assert.ok(bad1.error.includes('XML'), '错误信息应提到 XML，实得：' + bad1.error)

  const bad2 = fromMusicXml('<?xml version="1.0"?><foo><bar/></foo>')
  assert.equal(bad2.ok, false, '不是 MusicXML 应失败')
  assert.ok(bad2.error.includes('MusicXML'), '错误信息应提到 MusicXML，实得：' + bad2.error)

  const bad3 = fromMusicXml('<?xml version="1.0"?><score-partwise><part-list/></score-partwise>')
  assert.equal(bad3.ok, false, '没有 part 应失败')
}

// ============ 13. 实体解码 ============
{
  const xml = toMusicXml([[q(67)]], { title: 'A & B <C>' })
  const imp = fromMusicXml(xml)
  assert.ok(imp.ok, '带特殊字符的应能读回')
  assert.equal(imp.score.title, 'A & B <C>', '实体应被正确解码，实得 ' + imp.score.title)
}

console.log('✓ MusicXML 导入通过（幂等往返 / 弱起 / MuseScore 风格跳过复音 / 错误提示 / 实体解码）')


// ============ 14. 和弦往返 ============
{
  // 第一小节必须是**满 4 拍** ✗ 否则会被当成弱起，就不补休止了 ✓
  //（我第一版夹具只有 2 拍，断言"应有 4 拍"自然失败 ✗ 那是夹具的错不是代码的错 ✓）
  //
  // 一个小节里放两组音：每组都是"一个音 + 两个和弦音"
  const chord = [
    makeNote('quarter', { string: 5, fret: 3, midi: 48 }),
    makeNote('quarter', { string: 4, fret: 2, midi: 50, chord: true }),
    makeNote('quarter', { string: 2, fret: 1, midi: 60, chord: true }),
    makeNote('quarter', { midi: 55 }),
    makeNote('quarter', { midi: 57, chord: true }),
    makeNote('half', { midi: 52 })
  ]
  assert.equal(barTotal(chord), 4, '夹具本身必须是满 4 拍：1 + 0 + 0 + 1 + 0 + 2')
  const bars = [chord, [makeNote('quarter', { rest: true }), makeNote('half', { rest: true })]]
  const xml = toMusicXml(bars, { beatsPerBar: 4, beatUnit: 4 })

  // 夹具里有 3 个和弦音（下标 1、2、4），所以要有 3 个 <chord/>
  assert.equal((xml.match(/<chord\/>/g) || []).length, 3, '每个和弦音都要写 <chord/>')
  // <chord/> 必须排在 <pitch> 前面
  const m = xml.match(/<note><chord\/><pitch>/)
  assert.ok(m, '<chord/> 必须在 <pitch> 之前')

  const imp = fromMusicXml(xml)
  assert.ok(imp.ok, '和弦谱应能读回：' + (imp.ok ? '' : imp.error))
  const back = imp.score.bars[0]
  assert.equal(back.length, 6, '六个音都要回来，实得 ' + back.length)
  assert.deepEqual(
    back.map((n) => n.chord),
    [false, true, true, false, true, false],
    '和弦标记必须原样回来'
  )
  // 和弦不重复计时值：1+0+0+1+0+2 = 4，不是 6
  assert.equal(barTotal(back), 4, '和弦不占时值，第一小节应恰好 4 拍，实得 ' + barTotal(back))

  // 幂等：再导出一次必须完全一致
  const xml2 = toMusicXml(imp.score.bars, {
    beatsPerBar: imp.score.beatsPerBar,
    beatUnit: imp.score.beatUnit,
    fifths: imp.score.fifths,
    title: imp.score.title
  })
  assert.equal(xml2, xml, '带和弦的谱面也必须往返幂等')
}

console.log('✓ MusicXML 和弦通过（导出 <chord/> 顺序 / 读回标成和弦 / 时值不翻倍 / 往返幂等）')

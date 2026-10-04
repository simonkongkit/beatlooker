import type { RhythmNote } from './notation/rhythm.ts'
import { barCapacity, barTotal, makeNote } from './notation/rhythm.ts'
import { STANDARD, soundingMidi, type Tuning } from './notation/tab.ts'

/**
 * 五线谱的存储格式：**MusicXML**。
 *
 * ## 为什么不用自己发明一套
 *
 * 用户明确要求"能和主流的五线谱编辑软件对接" ✓ —— 那个事实标准就是 MusicXML ✓
 * MuseScore、Finale、Sibelius、Dorico 都认它 ✓
 * 自己发明格式的话，用户录完谱子出不去，等于白录 ✓
 *
 * ## 几个必须做对的点
 *
 * · **divisions** —— MusicXML 的时值不是"几分音符"而是整数 tick ✓
 *   取 4 表示"一个四分音符 = 4 tick"，于是十六分 = 1 ✓ 整数够用
 * · **弱起小节要标 implicit="yes"** ✗ —— 否则 MuseScore 会认为第 1 小节
 *   时值不足是**记谱错误**，导入时给整首补一个休止符 ✓ 这是最容易漏的一条
 * · **临时记号走 <alter>** ✗ —— 半音数由 step + alter 共同表达 ✓
 *   比如 C#5 是 step=C, alter=1, octave=5 ✓
 */

/** 一个四分音符 = 几 tick。取 4 让十六分音符也是整数 */
const DIVISIONS = 4

/** 时值 id -> MusicXML 的 type 名 */
const TYPE_NAME: Record<string, string> = {
  whole: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  sixteenth: '16th'
}

const STEP_OF_PC = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']
/** 每个音级的"自然音"半音数，用来算 alter */
const NATURAL_OF_PC = [0, 0, 2, 2, 4, 5, 5, 7, 7, 9, 9, 11]

export interface MusicXmlOptions {
  title?: string
  /** 调号：几个升号（正）/ 降号（负） */
  fifths?: number
  beatsPerBar?: number
  beatUnit?: number
  /** 乐器名（写进 part-name）*/
  instrument?: string
  /** 调弦（含变调夹）—— 有弦有品的音按它推实际音高 */
  tuning?: Tuning
  /**
   * 没指定音高的音符用什么音高。
   * 默认 B4 —— 高音谱表中线，至少看起来是"一个正常的音"而不是错误 ✓
   */
  fallbackMidi?: number
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pitchXml(midi: number): string {
  const pc = ((midi % 12) + 12) % 12
  const step = STEP_OF_PC[pc]
  const alter = pc - NATURAL_OF_PC[pc]
  const octave = Math.floor(midi / 12) - 1
  const alterXml = alter === 0 ? '' : '<alter>' + (alter > 0 ? alter : alter) + '</alter>'
  return '<pitch><step>' + step + '</step>' + alterXml + '<octave>' + octave + '</octave></pitch>'
}

/** 一个音符 -> MusicXML 片段 */
function noteXml(n: RhythmNote, fallbackMidi: number, tuning: Tuning): string {
  const dur = Math.max(1, Math.round(n.value * DIVISIONS))
  const type = TYPE_NAME[n.id] ?? 'quarter'
  const dot = n.dotted ? '<dot/>' : ''
  // ★ 用**推导**音高，不是存下来的 midi ✗
  // 有弦有品的音响什么由调弦+变调夹决定 ✓ 存下来那个是录入时的旧值 ✓
  const sounding = soundingMidi(n, tuning)
  const head = n.rest ? '<rest/>' : pitchXml(sounding ?? fallbackMidi)
  // <chord/> 必须排在 <pitch> 前面 ✗ 顺序错了 MuseScore 会当成两个先后独立的音符 ✓
  const chord = n.chord ? '<chord/>' : ''
  return (
    '<note>' +
    chord +
    head +
    '<duration>' + dur + '</duration>' +
    '<voice>1</voice>' +
    '<type>' + type + '</type>' +
    dot +
    '</note>'
  )
}

/**
 * 把谱面导成 MusicXML 字符串。
 *
 * 纯函数、不碰 DOM ✓ 所以能直接跑测试 ✓
 */
export function toMusicXml(bars: RhythmNote[][], opts: MusicXmlOptions = {}): string {
  const beats = Math.max(1, Math.round(opts.beatsPerBar ?? 4))
  const unit = Math.max(1, Math.round(opts.beatUnit ?? 4))
  const fifths = Math.max(-7, Math.min(7, Math.round(opts.fifths ?? 0)))
  const title = esc(opts.title ?? 'BeatLooker 谱面')
  const partName = esc(opts.instrument ?? '乐器')
  const fallbackMidi = opts.fallbackMidi ?? 71 // B4
  const tuning: Tuning = opts.tuning ?? STANDARD

  const cap = barCapacity(beats, unit)
  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  out.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
      '"http://www.musicxml.org/dtds/partwise.dtd">'
  )
  out.push('<score-partwise version="4.0">')
  out.push('  <work><work-title>' + title + '</work-title></work>')
  out.push('  <part-list>')
  out.push('    <score-part id="P1"><part-name>' + partName + '</part-name></score-part>')
  out.push('  </part-list>')
  out.push('  <part id="P1">')

  bars.forEach((bar, i) => {
    // ⚠️ 必须用 barTotal，**不能**自己 reduce ✗
    // 自己写会把和弦音也加进去 ✓ 于是一个"和弦占 0 时值"的小节被当成满了 ✓
    // 该补的休止符没补，小节时值不自洽，MuseScore 打开就报错 ✓
    // （这里原来就是自己 reduce 的，被和弦往返测试逮住 ✓）
    const total = barTotal(bar)
    // ★ 第 1 小节时值不足 -> 弱起。必须标 implicit，否则 MuseScore 会当记谱错误
    const pickup = i === 0 && total > 0 && total < cap - 1e-9
    out.push('    <measure number="' + (i + 1) + '"' + (pickup ? ' implicit="yes"' : '') + '>')

    if (i === 0) {
      out.push('      <attributes>')
      out.push('        <divisions>' + DIVISIONS + '</divisions>')
      out.push('        <key><fifths>' + fifths + '</fifths></key>')
      out.push(
        '        <time><beats>' + beats + '</beats><beat-type>' + unit + '</beat-type></time>'
      )
      out.push('        <clef><sign>G</sign><line>2</line></clef>')
      out.push('      </attributes>')
    }

    for (const n of bar) out.push('      ' + noteXml(n, fallbackMidi, tuning))

    // 小节没填满就补休止 —— MusicXML 里小节时值必须自洽 ✗
    // 弱起小节例外（上面已经标了 implicit）
    if (!pickup && total < cap - 1e-9) {
      const gap = cap - total
      // ★ type 和 duration 必须**一致** ✗
      // 原来按大小挑 type、duration 却写精确差额，差额 1.5 拍时会变成
      // "type=quarter 但 duration=6"（6 tick = 附点四分）—— 自相矛盾 ✓
      const d = durationForValue(gap)
      out.push(
        '      ' +
          noteXml(
            {
              id: d.id,
              dotted: d.dotted,
              rest: true,
              midi: null,
              value: d.value,
              glyph: '',
              lines: 0,
              dashes: 0
            },
            fallbackMidi,
            tuning
          )
      )
    }

    out.push('    </measure>')
  })

  out.push('  </part>')
  out.push('</score-partwise>')
  return out.join('\n') + '\n'
}
/* ============================ 导入（MusicXML -> 谱面）============================ */

/**
 * 最小的 XML 解析器。
 *
 * 为什么不用浏览器的 DOMParser ✗ —— 因为自检跑在 node 里没有它 ✗
 * 而"导出的东西能不能读回来"这件事**必须能自动验证** ✓
 * 自己写一个小的，反而让导入这条路可以离线测试 ✓
 *
 * 只处理 MusicXML 里真正会出现的写法：元素、属性、文本、自闭合、注释、
 * 声明、DOCTYPE、五种预定义实体 ✓
 */
export interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 直接文本内容（拼接后的）*/
  text: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function parseXml(src: string): XmlNode | null {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt))

    // 注释
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      if (end < 0) return null
      i = end + 3
      continue
    }
    // 声明 <?xml ... ?>
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt)
      if (end < 0) return null
      i = end + 2
      continue
    }
    // DOCTYPE（可能有内部子集 [...]，按括号配对跳过）
    if (src.startsWith('<!', lt)) {
      let depth = 0
      let k = lt
      for (; k < src.length; k++) {
        const c = src[k]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      if (k >= src.length) return null
      i = k + 1
      continue
    }

    const gt = src.indexOf('>', lt)
    if (gt < 0) return null
    let inner = src.slice(lt + 1, gt)
    i = gt + 1

    if (inner.startsWith('/')) {
      // 结束标签
      const tag = inner.slice(1).trim()
      const top = stack.pop()
      if (!top || top.tag !== tag) return null
      continue
    }

    const selfClose = inner.endsWith('/')
    if (selfClose) inner = inner.slice(0, -1)

    const m = inner.match(/^([^\s/]+)/)
    if (!m) return null
    const node: XmlNode = { tag: m[1], attrs: {}, children: [], text: '' }
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(inner.slice(m[1].length)))) {
      node.attrs[am[1]] = decodeEntities(am[3] !== undefined ? am[3] : am[4])
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  if (stack.length !== 1) return null
  return root
}

/** 取直接子元素里第一个某 tag */
function kid(n: XmlNode, tag: string): XmlNode | null {
  for (const c of n.children) if (c.tag === tag) return c
  return null
}
function kids(n: XmlNode, tag: string): XmlNode[] {
  return n.children.filter((c) => c.tag === tag)
}
/** 递归找第一个某 tag */
function deep(n: XmlNode, tag: string): XmlNode | null {
  for (const c of n.children) {
    if (c.tag === tag) return c
    const r = deep(c, tag)
    if (r) return r
  }
  return null
}

/** 时值（以四分音符为 1）-> 最接近的（时值 id, 是否附点）*/
export function durationForValue(value: number): { id: string; dotted: boolean; value: number } {
  const CAND: { id: string; v: number }[] = [
    { id: 'whole', v: 4 },
    { id: 'half', v: 2 },
    { id: 'quarter', v: 1 },
    { id: 'eighth', v: 0.5 },
    { id: 'sixteenth', v: 0.25 }
  ]
  for (const c of CAND) if (Math.abs(c.v - value) < 1e-6) return { id: c.id, dotted: false, value: c.v }
  for (const c of CAND) {
    if (Math.abs(c.v * 1.5 - value) < 1e-6) return { id: c.id, dotted: true, value: c.v * 1.5 }
  }
  // 对不上就取最接近的，不让整份导入失败
  let best = CAND[2]
  for (const c of CAND) if (Math.abs(c.v - value) < Math.abs(best.v - value)) best = c
  return { id: best.id, dotted: false, value: best.v }
}

const PC_OF_STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface ImportedScore {
  bars: RhythmNote[][]
  fifths: number
  beatsPerBar: number
  beatUnit: number
  title: string
  /** 被跳过的东西（复音和弦、装饰音等），用来提示用户 */
  skipped: string[]
}

export type ImportResult = { ok: true; score: ImportedScore } | { ok: false; error: string }

/**
 * 读 MusicXML。
 *
 * 只取 **第 1 声部** ✓ —— 这个应用的谱面模型是单声部的 ✗
 * MuseScore 导出的和弦会带 <chord/>、多声部会有 <backup>，
 * 全部按"跳过并计数"处理 ✓ 而不是硬塞进去把谱面搞乱 ✓
 */
export function fromMusicXml(xml: string): ImportResult {
  const root = parseXml(xml)
  if (!root) return { ok: false, error: 'XML 解析失败：文件可能不是合法的 XML' }
  const partwise = deep(root, 'score-partwise')
  if (!partwise) return { ok: false, error: '这不是 MusicXML（找不到 score-partwise 根元素）' }
  const part = kid(partwise, 'part') ?? deep(partwise, 'part')
  if (!part) return { ok: false, error: 'MusicXML 里没有 part' }

  const title = deep(partwise, 'work-title')?.text.trim() || deep(partwise, 'movement-title')?.text.trim() || '导入的谱面'

  const measures = kids(part, 'measure')
  if (!measures.length) return { ok: false, error: 'MusicXML 里没有小节' }

  let divisions = 1
  let fifths = 0
  let beatsPerBar = 4
  let beatUnit = 4
  const skipped: string[] = []
  const bars: RhythmNote[][] = []

  for (const measure of measures) {
    const attrs = kid(measure, 'attributes')
    if (attrs) {
      const d = kid(attrs, 'divisions')
      if (d) divisions = Math.max(1, Math.round(Number(d.text) || 1))
      const key = kid(attrs, 'key')
      if (key) {
        const f = kid(key, 'fifths')
        if (f) fifths = Math.max(-7, Math.min(7, Math.round(Number(f.text) || 0)))
      }
      const time = kid(attrs, 'time')
      if (time) {
        const b = kid(time, 'beats')
        const bt = kid(time, 'beat-type')
        if (b) beatsPerBar = Math.max(1, Math.round(Number(b.text) || 4))
        if (bt) beatUnit = Math.max(1, Math.round(Number(bt.text) || 4))
      }
    }

    const notes: RhythmNote[] = []
    for (const n of kids(measure, 'note')) {
      // 和弦音**照收** ✓ —— 标成 chord 让它和前一个音同时起 ✓
      // （原来是把它们跳过并计数 ✗ 那样导入 MuseScore 的和弦会只剩一个音 ✓）
      const isChordNote = !!kid(n, 'chord')
      if (kid(n, 'grace')) { skipped.push('装饰音'); continue }
      const voice = kid(n, 'voice')?.text.trim()
      if (voice && voice !== '1') { skipped.push('第 ' + voice + ' 声部'); continue }

      const durEl = kid(n, 'duration')
      const ticks = durEl ? Number(durEl.text) || 0 : 0
      const value = ticks > 0 ? ticks / divisions : 0
      if (value <= 0) { skipped.push('时值为 0 的音'); continue }

      const dv = durationForValue(value)
      const isRest = !!kid(n, 'rest')
      let midi: number | null = null
      let techString: number | null = null
      let techFret: number | null = null
      if (!isRest) {
        const pitch = kid(n, 'pitch')
        if (pitch) {
          const step = kid(pitch, 'step')?.text.trim().toUpperCase() ?? 'C'
          const alter = Number(kid(pitch, 'alter')?.text ?? 0) || 0
          const octave = Number(kid(pitch, 'octave')?.text ?? 4) || 0
          const pc = PC_OF_STEP[step]
          if (pc === undefined) { skipped.push('不认识的音名 ' + step); continue }
          midi = (octave + 1) * 12 + pc + alter
          // 吉他谱可以带 <notations><technical><string><fret>，能读就读 ✓
          const nots = kid(n, 'notations')
          const tech = nots ? deep(nots, 'technical') : null
          if (tech) {
            const sEl = deep(tech, 'string')
            const fEl = deep(tech, 'fret')
            const sv = sEl ? Number(sEl.text) : NaN
            const fv = fEl ? Number(fEl.text) : NaN
            if (Number.isFinite(sv) && Number.isFinite(fv) && sv >= 1 && sv <= 6 && fv >= 0 && fv <= 24) {
              techString = Math.round(sv)
              techFret = Math.round(fv)
            }
          }
        } else {
          skipped.push('没有音高的音符')
          continue
        }
      }
      notes.push(
        makeNote(dv.id, {
          dotted: dv.dotted,
          rest: isRest,
          midi,
          chord: isChordNote,
          string: techString,
          fret: techFret
        })
      )
    }
    bars.push(notes)
  }

  // 同一个原因只提示一次
  const uniq = [...new Set(skipped)]
  return { ok: true, score: { bars, fifths, beatsPerBar, beatUnit, title, skipped: uniq } }
}

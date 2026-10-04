/**
 * 节奏模型 —— 只有时值，没有音高。
 *
 * 所以渲染时所有音符都落在同一条线上（这就是"节奏谱"的常见形态），
 * 简谱那边统一用 1 表示音符、0 表示休止符。
 *
 * 时值统一以「四分音符 = 1」为单位，这样拍号换算只剩一条式子：
 *     一小节容量 = 拍号分子 * (4 / 拍号分母)
 * 4/4 → 4、3/4 → 3、6/8 → 3、2/2 → 4，都对得上。
 *
 * 纯逻辑，不依赖 DOM，可以用 node 跑测试。
 */

/** 一个音符的时值，单位是四分音符 */
export const QUARTER = 1

export interface DurationSpec {
  id: string
  /** 界面上按钮的文字 */
  label: string
  /** 时值（四分音符 = 1） */
  value: number
  /** 五线谱 glyph key，对应 glyphs.ts 里的 GLYPHS */
  glyph: string
  /** 简谱下划线条数（八分 1 条、十六分 2 条） */
  lines: number
  /** 简谱破折号个数（二分 1 个、全音符 3 个） */
  dashes: number
}

/** 可供输入的时值。顺序 = 界面上按钮的顺序。 */
export const DURATIONS: DurationSpec[] = [
  { id: 'whole', label: '全', value: 4, glyph: 'whole', lines: 0, dashes: 3 },
  { id: 'half', label: '二分', value: 2, glyph: 'half', lines: 0, dashes: 1 },
  { id: 'quarter', label: '四分', value: 1, glyph: 'quarter', lines: 0, dashes: 0 },
  { id: 'eighth', label: '八分', value: 0.5, glyph: 'eighth', lines: 1, dashes: 0 },
  { id: 'sixteenth', label: '十六分', value: 0.25, glyph: 'sixteenth', lines: 2, dashes: 0 }
]

const REST_GLYPH: Record<string, string> = {
  whole: 'restWhole',
  half: 'restHalf',
  quarter: 'restQuarter',
  eighth: 'restEighth',
  sixteenth: 'restSixteenth'
}

const byId = (id: string) => DURATIONS.find((d) => d.id === id) ?? DURATIONS[2]

/** 附点把时值乘以 1.5 */
export const DOT_FACTOR = 1.5

export interface RhythmNote {
  /** 基本时值的 id */
  id: string
  /**
   * 音高（MIDI 音符号）。`null` / 不填 = **只录时值，不指定音高**。
   *
   * 原来这个模型是"只有时值没有音高"的（节奏谱）✓ 现在要模仿 MuseScore
   * 那种键盘输入（选时值 → 打字音名）✓ 所以音高变成可选字段 ✓
   * 不填时一切照旧，老草稿和"纯节奏"用法都不受影响 ✓
   */
  midi?: number | null
  /**
   * 六线谱：第几弦（1 = 最细）。`null` / 不填 = 不是吉他记谱 ✓
   *
   * 和 midi 是**互补**的两套记法 ✗ 不是重复 ✓
   * 存弦和品、音高由调弦推出来 ✓ 所以换调弦/加变调夹时
   * 谱面位置不动、音高自动跟着变 ✓✓
   */
  string?: number | null
  /** 六线谱：第几品；0 = 空弦 */
  fret?: number | null
  /**
   * 这个音和**前一个音同时起**（和弦音）✓
   *
   * 照搬 MusicXML 的 <chord/> 语义 ✗ —— 标了它的音**不推进时间** ✓
   * 所以小节时值统计、横向排布都要跳过它 ✓
   * 这是把"和弦"塞进单声部模型的唯一正确办法 ✓ 而不是给每个音都算一份时值 ✓
   */
  chord?: boolean
  /** 是否附点 */
  dotted: boolean
  /** 是否休止符 */
  rest: boolean
  /** 展开后的时值（四分音符 = 1） */
  value: number
  /** 五线谱 glyph key */
  glyph: string
  /** 简谱下划线 / 破折号数量 */
  lines: number
  dashes: number
}

export function makeNote(
  id: string,
  opts: {
    dotted?: boolean
    rest?: boolean
    midi?: number | null
    string?: number | null
    fret?: number | null
    chord?: boolean
  } = {}
): RhythmNote {
  const spec = byId(id)
  const dotted = !!opts.dotted
  const rest = !!opts.rest
  return {
    id: spec.id,
    dotted,
    rest,
    midi: rest ? null : (opts.midi ?? null),
    string: rest ? null : (opts.string ?? null),
    fret: rest ? null : (opts.fret ?? null),
    chord: rest ? false : !!opts.chord,
    value: spec.value * (dotted ? DOT_FACTOR : 1),
    glyph: rest ? (REST_GLYPH[spec.id] ?? 'restQuarter') : spec.glyph,
    lines: spec.lines,
    dashes: spec.dashes
  }
}

/* --------------------------- 音高 <-> 谱面位置 --------------------------- */

/** 音级里的字母序号：C=0 D=1 E=2 F=3 G=4 A=5 B=6（升降号不改变字母）*/
const LETTER_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]

/** 高音谱表中线的音（B4）—— 五线谱上的"原点"*/
export const STAFF_REF_MIDI = 71

/**
 * 某个音高在第几"自然音级"上（跨八度连续计数）。
 *
 * 注意用的是**字母序号**而不是半音数 ✗ —— 五线谱上线间位置由字母决定 ✓
 * 比如 C#4 和 C4 在五线谱上**同一个位置** ✓ 差别只是临时记号 ✓
 * 用半音数算的话所有带升降号的音都会画错位置 ✓
 */
export function diatonicStep(midi: number): number {
  const octave = Math.floor(midi / 12) - 1
  return octave * 7 + LETTER_OF_PC[((midi % 12) + 12) % 12]
}

/** 相对高音谱表中线偏了几个"音级"（正数 = 往上）*/
export function staffStepsFromMiddle(midi: number): number {
  return diatonicStep(midi) - diatonicStep(STAFF_REF_MIDI)
}

/** 简谱数字（固定唱名，1 = C）*/
export function jianpuDigit(midi: number): number {
  const pc = ((midi % 12) + 12) % 12
  return [1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7][pc]
}

/** 这个音高是不是升/降音（简谱上要加记号）*/
export function accidentalOf(midi: number): '#' | 'b' | '' {
  const pc = ((midi % 12) + 12) % 12
  if ([1, 3, 6, 8, 10].includes(pc)) return '#'
  return ''
}

/** 一小节能装多少拍。6/8 = 6 个八分 = 3 个四分，2/2 = 2 个二分 = 4 个四分。 */
export function barCapacity(beatsPerBar: number, beatUnit: number): number {
  const n = Math.max(1, Math.round(beatsPerBar))
  const d = Math.max(1, Math.round(beatUnit))
  return (n * 4) / d
}

/**
 * 小节总时值。
 *
 * ⚠️ **和弦音不计入** ✗ —— 它们和前面的音同时起，不占额外时间 ✓
 * 不跳过的话，一个三和弦会被算成三倍的时值 ✓ 小结直接报"超出" ✓
 */
export function barTotal(notes: RhythmNote[]): number {
  let sum = 0
  for (const n of notes) if (!n.chord) sum += n.value
  return sum
}

export type BarStatus = 'empty' | 'ok' | 'pickup' | 'short' | 'long'

export interface BarCheck {
  index: number
  /** 'empty' | 'ok' | 'pickup' | 'short' | 'long' */
  status: BarStatus
  actual: number
  expected: number
  /** 差值：正数=超出，负数=不足 */
  delta: number
  message: string
}

const EPS = 1e-9

/** 把拍数说成人话："2 拍"、"1.5 拍"、"0.25 拍" */
export function beats(n: number): string {
  const r = Math.round(n * 1000) / 1000
  return `${r} 拍`
}

/**
 * 校验全部小节（**小节数不固定**）。
 *
 * 规则：
 *   · **第 1 小节**：允许不足（弱起 / pickup）—— 这是最初的"前 3 小节"需求
 *   · **最后一个小节**：也允许不足 —— 用户的实际演奏是「前四个小节 + 一个附点四分音符」，
 *     最后那一截天然装不满一小节，卡死它就没法输入
 *   · **中间的小节**：必须严丝合缝等于一小节容量
 *   · 任何小节**超出**都报错 —— 装不下的不可能是合法记谱，不能拿"不检查"当借口放过
 */
export function checkBars(
  bars: RhythmNote[][],
  beatsPerBar: number,
  beatUnit: number
): BarCheck[] {
  const cap = barCapacity(beatsPerBar, beatUnit)
  return bars.map((notes, index) => {
    const actual = barTotal(notes)
    const delta = actual - cap
    const isFirst = index === 0

    if (actual <= EPS) {
      return {
        index,
        status: 'empty' as BarStatus,
        actual,
        expected: cap,
        delta: -cap,
        message: `第 ${index + 1} 小节还是空的`
      }
    }

    if (Math.abs(delta) < EPS) {
      return {
        index,
        status: 'ok' as BarStatus,
        actual,
        expected: cap,
        delta: 0,
        message: `第 ${index + 1} 小节 ${beats(actual)}，正好`
      }
    }

    if (delta < 0) {
      const isLast = index === bars.length - 1 && bars.length > 1
      const loose = isFirst || isLast
      return {
        index,
        status: (loose ? 'pickup' : 'short') as BarStatus,
        actual,
        expected: cap,
        delta,
        message: isFirst
          ? `第 1 小节 ${beats(actual)}，不足一小节 —— 按弱起处理（允许）`
          : isLast
            ? `第 ${index + 1} 小节（最后）${beats(actual)}，不足一小节 —— 按收尾处理（允许）`
            : `第 ${index + 1} 小节只有 ${beats(actual)}，还差 ${beats(-delta)}`
      }
    }

    return {
      index,
      status: 'long' as BarStatus,
      actual,
      expected: cap,
      delta,
      message: `第 ${index + 1} 小节有 ${beats(actual)}，超出 ${beats(delta)}`
    }
  })
}

/** 是否全部通过（pickup 和 ok 都算通过） */
export function allPass(checks: BarCheck[]): boolean {
  return checks.every((c) => c.status === 'ok' || c.status === 'pickup')
}

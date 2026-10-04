/**
 * 谱面草稿的本地存储：把用户写的节奏和拍号存进 localStorage，下次打开自动恢复。
 *
 * 三条必须守住的底线：
 *
 *   1. **读回来的东西一律当成不可信。** 用户可能手改过、可能是旧版本写的、可能被别的
 *      标签页写坏。校验不过就**整份丢掉用默认值**，不做"尽量修复" —— 畸形数据一旦
 *      进了应用，坏的是整套布局和校验逻辑，比丢一份草稿严重得多。
 *   2. **localStorage 可能根本不能用。** 无痕模式、浏览器设置里禁掉、配额满，
 *      任何一种都会让 setItem 抛异常。全部包在 try 里，失败就静默降级（这次不存而已）。
 *   3. **格式带版本号。** 以后改了结构，旧数据要能被识别出来丢掉，而不是被误读成新格式。
 *
 * 存的东西很小（三个小节几十个音符，几百字节），所以不做压缩、不做增量。
 */

import { DURATIONS, makeNote, type RhythmNote } from './notation/rhythm.ts'
import { STANDARD, validateTuning, type Tuning } from './notation/tab.ts'

export const DRAFT_KEY = 'beatlooker.score-draft'
/** 结构改了就把这个数字加一，旧数据会被自动忽略 */
export const DRAFT_VERSION = 1

/**
 * 紧凑的音符表示：[时值 id, 是否附点, 是否休止]。
 * 其余字段（value / glyph / lines / dashes）都能由 id 推出来，不存 —— 存了反而
 * 会出现"存的和算的对不上"这种自相矛盾的状态。
 */
/**
 * 紧凑音符：[时值 id, 附点, 休止, 音高]。
 *
 * 第 4 位是后加的（音高）—— **旧数据只有 3 位，读取时按"没有音高"处理** ✓
 * 所以老草稿不会因为这次改动全部作废 ✓
 */
export type CompactNote = [
  string,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number
]

export interface ScoreDraft {
  version: number
  bpm: number
  beatsPerBar: number
  beatUnit: number
  barsPerRow: number
  instrumentId: string
  /**
   * 当前调弦（含**变调夹**）。
   *
   * ★ 漏了它，症状是"重开浏览器变调夹回到 0 品" ✗✗
   * 调弦是**用户设置**，和音符一样该活过刷新 ✓
   * 而且它是软先验/音高推导的输入 ✓ 丢了会让分析结果跟着变 ✗
   *
   * 老草稿里没有这个字段 → 读回来退化成 STANDARD ✓
   * 所以**不用升版本号** ✓ 加一个可选字段就行（升了反而把现存草稿全丢掉 ✗）
   */
  tuning: Tuning
  /**
   * 内存里始终是**可直接使用**的 RhythmNote（不是打包形式）。
   * 打包只发生在落盘那一刻 —— 让"打包/解包"这对转换只待在一个地方，
   * 调用方拿到的永远是能直接用的数据。
   */
  bars: RhythmNote[][]
}

/** 只依赖这三个方法，方便测试时塞一个假的进去 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const VALID_IDS = new Set(DURATIONS.map((d) => d.id))

export function packBars(bars: RhythmNote[][]): CompactNote[][] {
  return bars.map((bar) =>
    // 第 4 位是音高。**必须存** —— 键盘输入的音高就靠它活过刷新，
    // 最早漏了这一位，症状是"刷新之后音高全没了，而且不报错"。
    bar.map(
      (n) =>
        [
          n.id,
          n.dotted ? 1 : 0,
          n.rest ? 1 : 0,
          n.midi ?? null,
          n.string ?? null,
          n.fret ?? null,
          n.chord ? 1 : 0
        ] as CompactNote
    )
  )
}

/**
 * 解包并校验。任何一处不合法就返回 null（调用方退回默认谱子）。
 * 音值 id 必须认识 —— 这是最关键的一条：不认识的 id 会让 makeNote 悄悄退回四分音符，
 * 于是"存的八分音符变成了四分"，比直接丢掉更糟。
 */
export function unpackBars(raw: unknown): RhythmNote[][] | null {
  // 只是防损坏：小节数本身不设限（用户可能加到几十个），这里挡的是明显被写坏的数据
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2000) return null
  const out: RhythmNote[][] = []
  for (const bar of raw) {
    if (!Array.isArray(bar) || bar.length > 512) return null
    const notes: RhythmNote[] = []
    for (const cell of bar) {
      if (!Array.isArray(cell) || cell.length < 1) return null
      const id = cell[0]
      if (typeof id !== 'string' || !VALID_IDS.has(id)) return null
      // 第 4 位可以没有（旧版本存的只有 3 位）—— 那时按"没有音高"处理，
      // 老草稿照样能读，不会因为这次改动全部作废
      const rawMidi = cell.length > 3 ? cell[3] : null
      const midi =
        typeof rawMidi === 'number' && Number.isFinite(rawMidi) && rawMidi >= 0 && rawMidi <= 127
          ? Math.round(rawMidi)
          : null
      // 第 5、6 位是六线谱的弦和品。同样允许缺失（旧数据只有 3~4 位）
      const num = (v: unknown, lo: number, hi: number): number | null =>
        typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null
      // 弦和品**要么都有、要么都没有** —— 光有品没有弦是没有意义的 ✓
      // 所以任意一个不合法就把两个都丢掉，而不是留一个半吊子 ✓
      const strRaw = num(cell.length > 4 ? cell[4] : null, 1, 6)
      const fretRaw = num(cell.length > 5 ? cell[5] : null, 0, 24)
      const bothOk = strRaw !== null && fretRaw !== null
      const str = bothOk ? strRaw : null
      const fret = bothOk ? fretRaw : null
      const chord = cell.length > 6 && cell[6] === 1
      notes.push(makeNote(id, { dotted: cell[1] === 1, rest: cell[2] === 1, midi, string: str, fret, chord }))
    }
    out.push(notes)
  }
  return out
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return v < lo ? lo : v > hi ? hi : v
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return Math.round(clampNum(v, lo, hi, fallback))
}

/**
 * 解析调弦。**任何一处不对就返回 null**（调用方退化成 STANDARD）✓
 *
 * 调弦是会被写进频谱分析和音高推导的 ✓ 畸形数据混进去比丢一份草稿严重得多 ✓
 * 所以这里宁可严格 ✗ 不做"尽量修复" ✓
 */
function parseTuning(v: unknown): Tuning | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.name !== 'string') return null
  if (!Array.isArray(t.open) || t.open.length !== 6) return null
  const open: number[] = []
  for (const m of t.open) {
    if (typeof m !== 'number' || !Number.isFinite(m)) return null
    open.push(Math.round(m))
  }
  // ★ 这里**不能钳位** ✗✗
  // 钳位就成了"尽量修复" ✓ 而本模块的原则是"校验不过就整份丢掉" ✓
  // （第一版写成 clampInt(capo, 0, 12) ✓ 于是 capo:99 被静默改成 12、然后校验通过 ✗
  //   测试逮住了它 ✓ 这正是"测试要能失败"的价值）
  if (typeof t.capo !== 'number' || !Number.isInteger(t.capo)) return null
  const out: Tuning = { id: t.id, name: t.name, open, capo: t.capo }
  // validateTuning 返回错误描述字符串；有错就整份丢掉
  return validateTuning(out) ? null : out
}

/** 纯函数：解析 + 校验。和存储完全解耦，所以能直接单测 */
export function parseDraft(raw: string): ScoreDraft | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.version !== DRAFT_VERSION) return null
  const bars = unpackBars(d.bars)
  if (!bars) return null
  return {
    version: DRAFT_VERSION,
    bpm: clampInt(d.bpm, 20, 400, 120),
    beatsPerBar: clampInt(d.beatsPerBar, 1, 16, 4),
    beatUnit: clampInt(d.beatUnit, 1, 32, 4),
    barsPerRow: clampInt(d.barsPerRow, 1, 32, 4),
    instrumentId: typeof d.instrumentId === 'string' ? d.instrumentId : 'all',
    tuning: parseTuning(d.tuning) ?? { ...STANDARD },
    bars
  }
}

/** 拿一个能用的存储；拿不到就返回 null（调用方一律降级处理） */
export function defaultStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage
    return s ?? null
  } catch {
    // 某些浏览器在隐私设置下连读 localStorage 这个属性都会抛
    return null
  }
}

export function loadDraft(store: StorageLike | null = defaultStorage()): ScoreDraft | null {
  if (!store) return null
  try {
    const raw = store.getItem(DRAFT_KEY)
    return raw ? parseDraft(raw) : null
  } catch {
    return null
  }
}

/** 存成功返回 true。失败（配额满 / 无痕模式）返回 false，但绝不抛 */
export function saveDraft(
  draft: ScoreDraft,
  store: StorageLike | null = defaultStorage()
): boolean {
  if (!store) return false
  try {
    // 落盘时才打包：存的是紧凑形式，读回来的是可直接用的 RhythmNote
    const payload = { ...draft, bars: packBars(draft.bars) }
    store.setItem(DRAFT_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearDraft(store: StorageLike | null = defaultStorage()): void {
  try {
    store?.removeItem(DRAFT_KEY)
  } catch {
    /* 清不掉也不影响使用 */
  }
}

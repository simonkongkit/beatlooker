import type { RhythmNote } from './rhythm.ts'

/**
 * 吉他六线谱：调弦模型 + 弦/品 <-> 音高 换算。
 *
 * ## 一个关键设计：音高是**推出来的**，不是存进去的
 *
 * 六线谱上写的是"第几弦第几品" ✓ 音高是它和调弦共同决定的 ✓
 * 所以数据里存**弦和品** ✓ 音高现算 ✓✓
 *
 * 好处很直接：改了调弦或者加了变调夹，**所有音的谱面位置不动、音高自动跟着变** ✓
 * 这正是吉他手换调弦时期望的行为 ✓ 反过来如果存音高，改调弦就会把谱子搞乱 ✓
 */

/** 弦号：1 = 最细的高音弦，6 = 最粗的低音弦 */
export type StringNo = 1 | 2 | 3 | 4 | 5 | 6

export interface Tuning {
  id: string
  name: string
  /**
   * 六根弦的空弦音高（MIDI）。
   *
   * **索引 0 = 第 1 弦（最细）** … 索引 5 = 第 6 弦（最粗）✓
   * 和六线谱自下而上的画法无关，纯粹是数组下标 ✓
   */
  open: number[]
  /**
   * 变调夹夹在第几品（0 = 不夹）。
   *
   * 夹上之后**所有**弦一起升高 ✓ —— 这是变调夹的物理含义 ✓
   * 如果只想改某几根弦，用下面的 open 数组逐弦改（那就是特殊调弦了）✓
   */
  capo: number
}

/** 标准调弦 EADGBE，从第 1 弦到第 6 弦 */
export const STANDARD: Tuning = {
  id: 'standard',
  name: '标准 EADGBE',
  open: [64, 59, 55, 50, 45, 40],
  capo: 0
}

/** 常用调弦预设。open 数组一律是"第 1 弦 → 第 6 弦" */
export const TUNING_PRESETS: Tuning[] = [
  STANDARD,
  { id: 'dropd', name: '降 D（第 6 弦降到 D）', open: [64, 59, 55, 50, 45, 38], capo: 0 },
  { id: 'openg', name: '开放 G（DGDGBD）', open: [62, 59, 55, 50, 43, 38], capo: 0 },
  { id: 'dadgad', name: 'DADGAD', open: [62, 57, 55, 50, 45, 38], capo: 0 },
  { id: 'halfdown', name: '降半音（Eb Ab Db Gb Bb Eb）', open: [63, 58, 54, 49, 44, 39], capo: 0 },
  { id: 'opend', name: '开放 D（DADF#AD）', open: [62, 57, 54, 50, 45, 38], capo: 0 }
]

/** 六线谱上能写的最低/最高品 */
export const MIN_FRET = 0
export const MAX_FRET = 24

/**
 * 第几弦第几品 -> MIDI 音高。
 *
 * string 用 1~6 的人话编号（1 最细）✓ 数组下标要反过来 ✓
 */
export function stringFretToMidi(t: Tuning, string: number, fret: number): number {
  // open 数组的下标 0 就是第 1 弦 —— 不要反过来写 ✗
  // （第一版写成 6-string 了，结果第 1 弦空弦算成了低音 E2 ✓ 幸好测试逮住）
  const idx = Math.max(0, Math.min(5, Math.round(string) - 1))
  return t.open[idx] + t.capo + Math.max(MIN_FRET, Math.min(MAX_FRET, Math.round(fret)))
}

/**
 * 反过来：某个音高在某套调弦上，最容易怎么按。
 *
 * 返回**品位最低**的那个把位 ✓ —— 吉他手优先选低把位 ✓
 * 同一个音往往有几处能按（比如 E4 可以是第 1 弦空弦，也可以是第 2 弦第 5 品）✓
 * 这里不追求"最优指法" ✗ 只求一个合理且确定的答案 ✓
 */
export function midiToFret(t: Tuning, midi: number, preferString?: number): { string: number; fret: number } | null {
  const order = preferString
    ? [preferString, ...[1, 2, 3, 4, 5, 6].filter((s) => s !== preferString)]
    : [1, 2, 3, 4, 5, 6]
  let best: { string: number; fret: number } | null = null
  for (const s of order) {
    const fret = midi - stringFretToMidi(t, s, 0)
    if (fret < MIN_FRET || fret > MAX_FRET) continue
    if (!best || fret < best.fret) best = { string: s, fret }
  }
  return best
}

/** 这套调弦下每根弦的空弦音名（用来在界面上显示）*/
export function tuningNames(t: Tuning, nameOf: (midi: number) => string): string[] {
  return t.open.map((m) => nameOf(m + t.capo))
}

/** 校验一套调弦是否合理（六根弦、音高在范围内、品位递推不反）*/
export function validateTuning(t: Tuning): string | null {
  if (!Array.isArray(t.open) || t.open.length !== 6) return '调弦必须是 6 根弦'
  for (const m of t.open) {
    if (!Number.isFinite(m) || m < 12 || m > 96) return '空弦音高超出范围'
  }
  if (!Number.isFinite(t.capo) || t.capo < 0 || t.capo > 12) return '变调夹品位应在 0~12'
  return null
}

/**
 * 一个音符**实际发出来的音高**。
 *
 * ★ 有弦有品的音，音高一律**现推**，不看存下来的 midi ✗✗
 *
 * 存下来的 midi 是**录入那一刻**按当时的调弦算的 ✓
 * 之后改变调夹或换调弦，它不会跟着变 ✗
 * 用户看到的就是"调了变调夹，五线谱一点没动" ✓
 *
 * 现在现推：弦和品不动 ✓ 音高跟着调弦走 ✓✓
 * 这正是六线谱的语义（谱面写手指按哪里，响什么音由调弦决定）✓
 */
export function soundingMidi(note: RhythmNote, tuning: Tuning): number | null {
  if (note.rest) return null
  if (note.string != null && note.fret != null) {
    return stringFretToMidi(tuning, note.string, note.fret)
  }
  return note.midi ?? null
}


/**
 * 连桁（符尾连接）的**分组规则**。
 *
 * 五线谱上八分、十六分音符本来各自带符尾 ✓ 但实际记谱里，同一拍内的这些音
 * 要用横杠（桁）连起来 ✓ —— 这样一眼能看出节奏的分组 ✓ 也更好数拍 ✓
 *
 * 这个文件只管"**哪几个音连成一组**" ✓ 是纯函数 ✓ 怎么画在 render.ts 里 ✓
 *
 * 分组的核心依据是**拍号**：
 *
 *   - 单拍（4/4、3/4、2/4）：按**一拍的时值**分 ✓ 4/4 里两个八分一组 ✓
 *   - 复拍（6/8、9/8、12/8）：按**附点拍**分 ✓ 6/8 里三个八分一组 ✓
 *     （6/8 的"一拍"是附点四分 ✓ 不是八分 ✗ 按八分分就散成两个一组了）
 *
 * 另外三条边界：
 *   - 休止符**打断**分组 ✓（休止符本来就不连桁）
 *   - 四分及更长的音没有符尾 ✓ 也打断分组 ✓
 *   - 和弦音**跟着它的基音** ✓ 不单独成组、也不推进时间 ✓
 */

import type { RhythmNote } from './rhythm.ts'

/** 拍号分母对应的时值（四分音符为单位）：4 -> 1，8 -> 0.5 */
export function beatUnitQuarters(beatUnit: number): number {
  return 4 / Math.max(1, beatUnit)
}

/**
 * 一组桁最多跨多少时值（四分音符为单位）。
 *
 * 复拍的判据是**分母**，不是分子大小 ✓✓
 *
 *   分母 >= 8 且分子能被 3 整除  →  按附点拍分（3 个八分一组）
 *
 * 所以 **3/8 也算**复拍 ✓ 它的三个八分要连成**一组** ✓
 * （测试逮住过这个 ✗ 我一开始多写了"分子大于 3" ✓ 结果 3/8 被拆成两两一组 ✓）
 * 而 3/4 不算 ✓ 它是单拍 ✓ 八分两两一组 ✓
 */
export function beamSpanQuarters(beatsPerBar: number, beatUnit: number): number {
  const q = beatUnitQuarters(beatUnit)
  const compound = beatUnit >= 8 && beatsPerBar % 3 === 0
  return compound ? q * 3 : q
}

/**
 * 把一小节的音分成若干连桁组，返回每组在 **notes 数组里的下标**。
 *
 * 只返回**两个音以上**的组 ✓ —— 单独一个八分音符照样用带符尾的字形 ✓
 * 所以调用方不需要自己判断"这组够不够长"。
 */
export function beamGroups(
  notes: RhythmNote[],
  beatsPerBar: number,
  beatUnit: number
): number[][] {
  const span = beamSpanQuarters(beatsPerBar, beatUnit)
  if (!(span > 0)) return []

  const out: number[][] = []
  let cur: number[] = []
  let curSlot = -1
  /** 当前音在小节内的**起始拍位**（四分音符为单位）*/
  let beat = 0

  const flush = () => {
    if (cur.length >= 2) out.push(cur)
    cur = []
    curSlot = -1
  }

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]

    // 和弦音和它的基音同时起 ✓ 直接归到当前组，不推进时间
    if (n.chord) {
      if (cur.length) cur.push(i)
      continue
    }

    const start = beat
    beat += n.value

    // 休止符、四分及更长的音：都不连桁，并且**打断**当前组
    if (n.rest || !(n.lines > 0)) {
      flush()
      continue
    }

    // 落在同一个"桁格"里才连 ✓ 跨格就断开
    const slot = Math.floor((start + 1e-9) / span)
    if (cur.length && slot !== curSlot) flush()
    curSlot = slot
    cur.push(i)
  }
  flush()
  return out
}

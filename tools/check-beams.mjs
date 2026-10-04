/**
 * 连桁分组规则的自检：node tools/check-beams.mjs
 *
 * 这里只测**分组对不对** ✓ 画得漂不漂亮不归它管 ✓
 * 分组是乐理规则 ✓ 错了一眼就能看出来（八分音符该两个一组却连成四个）✓
 */
import assert from 'node:assert/strict'
import { beamGroups, beamSpanQuarters } from '../src/lib/notation/beams.ts'
import { makeNote } from '../src/lib/notation/rhythm.ts'

const e = () => makeNote('eighth')
const s = () => makeNote('sixteenth')
const q = () => makeNote('quarter')
const h = () => makeNote('half')
const rest = (id = 'eighth') => makeNote(id, { rest: true })

const label = (g) => JSON.stringify(g)

// ---- 1. 4/4：一拍两个八分，八分音符两两成组 ----
{
  const notes = [e(), e(), e(), e(), e(), e(), e(), e()]
  const g = beamGroups(notes, 4, 4)
  assert.equal(g.length, 4, '4/4 里 8 个八分应分成 4 组，实得 ' + label(g))
  assert.deepEqual(g, [[0, 1], [2, 3], [4, 5], [6, 7]], '每拍两个一组，实得 ' + label(g))
}

// ---- 2. 6/8 是复拍：三个八分一组（附点拍），不是两个 ----
{
  const notes = [e(), e(), e(), e(), e(), e()]
  const g = beamGroups(notes, 6, 8)
  assert.equal(g.length, 2, '6/8 里 6 个八分应分成 2 组，实得 ' + label(g))
  assert.deepEqual(g, [[0, 1, 2], [3, 4, 5]], '复拍按附点拍三个一组，实得 ' + label(g))
}

// ---- 3. 3/8 **是**复拍：三个八分连成一组 ----
// 判据是分母不是分子大小 ✓ 3/8 的三个八分算一个附点拍 ✓
{
  const notes = [e(), e(), e()]
  assert.equal(beamSpanQuarters(3, 8), 1.5, '3/8 的一组应跨 1.5 个四分音符')
  const g = beamGroups(notes, 3, 8)
  assert.deepEqual(g, [[0, 1, 2]], '3/8 的三个八分应连成一组，实得 ' + label(g))
}

// ---- 3b. 3/4 是单拍：八分还是两两一组 ----
{
  const notes = [e(), e(), e(), e(), e(), e()]
  const g = beamGroups(notes, 3, 4)
  assert.deepEqual(g, [[0, 1], [2, 3], [4, 5]], '3/4 应两两一组，实得 ' + label(g))
}

// ---- 4. 12/8 也是复拍 ----
{
  assert.equal(beamSpanQuarters(12, 8), 1.5, '12/8 的一组应跨 1.5 个四分音符')
  const notes = Array.from({ length: 12 }, e)
  const g = beamGroups(notes, 12, 8)
  assert.equal(g.length, 4, '12/8 里 12 个八分应分成 4 组，实得 ' + g.length)
}

// ---- 5. 休止符打断分组 ----
{
  // 用一个**整拍**的休止 ✓ 这样后面的八分仍落在拍上 ✓
  const notes = [e(), e(), rest('quarter'), e(), e()]
  const g = beamGroups(notes, 4, 4)
  assert.deepEqual(g, [[0, 1], [3, 4]], '休止符两边各自成组，实得 ' + label(g))

  // ★ 半拍休止会把后面的音**推离拍线** ✓ 于是它们跨拍、不能连成一条桁 ✓
  // （我一开始就写错在这里 ✗ 以为休止后面还是两两一组 ✓ 代码才是对的 ✓）
  const offbeat = [e(), e(), rest('eighth'), e(), e()]
  assert.deepEqual(
    beamGroups(offbeat, 4, 4),
    [[0, 1]],
    '八分休止后面的两个八分落在 1.5 / 2.0 拍，跨拍不该连，实得 ' + label(beamGroups(offbeat, 4, 4))
  )
}

// ---- 6. 四分及更长的音打断分组（它们本来就没有符尾）----
{
  const notes = [e(), e(), q(), e(), e()]
  const g = beamGroups(notes, 4, 4)
  assert.deepEqual(g, [[0, 1], [3, 4]], '四分音符应打断分组，实得 ' + label(g))
}

// ---- 7. 孤立的一个八分不连 ----
{
  assert.deepEqual(beamGroups([e()], 4, 4), [], '单个八分不该成组')
  assert.deepEqual(beamGroups([e(), q(), e()], 4, 4), [], '被四分隔开的两个八分也不该成组')
  assert.deepEqual(beamGroups([h()], 4, 4), [], '二分音符没有符尾')
}

// ---- 8. 跨拍的分组要断开 ----
{
  // 八分 + 八分（第 1 拍） + 八分 + 八分（第 2 拍）—— 正好两拍
  const notes = [e(), e(), e(), e()]
  const g = beamGroups(notes, 4, 4)
  assert.deepEqual(g, [[0, 1], [2, 3]], '不能把两拍连成一条长桁，实得 ' + label(g))

  // 弱起小节只有 1 拍：两个八分仍然一组
  const pickup = [e(), e()]
  assert.deepEqual(beamGroups(pickup, 4, 4), [[0, 1]], '弱起小节的八分也要连')
}

// ---- 9. 十六分：一拍里的四个连成一组 ----
// （要几条桁由 render 那边按每个音的 lines 决定，不归分组管）
{
  const notes = [s(), s(), s(), s()]
  const g = beamGroups(notes, 4, 4)
  assert.deepEqual(g, [[0, 1, 2, 3]], '一拍内的四个十六分应连成一组，实得 ' + label(g))

  // 混时值：八分 + 两个十六分 = 正好 1 拍 ✓ 一组
  // （算总时值是必须的 ✗ 我一开始写成 [八分,十六,十六,八分] = 1.5 拍 ✓
  //   那就跨拍了 ✓ 代码把它断开才是对的 ✓ 连着栽了两次）
  const mixed = [e(), s(), s()]
  assert.deepEqual(
    beamGroups(mixed, 4, 4),
    [[0, 1, 2]],
    '混时值同拍内应成组，实得 ' + label(beamGroups(mixed, 4, 4))
  )
}

// ---- 10. 和弦音跟着基音，不单独成组、也不推进时间 ----
{
  const base = makeNote('eighth')
  const chordNote = makeNote('eighth', { chord: true })
  const notes = [base, chordNote, e(), chordNote]
  const g = beamGroups(notes, 4, 4)
  // 基音在 0 拍、第二个基音在 0.5 拍 -> 同一拍，四个下标全进一组
  assert.deepEqual(g, [[0, 1, 2, 3]], '和弦音应跟基音同组且不推进时间，实得 ' + label(g))
}

// ---- 11. 空小节、单音符都不该出错 ----
{
  assert.deepEqual(beamGroups([], 4, 4), [], '空小节应返回空')
  assert.deepEqual(beamGroups([q()], 4, 4), [], '单个四分不应成组')
}

console.log('✓ 连桁分组通过（4/4 两两 / 6/8 与 3/8 复拍三三 / 3/4 两两 / 休止与四分打断 / 跨拍断开 / 弱起 / 和弦）')

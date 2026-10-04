/**
 * 把三小节节奏画出来：五线谱 + 简谱。
 *
 * 分成两层：
 *   · layoutStaff / layoutJianpu —— **纯函数**，只算位置，不碰 Canvas（可单测）
 *   · renderRhythm —— 真正落笔
 *
 * 两种记谱的横向排布规则不同，这是刻意的：
 *   · 五线谱按**时值比例**排（真实的记谱方式），所以弱起小节自然就窄
 *   · 简谱按**字符格**排（一个音符一格，附带的破折号各占一格），字符等距
 */

import type { BarCheck, RhythmNote } from './rhythm.ts'
import { theme } from '../theme.ts'

/** 画布用色统一走主题 —— 换配色时画布和界面不会各变各的 */
const ink = () => theme().canvas.ink
import {
  accidentalOf,
  barCapacity,
  barTotal,
  jianpuDigit,
  staffStepsFromMiddle
} from './rhythm.ts'
import { GLYPHS, STEM_H, STEM_W, STEM_X, toD } from './glyphs.ts'
import { beamGroups } from './beams.ts'
import { STANDARD, midiToFret, soundingMidi, type Tuning } from './tab.ts'

export interface NoteSlot {
  note: RhythmNote
  /** 音符中心 x */
  x: number
}

export interface BarBox {
  index: number
  x: number
  width: number
  total: number
  notes: NoteSlot[]
}

export interface RhythmLayout {
  bars: BarBox[]
  /** 小节线 x 坐标，长度 = bars.length + 1（最后一条是终止线） */
  dividers: number[]
}

/** 按权重把 [x0, x1] 切成若干段 */
function slice(x0: number, x1: number, weights: number[]): { x: number; width: number }[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const total = x1 - x0
  const safe = sum > 0 ? sum : weights.length
  let x = x0
  return weights.map((w) => {
    const width = sum > 0 ? (total * w) / safe : total / weights.length
    const box = { x, width }
    x += width
    return box
  })
}

/**
 * 小节框：**两种记谱共用同一套宽度**。
 *
 * 第一版让五线谱按「时值比例」、简谱按「字符格数」各算各的宽度，结果上下两行
 * 的小节线对不上，堆在一起看非常乱。小节宽度是**乐理信息**（弱起小节就该窄），
 * 不该由"用哪种记谱"决定；两种记谱的差别只在小节**内部**的排布规则。
 */
export function barBoxes(
  bars: RhythmNote[][],
  beatsPerBar: number,
  beatUnit: number,
  x0: number,
  x1: number
): { boxes: { x: number; width: number }[]; totals: number[] } {
  const cap = barCapacity(beatsPerBar, beatUnit)
  // 下限用小节容量的 1/4，避免空小节或极短小节宽度塌成 0
  const floor = cap / 4
  const totals = bars.map(barTotal)
  return { boxes: slice(x0, x1, totals.map((t) => Math.max(t, floor))), totals }
}

/** 五线谱：音符落在各自时值格的中心（宽度按时值比例，这是真实记谱方式） */
export function layoutStaff(
  bars: RhythmNote[][],
  beatsPerBar: number,
  beatUnit: number,
  x0: number,
  x1: number
): RhythmLayout {
  const { boxes, totals } = barBoxes(bars, beatsPerBar, beatUnit, x0, x1)

  const out = bars.map((notes, i) => {
    const total = totals[i]
    let cum = 0
    // 记住上一个**非和弦**音的位置：和弦音直接画在那里 ✓
    // （不推进 cum ✗ 否则一个三和弦会被摊成三个连续的音，看起来像琶音 ✓）
    let lastX = boxes[i].x
    const slots: NoteSlot[] = notes.map((note) => {
      if (note.chord) return { note, x: lastX }
      const center = cum + note.value / 2
      cum += note.value
      const x = total > 0 ? boxes[i].x + (boxes[i].width * center) / total : boxes[i].x
      lastX = x
      return { note, x }
    })
    return { index: i, x: boxes[i].x, width: boxes[i].width, total, notes: slots }
  })

  const dividers = out.map((b) => b.x)
  dividers.push(out.length ? out[out.length - 1].x + out[out.length - 1].width : x1)
  return { bars: out, dividers }
}

/** 简谱：小节框同上，但**小节内部**按字符格等距（一个音符占 1 + 破折号数 格） */
export function layoutJianpu(
  bars: RhythmNote[][],
  beatsPerBar: number,
  beatUnit: number,
  x0: number,
  x1: number
): RhythmLayout {
  const { boxes } = barBoxes(bars, beatsPerBar, beatUnit, x0, x1)
  const slotCount = bars.map((notes) =>
    notes.reduce((sum, n) => sum + 1 + (n.dashes || 0), 0)
  )

  const out = bars.map((notes, i) => {
    const per = boxes[i].width / Math.max(1, slotCount[i])
    let cum = 0
    const slots: NoteSlot[] = notes.map((note) => {
      // 和弦音不占格：和上一个音同 x ✓
      const x = note.chord ? boxes[i].x + per * (cum - 0.5) : boxes[i].x + per * (cum + 0.5)
      if (!note.chord) cum += 1 + (note.dashes || 0)
      return { note, x }
    })
    return { index: i, x: boxes[i].x, width: boxes[i].width, total: barTotal(notes), notes: slots }
  })

  const dividers = out.map((b) => b.x)
  dividers.push(out.length ? out[out.length - 1].x + out[out.length - 1].width : x1)
  return { bars: out, dividers }
}

/**
 * 五线谱上调号的写法。
 *
 * 升号出现顺序是 F C G D A E B ✓ 降号是 B E A D G C F ✓
 * 而且**每个号在谱线上的高低是固定的** ✗ —— 不是随便找地方放 ✓
 * 这是记谱法规定的位置，照抄就对了 ✓
 */
const SHARP_STEPS = [77, 72, 79, 74, 69, 76, 71] // F5 C5 G5 D5 A4 E5 B4
const FLAT_STEPS = [71, 76, 69, 74, 67, 72, 65] // B4 E5 A4 D5 G4 C5 F4

/** 调号占多宽（像素）*/
export function keySignatureWidth(fifths: number): number {
  const n = Math.abs(Math.round(fifths || 0))
  return n === 0 ? 0 : 10 + n * 11
}

export interface RenderRhythmOptions {
  ctx: CanvasRenderingContext2D
  /** 画布尺寸（CSS 像素） */
  width: number
  height: number
  bars: RhythmNote[][]
  beatsPerBar: number
  beatUnit: number
  /** 校验结果，用来把出错的小节标红；不传就不标 */
  checks?: BarCheck[]
  /** 'staff' | 'jianpu' | 'both' */
  mode?: 'staff' | 'jianpu' | 'both' | 'tab' | 'staff-tab'
  /** 六线谱用的调弦（含变调夹）。不传就是标准调弦 */
  tuning?: Tuning
  /**
   * 正在输入的音的**预览**（画在六线谱上"它将要落下的位置"）。
   *
   * 原来只有"按了空格的和弦"有预览 ✗ 而且画在小节**最右端** ✓
   * 用户反馈两点：①正在敲的品号也该有预览 ✓
   * ②预览离输入位置**太远** ✓ 应该就在它要落下的地方 ✓
   */
  pendingPreview?: PendingPreview | null
  /**
   * 被选中的音符（"文本编辑"式的选区）。
   *
   * 用户要求：**能拖拽选取几个符头，然后改时值或删除** ✓
   * 这里只管画高亮 ✓ 选区的状态归 App 管 ✓
   */
  selection?: { bar: number; index: number }[]
  /** 光标位置（选区的活动端）—— 画一个竖线，像文本光标 */
  cursor?: { bar: number; index: number } | null
  /** 调号：几个升号（正）/ 降号（负）。五线谱上会真的画出升/降号 */
  fifths?: number
  /**
   * 回放头位置，单位是**相对谱面第一拍的拍数**（可以是小数或负数）。
   * 给了就在五线谱上画一条跟随播放的竖线 ✓
   */
  playheadBeat?: number | null
  background?: string
  color?: string
  muted?: string
  bad?: string
}

export interface PendingPreview {
  /** 目标小节下标（0 起）*/
  bar: number
  /** 即将插入音符的时值（四分音符为单位）*/
  value: number
  /** 已经按过空格、还没回车的弦/品 */
  notes: { string: number; fret: number }[]
  /**
   * 正在敲的品号（还没按空格）。
   * 画成**空心**的，和已经确定的那几个区分开 ✓
   */
  typing?: { string: number; text: string } | null
}

const PAD = 14
/** 左边留给拍号的位置 */
const METER_W = 40

function usePath(d: string): Path2D {
  return new Path2D(d)
}

/** 画一个 glyph（原点 = 符头中心，单位 staff space） */
function paintGlyph(ctx: CanvasRenderingContext2D, key: string, size: number) {
  const g = GLYPHS[key]
  if (!g) return
  for (const sh of g.shapes) {
    const p = usePath(toD(sh.cmds))
    if (sh.mode === 'fill') {
      ctx.fill(p)
    } else {
      ctx.lineWidth = (sh.width ?? 0.15) // 已经在 scale(size) 坐标系里
      ctx.stroke(p)
    }
  }
}

function barIsBad(checks: BarCheck[] | undefined, index: number): boolean {
  const c = checks?.[index]
  return !!c && c.status !== 'ok' && c.status !== 'pickup'
}

function barIsPickup(checks: BarCheck[] | undefined, index: number): boolean {
  return checks?.[index]?.status === 'pickup'
}

/** 画五线谱那一条带 */
function drawStaffBand(o: RenderRhythmOptions, top: number, height: number) {
  const { ctx, bars, beatsPerBar, beatUnit, checks } = o
  const color = o.color ?? ink().text
  const muted = o.muted ?? ink().dim
  const bad = o.bad ?? ink().warn

  // 每次重画都重建命中表 —— 布局算法一改，命中表自动跟着对 ✓
  staffHits = []

  // ---- 纵向尺寸：按**谱面上实际用到的音域**反推，而不是只看画布高度 ----
  //
  // 原来只按高度算（(height-34)/6 并夹到 13）✗ 完全没看有哪些音 ✓
  // 结果：低音 E2（吉他最粗的空弦）在中线下方 18 个音级 ✓
  // 需要 9 个行距的高度 ✗ 而画布只给得起 4~5 个 ✓ 最低音直接被裁掉 ✓
  //
  // 现在的做法：先量出音域跨度，再反解行距 ✓ 并让这段音域在画布里**居中** ✓
  // 一处修好，所有画五线谱的地方（录入、分析预览）全都对 ✓
  let lo = -1
  let hi = 1
  const tune = o.tuning ?? STANDARD
  for (const bar of o.bars) {
    for (const n of bar) {
      const m = soundingMidi(n, tune)
      if (m == null || n.rest) continue
      const s = staffStepsFromMiddle(m)
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
  }
  // 上下各留一个音级，免得加线贴着画布边缘
  lo -= 1
  hi += 1
  const spanSteps = Math.max(4, hi - lo)

  // 需要的纵向空间 = 音级跨度 × (size/2) + 五线谱本身的行距 + 边距
  // 反解 size；下限 5 保证再挤也看得清，上限 15 避免音少时撑得过大
  const size = Math.max(5, Math.min(15, (height - 26) / (spanSteps / 2 + 4.5)))

  // 让 [lo, hi] 这段的中点在画布里居中，再反推中线（steps = 0）的位置
  const midStep = (lo + hi) / 2
  const baseY = top + height / 2 + midStep * (size / 2)
  const staffTop = baseY - 2 * size

  // 调号插在拍号和音符之间：先腾出位置，再画
  const fifths = Math.max(-7, Math.min(7, Math.round(o.fifths ?? 0)))
  const keyW = keySignatureWidth(fifths)
  const lay = layoutStaff(bars, beatsPerBar, beatUnit, PAD + METER_W + keyW, o.width - PAD)

  // 五线谱线
  ctx.strokeStyle = muted
  ctx.globalAlpha = 0.45
  ctx.lineWidth = 1
  for (let i = 0; i < 5; i++) {
    const y = Math.round(staffTop + i * size) + 0.5
    ctx.beginPath()
    ctx.moveTo(PAD, y)
    ctx.lineTo(lay.dividers[lay.dividers.length - 1], y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // 小节线（终止线画双线）
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  for (let i = 0; i < lay.dividers.length; i++) {
    const x = Math.round(lay.dividers[i]) + 0.5
    const isLast = i === lay.dividers.length - 1
    ctx.beginPath()
    ctx.moveTo(x, staffTop)
    ctx.lineTo(x, staffTop + 4 * size)
    ctx.stroke()
    if (isLast) {
      ctx.beginPath()
      ctx.moveTo(x - 4, staffTop)
      ctx.lineTo(x - 4, staffTop + 4 * size)
      ctx.stroke()
    }
  }

  // 拍号
  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(size * 1.9)}px ui-monospace, Consolas, monospace`
  const mx = PAD + METER_W / 2 + 4
  ctx.fillText(String(Math.round(beatsPerBar)), mx, staffTop + size)
  ctx.fillText(String(Math.round(beatUnit)), mx, staffTop + size * 3)

  // 调号：升号按 F C G D A E B 的顺序，降号按 B E A D G C F
  if (fifths !== 0) {
    const steps = fifths > 0 ? SHARP_STEPS : FLAT_STEPS
    const n = Math.abs(fifths)
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${Math.round(size * 2.1)}px "Segoe UI Symbol", "Noto Music", serif`
    for (let i = 0; i < n && i < steps.length; i++) {
      const st = staffStepsFromMiddle(steps[i])
      const x = PAD + METER_W + 8 + i * 11
      // 直接用 staffTop/size 算，不依赖下面才声明的 baseY（那是音符用的）
      ctx.fillText(fifths > 0 ? '♯' : '♭', x, staffTop + 2 * size - st * (size / 2))
    }
  }

  // 音符
  //
  // 位置按**自然音级差**决定（不是半音差 ✗）—— 五线谱的线间位置由字母决定，
  // C#4 和 C4 在谱面上是同一个位置，差别只在临时记号 ✓
  // 没指定音高（纯节奏）时 steps = 0，照旧画在中线上 ✓
  const half = size / 2

  // ---- 选区高亮 ----
  // 画在**音符下面** ✓ 所以先铺这一层，再画符头 ✓
  // 颜色用主题里的强调色 + 半透明 —— 深浅两套配色下都看得见 ✓
  const selKey = (b: number, i: number): string => b + ':' + i
  const selSet = new Set((o.selection ?? []).map((s) => selKey(s.bar, s.index)))
  if (selSet.size) {
    ctx.save()
    ctx.globalAlpha = 0.3
    ctx.fillStyle = ink().accent
    for (const bar of lay.bars) {
      for (let si = 0; si < bar.notes.length; si++) {
        if (!selSet.has(selKey(bar.index, si))) continue
        const slot = bar.notes[si]
        const sm2 = soundingMidi(slot.note, tune)
        const st2 = sm2 != null && !slot.note.rest ? staffStepsFromMiddle(sm2) : 0
        const y2 = baseY - st2 * half
        const r = size * 0.95
        ctx.fillRect(slot.x - r, y2 - r * 0.85, r * 2, r * 1.7)
      }
    }
    ctx.restore()
  }

  for (const bar of lay.bars) {
    const isBad = barIsBad(checks, bar.index)
    const isPickup = barIsPickup(checks, bar.index)
    ctx.fillStyle = isBad ? bad : isPickup ? muted : color
    ctx.strokeStyle = ctx.fillStyle
    // ★ 连桁分组：按拍号决定哪几个音的符尾要连起来 ✓
    const groups = beamGroups(
      bar.notes.map((s) => s.note),
      beatsPerBar,
      beatUnit
    )
    const beamed = new Set<number>()
    for (const g of groups) for (const i of g) beamed.add(i)

    for (let si = 0; si < bar.notes.length; si++) {
      const slot = bar.notes[si]
      const sm = soundingMidi(slot.note, tune)
      const steps = sm != null && !slot.note.rest ? staffStepsFromMiddle(sm) : 0
      const y = baseY - steps * half
      // 加线：超出五线谱范围的音要补短线，否则看不出到底多高
      if (steps > 4 || steps < -4) {
        const from = steps > 0 ? 6 : -6
        const to = steps
        for (let s = from; steps > 0 ? s <= to : s >= to; s += steps > 0 ? 2 : -2) {
          if (Math.abs(s) % 2 !== 0) continue
          const ly = Math.round(baseY - s * half) + 0.5
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.moveTo(slot.x - size * 1.05, ly)
          ctx.lineTo(slot.x + size * 1.05, ly)
          ctx.stroke()
        }
      }
      // 记下符头位置供点击/拖拽命中 ✓ 半径给得比符头略大，好点一些
      staffHits.push({ bar: bar.index, index: si, x: slot.x, y, r: size * 0.95 })

      ctx.save()
      ctx.translate(slot.x, y)
      ctx.scale(size, size)
      // 连桁的音用**只有符头**的字形 ✓
      // 符干和桁稍后一起画 —— 桁是斜的 ✓ 每根符干要各自画到它该到的高度 ✓
      // 用带固定长度符干的字形会出现"够不着桁"或"戳出桁"✗
      paintGlyph(ctx, beamed.has(si) ? 'headOnly' : slot.note.glyph, size)
      if (slot.note.dotted) paintGlyph(ctx, 'dot', size)
      ctx.restore()
    }

    // ---- 连桁：符干 + 桁 ----
    if (groups.length) {
      const th = size * 0.5 // 桁的粗细
      const gap = size * 0.78 // 相邻两条桁的间距
      ctx.fillStyle = ctx.strokeStyle
      for (const g of groups) {
        const info = g.map((si) => {
          const slot = bar.notes[si]
          const sm = soundingMidi(slot.note, tune)
          const steps = sm != null && !slot.note.rest ? staffStepsFromMiddle(sm) : 0
          return {
            x: slot.x + STEM_X * size,
            headY: baseY - steps * half,
            lines: Math.max(1, slot.note.lines)
          }
        })
        const xa = info[0].x
        const xb = info[info.length - 1].x
        const ya = info[0].headY - STEM_H * size
        const yb = info[info.length - 1].headY - STEM_H * size
        // 桁是一条**斜线**：从第一根符干顶连到最后一根 ✓
        const yAt = (x: number): number =>
          xb > xa ? ya + ((yb - ya) * (x - xa)) / (xb - xa) : ya

        // 符干：从符头一直画到它自己需要的最低那条桁 ✓
        ctx.lineWidth = Math.max(1, STEM_W * size)
        ctx.strokeStyle = ctx.fillStyle
        for (const it of info) {
          const bottom = yAt(it.x) + (it.lines - 1) * gap + th
          ctx.beginPath()
          ctx.moveTo(it.x, it.headY)
          ctx.lineTo(it.x, bottom)
          ctx.stroke()
        }

        // 主桁：贯通整组
        paintBeam(ctx, xa, yAt(xa), xb, yAt(xb), th)

        // 次级桁：只在"相邻两个音都需要这一级"之间画 ✓
        // 十六分音符夹在八分音符中间时，标准记谱会画一小段"短茬"✓
        const maxLines = Math.max(...info.map((it) => it.lines))
        for (let lvl = 1; lvl < maxLines; lvl++) {
          const off = lvl * gap
          for (let k = 0; k + 1 < info.length; k++) {
            if (info[k].lines > lvl && info[k + 1].lines > lvl) {
              paintBeam(ctx, info[k].x, yAt(info[k].x) + off, info[k + 1].x, yAt(info[k + 1].x) + off, th)
            }
          }
          for (let k = 0; k < info.length; k++) {
            if (info[k].lines <= lvl) continue
            const lNeeds = k > 0 && info[k - 1].lines > lvl
            const rNeeds = k + 1 < info.length && info[k + 1].lines > lvl
            if (lNeeds || rNeeds) continue
            // 孤立的一条：朝组内方向伸一小截
            const dir = k + 1 < info.length ? 1 : -1
            const x2 = info[k].x + dir * size * 0.62
            paintBeam(ctx, info[k].x, yAt(info[k].x) + off, x2, yAt(x2) + off, th)
          }
        }
      }
    }
  }

  // ---- 光标：选区的活动端 ----
  // 像文本光标一样画一条竖线 ✓ 让用户知道"现在在哪儿" ✓
  if (o.cursor) {
    const ci = o.cursor
    const cbar = lay.bars[ci.bar]
    const cslot = cbar?.notes[ci.index]
    if (cslot) {
      const csm = soundingMidi(cslot.note, tune)
      const cst = csm != null && !cslot.note.rest ? staffStepsFromMiddle(csm) : 0
      const cy = baseY - cst * half
      const cx = Math.round(cslot.x) + 0.5
      ctx.strokeStyle = ink().accent
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cy - size * 2.6)
      ctx.lineTo(cx, cy + size * 2.6)
      ctx.stroke()
      // 顶端一个小方块，更像文本光标
      ctx.fillStyle = ink().accent
      ctx.fillRect(cx - 2, cy - size * 2.6 - 4, 4, 4)
    }
  }

  return lay
}

/**
 * 一条桁 = 一个四条边的梯形。
 *
 * 只按**竖直方向**加厚 ✓ 不做法向加厚 —— 桁通常是接近水平的 ✓
 * 斜得厉害时这点差别看不出来 ✓ 代码却简单得多 ✓
 */
function paintBeam(
  ctx: CanvasRenderingContext2D,
  xa: number,
  ya: number,
  xb: number,
  yb: number,
  th: number
): void {
  ctx.beginPath()
  ctx.moveTo(xa, ya)
  ctx.lineTo(xb, yb)
  ctx.lineTo(xb, yb + th)
  ctx.lineTo(xa, ya + th)
  ctx.closePath()
  ctx.fill()
}

/** 画简谱那一条带 */
function drawJianpuBand(o: RenderRhythmOptions, top: number, height: number) {
  const { ctx, bars, beatsPerBar, beatUnit, checks } = o
  const color = o.color ?? ink().text
  const muted = o.muted ?? ink().dim
  const bad = o.bad ?? ink().warn

  const lay = layoutJianpu(bars, beatsPerBar, beatUnit, PAD + METER_W, o.width - PAD)
  const totalSlots = bars.reduce((s, ns) => s + ns.reduce((a, n) => a + 1 + (n.dashes || 0), 0), 0)
  const contentW = o.width - PAD * 2 - METER_W
  const slotW = totalSlots > 0 ? contentW / totalSlots : contentW
  const font = Math.max(12, Math.min(24, slotW * 0.92))

  const digitY = top + height / 2
  const lineY = digitY + font * 0.52 // 下划线位置
  const dashY = digitY

  // 小节线
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  for (let i = 0; i < lay.dividers.length; i++) {
    const x = Math.round(lay.dividers[i]) + 0.5
    const isLast = i === lay.dividers.length - 1
    ctx.beginPath()
    ctx.moveTo(x, top + 6)
    ctx.lineTo(x, top + height - 6)
    ctx.stroke()
    if (isLast) {
      ctx.beginPath()
      ctx.moveTo(x - 4, top + 6)
      ctx.lineTo(x - 4, top + height - 6)
      ctx.stroke()
    }
  }

  // 拍号
  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(font * 0.62)}px ui-monospace, Consolas, monospace`
  ctx.fillText(`${Math.round(beatsPerBar)}/${Math.round(beatUnit)}`, PAD + METER_W / 2 + 4, digitY)

  // 数字 / 0 / 破折号 / 附点
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const bar of lay.bars) {
    const isBad = barIsBad(checks, bar.index)
    const isPickup = barIsPickup(checks, bar.index)
    ctx.fillStyle = isBad ? bad : isPickup ? muted : color
    ctx.font = `bold ${Math.round(font)}px ui-monospace, Consolas, monospace`
    for (const slot of bar.notes) {
      // 有音高就按音高出数字（固定唱名 1 = C）；没音高照旧显示 1（纯节奏）
      const digit =
        slot.note.rest
          ? '0'
          : (() => {
              const m = soundingMidi(slot.note, o.tuning ?? STANDARD)
              return m != null ? jianpuDigit(m) + accidentalOf(m) : '1'
            })()
      ctx.fillText(String(digit), slot.x, digitY)
      if (slot.note.dotted) {
        ctx.beginPath()
        ctx.arc(slot.x + font * 0.42, digitY, font * 0.08, 0, Math.PI * 2)
        ctx.fill()
      }
      // 破折号：从下一个字符格开始，一个格一个
      for (let k = 0; k < (slot.note.dashes || 0); k++) {
        const dx = slot.x + slotW * (k + 1)
        ctx.fillRect(dx - slotW * 0.34, dashY - 1, slotW * 0.68, 2)
      }
    }
  }

  // 下划线：按「连续且该级都有的音符」成组画，这样才像真的简谱
  for (const level of [1, 2]) {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.6
    for (const bar of lay.bars) {
      const isBad = barIsBad(checks, bar.index)
      if (isBad) ctx.strokeStyle = bad
      else if (barIsPickup(checks, bar.index)) ctx.strokeStyle = muted
      else ctx.strokeStyle = color

      let runStart: number | null = null
      let runEnd = 0
      const flush = () => {
        if (runStart === null) return
        const y = Math.round(lineY + (level - 1) * 4) + 0.5
        ctx.beginPath()
        ctx.moveTo(runStart - slotW * 0.42, y)
        ctx.lineTo(runEnd + slotW * 0.42, y)
        ctx.stroke()
        runStart = null
      }
      for (const slot of bar.notes) {
        if ((slot.note.lines || 0) >= level) {
          if (runStart === null) runStart = slot.x
          runEnd = slot.x
        } else {
          flush()
        }
      }
      flush()
    }
  }

  return lay
}

/** 把三小节节奏画到画布上。调用方负责按 devicePixelRatio 设好 backing store 与变换。 */
export function renderRhythm(o: RenderRhythmOptions): void {
  const { ctx, width, height } = o
  ctx.fillStyle = o.background ?? ink().bg
  ctx.fillRect(0, 0, width, height)

  const mode = o.mode ?? 'both'
  const gap = 8
  if (mode === 'both') {
    const bandH = (height - gap) / 2
    drawStaffBand(o, 0, bandH)
    drawJianpuBand(o, bandH + gap, bandH)
  } else if (mode === 'staff-tab') {
    // 上五线谱、下六线谱 —— 吉他谱最常见的排法
    const bandH = (height - gap) / 2
    drawStaffBand(o, 0, bandH)
    const f5 = Math.max(-7, Math.min(7, Math.round(o.fifths ?? 0)))
    const x0 = PAD + METER_W + keySignatureWidth(f5)
    const lay = drawTabBand(o, bandH + gap, bandH, x0, width - PAD)
    if (o.playheadBeat != null) {
      const lay3 = layoutStaff(o.bars, o.beatsPerBar, o.beatUnit, x0, width - PAD)
      drawPlayheadOnStaff(ctx, lay3, o.beatsPerBar, o.beatUnit, o.playheadBeat, 0, bandH, ink().warn)
    }
    if (o.pendingPreview) {
      drawPending(ctx, lay, o.pendingPreview, bandH + gap, bandH, o.muted ?? ink().ok)
    }
  } else if (mode === 'staff') {
    drawStaffBand(o, 0, height)
    if (o.playheadBeat != null) {
      const lay2 = layoutStaff(o.bars, o.beatsPerBar, o.beatUnit, PAD + METER_W + keySignatureWidth(Math.max(-7, Math.min(7, Math.round(o.fifths ?? 0)))), width - PAD)
      drawPlayheadOnStaff(ctx, lay2, o.beatsPerBar, o.beatUnit, o.playheadBeat, 0, height, ink().warn)
    }
  } else if (mode === 'tab') {
    const lay = drawTabBand(o, 0, height, PAD + METER_W, width - PAD)
    if (o.pendingPreview) {
      drawPending(ctx, lay, o.pendingPreview, 0, height, o.muted ?? ink().ok)
    }
  } else {
    drawJianpuBand(o, 0, height)
  }
}


/* ------------------------------ 六线谱 ------------------------------ */

/** 六线谱纵向排布：第 1 弦在下、第 6 弦在上（吉他手看谱的习惯）*/
/**
 * 六线谱的纵向排布。
 *
 * ⚠️ **第 1 弦（最细）在最上面，第 6 弦在最下面** ✗
 * 这是标准六线谱的约定 ✓ 也和五线谱"音高越高画得越高"一致 ✓
 *
 * 我第一版画反了（1 弦在最下）✓ 还顺手写了个测试把这个错误方向钉死 ✓✓
 * 那才是最糟的：错误的假设被测试保护起来，以后改都不敢改 ✓
 */
function tabGeometry(top: number, height: number) {
  const gap = Math.min(13, (height - 16) / 5)
  const first = top + (height - gap * 5) / 2
  return { gap, first }
}

/**
 * 某个音符在六线谱上的位置（第几弦、第几品）。
 *
 * 优先用它自己存的弦/品 ✓ —— 那是用户真正按出来的位置 ✓
 * 没有的话（从 MusicXML 导入的音、或者纯五线谱输入的音）
 * 就按调弦**推一个尽量低的把位** ✓ 这样六线谱上也能看到它 ✓
 */
export function tabPosition(
  note: RhythmNote,
  tuning: Tuning
): { string: number; fret: number } | null {
  if (note.rest) return null
  if (note.string != null && note.fret != null) return { string: note.string, fret: note.fret }
  const m = soundingMidi(note, tuning)
  if (m != null) return midiToFret(tuning, m)
  return null
}

/** 画六线谱那一条带 */
function drawTabBand(
  o: RenderRhythmOptions,
  top: number,
  height: number,
  x0: number,
  x1: number
): RhythmLayout {
  const { ctx, bars, beatsPerBar, beatUnit, checks } = o
  const color = o.color ?? ink().text
  const muted = o.muted ?? ink().dim
  const bad = o.bad ?? ink().warn
  const tuning = o.tuning ?? STANDARD

  const { gap, first } = tabGeometry(top, height)
  const lay = layoutTab(bars, beatsPerBar, beatUnit, x0, x1)
  const right = lay.dividers[lay.dividers.length - 1]

  // 六条弦线
  ctx.strokeStyle = muted
  ctx.lineWidth = 1
  for (let s = 1; s <= 6; s++) {
    // 第 1 弦在最上：弦号越大越往下
    const y = Math.round(first + (s - 1) * gap) + 0.5
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(right, y)
    ctx.stroke()
  }

  // 左边标弦号
  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '10px ui-monospace, Consolas, monospace'
  for (let s = 1; s <= 6; s++) {
    ctx.fillText(String(s), x0 - 9, first + (s - 1) * gap)
  }

  // 小节线（终止线双线）
  ctx.strokeStyle = muted
  ctx.lineWidth = 1.4
  for (let i = 0; i < lay.dividers.length; i++) {
    const x = Math.round(lay.dividers[i]) + 0.5
    const isLast = i === lay.dividers.length - 1
    ctx.beginPath()
    ctx.moveTo(x, first)
    ctx.lineTo(x, first + gap * 5)
    ctx.stroke()
    if (isLast) {
      ctx.beginPath()
      ctx.moveTo(x - 4, first)
      ctx.lineTo(x - 4, first + gap * 5)
      ctx.stroke()
    }
  }

  // 品号：写在对应弦线上。先用底色垫一块，否则数字和穿过它的弦线糊在一起
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const bar of lay.bars) {
    const isBad = barIsBad(checks, bar.index)
    const isPickup = barIsPickup(checks, bar.index)
    const fg = isBad ? bad : isPickup ? muted : color
    for (const slot of bar.notes) {
      const pos = tabPosition(slot.note, tuning)
      if (!pos) continue
      const y = first + (pos.string - 1) * gap
      const label = String(pos.fret)
      ctx.font = 'bold 11px ui-monospace, Consolas, monospace'
      const w = ctx.measureText(label).width + 5
      ctx.fillStyle = o.background ?? ink().bg
      ctx.fillRect(slot.x - w / 2, y - gap * 0.45, w, gap * 0.9)
      ctx.fillStyle = fg
      ctx.fillText(label, slot.x, y)
    }
  }

  return lay
}

/**
 * 六线谱的横向排布：和简谱一样**按字符格等分** ✗ 不是按时值比例 ✓
 * 因为品号是等宽字符，按比例排会让密集处的数字叠在一起 ✓
 */
function layoutTab(
  bars: RhythmNote[][],
  beatsPerBar: number,
  beatUnit: number,
  x0: number,
  x1: number
): RhythmLayout {
  return layoutJianpu(bars, beatsPerBar, beatUnit, x0, x1)
}


/**
 * 点击落在六线谱的第几弦上（给鼠标交互用）。
 *
 * 只在六线谱那条带里有效 ✓ 点在带外、或者离弦线太远，都返回 null ✓
 * 返回 1~6（1 = 最细的弦，画在最下面）✓
 *
 * 抽成纯函数是为了**能单独测** ✗ —— 交互代码埋在组件里就只能靠手点了 ✓
 */
/**
 * 符头的命中表 —— 和检测图的 hitRows 一个路子：
 * **画和点共用同一套坐标** ✓ 两边各算一遍迟早会偏 ✗
 */
let staffHits: { bar: number; index: number; x: number; y: number; r: number }[] = []

/**
 * 命中测试：落在哪个符头上（半径内取最近的一个）。没中就返回 null
 *
 * `slack` 是给**触屏**用的额外容差（像素）✓
 * 桌面用鼠标 → 0 就够 ✓；手指要 10px 以上才点得中 ✓（Apple/Google 的建议是 44px 目标 ✓）
 */
export function staffHitTest(
  x: number,
  y: number,
  slack = 0
): { bar: number; index: number } | null {
  let best: { bar: number; index: number } | null = null
  let bestD = Infinity
  for (const h of staffHits) {
    const dx = x - h.x
    const dy = y - h.y
    const d = dx * dx + dy * dy
    const rr = h.r + slack
    if (d <= rr * rr && d < bestD) {
      bestD = d
      best = { bar: h.bar, index: h.index }
    }
  }
  return best
}

export function tabStringAt(
  y: number,
  canvasHeight: number,
  mode: RenderRhythmOptions['mode'],
  /**
   * 触屏用的额外容差，单位是**弦间距的倍数**（默认 0）✓
   * 桌面 0.6 就够 ✓；手指要放宽到 1.2 左右 ✓（相邻弦之间不再有死区 ✓）
   */
  slack = 0
): number | null {
  const gapBetweenBands = 8
  let top = 0
  let height = canvasHeight
  if (mode === 'staff-tab') {
    height = (canvasHeight - gapBetweenBands) / 2
    top = height + gapBetweenBands
  } else if (mode !== 'tab') {
    return null
  }
  const g = tabGeometry(top, height)
  // 第 1 弦在最上（y 最小），所以弦号随 y 增大而增大
  const raw = (y - g.first) / g.gap + 1
  const s = Math.round(raw)
  if (s < 1 || s > 6) return null
  // 离弦线超过 0.6 个间距就算没点中，避免"点空白处也选中弦"
  // 触屏放宽到 0.6 + slack ✓（手指比鼠标粗得多 ✓）
  if (Math.abs(raw - s) > 0.6 + slack) return null
  return s
}


/**
 * 预览该画在哪个 x 上 —— **它将要落下的那个位置**。
 *
 * 抽成独立函数是为了能测 ✓ 用户报的 bug 就是"预览跑到最后一个小节最右端" ✗
 * 这种错误只有在"目标小节不是最后一小节"时才看得出来 ✓
 *
 * 横坐标和 layoutStaff 用**完全一样**的算法：音符落在"它自己时值格的中心" ✓
 *   center = 小节已有内容 + 本音符时值 / 2
 *   分母   = 加进这个音**之后**的小节总时值
 * 所以预览位置 == 回车落谱后音符真正出现的位置 ✓✓
 */
export function pendingPreviewX(layout: RhythmLayout, pv: PendingPreview): number {
  const bi = Math.max(0, Math.min(layout.bars.length - 1, Math.round(pv.bar)))
  const bar = layout.bars[bi]
  if (!bar) return 0
  const val = Math.max(0.0001, pv.value)
  const newTotal = bar.total + val
  const center = bar.total + val / 2
  return newTotal > 0 ? bar.x + (bar.width * center) / newTotal : bar.x
}

/**
 * 画**正在输入的音的预览**，位置就是它将要落下的地方。
 *
 * 两处修正（都是用户报的）：
 *
 *   1. **位置**：原来画在"最后一个小节的右端" ✗ 输入位置在别的行时离得极远 ✓
 *      现在画在**目标小节**里 ✓ 横坐标用和 layoutStaff 同一套"格子中心"算法 ✓
 *      所以预览和回车之后真正落下的位置对得上 ✓
 *   2. **正在敲的品号也要预览** ✗ 原来只预览"按过空格的" ✓
 *      画成**空心**框 ✓ 和已经确定的那几个（实心）区分开 ✓
 */
function drawPending(
  ctx: CanvasRenderingContext2D,
  layout: RhythmLayout,
  pv: PendingPreview,
  top: number,
  height: number,
  highlight: string
) {
  if (!layout.bars.length) return
  if (!pv.notes.length && !pv.typing?.text) return

  const x = pendingPreviewX(layout, pv)

  const { gap, first } = tabGeometry(top, height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.max(9, Math.min(14, gap * 1.05))}px ui-monospace, Consolas, monospace`

  const badge = (string: number, label: string, filled: boolean) => {
    const y = first + (Math.max(1, Math.min(6, Math.round(string))) - 1) * gap
    const w = ctx.measureText(label).width + 7
    const h = gap * 0.92
    if (filled) {
      ctx.fillStyle = highlight
      ctx.fillRect(x - w / 2, y - h / 2, w, h)
      ctx.fillStyle = '#fff'
    } else {
      ctx.strokeStyle = highlight
      ctx.lineWidth = 1.6
      ctx.strokeRect(x - w / 2, y - h / 2, w, h)
      ctx.fillStyle = highlight
    }
    ctx.fillText(label, x, y)
  }

  for (const n of pv.notes) badge(n.string, String(n.fret), true)
  if (pv.typing?.text) badge(pv.typing.string, pv.typing.text, false)
}


/**
 * 在谱面上画一条**跟随播放的竖线**。
 *
 * ★ 谱面的横轴是**拍**，而回放位置是**秒** ✗ 两者要靠检测拟合出的速度换算 ✓
 * （同一个速度也用在了检测图上 ✓ 所以两条线永远对得齐 ✓）
 *
 * @param beat 相对谱面第一拍的**拍数**（可以是小数、可以是负数）
 */
function drawPlayheadOnStaff(
  ctx: CanvasRenderingContext2D,
  layout: RhythmLayout,
  beatsPerBar: number,
  beatUnit: number,
  beat: number,
  top: number,
  height: number,
  color: string
) {
  if (!layout.bars.length) return
  const cap = barCapacity(beatsPerBar, beatUnit)
  if (!(cap > 0)) return
  const barIdx = Math.floor(beat / cap)
  if (barIdx < 0 || barIdx >= layout.bars.length) return
  const inBar = beat - barIdx * cap
  const bar = layout.bars[barIdx]
  const x = Math.round(bar.x + (bar.width * inBar) / cap) + 0.5
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, top + 2)
  ctx.lineTo(x, top + height - 2)
  ctx.stroke()
  // 顶端一个小三角，位置更醒目
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x - 5, top + 2)
  ctx.lineTo(x + 5, top + 2)
  ctx.lineTo(x, top + 10)
  ctx.closePath()
  ctx.fill()
}

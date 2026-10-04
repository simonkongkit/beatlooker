/* =============================================================================
 * glyphs.ts —— 五线谱记号几何（应用版）
 *
 * 改编自 notation-perf/src/geometry.js。原文件是渲染性能基准的"唯一几何来源"，
 * 目的是让 SVG / Canvas / 位图三种画法画出逐点相同的形状。
 * 这里搬进应用并只保留需要的东西，原因是：**产品不应该依赖基准项目**
 * （那边是实验代码，随时可能为了跑分改动）。代价是两份拷贝，可以接受。
 *
 * 坐标约定：单位 unit = 五线谱一条线间距(staff space)，原点 = 符头中心，
 * x 向右为正、y 向下为正（与 Canvas 一致）。
 * 路径命令用可序列化数组：[['M',x,y],['C',x1,y1,x2,y2,x,y],['L',x,y],['Z']]
 *
 * 纯数据 + 纯函数，不碰 DOM，可以用 node 跑测试。
 * ========================================================================== */

export type PathCmd = (string | number)[]

export interface Shape {
  cmds: PathCmd[]
  mode: 'fill' | 'stroke'
  /** 仅 stroke 用：线宽（staff space） */
  width?: number
}

export interface Glyph {
  name: string
  shapes: Shape[]
}

const K = 0.5522847498307936 // 三次贝塞尔逼近 1/4 椭圆的 kappa

function rotate(cmds: PathCmd[], cx: number, cy: number, deg: number): PathCmd[] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return cmds.map((cmd) => {
    const out: PathCmd = [cmd[0]]
    for (let i = 1; i < cmd.length; i += 2) {
      const dx = (cmd[i] as number) - cx
      const dy = (cmd[i + 1] as number) - cy
      out.push(cx + dx * c - dy * s, cy + dx * s + dy * c)
    }
    return out
  })
}

export function ell(cx: number, cy: number, rx: number, ry: number, rot?: number): PathCmd[] {
  const cmds: PathCmd[] = [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry],
    ['C', cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy],
    ['C', cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry],
    ['C', cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy],
    ['Z']
  ]
  return rot ? rotate(cmds, cx, cy, rot) : cmds
}

export function rect(x: number, y: number, w: number, h: number): PathCmd[] {
  return [
    ['M', x, y],
    ['L', x + w, y],
    ['L', x + w, y + h],
    ['L', x, y + h],
    ['Z']
  ]
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** 路径命令 → SVG path 数据串；Canvas 侧 new Path2D(同一个串) */
export function toD(cmds: PathCmd[]): string {
  return cmds
    .map((cmd) => {
      const parts: (string | number)[] = [cmd[0]]
      for (let i = 1; i < cmd.length; i++) parts.push(r3(cmd[i] as number))
      return parts.join(' ')
    })
    .join(' ')
}

/* ---------- 记号部件（单位：staff space） ---------- */

export const HEAD_RX = 0.62
export const HEAD_RY = 0.46
export const HEAD_TILT = -20
export const STEM_X = 0.58
export const STEM_W = 0.125
export const STEM_H = 3.5

function stem(): Shape {
  return { cmds: rect(STEM_X, -STEM_H, STEM_W, STEM_H), mode: 'fill' }
}

/** 符尾：从符干顶端向右下弯出；dy 用来叠第 2、3 条符尾 */
function flag(dy: number): Shape {
  const y = -STEM_H + dy
  return {
    cmds: [
      ['M', STEM_X + STEM_W, y],
      ['C', 1.5, y + 0.55, 1.62, y + 1.25, 1.02, y + 1.9],
      ['C', 1.42, y + 1.15, 1.0, y + 0.6, STEM_X + STEM_W, y + 0.45],
      ['Z']
    ],
    mode: 'fill'
  }
}

function head(filled: boolean): Shape {
  return filled
    ? { cmds: ell(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT), mode: 'fill' }
    : { cmds: ell(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT), mode: 'stroke', width: 0.22 }
}

/** 四分休止符（手写体折线的近似形状） */
const QUARTER_REST: PathCmd[] = [
  ['M', -0.05, -1.45],
  ['C', 0.45, -1.05, 0.42, -0.7, 0.02, -0.42],
  ['C', 0.62, -0.28, 0.68, 0.35, 0.12, 0.72],
  ['C', 0.42, 0.82, 0.55, 1.02, 0.58, 1.28],
  ['L', 0.12, 1.42],
  ['C', 0.06, 1.15, -0.1, 0.98, -0.36, 0.86],
  ['C', -0.86, 0.55, -0.8, -0.05, -0.18, -0.4],
  ['C', -0.55, -0.65, -0.6, -1.05, -0.12, -1.3],
  ['Z']
]

function dotShape(x = 1.2, y = 0, r = 0.15): Shape {
  return { cmds: ell(x, y, r, r), mode: 'fill' }
}

function slash(): Shape {
  return { cmds: [['M', -0.42, 0.78], ['L', 0.3, -0.88]], mode: 'stroke', width: 0.2 }
}

/** 记号注册表。键名与 rhythm.ts 里 DurationSpec.glyph 一一对应。 */
export const GLYPHS: Record<string, Glyph> = {
  whole: {
    name: '全音符',
    shapes: [{ cmds: ell(0, 0, 0.78, 0.52, HEAD_TILT), mode: 'stroke', width: 0.22 }]
  },
  half: { name: '二分音符', shapes: [head(false), stem()] },
  quarter: { name: '四分音符', shapes: [head(true), stem()] },
  /**
   * 只有符头（**没有符干、没有符尾**）。
   *
   * ★ 连桁时用 ✓ 带桁的音不能再用带符尾的字形 ✗
   * 而且符干要**单独画到桁上** ✓ —— 组里中间那几个音的符干长短不一 ✗
   * 用固定长度的字形会出现"够不着桁"或"戳出桁"✓
   */
  headOnly: { name: '符头', shapes: [head(true)] },
  eighth: { name: '八分音符', shapes: [head(true), stem(), flag(0)] },
  sixteenth: { name: '十六分音符', shapes: [head(true), stem(), flag(0), flag(0.78)] },
  dot: { name: '附点', shapes: [dotShape()] },
  restWhole: { name: '全休止符', shapes: [{ cmds: rect(-0.62, -0.48, 1.24, 0.3), mode: 'fill' }] },
  restHalf: { name: '二分休止符', shapes: [{ cmds: rect(-0.62, 0.18, 1.24, 0.3), mode: 'fill' }] },
  restQuarter: { name: '四分休止符', shapes: [{ cmds: QUARTER_REST, mode: 'fill' }] },
  restEighth: { name: '八分休止符', shapes: [dotShape(-0.05, -0.5), slash()] },
  restSixteenth: {
    name: '十六分休止符',
    shapes: [dotShape(-0.05, -0.78), dotShape(-0.05, -0.22), slash()]
  }
}

/**
 * 粗略包围盒 —— 用路径上的所有坐标点近似（含贝塞尔控制点）。
 *
 * 控制点会让盒子比真实曲线略大一点，但画个小图标足够，
 * 而且比真去求三次曲线的极值简单太多。
 */
export function glyphBounds(g: Glyph): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of g.shapes) {
    const pad = (s.mode === 'stroke' ? (s.width ?? 0) : 0) / 2
    for (const cmd of s.cmds) {
      for (let i = 1; i + 1 < cmd.length; i += 2) {
        const x = cmd[i] as number
        const y = cmd[i + 1] as number
        if (x - pad < x0) x0 = x - pad
        if (y - pad < y0) y0 = y - pad
        if (x + pad > x1) x1 = x + pad
        if (y + pad > y1) y1 = y + pad
      }
    }
  }
  if (!Number.isFinite(x0)) return { x: -1, y: -1, w: 2, h: 2 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** 附点画在符头右侧一点，但它跟的是"基本时值"而不是休止符形状 */
export const DOT_OFFSET_X = 1.2

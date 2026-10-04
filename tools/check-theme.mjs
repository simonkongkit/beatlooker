import assert from 'node:assert/strict'
import { THEMES } from '../src/lib/theme.ts'

/**
 * 对比度自检（WCAG 相对亮度公式）。
 *
 * 为什么需要它：配色是"看着不对但说不出哪儿不对"的典型 ✗
 * 实测踩过一次 —— 浅色主题下频率刻度几乎看不见 ✓ 根因是它用了写死的
 * 半透明浅灰 + **黑色**文字阴影 ✗ 深色底上勉强能看，浅色底上直接糊掉 ✓
 * 有了这条自检，以后再改配色就不会悄悄跌破可读线 ✓
 */

/** 解析 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() —— 只支持本主题里用到的写法 */
function parseColor(s) {
  const t = s.trim()
  let m = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }
  m = t.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x))
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  throw new Error('看不懂的颜色写法：' + s)
}

/** 把带透明度的前景压到背景上 */
function over(fg, bg) {
  return [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
}

function luminance(c) {
  const f = (v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}

function contrast(fgStr, bgStr) {
  const bg = parseColor(bgStr)
  const fg = over(parseColor(fgStr), bg)
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// 正文类要 4.5:1（WCAG AA 普通文字），小号标签类要 3:1
const TEXT_MIN = 4.5
const LABEL_MIN = 3.0

const TEXT_VARS = ['--text', '--fg-dim']
const LABEL_VARS = ['--muted', '--muted-2', '--axis-fg', '--energy-axis-fg', '--tag-fg', '--dim2']

let worst = { r: 99, what: '' }
for (const t of THEMES) {
  const bg = t.css['--bg']
  const stage = t.css['--stage-bg']
  for (const v of TEXT_VARS) {
    const r = contrast(t.css[v], bg)
    assert.ok(r >= TEXT_MIN, t.name + ' 的 ' + v + ' 对比度只有 ' + r.toFixed(2) + '，低于 ' + TEXT_MIN)
    if (r < worst.r) worst = { r, what: t.name + ' ' + v }
  }
  for (const v of LABEL_VARS) {
    for (const [name, back] of [['界面底', bg], ['画布底', stage]]) {
      const r = contrast(t.css[v], back)
      assert.ok(
        r >= LABEL_MIN,
        t.name + ' 的 ' + v + ' 在' + name + '上对比度只有 ' + r.toFixed(2) + '，低于 ' + LABEL_MIN
      )
      if (r < worst.r) worst = { r, what: t.name + ' ' + v + ' @' + name }
    }
  }
}

// 画布墨色也查一遍（它们是画在画布底色上的）
for (const t of THEMES) {
  const bg = '#' + t.canvas.ink.bg.replace('#', '')
  for (const v of ['text', 'dim', 'dim2']) {
    const r = contrast(t.canvas.ink[v], bg)
    assert.ok(r >= LABEL_MIN, t.name + ' 画布的 ink.' + v + ' 对比度只有 ' + r.toFixed(2))
    if (r < worst.r) worst = { r, what: t.name + ' ink.' + v }
  }
}

console.log(
  '✓ 配色对比度通过（' + THEMES.length + ' 套 × 正文 ≥' + TEXT_MIN + ':1 / 标签 ≥' + LABEL_MIN +
    ':1）最弱一处 ' + worst.what + ' = ' + worst.r.toFixed(2) + ':1'
)

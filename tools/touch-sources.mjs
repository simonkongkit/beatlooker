/**
 * 改完源码之后跑一遍 —— 逼 Vite 重新编译，并**校验开发服务器真的发了新代码**。
 *
 * ## 为什么需要它
 *
 * Vite 的文件监听在 Windows 上会**漏事件** ✗ 这个会话里已经栽了三次 ✓✓
 * 症状是：磁盘上的代码是对的 ✓ 自检也从磁盘读、全过 ✓
 * 但**浏览器拿到的还是旧的** ✗ 于是页面行为和你写的代码不一致 ✓
 *
 * 最坑的是这种情况下所有测试都是绿的 ✗ 只有截图或手动点才会发现 ✓
 *
 * 用法：node tools/touch-sources.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'

const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|svelte)$/.test(name)) files.push(p)
  }
}
walk('src')
files.push('src/App.svelte')

// 原样重写：内容不变，只更新 mtime
for (const p of new Set(files)) writeFileSync(p, readFileSync(p, 'utf8'))
console.log('已 touch ' + new Set(files).size + ' 个源文件')

// 校验：向开发服务器要几个关键模块，看返回的内容和磁盘是否一致
const probe = (path) =>
  new Promise((res) => {
    https
      .get({ host: 'localhost', port: 5173, path, rejectUnauthorized: false }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(d))
      })
      .on('error', () => res(''))
  })

// 每个模块配一段"只有新代码才有的字符串"
const CHECKS = [
  ['/src/lib/draft.ts', 'cell[6] === 1', '草稿要能读和弦标记'],
  ['/src/lib/notation/rhythm.ts', 'chord', '节奏模型要有和弦字段'],
  ['/src/lib/notation/render.ts', 'tabStringAt', '六线谱要有点击命中'],
  ['/src/lib/musicxml.ts', 'fromMusicXml', 'MusicXML 要能导入']
]

let bad = 0
for (const [path, needle, why] of CHECKS) {
  const body = await probe(path)
  const ok = body.includes(needle)
  if (!ok) bad++
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + path + '  ' + why + (ok ? '' : '  —— 服务器发的是旧代码！'))
}
console.log(bad === 0 ? '开发服务器发的是最新代码 ✓' : '⚠️ 有 ' + bad + ' 个模块是旧的 —— 可能要重启开发服务器')
process.exit(bad === 0 ? 0 : 1)

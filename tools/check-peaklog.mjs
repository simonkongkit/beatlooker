import assert from 'node:assert/strict'
import { PeakLog } from '../src/lib/peakLog.ts'

// 存的是 Float32，取出来会有浮点误差，不能按 Float64 精确比较
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg ?? '') + ' 期望 ' + b + '，实得 ' + a)
const same = (got, want, msg) => {
  assert.equal(got.length, want.length, (msg ?? '') + ' 个数不符')
  for (let i = 0; i < want.length; i++) {
    near(got[i].f, want[i].f, (msg ?? '') + ' 第 ' + i + ' 个频率')
    near(got[i].m, want[i].m, (msg ?? '') + ' 第 ' + i + ' 个幅度')
  }
}

// ============ 1. 存进去能原样取出来 ============
{
  const log = new PeakLog(93.75, { maxPeaks: 8 })
  log.push([{ f: 100, m: 0.5 }, { f: 200, m: 0.3 }])
  log.push([{ f: 300, m: 0.9 }])
  log.push([])
  assert.equal(log.columns, 3)
  same(log.at(0), [{ f: 100, m: 0.5 }, { f: 200, m: 0.3 }], '第 0 列')
  same(log.at(1), [{ f: 300, m: 0.9 }], '第 1 列')
  same(log.at(2), [], '第 2 列')
  same(log.at(3), [], '越界应返回空')
  same(log.at(-1), [], '负数下标应返回空')
}

// ============ 2. 超过上限时留最强的 ============
{
  const log = new PeakLog(93.75, { maxPeaks: 3 })
  log.push([
    { f: 1, m: 0.1 }, { f: 2, m: 0.9 }, { f: 3, m: 0.4 },
    { f: 4, m: 0.7 }, { f: 5, m: 0.2 }
  ])
  const got = log.at(0)
  assert.equal(got.length, 3, '应只留 3 个')
  // 留下的是 m 最大的三个：0.9(f=2)、0.7(f=4)、0.4(f=3)
  const fs = got.map((p) => p.f).sort((a, b) => a - b)
  assert.deepEqual(fs, [2, 3, 4], '应留 m 最大的 2/3/4，实得 ' + fs.join(','))
}

// ============ 3. 跨 chunk 边界也要对 ============
{
  const log = new PeakLog(93.75, { maxPeaks: 2 })
  for (let i = 0; i < 5000; i++) log.push([{ f: i * 1.5, m: i / 5000 }])
  assert.equal(log.columns, 5000, '应有 5000 列')
  // 4095 / 4096 / 4097 正好卡在 chunk 边界上
  for (const c of [0, 4095, 4096, 4097, 4999]) {
    const got = log.at(c)
    assert.equal(got.length, 1, '第 ' + c + ' 列应有 1 个峰')
    near(got[0].f, c * 1.5, '第 ' + c + ' 列频率')
  }
}

// ============ 4. 容量上限与清空 ============
{
  const log = new PeakLog(93.75, { maxPeaks: 2, maxColumns: 3 })
  for (let i = 0; i < 10; i++) log.push([{ f: i, m: 1 }])
  assert.equal(log.columns, 3, '到上限就不该再记')
  assert.equal(log.full, true)
  log.clear()
  assert.equal(log.columns, 0)
  assert.equal(log.full, false)
  same(log.at(0), [], '清空后应取不到')
}

// ============ 5. at() 复用同一个数组（性能约定，别不小心改了）============
{
  const log = new PeakLog(93.75, { maxPeaks: 4 })
  log.push([{ f: 10, m: 1 }])
  log.push([{ f: 20, m: 1 }])
  const a = log.at(0)
  near(a[0].f, 10, '第一次取')
  log.at(1) // 再取一次会改写同一个数组
  near(a[0].f, 20, 'at() 复用同一个数组 —— 这是有意的，调用方不能存引用')
}

console.log('✓ 谱峰日志通过（往返 / 留最强 / 跨块边界 / 容量与清空 / 数组复用约定）')

/**
 * DelayLine 的独立自检：node tools/check-delay.mjs
 *
 * 这是整个 1 秒延迟功能的核心逻辑，脱离浏览器单独验证。
 */
import assert from 'node:assert/strict'
import { DelayLine } from '../src/lib/delayLine.ts'

// 1) 基本读取：窗口结尾 = 最新样本往前 delaySamples 个
{
  const line = new DelayLine(16)
  const out = new Float32Array(4)
  line.push(Float32Array.from({ length: 10 }, (_, i) => i)) // 写入 0..9

  assert.equal(line.length, 10)
  assert.equal(line.readDelayed(0, out), true)
  assert.deepEqual([...out], [6, 7, 8, 9], '延迟 0 应取最新 4 个样本')

  assert.equal(line.readDelayed(2, out), true)
  assert.deepEqual([...out], [4, 5, 6, 7], '延迟 2 应整体前移 2 个样本')
}

// 2) 环形回绕后仍然正确
{
  const line = new DelayLine(8)
  const out = new Float32Array(3)
  line.push(Float32Array.from({ length: 10 }, (_, i) => i)) // 只留下最后 8 个：2..9

  assert.equal(line.length, 8)
  assert.equal(line.readDelayed(0, out), true)
  assert.deepEqual([...out], [7, 8, 9], '回绕后延迟 0 仍是最新 3 个')
}

// 3) 数据不足：返回 false 且输出清零
{
  const line = new DelayLine(8)
  const out = new Float32Array(4)
  line.push(Float32Array.from([1, 2, 3]))

  assert.equal(line.readDelayed(5, out), false)
  assert.deepEqual([...out], [0, 0, 0, 0], '凑不满 delay + window 时必须给静音')
}

// 4) 与需求一致的验收：48kHz 下延迟恰好 1 秒
{
  const rate = 48000
  const line = new DelayLine(rate * 4)
  const chunk = new Float32Array(rate)
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < rate; i++) chunk[i] = s * rate + i
    line.push(chunk)
  }

  const win = new Float32Array(480) // 10ms 窗口
  assert.equal(line.readDelayed(rate, win), true)

  const newest = 3 * rate - 1
  assert.equal(win[win.length - 1], newest - rate, '窗口结尾应正好是 1 秒前的样本')
  assert.equal(win[0], newest - rate - (win.length - 1), '窗口起点应同步前移')
}

console.log('✓ DelayLine 全部检查通过（含 48kHz 下精确延迟 1 秒）')

/**
 * 能量记录链路的独立自检：node tools/check-score.mjs
 *
 * 覆盖：读数日志的顺序/越界/上限/时间轴、小节换算、行边界不累积误差、
 * 以及谱面行的像素几何（能量高度、小节线/拍线）。
 */
import assert from 'node:assert/strict'
import { EnergyLog } from '../src/lib/energyLog.ts'
import { makeLayout, rowCount, rowRange, renderScoreRow, ROW_BG, ROW_CAP } from '../src/lib/score.ts'
import { createEnergyRamp } from '../src/lib/spectrumImage.ts'

// 1) 读数日志：顺序读写、越界、上限、时间轴
{
  const log = new EnergyLog(4, { chunkSize: 4 }) // 4 读数/秒，块故意开小以覆盖跨块
  for (let i = 0; i < 10; i++) log.push(i + 1)

  assert.equal(log.length, 10)
  assert.equal(log.seconds, 2.5)
  for (let i = 0; i < 10; i++) assert.equal(log.at(i), i + 1, `第 ${i} 个读数应为 ${i + 1}`)
  assert.equal(log.at(-1), 0, '越界（负）应返回 0')
  assert.equal(log.at(10), 0, '越界（超尾）应返回 0')
  assert.equal(log.max, 10)
  assert.equal(log.timeAt(8), 2, '第 8 个读数对应 2 秒')
  assert.equal(log.timeAt(0), 0)
  assert.equal(log.bytes, 3 * 4 * 4, '3 块 x 4 读数 x 4 字节')

  log.clear()
  assert.equal(log.length, 0)
  assert.equal(log.max, 0)
  assert.equal(log.at(0), 0)

  const capped = new EnergyLog(4, { chunkSize: 2, maxReadings: 3 })
  for (let i = 0; i < 6; i++) capped.push(i)
  assert.equal(capped.length, 3, '到达上限后不再写入')
  assert.equal(capped.full, true)
  assert.equal(capped.at(2), 2)
  assert.equal(capped.at(3), 0)
}

// 2) 小节换算：BPM 按拍号分母的时值计
{
  const l44 = makeLayout({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 4, 93.75)
  assert.equal(l44.beatSeconds, 0.5)
  assert.equal(l44.barSeconds, 2)
  assert.equal(l44.rowSeconds, 8)
  assert.equal(l44.readingsPerRow, 750)
  assert.equal(l44.beatsPerRow, 16)

  const l34 = makeLayout({ bpm: 120, beatsPerBar: 3, beatUnit: 4 }, 4, 93.75)
  assert.equal(l34.barSeconds, 1.5)

  const l68 = makeLayout({ bpm: 120, beatsPerBar: 6, beatUnit: 8 }, 4, 93.75)
  assert.equal(l68.barSeconds, 3, '6/8 里一拍是八分音符，一小节 6 拍')

  // 非法输入要被夹住，不能产生 0 或负的时长
  const bad = makeLayout({ bpm: 0, beatsPerBar: 0, beatUnit: 4 }, 0, 0)
  assert.ok(bad.bpm >= 1 && bad.beatsPerBar >= 1 && bad.barsPerRow >= 1 && bad.rate > 0)
  assert.ok(bad.readingsPerRow > 0)
}

// 3) 行边界：首尾相接、不累积舍入误差
{
  // 故意挑一个除不尽的组合：每行 100.4x 个读数
  const layout = makeLayout({ bpm: 137, beatsPerBar: 3, beatUnit: 4 }, 2, 93.75)
  const rpr = layout.readingsPerRow
  assert.ok(Math.abs(rpr - Math.round(rpr)) > 1e-9, '这个用例需要每行读数不是整数')

  let prevTo = 0
  for (let row = 0; row < 2000; row++) {
    const [from, to] = rowRange(layout, row)
    assert.equal(from, Math.round(row * rpr))
    assert.ok(to > from, '行区间不能为空')
    assert.equal(from, prevTo, `第 ${row} 行必须紧接上一行，不能有缝或重叠`)
    prevTo = to
  }

  // 2000 行之后的累计偏差必须远小于一个读数
  const [farFrom] = rowRange(layout, 2000)
  assert.ok(Math.abs(farFrom - 2000 * rpr) < 0.5, '长记录的累计误差必须 < 0.5 个读数')

  // 逐行累加整数的错误做法会怎样：这里确认我们没有那样做
  assert.notEqual(rowRange(layout, 10)[0], 10 * Math.round(rpr))
}

// 4) 行数
{
  const layout = makeLayout({ bpm: 120, beatsPerBar: 4, beatUnit: 4 }, 4, 93.75)
  assert.equal(rowCount(layout, 0), 0)
  assert.equal(rowCount(layout, 1), 1)
  assert.equal(rowCount(layout, 750), 1)
  assert.equal(rowCount(layout, 751), 2)
  assert.equal(rowCount(layout, 11250), 15, '2 分钟 4/4 120BPM 每行 4 小节 = 15 行')
}

// 5) 谱面行的像素几何
{
  const W = 160
  const H = 40
  const ramp = createEnergyRamp()
  const into = new Uint8ClampedArray(W * H * 4)
  const style = {
    width: W,
    height: H,
    contentLeft: 0,
    barsPerRow: 4,
    beatsPerBar: 4,
    beatsPerRow: 16,
    readingsPerRow: 160,
    scale: 1,
    mode: 'linear',
  }
  const flat = (v) => () => v
  const px = (x, y) => {
    const o = (y * W + x) * 4
    return [into[o], into[o + 1], into[o + 2], into[o + 3]]
  }

  // 恒定 0.5 → 柱顶应落在 height-1-round(0.5*(height-1)) = 19 行
  into.fill(0)
  renderScoreRow(flat(0.5), 0, W, style, ramp, into)
  assert.deepEqual(px(1, 19), [ROW_CAP[0], ROW_CAP[1], ROW_CAP[2], 255], '柱顶行应是亮色描边')
  assert.deepEqual(px(1, 18), [ROW_BG[0], ROW_BG[1], ROW_BG[2], 255], '柱顶之上应是背景')
  assert.deepEqual(px(1, 39), [ramp[0], ramp[1], ramp[2], 255], '底部应是最暗那端渐变')

  // 能量越大柱子越高
  into.fill(0)
  renderScoreRow(flat(1), 0, W, style, ramp, into)
  assert.deepEqual(px(1, 0), [ROW_CAP[0], ROW_CAP[1], ROW_CAP[2], 255], '满量程应顶到第一行')

  into.fill(0)
  renderScoreRow(flat(0), 0, W, style, ramp, into)
  assert.deepEqual(px(1, 38), [ROW_BG[0], ROW_BG[1], ROW_BG[2], 255], '能量为 0 时只剩底部一行')
  assert.deepEqual(px(1, 39), [ROW_CAP[0], ROW_CAP[1], ROW_CAP[2], 255])

  // 小节线比拍线亮，两者都比背景亮
  into.fill(0)
  renderScoreRow(flat(0.5), 0, W, style, ramp, into)
  const barLine = px(0, 0)[0]
  const beatLine = px(10, 0)[0]
  const bg = px(1, 0)[0]
  assert.ok(barLine > beatLine, `小节线应比拍线亮：bar=${barLine} beat=${beatLine}`)
  assert.ok(beatLine > bg, `拍线应比背景亮：beat=${beatLine} bg=${bg}`)

  // 读到超出日志总数时不能越界、不能抛错，且该处应退化成静音（只剩底部基线）
  into.fill(0)
  renderScoreRow((i) => (i < 20 ? 1 : 0), 0, 20, style, ramp, into)
  assert.deepEqual(px(2, 38), [ramp[7 * 3], ramp[7 * 3 + 1], ramp[7 * 3 + 2], 255], 'x=2 仍在数据内，应是满格')
  // 注意避开网格线：拍线落在 x = 0,10,20,... 上，取 x=103
  assert.deepEqual(px(103, 38), [ROW_BG[0], ROW_BG[1], ROW_BG[2], 255], '数据用尽后应为静音')
  assert.deepEqual(px(103, 39), [ROW_CAP[0], ROW_CAP[1], ROW_CAP[2], 255], '静音处仍保留底部基线')

  // alpha 必须写满，否则叠在页面上会透
  into.fill(0)
  renderScoreRow(flat(0.5), 0, W, style, ramp, into)
  for (let i = 3; i < into.length; i += 4) assert.equal(into[i], 255, 'alpha 必须为 255')
}

console.log('✓ 能量记录链路全部检查通过（读数日志 / 小节换算 / 行边界 / 谱面几何）')

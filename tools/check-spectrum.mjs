/**
 * 频谱链路的独立自检：node tools/check-spectrum.mjs
 *
 * 覆盖 FFT 正确性、频率映射、以及「格子颜色 = 能量」的像素输出。
 */
import assert from 'node:assert/strict'
import { SpectrumAnalyser, columnEnergy, fftInPlace } from '../src/lib/fft.ts'
import {
  applyScale,
  buildRowMap,
  createEnergyRamp,
  createPalette,
  fillRows,
  PANEL_BG,
  renderColumn,
  renderEnergyColumn,
  valueAtLevel,
} from '../src/lib/spectrumImage.ts'

const RATE = 48000

// 1) 单频正弦 → 峰值落在正确的 bin 上，且幅度归一化到 ≈ 1.0
{
  const fftSize = 1024
  const numBins = fftSize / 2
  const bin = 64
  // 让频率正好落在 bin 中心（1024/64 = 16 个样本一个周期），避免频谱泄漏
  const freq = (bin * RATE) / fftSize

  const samples = new Float32Array(fftSize)
  for (let i = 0; i < fftSize; i++) {
    samples[i] = Math.sin((2 * Math.PI * freq * i) / RATE)
  }

  const mags = new SpectrumAnalyser(fftSize).analyse(samples)

  let peak = 0
  for (let k = 1; k < numBins; k++) if (mags[k] > mags[peak]) peak = k
  assert.equal(peak, bin, `峰值应落在 bin ${bin}，实际 ${peak}`)
  assert.ok(Math.abs(mags[bin] - 1) < 0.02, `满量程正弦幅度应 ≈ 1.0，实际 ${mags[bin]}`)
  assert.ok(mags[bin + 40] < 0.01, '远离峰值的 bin 应接近 0')
}

// 2) 非法长度要报错，而不是静默算错
{
  assert.throws(() => fftInPlace(new Float32Array(6), new Float32Array(6)), /2 的幂/)
}

// 3) 频率映射：高频在上、低频在下，且每行都有非空频段
{
  const rows = 200
  const numBins = 1024
  const map = buildRowMap(rows, RATE, 2048, 50, 16000)

  assert.equal(map.start.length, rows)
  assert.ok(map.start[0] > map.start[rows - 1], '顶部行必须是高频（bin 更大）')

  for (let y = 0; y < rows; y++) {
    assert.ok(map.start[y] >= 1, `第 ${y} 行不能包含 DC`)
    assert.ok(map.end[y] > map.start[y], `第 ${y} 行不能是空频段`)
    assert.ok(map.end[y] <= numBins, `第 ${y} 行 bin 越界`)
    if (y > 0) assert.ok(map.start[y] <= map.start[y - 1], `第 ${y} 行应不高于上一行的频率`)
  }
}

// 4) 像素输出：alpha 写满，信号越强颜色越亮
{
  const rows = 100
  const numBins = 1024
  const map = buildRowMap(rows, RATE, 2048, 50, 16000)
  const palette = createPalette()
  const buf = new Uint8ClampedArray(2 * rows * 4)

  const brightness = () => {
    let s = 0
    for (let i = 0; i < buf.length; i += 4) s += buf[i] + buf[i + 1] + buf[i + 2]
    return s
  }

  renderColumn(new Float32Array(numBins), map, palette, 20, buf, 2)
  for (let i = 3; i < buf.length; i += 4) assert.equal(buf[i], 255, 'alpha 应为 255')
  const quiet = brightness()

  renderColumn(new Float32Array(numBins).fill(0.5), map, palette, 20, buf, 2)
  const loud = brightness()

  assert.ok(loud > quiet * 1.5, `更强的信号必须更亮：quiet=${quiet} loud=${loud}`)
}

// 5) 总能量：恒非负，且随信号单调增长
{
  const numBins = 1024
  assert.equal(columnEnergy(new Float32Array(numBins)), 0, '全 0 输入的能量必须是 0')

  const quiet = columnEnergy(new Float32Array(numBins).fill(0.001))
  const loud = columnEnergy(new Float32Array(numBins).fill(0.1))
  assert.ok(quiet > 0, '有信号时能量必须为正')
  assert.ok(loud > quiet, '更强的信号能量必须更大')
}

// 6) 能量柱：能量越大柱子越高、超出满量程夹在面板顶部、不碰面板以上的行
{
  const rows = 100
  const topRow = 60
  const width = 2
  const ramp = createEnergyRamp()
  const cap = [236, 254, 255]
  const buf = new Uint8ClampedArray(width * rows * 4)

  // 面板里第一条不是背景色的行，就是柱顶
  const topmostLitRow = () => {
    for (let y = topRow; y < rows; y++) {
      const o = y * width * 4
      if (buf[o] !== PANEL_BG[0] || buf[o + 1] !== PANEL_BG[1] || buf[o + 2] !== PANEL_BG[2]) {
        return y
      }
    }
    return rows
  }

  buf.fill(0)
  renderEnergyColumn(1, 10, 'linear', buf, width, topRow, rows, ramp, cap)
  const low = topmostLitRow()

  buf.fill(0)
  renderEnergyColumn(8, 10, 'linear', buf, width, topRow, rows, ramp, cap)
  const high = topmostLitRow()
  assert.ok(high < low, `能量更大时柱顶应更高：low=${low} high=${high}`)

  buf.fill(0)
  renderEnergyColumn(999, 10, 'linear', buf, width, topRow, rows, ramp, cap)
  assert.equal(topmostLitRow(), topRow, '超出满量程必须夹在面板顶部')

  for (let y = 0; y < topRow; y++) {
    assert.equal(buf[y * width * 4 + 3], 0, `第 ${y} 行在面板之上，不该被动到`)
  }

  buf.fill(0)
  renderEnergyColumn(0, 10, 'linear', buf, width, topRow, rows, ramp, cap)
  assert.equal(topmostLitRow(), rows - 1, '能量为 0 时只剩底部一条基线')
}

// 7) fillRows 只动指定区间
{
  const width = 2
  const rows = 10
  const buf = new Uint8ClampedArray(width * rows * 4)
  fillRows(buf, width, 3, 5, [1, 2, 3])

  for (let y = 3; y < 5; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      assert.deepEqual([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]], [1, 2, 3, 255])
    }
  }
  assert.equal(buf[2 * width * 4 + 3], 0, '区间之前不该被改')
  assert.equal(buf[5 * width * 4 + 3], 0, '区间之后不该被改')
}

// 8) 纵轴刻度：三种都满足 0 -> 0 且单调；db 必须把弱音抬得最高
{
  const scale = 1
  assert.equal(applyScale(0, scale, 'linear'), 0, '0 能量在三种刻度下都必须是 0')
  assert.equal(applyScale(0, scale, 'sqrt'), 0)
  assert.equal(applyScale(0, scale, 'db'), 0)
  assert.equal(applyScale(1, scale, 'db'), 1, '满量程在 db 下应正好到顶')

  // 0.0325 是实测出来的中位数（鼓点 + 和声，3000 个读数）
  const weak = 0.0325
  const lin = applyScale(weak, scale, 'linear')
  const sq = applyScale(weak, scale, 'sqrt')
  const db = applyScale(weak, scale, 'db')
  assert.ok(sq > lin, 'sqrt 必须比线性抬得高')
  assert.ok(db > sq, 'db 必须比 sqrt 抬得还高')
  assert.ok(lin < 0.05, `线性下这个弱音应低于 5% 高度，实际 ${(lin * 100).toFixed(1)}%`)
  assert.ok(db > 0.4, `db 下这个弱音应高于 40% 高度，实际 ${(db * 100).toFixed(1)}%`)

  let prev = -1
  for (const v of [0, 1e-6, 1e-4, 0.01, 0.1, 0.5, 1, 10]) {
    const x = applyScale(v, scale, 'db')
    assert.ok(x >= prev, 'db 刻度必须单调不减')
    prev = x
  }

  // valueAtLevel 必须和 applyScale 互为逆，否则面板上标的刻度值就是在骗人
  for (const mode of ['linear', 'sqrt', 'db']) {
    for (const e of [0.001, 0.02, 0.3, 1]) {
      const back = valueAtLevel(scale, applyScale(e, scale, mode), mode)
      assert.ok(Math.abs(back - e) < 1e-6, `${mode} 下 ${e} 往返应回到自身，实际 ${back}`)
    }
  }
}

console.log('✓ 频谱 + 能量链路全部检查通过（FFT / 频率映射 / 上色 / 能量 / 面板布局 / 刻度）')

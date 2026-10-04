/**
 * 离线预览：不接麦克风，用合成音频跑一遍完整的像素管线，输出一张 PNG。
 *
 *   node tools/preview-spectrum.mjs
 *
 * 用途：改完渲染逻辑后，不开浏览器就能确认两个面板的布局、配色和能量柱形状。
 * 参数与 App.svelte 里的一致。
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { analyseAudioBuffer } from '../src/lib/audioFile.ts'
import { EnergyLog } from '../src/lib/energyLog.ts'
import { SpectrumAnalyser, columnEnergy } from '../src/lib/fft.ts'
import { makeLayout, rowCount, renderScoreRow } from '../src/lib/score.ts'
import {
  buildRowMap,
  createEnergyRamp,
  createPalette,
  dbByteToIndex,
  fillRows,
  renderColumn,
  renderEnergyColumn,
} from '../src/lib/spectrumImage.ts'

// ---- 与 App.svelte 保持一致的显示参数 ----
const RATE = 48000
const FFT_SIZE = 2048
const HOP = 512
const COL_W = 2
const F_MIN = 50
const F_MAX = 16000
const SPEC_RATIO = 0.62
const PANEL_GAP = 10
const GAIN_DB = 20

const COLS = 420
const W = COLS * COL_W
const H = 560
const specRows = Math.round(H * SPEC_RATIO)
const energyTop = specRows + PANEL_GAP

const ROW_H = 48

const GAP_RGB = [10, 10, 18]
const SEP_RGB = [38, 38, 52]
const CAP_RGB = [236, 254, 255]

// ---- 合成一段测试音频：对数扫频 + 脉冲音 + 噪声脉冲 ----
const total = FFT_SIZE + COLS * HOP
const audio = new Float32Array(total)
let seed = 12345
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

let phase = 0
for (let i = 0; i < total; i++) {
  const t = i / RATE
  const p = i / total

  // 1) 200Hz → 8kHz 对数扫频
  const f = 200 * Math.pow(8000 / 200, p)
  phase += (2 * Math.PI * f) / RATE
  let s = Math.sin(phase) * 0.35

  // 2) 1kHz 脉冲音：每 0.35s 响 0.12s，制造明显的能量起伏
  const pulse = t % 0.35 < 0.12 ? 1 : 0
  s += Math.sin(2 * Math.PI * 1000 * t) * 0.3 * pulse

  // 3) 噪声脉冲：每 0.9s 来一次宽带冲击
  if (t % 0.9 < 0.06) s += (rand() * 2 - 1) * 0.25

  audio[i] = s
}

// ---- 逐列渲染 ----
const analyser = new SpectrumAnalyser(FFT_SIZE)
const rowMap = buildRowMap(specRows, RATE, FFT_SIZE, F_MIN, F_MAX)
const palette = createPalette()
const ramp = createEnergyRamp()

const canvas = new Uint8ClampedArray(W * H * 4)
fillRows(canvas, W, 0, H, [7, 7, 12])

const colBuf = new Uint8ClampedArray(COL_W * H * 4)
let energyMax = 1e-7
let peak = 0

for (let c = 0; c < COLS; c++) {
  const mags = analyser.analyse(audio.subarray(c * HOP, c * HOP + FFT_SIZE))
  const energy = columnEnergy(mags)
  if (energy > energyMax) energyMax = energy

  colBuf.fill(0)
  renderColumn(mags, rowMap, palette, GAIN_DB, colBuf, COL_W)
  fillRows(colBuf, COL_W, specRows, energyTop, GAP_RGB)
  fillRows(colBuf, COL_W, specRows, specRows + 1, SEP_RGB)
  renderEnergyColumn(energy, energyMax, 'db', colBuf, COL_W, energyTop, H, ramp, CAP_RGB)

  const x0 = c * COL_W
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < COL_W; x++) {
      const s = (y * COL_W + x) * 4
      const d = (y * W + x0 + x) * 4
      canvas[d] = colBuf[s]
      canvas[d + 1] = colBuf[s + 1]
      canvas[d + 2] = colBuf[s + 2]
      canvas[d + 3] = 255
    }
  }
}

// ---- 最小 PNG 编码器（zlib 来自 node 内置，无需依赖） ----
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4)
    raw[o] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, o + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = encodePng(W, H, canvas)
writeFileSync('tools/preview-spectrum.png', png)
console.log(`频谱预览 ${W}x${H}（频谱面板 0..${specRows}，能量面板 ${energyTop}..${H}）`)
console.log(`  能量满量程 = ${energyMax.toFixed(4)}  ->  tools/preview-spectrum.png (${(png.length / 1024).toFixed(1)} KB)`)

// ---- 谱面预览：每小节第一拍一记低鼓 + 每拍一记中鼓 + 按拍换音高的和声 ----
// 段落严格按 120BPM 4/4 重复，所以如果小节线对得上，图上每行的鼓点应该落在同一些位置。
{
  const BPM = 120
  const BEATS = 4
  const BEAT_UNIT = 4
  const BARS_PER_ROW = 4
  const SECONDS = 32

  const beatSec = 60 / BPM
  const barSec = BEATS * beatSec
  const scoreCols = Math.round((SECONDS * RATE) / HOP)
  const total2 = FFT_SIZE + scoreCols * HOP
  const audio2 = new Float32Array(total2)

  for (let i = 0; i < total2; i++) {
    const t = i / RATE
    const inBar = t % barSec
    const beat = Math.floor(inBar / beatSec)
    const beatPhase = inBar - beat * beatSec

    let s = 0
    if (inBar < 0.09) s += Math.sin(2 * Math.PI * 55 * t) * Math.exp(-inBar * 38) * 1.0
    if (beatPhase < 0.04) s += Math.sin(2 * Math.PI * 190 * t) * Math.exp(-beatPhase * 70) * 0.45
    const semi = [0, 3, 5, 7][beat]
    s += Math.sin(2 * Math.PI * 330 * Math.pow(2, semi / 12) * t) * 0.14
    audio2[i] = s
  }

  const log = new EnergyLog(RATE / HOP)
  const analyser2 = new SpectrumAnalyser(FFT_SIZE)
  for (let c = 0; c < scoreCols; c++) {
    log.push(columnEnergy(analyser2.analyse(audio2.subarray(c * HOP, c * HOP + FFT_SIZE))))
  }

  const layout = makeLayout({ bpm: BPM, beatsPerBar: BEATS, beatUnit: BEAT_UNIT }, BARS_PER_ROW, log.rate)
  const rows = rowCount(layout, log.length)
  const SW = 840
  const scoreCanvas = new Uint8ClampedArray(SW * rows * ROW_H * 4)

  const style = {
    width: SW,
    height: ROW_H,
    contentLeft: 74,
    barsPerRow: layout.barsPerRow,
    beatsPerBar: layout.beatsPerBar,
    beatsPerRow: layout.beatsPerRow,
    readingsPerRow: layout.readingsPerRow,
    scale: log.max,
    mode: 'db',
  }

  const rowImage = new Uint8ClampedArray(SW * ROW_H * 4)
  const read = (i) => log.at(i)
  for (let row = 0; row < rows; row++) {
    rowImage.fill(0)
    renderScoreRow(read, Math.round(row * layout.readingsPerRow), log.length, style, ramp, rowImage)
    scoreCanvas.set(rowImage, row * SW * ROW_H * 4)
  }

  const scorePng = encodePng(SW, rows * ROW_H, scoreCanvas)
  writeFileSync('tools/preview-score.png', scorePng)
  console.log(
    `谱面预览 ${SW}x${rows * ROW_H}  ${rows} 行 x ${BARS_PER_ROW} 小节` +
      `（每小节 ${layout.barSeconds}s，每行 ${layout.readingsPerRow.toFixed(1)} 个读数）`
  )
  console.log(
    `  ${log.length} 个读数 / ${log.seconds.toFixed(1)}s  ->  tools/preview-score.png (${(scorePng.length / 1024).toFixed(1)} KB)`
  )
}

// ---- 整曲概览预览：走真实的「本地音频文件」分析链路 ----
// 造一个 40 秒、分段的假 AudioBuffer（前奏弱 -> 主歌 -> 副歌强 -> 尾奏），
// 这样频谱和能量曲线上应该能一眼看出四个段落。
{
  const fileRate = 48000
  const seconds = 40
  const n = fileRate * seconds
  const samples = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const t = i / fileRate
    let level = 0.12
    if (t >= 8 && t < 20) level = 0.35
    else if (t >= 20 && t < 32) level = 0.85
    else if (t >= 32) level = 0.2

    const beat = t % 0.5
    let s = Math.sin(2 * Math.PI * 220 * t) * 0.25 * level
    s += Math.sin(2 * Math.PI * 880 * t) * 0.12 * level
    s += Math.sin(2 * Math.PI * (300 + 200 * Math.sin(t * 0.3)) * t) * 0.1 * level
    if (beat < 0.05) s += Math.sin(2 * Math.PI * 60 * t) * Math.exp(-beat * 40) * level
    samples[i] = s
  }

  const fake = {
    numberOfChannels: 1,
    length: n,
    sampleRate: fileRate,
    duration: seconds,
    getChannelData: () => samples,
  }

  const result = await analyseAudioBuffer(fake, 'demo-song.wav', { rasterMaxWidth: 1200 })

  const specH = result.specRows
  const gapH = 10
  const energyH = 140
  const OW = result.rasterWidth
  const OH = specH + gapH + energyH
  const buf = new Uint8ClampedArray(OW * OH * 4)

  // 1) 频谱：dB 字节 -> 调色板
  for (let y = 0; y < specH; y++) {
    for (let x = 0; x < OW; x++) {
      const p = dbByteToIndex(result.raster[x * specH + y], 20) * 3
      const o = (y * OW + x) * 4
      buf[o] = palette[p]
      buf[o + 1] = palette[p + 1]
      buf[o + 2] = palette[p + 2]
      buf[o + 3] = 255
    }
  }

  // 2) 空隙 + 分隔线
  for (let y = specH; y < specH + gapH; y++) {
    for (let x = 0; x < OW; x++) {
      const o = (y * OW + x) * 4
      buf[o] = 10
      buf[o + 1] = 10
      buf[o + 2] = 18
      buf[o + 3] = 255
    }
  }
  for (let x = 0; x < OW; x++) {
    const o = (specH * OW + x) * 4
    buf[o] = 38
    buf[o + 1] = 38
    buf[o + 2] = 52
    buf[o + 3] = 255
  }

  // 3) 能量：整首歌一行铺满，不要网格
  const strip = new Uint8ClampedArray(OW * energyH * 4)
  renderScoreRow(
    (i) => result.log.at(i),
    0,
    result.log.length,
    {
      width: OW,
      height: energyH,
      contentLeft: 0,
      barsPerRow: 1,
      beatsPerBar: 1,
      beatsPerRow: 0,
      readingsPerRow: Math.max(1, result.log.length),
      scale: Math.max(1e-7, result.log.max),
      mode: 'db',
    },
    ramp,
    strip
  )
  buf.set(strip, (specH + gapH) * OW * 4)

  const filePng = encodePng(OW, OH, buf)
  writeFileSync('tools/preview-file.png', filePng)
  console.log(
    `整曲概览 ${OW}x${OH}  ${result.columns} 列 / ${result.durationSeconds}s / ${result.sampleRate}Hz`
  )
  console.log(
    `  栅格压缩到 ${result.rasterWidth} 列，分析占用 ${((result.raster.length + result.log.bytes) / 1024 / 1024).toFixed(1)} MB  ->  tools/preview-file.png (${(filePng.length / 1024).toFixed(1)} KB)`
  )
}

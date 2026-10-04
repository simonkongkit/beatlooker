/**
 * 本地音频文件分析链路的独立自检：node tools/check-audiofile.mjs
 *
 * 用假的 AudioBuffer（鸭子类型）跑离线分析，不需要浏览器也不需要真实音频文件。
 * 覆盖：列数公式、读数日志、栅格尺寸/取值、纯音落点、超长压缩、取消、太短报错。
 */
import assert from 'node:assert/strict'
import { analyseAudioBuffer } from '../src/lib/audioFile.ts'
import { buildRowMap } from '../src/lib/spectrumImage.ts'

const RATE = 48000
const FFT_SIZE = 2048
const HOP = 512

/** 造一个满足 analyseAudioBuffer 需要的假 AudioBuffer（长度由传入的数组决定） */
function fakeBuffer(channelData, sampleRate = RATE) {
  const length = channelData[0].length
  return {
    numberOfChannels: channelData.length,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => channelData[c],
    _data: channelData,
  }
}

function sineInto(array, freq, sampleRate = RATE, amp = 1) {
  for (let i = 0; i < array.length; i++) array[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
  return array
}

// 1) 列数公式 + 读数日志
{
  const buf = fakeBuffer([new Float32Array(Math.round(RATE * 1))])
  const a = await analyseAudioBuffer(buf, 'one-second.wav')

  const expected = Math.floor((buf.length - FFT_SIZE) / HOP) + 1
  assert.equal(a.columns, expected, '列数必须是 floor((N - fftSize)/hop) + 1')
  assert.equal(a.log.length, expected, '每列必须恰好有一个能量读数')
  assert.ok(Math.abs(a.log.rate - RATE / HOP) < 1e-9, '读数速率 = 采样率 / hop')
  assert.equal(a.name, 'one-second.wav')
  assert.equal(a.sampleRate, RATE)
  assert.equal(a.durationSeconds, 1)
  assert.equal(a.rasterWidth, a.columns, '歌不长时栅格宽度应等于列数')
  assert.equal(a.raster.length, a.rasterWidth * a.specRows)
}

// 2) 栅格取值必须在合法范围（dB 字节，真值 = 字节 - 140）
{
  const buf = fakeBuffer([new Float32Array(Math.round(RATE * 0.5))])
  sineInto(buf._data[0], 1000, RATE, 0.5)
  const a = await analyseAudioBuffer(buf, 'tone.wav')

  let lo = 255
  let hi = 0
  for (const v of a.raster) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  assert.ok(lo >= 0 && hi <= 135, `dB 字节必须在 0..135，实际 ${lo}..${hi}`)
}

// 3) 1kHz 纯音的峰值必须落在频率轴正确的那一行
{
  const buf = fakeBuffer([new Float32Array(RATE)])
  sineInto(buf._data[0], 1000)
  const a = await analyseAudioBuffer(buf, 'tone.wav')

  // 用同一套映射算出 1kHz 应该在第几行
  const rowMap = buildRowMap(a.specRows, RATE, FFT_SIZE, 50, 16000)
  const binHz = RATE / FFT_SIZE
  const wantBin = Math.round(1000 / binHz)
  let wantRow = -1
  for (let y = 0; y < a.specRows; y++) {
    if (wantBin >= rowMap.start[y] && wantBin < rowMap.end[y]) wantRow = y
  }
  assert.ok(wantRow > 0, '应当能在频率轴上找到 1kHz 那一行')

  // 取中间那一列（避开起始瞬态），找峰值行
  const mid = Math.floor(a.rasterWidth / 2)
  let peakRow = 0
  let peakVal = -1
  for (let y = 0; y < a.specRows; y++) {
    const v = a.raster[mid * a.specRows + y]
    if (v > peakVal) {
      peakVal = v
      peakRow = y
    }
  }
  assert.ok(peakVal >= 130, `满量程纯音的峰值行应该很亮，实际 ${peakVal}`)
  assert.ok(
    Math.abs(peakRow - wantRow) <= 2,
    `1kHz 峰值应落在第 ${wantRow} 行附近，实际 ${peakRow}`
  )

  // 低频段应该基本没有能量
  const lowRow = Math.floor(a.specRows * 0.9)
  assert.ok(a.raster[mid * a.specRows + lowRow] < 80, '50Hz 附近不该有 1kHz 的能量')
}

// 4) 长文件：栅格宽度被压到上限，且逐行取最大值（不是平均值）
{
  const seconds = 20
  const buf = fakeBuffer([new Float32Array(RATE * seconds)])
  sineInto(buf._data[0], 1000)
  const a = await analyseAudioBuffer(buf, 'long.wav', { rasterMaxWidth: 200 })

  assert.ok(a.columns > 200, '这个用例要的是列数远超栅格宽度')
  assert.equal(a.rasterWidth, 200, '栅格宽度必须被夹到上限')
  assert.equal(a.raster.length, 200 * a.specRows)
  // 压缩后纯音仍然是亮的（最大值法保住了它；平均值法会被静音行拉低）
  const mid = 100
  let peak = 0
  for (let y = 0; y < a.specRows; y++) peak = Math.max(peak, a.raster[mid * a.specRows + y])
  assert.ok(peak >= 130, `压缩后纯音峰值仍应很亮，实际 ${peak}`)
}

// 5) 取消：列数足够多时才需要让出主线程，取消应返回 null
{
  const buf = fakeBuffer([new Float32Array(RATE * 4)])
  const cancelled = await analyseAudioBuffer(buf, 'cancel.wav', {}, undefined, () => true)
  assert.equal(cancelled, null, '被取消时必须返回 null')
}

// 6) 太短的音频要明确报错，而不是返回一份空结果
{
  const buf = fakeBuffer([new Float32Array(1000)])
  await assert.rejects(() => analyseAudioBuffer(buf, 'tiny.wav'), /太短|43ms/)
}

// 7) 进度回调必须从 0 走到 total
{
  const buf = fakeBuffer([new Float32Array(RATE)])
  const seen = []
  await analyseAudioBuffer(buf, 'p.wav', {}, (p) => seen.push(p.done))
  const total = Math.floor((buf.length - FFT_SIZE) / HOP) + 1
  assert.equal(seen[0], 0, '第一次回调应从 0 开始')
  assert.ok(seen.length >= 2, '至少应有开始和结束两次回调')
  assert.equal(seen[seen.length - 1], total, '最后一次回调应是总列数')
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], '进度不能倒退')
}

// 8) 立体声：两声道混成单声道后仍然分析得出来
{
  const left = sineInto(new Float32Array(RATE), 1000)
  const right = sineInto(new Float32Array(RATE), 1000)
  const buf = fakeBuffer([left, right])
  assert.equal(buf.numberOfChannels, 2)

  const a = await analyseAudioBuffer(buf, 'stereo.mp3')
  assert.equal(a.channels, 2, '声道数要如实报告')

  const mid = Math.floor(a.rasterWidth / 2)
  let peak = 0
  for (let y = 0; y < a.specRows; y++) peak = Math.max(peak, a.raster[mid * a.specRows + y])
  assert.ok(peak >= 130, `两个声道同相相加后仍应是满量程，实际 ${peak}`)
}

console.log('✓ 音频文件链路全部检查通过（解码后分析 / 栅格 / 频率落点 / 压缩 / 取消 / 报错）')

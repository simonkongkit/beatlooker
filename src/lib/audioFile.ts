/**
 * 本地音频文件 → 整曲分析。
 *
 * 解码走浏览器内置的 decodeAudioData，所以 mp3 / wav / m4a(aac) / ogg / flac
 * 这些常见格式都能吃（具体支持哪些取决于浏览器，见 README），不引第三方解码库。
 *
 * 分析和实时采集用的是完全同一套 FFT / 分帧逻辑，区别只有两点：
 *   1. 不加延迟 —— 延迟是实时监听的用法，离线分析要覆盖整首歌
 *   2. 结果是同步分块算完的，所以要主动让出主线程并汇报进度
 */

// 显式带 .ts：这个模块会被 node 直接加载跑自检（tools/check-audiofile.mjs），
// 而 node 的原生类型剥离不做扩展名补全。Vite 侧同样认这个写法。
import { EnergyLog } from './energyLog.ts'
import { SpectrumAnalyser, columnEnergy } from './fft.ts'
import { buildRowMap, rowDbBytes } from './spectrumImage.ts'
import { NoteLog } from './noteLog.ts'
import { PeakLog } from './peakLog.ts'
import { findPeaks } from './harmonic.ts'
import { bandEnergies, buildBands, type Band } from './noteBands.ts'

export interface AnalyseOptions {
  /** 解码后统一重采样到这个采样率，默认 48000 */
  sampleRate?: number
  fftSize?: number
  hop?: number
  /** 频谱栅格纵向行数 */
  specRows?: number
  fMin?: number
  fMax?: number
  /** 栅格最宽多少列；歌再长也压到这个宽度 */
  rasterMaxWidth?: number
}

export interface FileAnalysis {
  name: string
  sampleRate: number
  durationSeconds: number
  channels: number
  /** 整曲能量记录（汉宁窗），谱面视图和能量面板用它 */
  log: EnergyLog
  /** 起音检测专用的能量记录（锯齿窗，左高右低） */
  onsetLog: EnergyLog
  /**
   * 每列的谱峰。谐波求和要用 —— 频带日志的分辨率不够（见 peakLog.ts 的说明）。
   */
  peakLog: PeakLog
  /** 一共分析出多少列 */
  columns: number
  specRows: number
  rasterWidth: number
  /**
   * 频谱栅格：rasterWidth x specRows，每字节是一行的 dB（真值 = 该字节 + DB_FLOOR）。
   * 存 dB 而不是颜色，是为了改灵敏度时不用重算整首歌。
   */
  raster: Uint8Array
  /** 频率带能量记录（每列每条带一个 dB 字节），按音高检测起点要用 */
  noteLog: NoteLog
  /** 频带划分，和 noteLog 一一对应 */
  bands: Band[]
}

export interface AnalyseProgress {
  done: number
  total: number
}

const DEFAULT_RASTER_WIDTH = 4096
/**
 * 频带日志最多记多少列。
 * 每列是「音带数」个字节，一首歌几万列也就几 MB；但一小时的文件会有 33 万列，
 * 那就上百 MB 了 —— 所以加个上限，超出的部分不记频带（总能量照常记）。
 */
const NOTE_LOG_MAX_COLUMNS = 60000
/** 每算多少列让出一次主线程 */
const CHUNK = 300

/**
 * 解码本地音频文件。
 *
 * 用 OfflineAudioContext 而不是 AudioContext：既不需要用户手势，
 * 又能把结果统一重采样到指定采样率，不受声卡实际采样率影响 ——
 * 否则同一个文件在不同机器上时间轴会不一样。
 */
export async function decodeAudioFile(file: File, sampleRate = 48000): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, sampleRate)
  return await ctx.decodeAudioData(bytes)
}

/** 多声道混成单声道 */
function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  if (channels === 1) return buffer.getChannelData(0)

  const length = buffer.length
  const out = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) out[i] += data[i]
  }
  for (let i = 0; i < length; i++) out[i] /= channels
  return out
}

/**
 * 离线分析整段音频。
 *
 * @param onProgress  每算完一块回调一次，用来画进度
 * @param isCancelled 返回 true 表示放弃本次分析（用户又选了别的文件）
 * @returns 分析结果；被取消时返回 null
 */
export async function analyseAudioBuffer(
  buffer: AudioBuffer,
  name: string,
  options: AnalyseOptions = {},
  onProgress?: (p: AnalyseProgress) => void,
  isCancelled?: () => boolean
): Promise<FileAnalysis | null> {
  const fftSize = options.fftSize ?? 2048
  const hop = options.hop ?? 512
  const specRows = options.specRows ?? 360
  const fMin = options.fMin ?? 50
  const fMax = options.fMax ?? 16000
  const rasterMaxWidth = options.rasterMaxWidth ?? DEFAULT_RASTER_WIDTH

  const sampleRate = buffer.sampleRate
  const mono = toMono(buffer)

  // 第一列的窗口结尾放在 fftSize 处，这样第一列正好覆盖文件开头
  const columns = mono.length >= fftSize ? Math.floor((mono.length - fftSize) / hop) + 1 : 0
  if (columns === 0) {
    throw new Error('音频太短了：不足一个 FFT 窗口（约 43ms）。')
  }

  const rasterWidth = Math.max(1, Math.min(columns, rasterMaxWidth))
  const raster = new Uint8Array(rasterWidth * specRows)
  const sameWidth = rasterWidth === columns

  const analyser = new SpectrumAnalyser(fftSize, 'hann')
  // 起音检测专用的锯齿窗那一路，和汉宁那路独立
  const onsetAnalyser = new SpectrumAnalyser(fftSize, 'sawtooth')
  const rowMap = buildRowMap(specRows, sampleRate, fftSize, fMin, fMax)
  const log = new EnergyLog(sampleRate / hop, { maxReadings: columns })
  const onsetLog = new EnergyLog(sampleRate / hop, { maxReadings: columns })
  const peakLog = new PeakLog(sampleRate / hop, { maxColumns: columns })
  const row = new Uint8Array(specRows)

  // 频带按和实时采集**完全相同**的方式切（同一个 buildBands、同一个频率范围），
  // 否则同一个演奏在两种模式下会给出不同的音名
  const bands = buildBands(fMin, fMax, fftSize, sampleRate)
  const noteLog = new NoteLog(bands.length, sampleRate / hop, {
    maxColumns: Math.min(columns, NOTE_LOG_MAX_COLUMNS)
  })
  const bandScratch = new Float32Array(bands.length)

  onProgress?.({ done: 0, total: columns })

  for (let c = 0; c < columns; c++) {
    const end = fftSize + c * hop
    const magnitudes = analyser.analyse(mono.subarray(end - fftSize, end))
    log.push(columnEnergy(magnitudes))
    onsetLog.push(columnEnergy(onsetAnalyser.analyse(mono.subarray(end - fftSize, end))))
    peakLog.push(findPeaks(magnitudes, sampleRate, fftSize))
    // 和总能量在同一列上产出，索引对齐
    bandEnergies(magnitudes, bands, bandScratch)
    noteLog.pushEnergies(bandScratch)

    rowDbBytes(magnitudes, rowMap, row)

    if (sameWidth) {
      raster.set(row, c * specRows)
    } else {
      // 歌比栅格宽：多个源列并进同一列像素，逐行取最大值（保住瞬态）
      const base = Math.min(rasterWidth - 1, Math.floor((c / columns) * rasterWidth)) * specRows
      for (let y = 0; y < specRows; y++) {
        if (row[y] > raster[base + y]) raster[base + y] = row[y]
      }
    }

    if (c % CHUNK === CHUNK - 1) {
      onProgress?.({ done: c + 1, total: columns })
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isCancelled?.()) return null
    }
  }

  onProgress?.({ done: columns, total: columns })

  return {
    name,
    sampleRate,
    durationSeconds: buffer.duration,
    channels: buffer.numberOfChannels,
    log,
    onsetLog,
    peakLog,
    columns,
    specRows,
    rasterWidth,
    raster,
    noteLog,
    bands,
  }
}

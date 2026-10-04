import { DelayLine } from './delayLine'
import { EnergyLog } from './energyLog'
import { SpectrumAnalyser, columnEnergy } from './fft'
import { Spectrogram } from './spectrogram'
import { F_MAX, F_MIN } from './fft'
import { MicRecorder } from './recorder.ts'
import { NoteLog } from './noteLog.ts'
import { PeakLog } from './peakLog.ts'
import { findPeaks } from './harmonic.ts'
import { bandEnergies, buildBands, type Band } from './noteBands.ts'

export interface MicrophoneOptions {
  /** 延迟多少秒后再分析（整张频谱图整体后退这么多），默认 1 秒 */
  delaySeconds?: number
  /** FFT 点数，必须是 2 的幂；决定频率分辨率，默认 2048 */
  fftSize?: number
  /** 每积累多少个样本产出一列频谱；决定时间分辨率，默认 512 */
  hop?: number
  /** 原始音频环形缓冲保留多久，必须大于 delay + fftSize/sampleRate */
  historySeconds?: number
  /** 频谱列环形缓冲容量，即渲染最多允许积压多少列 */
  columnCapacity?: number
  /** 能量记录最多存多少秒（防止长时间挂着把内存吃光），默认 1 小时 */
  logMaxSeconds?: number
}

/**
 * 麦克风 → 频谱列。
 *
 * 数据流：
 *   worklet 每 2048 样本送一批原始音频
 *     → 原始音频写入 DelayLine（4 秒）
 *     → 每积累 hop 个样本，就从 DelayLine 里「倒着 delaySeconds 秒」
 *       取一个 fftSize 长的窗口做 FFT
 *     → 幅度谱作为一列写进 Spectrogram
 *
 * 延迟发生在取窗那一步：窗口的结尾固定在「最新样本往前 delaySamples 个」，
 * 所以延迟是按样本数精确计算的，跟渲染帧率无关。
 */
export class MicrophoneSpectrum {
  readonly fftSize: number
  readonly hop: number
  readonly spectrum: Spectrogram

  /**
   * 能量读数记录，隐含保存时间轴（第 i 个读数 = i / rate 秒）。
   *
   * 第一次 start() 时按实际采样率创建，之后一直保留 —— 停止采集不会清空它，
   * 否则「录完再看」这个用法就没意义了。要清空请调 clearLog()。
   */
  log: EnergyLog | null = null

  /**
   * 频率带能量记录：每列每条带一个 dB 字节。
   *
   * 和 log 一样在第一次 start() 时按实际采样率创建 —— 建带要用到 bin 宽度，
   * 而那取决于采样率。采样率变了就重建（时间轴和频率轴都变了）。
   */
  noteLog: NoteLog | null = null
  /**
   * 起音检测用的能量日志（锯齿窗算出来的），和 log（汉宁窗）一一对应。
   * 检测起点只用它，认音名仍然用汉宁那路。
   */
  onsetLog: EnergyLog | null = null
  /**
   * 每列的**谱峰**（频率 + 幅度）。
   *
   * 谐波求和必须知道"某次谐波位置上到底有没有峰" ✓ 而频带日志给不出这个 ——
   * 全音域才 ~80 条带，500Hz 以下每条覆盖 2~3 个半音 ✗ 中心频率离真实谐波太远 ✓
   * 实测两条路 0/20 一致，所以单独存一份峰。
   */
  peakLog: PeakLog | null = null
  /** 当前使用的频带划分 */
  bands: Band[] = []

  /**
   * 录音器：只为了回放自己刚弹的那一遍。和分析链路完全独立 ——
   * 一条 MediaStream 可以同时喂给 worklet 和 MediaRecorder，互不干扰。
   */
  readonly recorder = new MicRecorder()

  /** 延迟秒数，可以运行中随时改 */
  delaySeconds: number
  historySeconds: number
  logMaxSeconds: number

  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private line: DelayLine | null = null

  private readonly analyser: SpectrumAnalyser
  /**
   * 起音检测专用的分析器：**锯齿窗（左高右低）**，和上面那路汉宁窗完全独立。
   *
   * 两条链路分工：
   *   · analyser（汉宁）→ 频谱图显示 + 音高识别 —— 要好频率分辨率
   *   · onsetAnalyser（锯齿）→ 只出「这一列有多响」—— 要好时间定位
   */
  private readonly onsetAnalyser: SpectrumAnalyser
  private readonly window: Float32Array
  private readonly hopBuffer: Float32Array
  private bandScratch: Float32Array = new Float32Array(0)
  private filled = 0

  constructor(options: MicrophoneOptions = {}) {
    this.fftSize = options.fftSize ?? 2048
    this.hop = options.hop ?? 512
    this.delaySeconds = options.delaySeconds ?? 1
    this.historySeconds = options.historySeconds ?? 4
    this.logMaxSeconds = options.logMaxSeconds ?? 3600

    this.analyser = new SpectrumAnalyser(this.fftSize, 'hann')
    this.onsetAnalyser = new SpectrumAnalyser(this.fftSize, 'sawtooth')
    this.window = new Float32Array(this.fftSize)
    this.hopBuffer = new Float32Array(this.hop)
    this.spectrum = new Spectrogram(options.columnCapacity ?? 512, this.analyser.numBins)
  }

  get isRunning(): boolean {
    return this.line !== null
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0
  }

  /** 每秒产出多少列频谱 */
  get columnsPerSecond(): number {
    const rate = this.sampleRate
    return rate ? rate / this.hop : 0
  }

  get bufferedSeconds(): number {
    const rate = this.sampleRate
    return rate && this.line ? this.line.length / rate : 0
  }

  /** 原始缓冲是否已经攒够「延迟 + 一个 FFT 窗口」 */
  get ready(): boolean {
    const rate = this.sampleRate
    if (!rate || !this.line) return false
    const need = Math.round(this.delaySeconds * rate) + this.fftSize
    return this.line.length >= need
  }

  async start(): Promise<void> {
    if (this.line) return

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        '拿不到麦克风接口。请用 http://localhost 打开（file:// 直接双击打开不行）。'
      )
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 做频谱分析要原始声音，关掉这三项后处理
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    const ctx = new AudioContext()
    try {
      if (ctx.state === 'suspended') await ctx.resume()
      if (!ctx.audioWorklet) throw new Error('当前浏览器不支持 AudioWorklet。')
      // 路径必须带上 base：部署到 GitHub Pages 项目页时应用在 /<repo>/ 下，
      // 写死 '/wave-worklet.js' 会 404，麦克风整条链路直接失效。
      // BASE_URL 由 Vite 注入，本地开发时就是 '/'。
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}wave-worklet.js`)
    } catch (e) {
      for (const track of stream.getTracks()) track.stop()
      try {
        await ctx.close()
      } catch {
        /* 已关闭则忽略 */
      }
      throw e
    }

    const line = new DelayLine(Math.ceil(this.historySeconds * ctx.sampleRate))
    const node = new AudioWorkletNode(ctx, 'wave-capture')
    node.port.onmessage = (event: MessageEvent<Float32Array>) => this.feed(event.data)

    ctx.createMediaStreamSource(stream).connect(node)
    // 音频图必须有一条通往 destination 的路径，音频线程才会拉取这个节点。
    // worklet 从不往 outputs 写数据（输出恒为静音），所以这样接不会出声、不会啸叫。
    node.connect(ctx.destination)

    // 录音和分析用的是同一条流，两边互不影响
    this.recorder.start(stream)

    this.stream = stream
    this.ctx = ctx
    this.node = node
    this.line = line
    this.filled = 0
    this.spectrum.reset()

    // 读数速率 = 每秒产出多少列，它就是记录的时间轴刻度
    const rate = ctx.sampleRate / this.hop
    if (!this.log || Math.abs(this.log.rate - rate) > 1e-9) {
      // 采样率变了（换了设备）旧记录的时间轴就不成立了，只能重开一份
      this.log = new EnergyLog(rate, { maxReadings: Math.round(rate * this.logMaxSeconds) })
    }

    // 频带按**全音域**切，不按当前选的乐器 —— 这样换乐器重测时不用重录，
    // 筛选放到检测那一步做。覆盖范围跟着应用自己的 F_MIN/F_MAX。
    this.bands = buildBands(F_MIN, F_MAX, this.fftSize, ctx.sampleRate)
    this.bandScratch = new Float32Array(this.bands.length)
    if (!this.onsetLog || Math.abs(this.onsetLog.rate - rate) > 1e-9) {
      this.onsetLog = new EnergyLog(rate, { maxReadings: Math.round(rate * this.logMaxSeconds) })
    }
    if (!this.peakLog || Math.abs(this.peakLog.rate - rate) > 1e-9) {
      this.peakLog = new PeakLog(rate, { maxColumns: Math.round(rate * this.logMaxSeconds) })
    }
    if (!this.noteLog || this.noteLog.bandCount !== this.bands.length) {
      this.noteLog = new NoteLog(this.bands.length, rate, {
        maxColumns: Math.round(rate * this.logMaxSeconds)
      })
    }
  }

  /** 清空能量记录（不影响正在进行的采集） */
  clearLog(): void {
    this.log?.clear()
    this.noteLog?.clear()
    this.onsetLog?.clear()
    this.peakLog?.clear()
  }

  /**
   * 把一批原始样本按 hop 切块。
   * 关键点：必须「攒满一块 → 写进 DelayLine → 立刻出一列」，
   * 不能先把整批样本都写进去再补算，否则同一批里的几列会取到相同的窗口。
   */
  private feed(batch: Float32Array): void {
    const hop = this.hop
    const line = this.line
    if (!line) return

    let offset = 0
    while (offset < batch.length) {
      const take = Math.min(hop - this.filled, batch.length - offset)
      this.hopBuffer.set(batch.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take

      if (this.filled === hop) {
        line.push(this.hopBuffer)
        this.filled = 0
        this.emitColumn()
      }
    }
  }

  /** 产出一列频谱：取「延迟之后」的一个窗口做 FFT */
  private emitColumn(): void {
    const line = this.line
    if (!line) return

    const delaySamples = Math.round(this.delaySeconds * this.sampleRate)
    // 窗口结尾 = 最新样本往前 delaySamples 个 —— 延迟就发生在这一步
    if (!line.readDelayed(delaySamples, this.window)) return

    const magnitudes = this.analyser.analyse(this.window)
    const energy = columnEnergy(magnitudes)

    // 锯齿窗那一路：只取总能量，给起音检测用
    this.onsetLog?.push(columnEnergy(this.onsetAnalyser.analyse(this.window)))
    // 谱峰走汉宁窗那一路 —— 起音检测用锯齿窗，但认音高要好频率分辨率
    this.peakLog?.push(findPeaks(magnitudes, this.sampleRate, this.fftSize))

    this.spectrum.produce(magnitudes, energy)

    // 记录发生在「产出」这一步，而不是渲染那一步：
    // 每个 hop 恰好一个读数，不会被渲染丢帧/切后台丢掉列影响，
    // 所以「读数下标 -> 时间」这个关系永远成立。
    this.log?.push(energy)

    // 频带能量和总能量在同一列上产出，索引天然对齐（检测要靠这一点对齐两者）
    if (this.noteLog && this.bandScratch.length === this.bands.length) {
      bandEnergies(magnitudes, this.bands, this.bandScratch)
      this.noteLog.pushEnergies(this.bandScratch)
    }
  }

  async stop(): Promise<void> {
    // 必须**先**停录音再停轨道 —— 反过来的话最后那一小段会被截掉
    this.recorder.stop()

    this.node?.port.close()
    this.node?.disconnect()
    this.node = null

    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null

    const ctx = this.ctx
    this.ctx = null
    this.line = null
    this.filled = 0
    this.spectrum.reset()

    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close()
      } catch {
        /* 已关闭则忽略 */
      }
    }
  }
}

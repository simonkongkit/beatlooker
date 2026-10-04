<script lang="ts">
  import { onMount } from 'svelte'
  import { analyseAudioBuffer, decodeAudioFile, type FileAnalysis } from './lib/audioFile'
  import type { EnergyLog } from './lib/energyLog'
  import type { NoteLog } from './lib/noteLog'
  import type { Recording } from './lib/recorder'
  import {
    clearStoredRecording,
    extensionFor,
    loadRecording,
    saveRecording
  } from './lib/recordingStore'
  import {
    DRAFT_VERSION,
    clearDraft,
    loadDraft,
    saveDraft,
    type ScoreDraft
  } from './lib/draft'
  import { MicrophoneSpectrum } from './lib/microphone'
  import {
    DURATIONS,
    allPass,
    barCapacity,
    barTotal,
    beats,
    checkBars,
    makeNote,
    type RhythmNote
  } from './lib/notation/rhythm'
  import { renderRhythm, staffHitTest, tabStringAt } from './lib/notation/render'
import { STANDARD, TUNING_PRESETS, stringFretToMidi, type Tuning } from './lib/notation/tab'
  import { GLYPHS, glyphBounds, toD } from './lib/notation/glyphs'
  import {
    detectOnsetsWithNotes,
    expectedOnsets,
    patternBeats,
    matchTempo,
    mergeChordEvents,
    readEnergies,
    type DetectedOnset,
    type TempoMatch
  } from './lib/onset'
  import {
    findLoopPeriod,
    foldEnvelope,
    pickFoldEvents,
    foldEventTimes,
    type FoldEvent
  } from './lib/loop'
  import {
    INSTRUMENTS,
    NOTE_NAMES,
    findInstrument,
    midiName,
    midiToFreq,
    type Band
  } from './lib/noteBands'
  import { keyPitchClasses } from './lib/harmonic'
  import { fromMusicXml, toMusicXml } from './lib/musicxml'
  import {
    expectedPitchSequence,
    findPerformanceStart,
    type PerformanceStart
  } from './lib/onset'
  import { THEMES, loadThemeId, setTheme, theme } from './lib/theme'
  // ★ 检测结果显示 —— **重新设计的一版** ✓✓
  //   旧的那套把能量/期望/检测挤在两条带里、还叠了贯穿全行的竖线（那个模块已删除） ✗
  //   新的只画**三条平行不重叠的横带** ✓ 见 detectionView.ts 顶部的说明 ✓
  /** 检测图每行画几个小节 */
  const DETECTION_BARS_PER_ROW = 2

  import {
    detectionRowGeom,
    detectionViewHeight,
    renderDetectionView,
    type ViewExpected,
    type ViewOnset
  } from './lib/detectionView'
  import {
    makeLayout,
    rowCount,
    rowRange,
    renderScoreRow,
    type ScoreLayout,
    type ScoreRowStyle,
  } from './lib/score'
  import {
    buildRowMap,
    createEnergyRamp,
    createPalette,
    dbByteToIndex,
    fillRows,
    renderColumn,
    renderEnergyColumn,
    valueAtLevel,
    type ScaleMode,
  } from './lib/spectrumImage'
  // F_MIN / F_MAX 由 DSP 核心统一定义 —— 采集端切音带要用同一个范围
  import { F_MAX, F_MIN } from './lib/fft'

  // ---------- 显示参数 ----------
  const FFT_SIZE = 2048 // 频率分辨率：48000/2048 ≈ 23.4 Hz 一个 bin
  const HOP = 512 // 时间分辨率：48000/512 ≈ 10.7 ms 产出 1 列
  const COL_W = 2 // 1 列占 2 个 CSS 像素
  /** 画布用色统一走主题 —— 换配色时画布和界面不会各变各的 */
  const ink = () => theme().canvas.ink

  const BG = () => theme().canvas.ink.bg

  /** 频谱图面板占画布高度的比例，剩下的给能量图 */
  const SPEC_RATIO = 0.62
  /** 两个面板之间的空隙（像素），其中第一行画成分隔线 */
  const PANEL_GAP = 10
  /** 能量满量程的下限，避免静音时被除到无穷大 */
  const ENERGY_FLOOR = 1e-7
  /** 满量程回落的时间常数（秒） */
  const ENERGY_DECAY_TAU = 3

  const GAP_RGB: [number, number, number] = [10, 10, 18]
  const SEP_RGB: [number, number, number] = [38, 38, 52]
  const CAP_RGB: [number, number, number] = [236, 254, 255]

  const TICKS = [16000, 8000, 4000, 2000, 1000, 500, 250, 100, 50]

  /** 谱面视图：一行多高、左边留多宽写标签 */
  const ROW_H = 48
  const LABEL_W = 74
  /** 谱面最多画多少行。每行约 w x 48 像素，96 行在 900px 宽下是 16MB 画布 */
  const ROW_CAP = 96

  /** 离线分析频谱栅格的纵向行数（和屏幕上的面板高度无关，显示时缩放） */
  const FILE_SPEC_ROWS = 360
  /** 栅格最宽多少列：歌再长也压到这个宽度 */
  const RASTER_MAX_WIDTH = 4096

  const engine = new MicrophoneSpectrum({ delaySeconds: 1, fftSize: FFT_SIZE, hop: HOP })
  /**
   * 配色方案。画布的颜色（频谱调色板、能量渐变、检测图线条）全都从这里取 ——
   * 见 theme.ts：界面走 CSS 变量、画布走 canvas 字段，两边同源，
   * 换主题时不会出现"界面变白了、频谱图还是黑的"这种拼贴。
   */
/**
 * 三个选项卡：录入谱子 / 录音 / 分析。
 *
 * **默认停在"录入谱子"** ✓ —— 用户要求音高录入在最上面、不要等进了分析界面才录 ✓
 *
 * 实现上用 CSS 显隐（.tabpane / .active）而**不是 {#if}** ✓✓
 * 因为 {#if} 会销毁画布元素 ✗ 牵连 $effect、ResizeObserver 和 RAF 循环 ✗
 * 显隐的话画布一直在，切回来时 ResizeObserver 自然触发重画 ✓ 风险低得多 ✓
 */
  let tab = $state<'score' | 'record' | 'analyze'>('score')

  let themeId = $state(loadThemeId())

  // 调色板是 256 项查找表，换主题要重建。用 $derived 跟着 themeId 走，
  // 主题一变这里就重算，画布那边各自的重画由它们自己的 $effect 负责。
  const palette = $derived(
    (() => {
      void themeId
      return createPalette(theme().canvas.spectrum)
    })()
  )
  const energyRamp = $derived(
    (() => {
      void themeId
      return createEnergyRamp(theme().canvas.energyRamp)
    })()
  )

  let canvas = $state<HTMLCanvasElement | undefined>(undefined)
  let running = $state(false)
  let starting = $state(false)
  let errorText = $state('')

  let gainDb = $state(20) // 灵敏度补偿（dB）
  let delay = $state(1) // 整张频谱图整体后退多少秒
  /**
   * 纵轴刻度。默认 db：实测线性刻度下 90% 的时间能量曲线都贴在基线上，
   * 弱音完全看不见；db 能把它抬到半高左右。
   */
  let scaleMode = $state<ScaleMode>('db')

  let fps = $state(0)
  let sampleRate = $state(0)
  let colsPerSecond = $state(0)
  let spanSeconds = $state(0)
  let buffered = $state(0)
  let hasData = $state(false)
  let energyScale = $state(0)

  // 覆盖层（HTML 坐标轴刻度）用的布局，resize 时更新
  let overlaySpecH = $state(0)
  let overlayEnergyTop = $state(0)
  let overlayEnergyH = $state(0)

  // ---- 音源：麦克风 / 本地音频文件 ----
  /** 两种来源互斥：文件模式不采集麦克风，麦克风模式不显示文件 */
  let source = $state<'mic' | 'file'>('mic')
  let fileName = $state('')
  let fileUrl = $state('')
  let fileError = $state('')
  let analyzing = $state(false)
  let analyzeProgress = $state(0)
  let fileEnergyMax = $state(0)
  let fileInfo = $state({ seconds: 0, columns: 0, kb: 0, sampleRate: 0, channels: 0 })
  let fileInput = $state<HTMLInputElement | undefined>(undefined)
  let audioEl = $state<HTMLAudioElement | undefined>(undefined)
  let dragging = $state(false)

  // 大对象放普通变量，不进 $state —— 免得整块栅格被代理拖慢
  /**
   * 文件分析结果。
   *
   * ★ 用 `$state.raw` 而不是普通 `$state` ✗✗
   * 它装着频谱栅格 / 各种日志（几 MB 的 TypedArray ✓）✓
   * 普通 `$state` 会**深度代理**它们 ✓ 每次读都走 Proxy ✓ 又慢又没必要 ✓
   * raw 只在**整体赋值**时触发 ✓ 正好是我们要的语义 ✓✓
   * （不放进 $state 也不行 ✗ —— 那样换文件时读它的界面不会更新 ✓ svelte-check 也会警告 ✓）
   */
  let analysis = $state.raw<FileAnalysis | null>(null)
  let overviewCanvas: HTMLCanvasElement | null = null
  let rasterCanvas: HTMLCanvasElement | null = null
  /** 用来取消上一次还没跑完的分析（用户又选了别的文件） */
  let loadGeneration = 0

  // ---- 能量记录 / 谱面视图 ----
  /**
   * 上次保存的草稿。**在组件初始化时同步读**，不能等 onMount ——
   * 保存用的 $effect 会在 onMount 之前先跑一次，那样就会拿默认值把用户存的谱子盖掉。
   */
  const savedDraft = loadDraft()

  let bpm = $state(savedDraft?.bpm ?? 120)
  let beatsPerBar = $state(savedDraft?.beatsPerBar ?? 4)
  let beatUnit = $state(savedDraft?.beatUnit ?? 4)
  let barsPerRow = $state(savedDraft?.barsPerRow ?? 4)

  // ---- 节奏（只输时值，不含音高）----
  /** 第一次打开时给用户看的示例：「弱起 + 两个满小节」，让功能可发现 */
  function demoBars(): RhythmNote[][] {
    return [
      [makeNote('quarter')],
      [makeNote('quarter'), makeNote('quarter'), makeNote('quarter'), makeNote('quarter')],
      [makeNote('half'), makeNote('quarter'), makeNote('eighth'), makeNote('eighth')]
    ]
  }

  /**
   * 时值按钮上的图标：直接用 glyphs.ts 的几何生成 SVG。
   *
   * 这样按钮上的符号和应用画的谱面是**同一套坐标** ✓ 长得一模一样，
   * 而不是另找一套字体或图标 —— 那种做法迟早会和谱面对不上。
   *
   * 五个时值**共用一个 viewBox**（取它们的并集）：
   * 符干长度在乐谱里本来就该一样长，各画各的会让全音符看起来比八分音符大一圈。
   */
  const durationIcons = (() => {
    const items = DURATIONS.map((d) => {
      const g = GLYPHS[d.glyph]
      return { id: d.id, label: d.label, g, b: glyphBounds(g) }
    })
    const x0 = Math.min(...items.map((i) => i.b.x)) - 0.25
    const y0 = Math.min(...items.map((i) => i.b.y)) - 0.25
    const x1 = Math.max(...items.map((i) => i.b.x + i.b.w)) + 0.25
    const y1 = Math.max(...items.map((i) => i.b.y + i.b.h)) + 0.25
    const viewBox = `${x0} ${y0} ${x1 - x0} ${y1 - y0}`
    return items.map((i) => ({
      id: i.id,
      label: i.label,
      viewBox,
      paths: i.g.shapes.map((s) => ({
        d: toD(s.cmds),
        filled: s.mode === 'fill',
        width: s.width ?? 0
      }))
    }))
  })()

  /**
   * 小节数**不设上限**。
   *
   * 最早写死 3 小节 —— 那是照"前 3 小节"那个需求做的。但用户实际演奏的是
   * 「前四个小节 + 一个附点四分音符」，3 小节根本装不下，输不进去就什么都谈不上。
   * 校验（checkBars）本来就是遍历所有小节的，放开只是把这里的夹取拿掉。
   *
   * 这里只留一个**防损坏**用的上限：本地草稿万一被写坏（比如塞进一百万个小节），
   * 页面会直接卡死。用户自己点「＋小节」不受这个数限制。
   */
  const SANITY_MAX_BARS = 2000

  /** 存的东西可能来自旧版本或被人手改过，小节数不一定合法，统一规范化 */
  function normalizeBars(bars: RhythmNote[][]): RhythmNote[][] {
    const out = bars.slice(0, SANITY_MAX_BARS)
    if (out.length === 0) out.push([])
    return out
  }

  /** 换配色：先写 CSS 变量和记录当前主题，再让画布重画 */
  function pickTheme(id: string) {
    setTheme(id)
    themeId = id
    detectionVersion++
    const rc = rhythmCanvas
    if (rc) drawRhythm(rc)
    const dc = detectionCanvas
    if (dc) drawDetection(dc)
    const sc = scoreCanvas
    if (sc && scoreLayout) drawScore(sc, scoreLayout, scoreRowTotal)
  }

  /**
   * 导出谱面为 MusicXML。
   *
   * 用 MusicXML 而不是自定义格式 ✓ —— MuseScore / Finale / Sibelius / Dorico 都认它 ✓
   * 用户录完谱子必须能拿出去用 ✓ 否则录了等于白录 ✓
   */
  function exportMusicXml() {
    const xml = toMusicXml(rhythmBars, {
      title: 'BeatLooker 谱面',
      fifths: keySignature ?? 0,
      beatsPerBar,
      beatUnit
    })
    const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'beatlooker.musicxml'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 在部分浏览器上会让下载失败，延后一点
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  /** 导入 MusicXML 的状态提示 */
  let importMsg = $state('')
  let importBad = $state(false)
  let importName = $state('')

  /**
   * 读 MusicXML 填回谱面。
   *
   * 只读**第 1 声部** ✓ —— 这个谱面模型是单声部的 ✗
   * MuseScore 导出的和弦、装饰音、第 2 声部都会被跳过，并**如实告诉用户跳了什么** ✓
   * 静默丢东西比报错更糟 ✓
   */
  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // 否则再选同一个文件不会触发 change
    if (!file) return
    importName = file.name
    try {
      const text = await file.text()
      const res = fromMusicXml(text)
      if (!res.ok) {
        importBad = true
        importMsg = '导入失败：' + res.error
        return
      }
      rhythmBars = res.score.bars
      activeBar = 0
      beatsPerBar = res.score.beatsPerBar
      beatUnit = res.score.beatUnit
      keySignature = res.score.fifths
      dotNext = false
      restNext = false
      importBad = false
      const n = res.score.bars.reduce((a, b) => a + b.length, 0)
      importMsg =
        '已导入《' + res.score.title + '》：' + res.score.bars.length + ' 小节 / ' + n + ' 个音符' +
        (res.score.skipped.length ? '　（跳过：' + res.score.skipped.join('、') + '）' : '')
    } catch (err) {
      importBad = true
      importMsg = '读取文件出错：' + (err as Error).message
    }
  }

  function addBar() {
    if (rhythmBars.length >= SANITY_MAX_BARS) return
    rhythmBars = [...rhythmBars, []]
    activeBar = rhythmBars.length - 1
  }

  function removeBar() {
    if (rhythmBars.length <= 1) return
    rhythmBars = rhythmBars.slice(0, -1)
    if (activeBar >= rhythmBars.length) activeBar = rhythmBars.length - 1
  }

  /**
   * 草稿加载前的**体检** ✓
   *
   * 以前是"读到什么就用什么" ✗ 坏数据会直接显示成一张错乱的谱子 ✓
   * 用户只能看到"谱子乱了" ✗ 却不知道是数据坏了还是程序坏了 ✓
   *
   * 这里只做**结构性**检查（不修数据、也不丢数据）：
   *   · 每小节的总时值是否说得通（严重偏离就值得怀疑）
   *   · 有没有小节一个音都没有却夹在中间
   * 发现问题就**留着数据 + 明确告诉用户** ✓ 而不是默默展示一份乱谱 ✓
   */
  function inspectDraft(bars: RhythmNote[][]): string[] {
    const warn: string[] = []
    const cap = barCapacity(beatsPerBar, beatUnit)
    let short = 0
    let long = 0
    let empty = 0
    bars.forEach((b, i) => {
      const t = barTotal(b)
      if (b.length === 0 && bars.length > 1) empty++
      else if (i > 0 && i < bars.length - 1) {
        if (t > cap + 1e-6) long++
        else if (t > 0 && t < cap - 1e-6) short++
      }
    })
    if (long > 0) warn.push(long + ' 个小节超出拍号容量')
    if (short > 0) warn.push(short + ' 个中间小节没填满')
    if (empty > 0) warn.push(empty + ' 个空小节')
    return warn
  }

  const draftWarnings = $state<string[]>(savedDraft ? inspectDraft(normalizeBars(savedDraft.bars)) : [])

  let rhythmBars = $state<RhythmNote[][]>(
    savedDraft ? normalizeBars(savedDraft.bars) : demoBars()
  )
  /** 这次是不是从本地草稿恢复的，界面上提示一下 */
  let restoredNote = $state(!!savedDraft)
  let activeBar = $state(0)
  /** 附点 / 休止是「一次性」修饰键：点一个音符按钮后就自动弹起 */
  let dotNext = $state(false)
  let restNext = $state(false)
  let rhythmCanvas = $state<HTMLCanvasElement | undefined>(undefined)
  let rhythmWidth = $state(0)

  // ---- 演奏检测 ----
  /** 检测结果含 Float32Array，放普通变量不进 $state（和 view / imageData 一个道理），
      靠 detectionVersion 触发重画 */
  let detection: {
    onsets: DetectedOnset[]
    match: TempoMatch | null
    energies: Float32Array
    rate: number
    /** 每个小节多少拍：检测结果按小节分行显示，切行和画小节线都要用它 */
    barTotals: number[]
  } | null = null
  let detectionVersion = $state(0)

  /**
   * 曲子从哪一刻开始弹（**绝对**判断的结果）。
   *
   * 和"又弹了一个新音"是两件事 ✗ 这里只回答"有没有开始演奏" ✓
   * 检测出的所有起点都在它之后 ✓ 之前的底噪波动一律不报 ✓
   */
  let perfStart = $state<PerformanceStart | null>(null)

  /**
   * 用户**手动指定**的起奏点（秒）。null = 用自动检测的那个 ✓
   *
   * ★ 为什么要这个口子 ✗✗
   * 用户实测 5323.webm：自动判据把 **0.416 秒处椅子的咯吱声**当成了演奏开始 ✓
   * 我去量了那一瞬间 ✓ 它是：
   *   **70Hz 基频 + 成整数倍谐波 + 陡然抬起 +13.7dB + 不归零 + 持续**
   *   —— 和"弹了一个低音"在**声学特征上完全一样** ✗
   * 所以这不是判据写错了 ✓ 是**这一类声音本来就分不开** ✓
   * 硬去调判据只会把**真的起奏**也一起漏掉 ✗ 得不偿失 ✓
   * 正确做法是给用户一个"我说了算"的口子 ✓✓
   */
  let perfStartManual = $state<number | null>(null)

  /**
   * 录音页画布上，横向比例 f（0~1）对应录音里的第几秒。
   *
   * 两种模式画布**布局不同** ✗ 必须分开算 ✓ 否则拖的地方和看到的地方对不上 ✓
   *   · 文件模式：整首歌**按比例铺满整个宽度** ✓ t = f × 时长
   *     （和 drawFileFrame 画回放头是同一套映射 ✓）
   *   · 麦克风模式：画布是**滚动的最近一段** ✓ 显示最后 span 秒
   *     t = max(0, 总时长 − span) + f × min(span, 总时长)
   *     ⚠️ 所以录音模式下只能选到**当前可见窗口里**的时刻 ✓
   *        更早的得靠播放把窗口滚过去 ✓ 这是滚动画布的固有限制 ✓
   */
  function stageTimeAt(f: number): number | null {
    if (source === 'file') {
      const a = analysis
      if (!a || !(a.durationSeconds > 0)) return null
      return f * a.durationSeconds
    }
    const total = logRate > 0 ? logCount / logRate : 0
    if (!(total > 0)) return null
    const span = spanSeconds > 0 ? Math.min(spanSeconds, total) : total
    return Math.max(0, total - span) + f * span
  }

  /** 反过来：某一秒在画布上的横向比例 */
  function stageFracOf(t: number): number | null {
    if (source === 'file') {
      const a = analysis
      if (!a || !(a.durationSeconds > 0)) return null
      return Math.max(0, Math.min(1, t / a.durationSeconds))
    }
    const total = logRate > 0 ? logCount / logRate : 0
    if (!(total > 0)) return null
    const span = spanSeconds > 0 ? Math.min(spanSeconds, total) : total
    if (span <= 0) return null
    return Math.max(0, Math.min(1, (t - Math.max(0, total - span)) / span))
  }

  /**
   * 在录音页画布上**拖**那条"开始"竖线。
   *
   * 用户明确要求："**用鼠标选择就可以**" ✓✓
   * 所以入口只有这一种 ✗ 不再有"用当前播放位置"那种按钮 ✓
   */
  function onStartDrag(e: PointerEvent) {
    const c = canvas
    if (!c) return
    const rect = c.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const f = (ev.clientX - rect.left) / Math.max(1, rect.width)
      const t = stageTimeAt(Math.max(0, Math.min(1, f)))
      if (t != null) perfStartManual = Math.max(0, t)
    }
    move(e)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.preventDefault()
  }
  let hasDetection = $state(false)
  let detectMessage = $state('')
  // ---- 录音回放 ----
  let recording = $state<Recording | null>(null)
  // 注意别叫 audioEl —— 那个名字已经被文件模式的播放器占了
  let recAudioEl = $state<HTMLAudioElement | undefined>(undefined)
  let audioPlaying = $state(false)
  /** 录音里的当前位置（秒），用来给界面显示到小数点后两位 */
  let playPos = $state(0)

  /** 正在拖进度条 —— 拖动时 ontimeupdate 不要抢，否则滑块会被拽回去 */
  let seeking = $state(false)

  /* ---------------- 整曲能量图上的"时刻标记" ---------------- */

  /**
   * 鼠标在能量图上点的那个时刻（秒）。null = 没标。
   *
   * 用户要求：能在**整曲总能量**上用鼠标标时刻 ✓ 并显示**能量和时间** ✓
   *
   * 只有**加载文件**时能用 ✗ —— 因为那时整首歌是**按比例铺满整个宽度**的 ✓
   * 映射就是 `t = (x / 画布宽) × 时长` ✓✓ 和 drawFileFrame 画回放头用的是同一套 ✓
   * 麦克风模式画的是**滚动的最近一段** ✗ 没有一个"整曲"的坐标系 ✓ 所以不做 ✓
   */
  let markTime = $state<number | null>(null)

  /** 标记处的能量（dB，相对整曲峰值）*/
  const markInfo = $derived.by(() => {
    // ★ 显式依赖一个 $state ✗ —— `analysis` 是普通变量（它装着大缓冲区 ✓ 故意不进 $state ✓）
    // 而 fileEnergyMax 和它**同时被设置** ✓ 拿它当"换了文件"的信号 ✓
    // 否则换文件后标记不会重算 ✓ 而且 svelte-check 会警告 ✓✓
    void fileEnergyMax
    const a = analysis
    if (markTime === null || !a || !(a.durationSeconds > 0)) return null
    const log = a.log
    const i = Math.round(markTime * log.rate)
    const v = i >= 0 && i < log.length ? log.at(i) : 0
    const max = fileEnergyMax > 0 ? fileEnergyMax : 1
    return {
      time: markTime,
      leftPct: (markTime / a.durationSeconds) * 100,
      db: v > 0 ? 10 * Math.log10(v / max) : -99
    }
  })

  /** 在能源图上点一下 -> 标记那个时刻 */
  function onStageClick(e: MouseEvent) {
    const c = canvas
    const a = analysis
    if (!c || !a || source !== 'file' || !(a.durationSeconds > 0)) return
    const r = c.getBoundingClientRect()
    if (!(r.width > 0)) return
    const f = (e.clientX - r.left) / r.width
    markTime = Math.max(0, Math.min(a.durationSeconds, f * a.durationSeconds))
  }

  /* ---------------- 回放（吸顶的紧凑播放条）---------------- */

  /**
   * 播放条该控制哪个 audio 元素 —— **跟着"这次分析的是谁"走** ✓✓
   *
   * 这里原来写死 recAudioEl ✗ 于是"加载文件 → 录音 → 再加载文件"之后，
   * 分析结果明明是文件的，播放条却还在放录音 ✓ 状态串了 ✓
   */
  function activeAudio(): HTMLAudioElement | undefined {
    return source === 'file' ? audioEl : recAudioEl
  }

  /** 媒体元素自己报的时长 —— 比推算值更可靠（文件还没解析出元数据时推算值是 0）*/
  let mediaDuration = $state(0)

  /** 文件模式下的总时长（audio 元素的 duration 不是响应式的，用事件同步过来）*/
  let fileDuration = $state(0)

  /** 播放条的总时长 */
  const playTotal = $derived(
    source === 'file' ? (fileDuration > 0 ? fileDuration : (audioEl?.duration ?? 0) || 0) : (recording?.seconds ?? 0)
  )

  /** 有东西可播才显示播放条 */
  const hasPlayback = $derived(source === 'file' ? fileUrl !== '' : recording !== null)

  function togglePlay() {
    const a = activeAudio()
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }

  /** 进度条拖动：直接跳到那个位置，并同步回放头 */
  function seekTo(seconds: number) {
    const a = activeAudio()
    const total = playTotal || a?.duration || 0
    if (!a || !(total > 0)) return
    const t = Math.max(0, Math.min(total, seconds))
    a.currentTime = t
    playPos = t
    playhead = playheadAt(t)
    detectionVersion++
  }

  function nudge(seconds: number) {
    seekTo(playPos + seconds)
  }

  /* ---------------- 分析图上方的那条五线谱 ---------------- */

  /**
   * 检测结果上方的五线谱预览。
   *
   * 用户要求"能量图上方显示五线谱" ✓ —— 这样对着检测出来的能量起伏，
   * 一眼就能看出**是谱面上的哪个音** ✓ 不用在选项卡之间来回切 ✓
   */
  let scorePreviewCanvas = $state<HTMLCanvasElement | undefined>(undefined)

  /**
   * 谱面预览的重画。
   *
   * ★ 必须用 $effect，**不能**在设置完 detection 之后直接调 ✗
   *
   * 原因：detection 是普通变量 ✓ 靠 detectionVersion 触发重渲染 ✓
   * 而 Svelte 的 DOM 更新是**批量延后**的 ✓ 直接调的那一刻
   * {#if detection} 还没重新渲染 ✓ 画布还没绑上来 ✓ 画了个寂寞 ✓
   * 用户看到的就是"一进分析界面五线谱是空的，切一下选项卡才出现" ✓✓
   *
   * $effect 跑在 DOM 更新之后 ✓ 而且画布绑定（scorePreviewCanvas 变化）
   * 本身也会触发它 ✓ 所以第一次显示时一定会画上 ✓
   */
  $effect(() => {
    // 依赖：检测结果版本、画布是否绑上、谱面本身，以及**回放位置** ✓
    // playhead 一定要列进来 ✗ 否则播放时谱面上的回放头不会动 ✓
    void detectionVersion
    void scorePreviewCanvas
    void rhythmBars
    void keySignature
    void playhead
    drawScorePreview()
  })

  function drawScorePreview() {
    const c = scorePreviewCanvas
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(Math.max(rhythmWidth, rhythmBars.length * MIN_BAR_PX)))
    const h = SCORE_PREVIEW_H
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    c.style.width = w + 'px'
    c.style.height = h + 'px'
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // ★ 回放头：秒 -> 拍
    // 谱面的横轴是**拍**，回放位置是**秒** ✗ 靠检测拟合出的那个速度换算 ✓
    // 检测图上的回放头用的是同一个速度 ✓ 所以两条线永远对得齐 ✓
    const m = detection?.match ?? null
    const beatAtHead =
      m && playhead != null && m.secondsPerQuarter > 0
        ? (playhead - m.offset) / m.secondsPerQuarter
        : null
    renderRhythm({
      ctx,
      width: w,
      height: h,
      bars: rhythmBars,
      beatsPerBar,
      beatUnit,
      checks: rhythmChecks,
      fifths: keySignature ?? 0,
      mode: 'staff',
      tuning,
      playheadBeat: beatAtHead
    })
  }
  /** 回放头在**分析时间轴**上的位置（秒）。见下面 playheadAt 的换算说明。 */
  let playhead = $state<number | null>(null)
  /** 选中的乐器：只影响检测时的频带筛选，不影响已录到的数据 */
  let instrumentId = $state(savedDraft?.instrumentId ?? 'all')
  let showRef = $state(false)
  /** 检测出来的音名不再展示 ✓ 状态也就不需要了 ✓ */

  const instrument = $derived(findInstrument(instrumentId))
  /** 音高频率参考表：每个八度一行、十二个半音一列 */
  const refRows = $derived.by(() => {
    const lo = instrument.minMidi
    const hi = instrument.maxMidi
    const rows: { octave: number; cells: (number | null)[] }[] = []
    for (let oct = Math.floor(lo / 12); oct <= Math.floor(hi / 12); oct++) {
      const cells: (number | null)[] = []
      for (let pc = 0; pc < 12; pc++) {
        const midi = oct * 12 + pc
        cells.push(midi >= lo && midi <= hi ? midi : null)
      }
      rows.push({ octave: oct - 1, cells })
    }
    return rows
  })
  let detectionCanvas = $state<HTMLCanvasElement | undefined>(undefined)
  let detectionWidth = $state(0)
  /** 给界面看的摘要，避开展示层直接读非响应式对象 */
  /**
 * 循环折叠检测。
 *
 * 一段练习录音里，同一段会反复弹 —— 真起音在每一遍的同一相位上出现，
 * 而泛音拍频的相位由琴弦物理性质决定、和弹奏无关。所以把能量包络按
 * "一遍的时长"折叠、跨遍平均，真事件保留、拍频抵消。
 *
 * 实测某段 26 秒录音：单帧判据检出 90 个起点（实际 27 个），
 * 折叠后干干净净 9 个事件 × 3 个完整遍 = 27 个。
 *
 * 代价：**至少要把同一段弹两遍**，只弹一遍用不了（那时会退回普通检测）。
 */
/**
 * 调号（五线谱上那几个升降）。正数 = 升号个数，负数 = 降号个数，null = 不用先验。
 *
 * **故意只做软先验，不锁死** —— 用户明确说过"有的曲子偶尔也会出现谱号外的音" ✓
 * 调外音级权重 0.35：只要比调内竞争者强约 4.5dB 就能反超 ✓
 * 而纯靠噪声碰巧凑出来的调外候选赢不了 ✓
 *
 * 而且只需"几个升降"这一个数：**大小调共用同一套音级** ✓
 * C 大调和 a 小调都是那 7 个音 ✓ 所以不用问大小调 ✓
 */
let keySignature = $state<number | null>(null)

/** 调号下拉的选项 */
const KEY_OPTIONS = (() => {
  const majorSharp = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
  const minorSharp = ['a', 'e', 'b', 'f#', 'c#', 'g#', 'd#', 'a#']
  const majorFlat = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭']
  const minorFlat = ['a', 'd', 'g', 'c', 'f', 'b♭', 'e♭', 'a♭']
  const out: { sig: number | null; label: string }[] = [{ sig: null, label: '不用调号先验' }]
  out.push({ sig: 0, label: '无升降　　C 大调 / a 小调' })
  for (let i = 1; i <= 7; i++) {
    out.push({ sig: i, label: i + ' 个升号　' + majorSharp[i] + ' 大调 / ' + minorSharp[i] + ' 小调' })
  }
  for (let i = 1; i <= 7; i++) {
    out.push({ sig: -i, label: i + ' 个降号　' + majorFlat[i] + ' 大调 / ' + minorFlat[i] + ' 小调' })
  }
  return out
})()

/** 当前调号的音阶，给用户看一眼确认选对了 */
const keyHint = $derived(
  keySignature === null
    ? '不用先验时所有音级一视同仁'
    : '音阶 ' +
      keyPitchClasses(keySignature)
        .slice()
        .sort((a, b) => a - b)
        .map((pc) => NOTE_NAMES[pc])
        .join(' ') +
      '　调外音也有 0.35 权重（不锁死）'
)

let useFold = $state(false)
/** 一遍的时长（秒）。0 = 自动估 */
let loopPeriod = $state(0)
let foldNote = $state('')
/** 按遍重复搜索的结果：每一遍数各拟合一次，界面可以把它们列出来让人挑 */
/** 用户手动选定的遍数（0 = 让程序自动挑） */
let forcedReps = $state(0)
/** 这次实际用的是几遍 */
let detectedRepsUsed = $state(1)
let detectedReps = $state<
  { rep: number; bpm: number; f1: number; matches: number; expected: number; extras: number }[]
>([])

let detectStats = $state({
    onsets: 0,
    matched: 0,
    expected: 0,
    extras: 0,
    bpm: 0,
    meanMs: 0,
    maxMs: 0,
    f1: 0
  })

  const rhythmChecks = $derived(checkBars(rhythmBars, beatsPerBar, beatUnit))
  const rhythmOk = $derived(allPass(rhythmChecks))
  const rhythmCapacity = $derived(barCapacity(beatsPerBar, beatUnit))

  let scoreCanvas = $state<HTMLCanvasElement | undefined>(undefined)
  let scoreWidth = $state(0)
  let logCount = $state(0)
  let logRate = $state(0)
  let logBytes = $state(0)
  let logFull = $state(false)

  /** 时间换算全在这里：每拍秒数 -> 每小节秒数 -> 每行读数数 */
  const scoreLayout = $derived(
    makeLayout({ bpm, beatsPerBar, beatUnit }, barsPerRow, logRate > 0 ? logRate : 48000 / HOP)
  )
  const scoreRowTotal = $derived(rowCount(scoreLayout, logCount))
  const logSeconds = $derived(logRate > 0 ? logCount / logRate : 0)

  /** 面板上标的满量程：文件模式用整曲最大值，实时模式用自适应值 */
  const shownEnergyMax = $derived(source === 'file' ? fileEnergyMax : energyScale)
  const energyTag = $derived(source === 'file' ? '总能量 · 整曲' : '总能量 · 满量程自适应')

  /** 当前生效的能量记录：文件模式用文件的，实时模式用麦克风录的 */
  function activeLog(): EnergyLog | null {
    return source === 'file' ? (analysis?.log ?? null) : engine.log
  }

  /**
   * 每帧的布局数据，**一律用设备像素**。
   *
   * 为什么不是「CSS 像素 + setTransform」那套常见写法：画布里有三处 putImageData，
   * 而这个 API 忽略变换矩阵、只认设备像素。要么整体 CSS 像素（那就不能有变换），
   * 要么整体设备像素 —— 只改一半必然错位。这里选后者，顺手拿到真·高分屏清晰度。
   */
  const view = {
    w: 1,
    h: 1,
    dpr: 1,
    cssW: 1,
    cssH: 1,
    colW: COL_W,
    sepRows: 1,
    specRows: 1,
    energyTop: 2,
  }
  let rowMap = buildRowMap(1, 48000, FFT_SIZE, F_MIN, F_MAX)
  let imageData: ImageData | null = null
  let frames = 0
  let fpsStart = 0
  let lastT = 0
  /** 能量自适应满量程：瞬时上抬、缓慢回落。能量没有上界，所以纵轴也得跟着动。 */
  let energyMax = ENERGY_FLOOR

  function fmt(v: number): string {
    if (!(v > 0)) return '0'
    if (v >= 100) return v.toFixed(0)
    if (v >= 1) return v.toFixed(1)
    if (v >= 0.01) return v.toFixed(3)
    return v.toExponential(1)
  }

  function tickLabel(f: number): string {
    return f >= 1000 ? `${f / 1000}k` : `${f}`
  }

  /** 频率 → 频谱图面板内的像素位置（对数轴，高频在上） */
  function tickTop(f: number): string {
    const t = Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)
    return `${((1 - t) * overlaySpecH).toFixed(1)}px`
  }

  function clearRaster() {
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return
    ctx.fillStyle = BG()
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  /** 画布尺寸或采样率变了，行→频率的映射必须重建 */
  function rebuildTargets() {
    const c = canvas
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    // 一列的像素覆盖整个画布高度：上半是频谱图，下半是能量图
    imageData = ctx.createImageData(view.colW, Math.max(1, view.h))
    rowMap = buildRowMap(view.specRows, engine.sampleRate || 48000, FFT_SIZE, F_MIN, F_MAX)
  }

  function resize() {
    const c = canvas
    if (!c) return
    const rect = c.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(rect.width))
    const cssH = Math.max(1, Math.round(rect.height))
    // 画布按设备像素渲染。dpr 封顶 2：手机 dpr 普遍是 3，再往上像素量翻倍而肉眼收益很小。
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(cssW * dpr)
    const h = Math.round(cssH * dpr)
    // dpr 也要参与比较：窗口在等宽的两块不同 DPI 显示器之间移动时，CSS 尺寸可能不变
    if (c.width === w && c.height === h && view.dpr === dpr) return

    c.width = w
    c.height = h
    view.w = w
    view.h = h
    view.dpr = dpr
    view.cssW = cssW
    view.cssH = cssH
    view.colW = Math.max(1, Math.round(COL_W * dpr))
    view.sepRows = Math.max(1, Math.round(dpr))

    // 纵向切分：上面频谱图，下面能量图（都在设备像素里算）
    const specRows = Math.max(8, Math.min(h - 40, Math.round(h * SPEC_RATIO)))
    view.specRows = specRows
    view.energyTop = Math.min(h - 4, specRows + Math.round(PANEL_GAP * dpr))

    // 覆盖层是 HTML，要用 CSS 像素定位，所以换算回去
    overlaySpecH = Math.round(specRows / dpr)
    overlayEnergyTop = Math.round(view.energyTop / dpr)
    overlayEnergyH = Math.round((h - view.energyTop) / dpr)

    // 尺寸变了 ⇒ 频率映射变了，旧像素不再对应正确的频率，直接清掉重画
    clearRaster()
    rebuildTargets()
    rebuildOverview()
  }

  function render(t: number) {
    const c = canvas
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return

    // 状态每 500ms 刷新一次，不要每帧写响应式状态
    frames++
    if (fpsStart === 0) fpsStart = t
    if (t - fpsStart >= 500) {
      fps = Math.round((frames * 1000) / (t - fpsStart))
      frames = 0
      fpsStart = t
      // 文件模式下这些实时指标没有意义，别用麦克风的值去覆盖文件的信息
      if (source === 'mic') {
        sampleRate = engine.sampleRate
        colsPerSecond = engine.columnsPerSecond
        spanSeconds = colsPerSecond ? view.w / view.colW / colsPerSecond : 0
        buffered = engine.bufferedSeconds
        hasData = engine.spectrum.produced > 0
        energyScale = energyMax
        logCount = engine.log?.length ?? 0
        logRate = engine.log?.rate ?? 0
        logBytes = engine.log?.bytes ?? 0
        logFull = engine.log?.full ?? false
      }
    }

    if (source === 'file') {
      drawFileFrame(ctx)
      return
    }

    if (!engine.isRunning || !imageData) return

    engine.delaySeconds = delay

    // 满量程缓慢回落：峰值过去后纵轴自己收回来。
    // 用时间常数而不是每帧固定系数，掉帧时行为也一致。
    const dt = lastT ? Math.min(0.25, (t - lastT) / 1000) : 1 / 60
    lastT = t
    energyMax = Math.max(ENERGY_FLOOR, energyMax * Math.exp(-dt / ENERGY_DECAY_TAU))

    const spec = engine.spectrum
    const colW = view.colW // 一列的宽度（设备像素）
    const maxCols = Math.ceil(view.w / colW) // 一屏能容纳多少列
    let newCols = spec.pending

    if (newCols > maxCols) {
      // 渲染落后太多（切后台、长时间卡顿）：丢掉旧列只画最新的，
      // 否则会一次性补画几千列把页面卡死
      spec.skip(newCols - maxCols)
      newCols = maxCols
      ctx.fillStyle = BG()
      ctx.fillRect(0, 0, view.w, view.h)
    } else if (newCols > 0) {
      // 整体左移 newCols 格；右侧空出来的这段马上被新列填满。
      // 画布上没有变换矩阵，所以这里的偏移量同样是设备像素。
      ctx.drawImage(c, -newCols * colW, 0)
    }

    const data = imageData.data
    for (let i = 0; i < newCols; i++) {
      const col = spec.consume()
      if (!col) break

      // 能量是引擎在产出这一列时算好、随列一起存下的，
      // 所以画面上画的和记录里录的是同一个值
      const energy = spec.consumedEnergy
      // 瞬时上抬：只要出现更大的能量就立刻抬高满量程，绝不裁掉
      if (energy > energyMax) energyMax = energy

      // 同一列数据、同一个 x，纵向切成两个面板 ——
      // 频谱图和能量图的横轴就是这样天然对齐的，不需要额外同步逻辑
      renderColumn(col, rowMap, palette, gainDb, data, colW)
      fillRows(data, colW, view.specRows, view.energyTop, GAP_RGB)
      fillRows(data, colW, view.specRows, view.specRows + view.sepRows, SEP_RGB)
      renderEnergyColumn(
        energy,
        energyMax,
        scaleMode,
        data,
        colW,
        view.energyTop,
        view.h,
        energyRamp,
        CAP_RGB
      )

      // putImageData 只认设备像素（忽略变换矩阵），正好和数据一致
      ctx.putImageData(imageData, view.w - (newCols - i) * colW, 0)
    }
  }

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60)
    return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
  }

  /**
   * 把记录按小节排成一行行画出来。
   *
   * 横轴是行内时间（一小节一条亮线、一拍一条暗线），纵轴是能量。
   * 所有行共用同一个满量程，所以行与行之间的高低可以直接对比。
   */
  function drawScore(c: HTMLCanvasElement, layout: ScoreLayout, rows: number) {
    // 谱面也按设备像素渲染。这里本来只画能量面积和小节线，用 CSS 像素也行，
    // 但「小节 1-4」这些标签是 ctx.fillText 画的 —— 不放大 backing store 的话，
    // 10px 文字在高分屏上会被整幅放大，锯齿非常明显。
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(c.getBoundingClientRect().width))
    const h = Math.max(1, rows * ROW_H)
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    // 没有 CSS height 时，画布的显示高度等于 height 属性值，所以必须显式设回来
    if (c.width !== bw || c.height !== bh) {
      c.width = bw
      c.height = bh
    }
    c.style.height = h + 'px'

    const ctx = c.getContext('2d')
    if (!ctx) return

    // 文字走变换矩阵，用 CSS 像素坐标；而 putImageData 忽略变换矩阵，
    // 所以能量行的缓冲按设备像素生成、坐标也按设备像素给。两者井水不犯河水。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = BG()
    ctx.fillRect(0, 0, w, h)

    const log = activeLog()
    if (!log || rows === 0) return

    const rowPx = Math.round(ROW_H * dpr)
    const style: ScoreRowStyle = {
      width: bw,
      height: rowPx,
      contentLeft: Math.round(LABEL_W * dpr),
      barsPerRow: layout.barsPerRow,
      beatsPerBar: layout.beatsPerBar,
      beatsPerRow: layout.beatsPerRow,
      readingsPerRow: layout.readingsPerRow,
      scale: Math.max(ENERGY_FLOOR, log.max),
      mode: scaleMode,
    }

    const rowImage = ctx.createImageData(bw, rowPx)
    const read = (i: number) => log.at(i)

    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.textBaseline = 'top'

    for (let row = 0; row < rows; row++) {
      const [from] = rowRange(layout, row)
      renderScoreRow(read, from, log.length, style, energyRamp, rowImage.data)
      // 设备像素坐标；上面设的变换矩阵对这个调用无效
      ctx.putImageData(rowImage, 0, row * rowPx)

      const firstBar = row * layout.barsPerRow + 1
      const lastBar = firstBar + layout.barsPerRow - 1
      ctx.fillStyle = ink().text
      ctx.fillText(`小节 ${firstBar}-${lastBar}`, 6, row * ROW_H + 10)
      ctx.fillStyle = ink().dim
      ctx.fillText(formatTime(log.timeAt(from)), 6, row * ROW_H + 24)
    }
  }

  /** 节奏画布固定高度；宽度跟随容器 */
  const RHYTHM_H = 320
  /** 分析图上方那条五线谱预览的高度 */
  const SCORE_PREVIEW_H = 210

  /** 一个小节至少要多宽，否则小节一多就挤成一团看不清 */
  const MIN_BAR_PX = 168

  function drawRhythm(c: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // 小节多了就把画布**撑宽**、让外层横向滚动，而不是把小节挤扁。
    // rhythmWidth 是外层容器的宽度（由 ResizeObserver 量），不是画布自己的 ——
    // 否则撑宽画布会触发观察器、观察器又去改宽度，转圈。
    const w = Math.max(1, Math.round(Math.max(rhythmWidth, rhythmBars.length * MIN_BAR_PX)))
    const h = RHYTHM_H
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    if (c.width !== bw || c.height !== bh) {
      c.width = bw
      c.height = bh
    }
    c.style.height = h + 'px'
    c.style.width = w + 'px'

    const ctx = c.getContext('2d')
    if (!ctx) return
    // 和主画布同一套约定：backing store 按 dpr 放大、绘制用 CSS 像素坐标
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    renderRhythm({
      ctx,
      width: w,
      height: h,
      bars: rhythmBars,
      beatsPerBar,
      beatUnit,
      checks: rhythmChecks,
      // 调号画在谱面上 —— 用户选了几个升/降号，谱面就该长什么样
      fifths: keySignature ?? 0,
      mode: notationMode,
      tuning,
      // ★ 预览画在"这个音将要落下的位置"，而不是最后一个小节的右端 ✓✓
      // 目标小节用 activeBar —— 和 commitFret 写进去的那个小节是同一个 ✓
      // 时值用当前选中的 ✓ 这样横坐标和 layoutStaff 的"格子中心"算法对得上 ✓
      // 选区和光标 —— 让用户看得见"选中了什么、现在在哪儿" ✓
      selection: selRefs,
      cursor: selFocus,
      pendingPreview: tabPick
        ? {
            bar: activeBar,
            value: entryValue(),
            notes: pendingChord,
            typing: fretBuf
              ? { string: tabPick.string, text: fretBuf }
              : null
          }
        : null
    })
  }

  /** 把要存的东西收成一个对象。$effect 里同步调用它，读到的状态就会被自动追踪。 */
  function currentDraft(): ScoreDraft {
    return {
      version: DRAFT_VERSION,
      bpm,
      beatsPerBar,
      beatUnit,
      barsPerRow,
      instrumentId,
      // 调弦（含变调夹）也要存 —— 不然重开浏览器就回到"标准调弦 / 夹 0 品" ✗
      tuning: { ...tuning, open: [...tuning.open] },
      // 不在这里打包 —— saveDraft 内部负责，调用方只经手可直接使用的 RhythmNote
      bars: rhythmBars
    }
  }

  /**
   * 谱子/拍号一改就存，防抖 300ms（连点音符按钮时不必每次都写盘）。
   *
   * 注意这里**故意不返回清理函数**：返回了的话组件销毁时会把这个还没到点的定时器
   * 清掉，最后那一下改动就丢了。让它在销毁后照常落盘更安全。
   */
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const draft = currentDraft()
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => saveDraft(draft), 300)
  })

  /**
   * 录音里的第 p 秒，对应检测图时间轴上的哪一秒 —— **就是 p，不加任何偏移**。
   *
   * ⚠️ 这里原来加过一个 `delay`，理由是"分析链路整体延迟"。**那是错的**，
   * 用户实测就报"录音播放和检测的能量对不上"。原因：
   *   · `delay` 只作用于**麦克风频谱图的视觉滚动**（engine.delaySeconds），
   *     让波形看起来是从右边慢慢推出来的
   *   · 而能量日志是按**到达时间**索引的，第 i 列就是第 i*hop/rate 秒采到的，
   *     没有延迟
   *   · 检测图又是直接按 log 下标画的
   * 所以检测图的横轴**就是真实时间**，回放头停在录音的第 p 秒即可。
   * 加那一秒，听到的和看到的会永远差一秒。
   */
  function playheadAt(audioSeconds: number): number {
    return audioSeconds
  }

  /**
   * 点检测图定位：把录音跳到点在的那个时刻，并**暂停**在那儿。
   * 默认暂停是有意的 —— 点一下就播起来会让人来不及看清。
   */
  /**
   * 点检测图 -> 时刻。
   *
   * 换算必须和**画图**用同一套算式 ✓ 否则点的地方和看到的对不上 ✗
   * 所以两边都从 detectionRowGeom 取 ✓ 只有一处真值 ✓
   */
  function detectionHitTest(x: number, y: number): number | null {
    const c = detectionCanvas
    const d = detection
    if (!c || !d || !d.match) return null
    const rows = detectionRowGeom({
      width: Math.max(1, Math.round(c.getBoundingClientRect().width)),
      height: detectionViewHeight(d.barTotals.length, DETECTION_BARS_PER_ROW),
      energies: d.energies,
      rate: d.rate,
      onsets: d.onsets.map((o) => ({ time: o.time, weak: o.weak })),
      barEdges: (() => {
        const e2: number[] = []
        let q = 0
        for (const tot of d.barTotals) {
          e2.push(d.match!.offset + q * d.match!.secondsPerQuarter)
          q += tot
        }
        e2.push(d.match!.offset + q * d.match!.secondsPerQuarter)
        return e2
      })(),
      barsPerRow: DETECTION_BARS_PER_ROW,
      maxTime:
        source === 'file'
          ? (analysis && analysis.durationSeconds > 0 ? analysis.durationSeconds : null)
          : (recording && recording.seconds > 0 ? recording.seconds : null)
    })
    const row = rows.find((r2) => y >= r2.y0 && y <= r2.y1)
    return row ? row.timeAtX(x) : null
  }

  function onDetectionClick(e: MouseEvent) {
    const c = detectionCanvas
    if (!c) return
    const r = c.getBoundingClientRect()
    // 画布按 CSS 像素绘制（dpr 由 setTransform 处理），所以事件坐标减掉边界即可
    const t = detectionHitTest(e.clientX - r.left, e.clientY - r.top)
    if (t === null) return

    if (!recAudioEl || !recording) return
    const clamped = Math.max(0, Math.min(recording.seconds, t))
    recAudioEl.pause()
    recAudioEl.currentTime = clamped
    playPos = clamped
    playhead = clamped
    detectionVersion++
  }

  /** 空格播放 / 暂停（在输入框里按空格是打字，不抢） */
  function onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null
    // 在输入框里打字时一律不抢
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return

    const k = e.key

    // ★ 选中六线谱某根弦之后，空格归**和弦输入**，不再是播放/暂停 ✓✓
    //
    // 这里原来把"空格 = 播放/暂停"放在最前面 ✗ 而且用的是 e.code === 'Space' ✓
    // 结果真按空格时先被播放/暂停截走、直接 return ✓ 和弦那条分支**永远到不了** ✓
    //
    // ⚠️ 我的注入测试没抓到这个 ✗ —— 因为模拟事件时只写了 { key: ' ' }、
    //    没写 code ✓ 而真实浏览器两个字段都会设 ✓ 于是测试给了假绿 ✓✓
    //    （教训：模拟键盘事件要**带全字段**，只给 key 是不够的）
    // ★ 有选区时，退格/删除的**第一优先**是删掉选中的音符 ✓✓
    // 必须在下面那个 tabPick 分支之前 ✗ 否则拖选之后按退格会去退"待输入的和弦" ✓
    if ((k === 'Backspace' || k === 'Delete') && selRefs.length) {
      deleteSelection()
      e.preventDefault()
      return
    }

    if (tabPick) {
      if (k === ' ' || k === 'Spacebar' || e.code === 'Space') {
        // 空格 = 把当前这个「弦 + 品」放进待输入和弦，并**立刻显示出来**
        if (fretBuf !== '') {
          const fret = Math.max(0, Math.min(24, Number(fretBuf) || 0))
          const next = [...pendingChord]
          const i = next.findIndex((p) => p.string === tabPick!.string)
          if (i >= 0) next[i] = { string: tabPick!.string, fret }
          else next.push({ string: tabPick!.string, fret })
          next.sort((a, b) => a.string - b.string)
          pendingChord = next
          fretBuf = ''
          // 自动挪到下一根弦：6 → 5 → 4 → 3 → 2 → 1（从低音弦往高音弦）
          if (tabPick!.string > 1) tabPick = { bar: tabPick!.bar, string: tabPick!.string - 1 }
        }
        e.preventDefault()
        return
      }
    }

    // 没在输入和弦时，空格才是播放 / 暂停
    if (e.code === 'Space') {
      if (!recAudioEl) return
      e.preventDefault()
      if (recAudioEl.paused) void recAudioEl.play()
      else recAudioEl.pause()
      return
    }

    // ---- 六线谱：选中某根弦后，数字就是**品位** ----
    // 这时 1~5 不再当时值、0 不再当休止 —— 时值改用鼠标点上面的按钮 ✓
    // 这正是「点弦线 -> 打品位 -> 回车」的输入流程
    if (tabPick) {
      if (/^[0-9]$/.test(k)) {
        const next = (fretBuf + k).slice(0, 2)
        // 两位数只有 <= 24 才收（吉他最高 24 品）
        fretBuf = next.length === 2 && Number(next) > 24 ? k : next
        e.preventDefault()
        return
      }
      if (k === 'Enter') {
        commitFret()
        e.preventDefault()
        return
      }
      if (k === 'Escape') {
        tabPick = null
        fretBuf = ''
        pendingChord = []
        e.preventDefault()
        return
      }
      if (k === 'Backspace') {
        // ★ 退格的顺序：**先把"还没落谱的东西"退干净，再动已经落谱的音符** ✗✗
        //
        // 这里原来只有两步（退品位数 -> 取消选中）✓ 于是第二次按退格时
        // tabPick 已经是 null ✓ 就**掉到下面的通用处理**里 ✓ → undoNote() ✓
        // → 把已经落谱的**上一个和弦删掉** ✗✓ 用户报的就是这个 ✓
        //
        // 正确顺序：品位数 -> 待输入和弦的最后一个音 -> 取消选中 ✓
        if (fretBuf) {
          fretBuf = fretBuf.slice(0, -1)
        } else if (pendingChord.length) {
          // 退掉待输入和弦的最后一项，并把选中挪回那根弦，方便接着改
          const last = pendingChord[pendingChord.length - 1]
          pendingChord = pendingChord.slice(0, -1)
          tabPick = { bar: tabPick.bar, string: last.string }
        } else {
          // 待输入的全退完了，才取消选中。**不碰已经落谱的音符** ✓
          tabPick = null
        }
        e.preventDefault()
        return
      }
    }

    // 时值：1~5
    const durIdx = '12345'.indexOf(k)
    if (durIdx >= 0) {
      setDuration(DUR_KEYS[durIdx])
      e.preventDefault()
      return
    }

    // 八度：Z 降 / X 升
    if (k === 'z' || k === 'Z') {
      entryOctave = Math.max(0, entryOctave - 1)
      e.preventDefault()
      return
    }
    if (k === 'x' || k === 'X') {
      entryOctave = Math.min(8, entryOctave + 1)
      e.preventDefault()
      return
    }

    // 升降号：- 降号，= 或 + 升号。按同一个键两次回到还原
    if (k === '-' || k === '_') {
      accidental = accidental === -1 ? 0 : -1
      e.preventDefault()
      return
    }
    if (k === '=' || k === '+') {
      accidental = accidental === 1 ? 0 : 1
      e.preventDefault()
      return
    }

    // 附点 / 休止
    if (k === '.') {
      dotNext = !dotNext
      e.preventDefault()
      return
    }
    // 休止：**直接插入**一个休止符（MuseScore 里 0 也是这个作用）。
    // 原来这里只是切换 restNext，而下面的字母分支又有 !restNext 的拦截 ——
    // 结果键盘既进不了休止、开着休止模式时字母还被吞掉，只能靠鼠标点 ✗
    if (k === 'r' || k === 'R' || k === '0') {
      restNext = true
      addNote(entryDuration)
      e.preventDefault()
      return
    }

    // 音名：A~G 输入音高（字母一定意味着"要一个音"，顺便清掉休止模式）
    const pc = LETTER_PC[k.toLowerCase()]
    if (pc !== undefined) {
      restNext = false
      // MIDI：C4 = 60，所以 octave*12 + pc + 12
      addNote(entryDuration, entryOctave * 12 + pc + 12 + accidental)
      e.preventDefault()
      return
    }

    // 退格：撤销
    if (k === 'Backspace') {
      undoNote()
      e.preventDefault()
      return
    }

    // ↑↓：把刚输入的那个音升降半音
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const dir = k === 'ArrowUp' ? 1 : -1
      const bar = rhythmBars[activeBar] ?? []
      if (!bar.length) return
      const last = bar[bar.length - 1]
      if (last.rest || last.midi == null) return
      const next = Math.max(0, Math.min(127, last.midi + dir))
      rhythmBars = rhythmBars.map((b, i) =>
        i === activeBar ? [...b.slice(0, -1), { ...last, midi: next }] : b
      )
      e.preventDefault()
    }
  }

  /** 实测速度和「上面标的」速度对不上（差超过 1 BPM 才算，避免 95.4 vs 95 这种无意义的抖动） */
  const tempoMismatch = $derived(
    detectStats.matched > 0 && Math.abs(detectStats.bpm - bpm) > 1
  )

  /**
   * 把**实测速度**套到「能量记录」的速度上。
   *
   * 为什么需要这一步：检测本身不依赖上面那个 BPM（它是在 40~240 里全局搜出来、
   * 从演奏本身拟合的），但**谱面分小节用的是上面那个 BPM**。两者不一致时，
   * 谱面上的小节线就全错位 —— 你弹 96、上面写 120，小节线当然对不上。
   * 所以测完之后要把实测值**同步过去**，谱面才会按你实际弹的速度分小节。
   */
  function applyMeasuredTempo() {
    if (!(detectStats.bpm > 0)) return
    bpm = Math.round(detectStats.bpm)
    detectMessage = `已把速度设为 ${bpm} BPM —— 谱面现在按你实际弹的速度分小节。`
  }

  /**
   * 把上一次的检测结果整个清掉。
   *
   * ★ 换音频源（重新录音 / 换文件 / 移除文件）时必须调它 ✗✗
   *
   * 用户实测报的：先分析了一个 27 秒的文件 ✓ 然后在录制窗口重新录了 6.84 秒 ✓
   * 结果**上方播放器显示 6.84 秒 ✓ 下方分析图还挂在 27 秒的旧数据上** ✗✗
   * 根因就是这里 —— 换录音时只换了 `recording` ✓ 没清 `detection` ✓
   * 于是"图是旧的、播放器是新的" ✓ 两边说的不是同一段音频 ✓
   */
  function resetDetection() {
    markTime = null
    detection = null
    hasDetection = false
    perfStart = null
    detectStats = { onsets: 0, matched: 0, expected: 0, extras: 0, bpm: 0, meanMs: 0, maxMs: 0, f1: 0 }
    detectedReps = []
    detectedRepsUsed = 1
    foldNote = ''
    detectMessage = ''
    playhead = null
    playPos = 0
    audioPlaying = false
    detectionVersion++
  }

  function clearRecording() {
    engine.recorder.clear()
    recording = null
    audioPlaying = false
    playhead = null
    playPos = 0
    // 录音没了，基于它的检测结果也必须一起没 ✗
    resetDetection()
    void clearStoredRecording()
  }

  /** 当前生效的频带日志：实时模式用引擎的，文件模式用分析结果的 */
  function activeNoteLog(): { log: NoteLog; bands: Band[] } | null {
    if (source === 'file') {
      const a = analysis
      return a ? { log: a.noteLog, bands: a.bands } : null
    }
    return engine.noteLog ? { log: engine.noteLog, bands: engine.bands } : null
  }

  /** 对当前生效的能量记录跑一遍：检测起点 -> 和用户输入的节奏对齐 -> 算速度 */
  function runDetection() {
    const log = activeLog()
    const expected = expectedOnsets(rhythmBars)

    if (!log || log.length < 8) {
      detection = null
      hasDetection = false
      detectionVersion++
      detectMessage = '还没有能量记录。先点「开始」录一段，或者加载一个音频文件。'
      return
    }
    if (expected.length === 0) {
      detection = null
      hasDetection = false
      detectMessage = '上面还没有输入节奏。先在「前 3 小节节奏」里把音符点上。'
      return
    }

    const allEnergies = readEnergies(log)

    // ---- 取频带数据：按选中的乐器筛一遍，再各取一条时间序列出来 ----
    const nl = activeNoteLog()
    let dbByBand: Float32Array[] | null = null
    let picked: Band[] = []
    if (nl && nl.log.columns > 0) {
      const ins = instrument
      const idx: number[] = []
      nl.bands.forEach((b, i) => {
        // 音域有交集的带才留下
        if (b.maxMidi >= ins.minMidi && b.minMidi <= ins.maxMidi) idx.push(i)
      })
      picked = idx.map((i) => nl.bands[i])
      dbByBand = idx.map((i) => nl.log.bandSeries(i))
    }

    // 频带日志有列数上限（长文件的尾部可能没记）。检测只用频带，所以按频带的长度截；
    // 画图那边用完整的能量序列（它自己有 timeAt 映射，不依赖下标对齐）。
    let bandLimited = false
    if (dbByBand && dbByBand.length && allEnergies.length !== dbByBand[0].length) {
      const usable = Math.min(allEnergies.length, dbByBand[0].length)
      dbByBand = dbByBand.map((s) => s.subarray(0, usable))
      bandLimited = true
    }
    const energies = allEnergies

    // 触发用锯齿窗那一路（onsetLog），认音名仍然用汉宁窗的频带（noteLog）
    const trigger = source === 'file' ? analysis?.onsetLog : engine.onsetLog
    const triggerEnergies = trigger && trigger.length > 0 ? readEnergies(trigger) : null
    // 起奏是**绝对**判断，单独算一次 ✓ 给界面显示，也用来解释"为什么前面那些不算"
    perfStart = triggerEnergies ? findPerformanceStart(triggerEnergies, log.rate) : null

    // 谱峰日志：谐波求和认音名要用（频带的分辨率不够，见 peakLog.ts）
    const peakLog = source === 'file' ? analysis?.peakLog : engine.peakLog
    let onsets = detectOnsetsWithNotes(dbByBand, picked, log.rate, {
      triggerEnergies,
      peakLog: peakLog && peakLog.columns > 0 ? peakLog : null,
      keySignature,
      // ★ 手动指定的起奏点：**门控也用它** ✓✓
      //   原来只换了相位锚点 ✗ 门控那边会自己重算一遍 ✗
      //   于是"起奏之前一律不算起点"仍按自动那个执行 ✓ 用户看到的就是"设了没跟上" ✓
      ...(perfStartManual != null ? { startTime: perfStartManual } : {})
    })
    foldNote = ''

    if (useFold) {
      // 没给周期就先按普通检测估一个：从起点时刻里搜最能解释它们的周期
      let period = loopPeriod
      if (!(period > 0)) {
        const info = findLoopPeriod(onsets.map((o) => o.time))
        if (info && info.laps >= 2) {
          period = info.period
          loopPeriod = Math.round(period * 100) / 100
        }
      }
      const fold = period > 0 && triggerEnergies ? foldEnvelope(triggerEnergies, log.rate, period) : null
      if (fold) {
        const events = pickFoldEvents(fold, { expectedCount: expected.length })
        const times = foldEventTimes(fold, events)
        onsets = detectOnsetsWithNotes(dbByBand, picked, log.rate, {
          triggerEnergies,
          peakLog: peakLog && peakLog.columns > 0 ? peakLog : null,
          keySignature,
          presetTimes: times
        })
        const db = events.map((e: FoldEvent) => e.riseDb.toFixed(1)).join('/')
        foldNote = `循环折叠：一遍 ${fold.period.toFixed(2)}s，完整 ${fold.laps} 遍，找到 ${events.length} 个事件（上升 ${db} dB），展开成 ${times.length} 个起音。`
      } else {
        foldNote = `循环折叠用不了（一遍 ${period > 0 ? period.toFixed(2) + 's' : '没测出来'}，需要至少 2 个完整遍），已退回普通检测。`
      }
    }
    // 把起点强度一起传进去：起点密集时 F1 分不出真假对齐，
    // 靠"匹配上的起点强度之和"才能选对（见 onset.ts 里的说明）
    // 期望模式**按遍重复**：练习录音里同一段会反复弹。
    //
    // 只拿一遍的期望音去对整段，拟合只能去找一个很慢的速度好把 9 个期望音摊满全程 ——
    // 用户实测就报过这个："我按一百多的速度演奏，你说我是 47"，而 47 差不多正好是一半。
    // 而且第 2 遍之后的真音会全部落在期望音之外，被标成"多打"（粉色）。
    //
    // 所以把"弹了几遍"也当成未知量一起搜，按 F1 挑最好的那组。
    const periodQ = patternBeats(rhythmBars)

    // ★★ 统计口径用**合并后**的事件 ★★（用户："统计环节可以使用合并" ✓）
    //
    // 一个和弦的几根弦落在 70~130 毫秒之内 ✓ 于是会报出**两个起点** ✓
    // 如果谱子上那儿只有**一个**音 ✓ 第二个就会被算成"多打" ✗ 统计被冤枉 ✓
    // 所以算对齐 / 对上 / 多打 / F1 时，先把和弦的多个起点并成一个事件 ✓✓
    //
    // ⚠️ 但 `onsets`（也就是 detection.onsets）**一个都不动** ✗✗
    //   用户明确要求"不要把这种多打从原始的数据里抹除" ✓
    //   所以图上画的还是**原始的点** ✓（弱的画虚线 ✓ 和弦的两根弦都画出来 ✓）
    //   只有这一路的统计用它 ✓
    //
    // 合并的判据不是时间差 ✗ 是**音高集合**：
    //   16 分音符在 160 BPM 下就是 0.094 秒 ✓ 只看时间会把真的十六分音符并掉 ✗
    //   实测和弦的特征是"后一个带出 63%~98% 的全新音高" ✓ 拿它判 ✓
    // 统计口径分两步（**原始 onsets 一个不动** ✗）：
    //   ① 去掉 weak（低置信）—— 带数不够 ✓ 或者"和占比 + 总能量方向"不成立 ✗
    //      合成信号（有真值 48 个音）上这条把精确率从 0.51 拉到 **1.00** ✓ 召回保持 1.00 ✓✓
    //   ② 再把和弦的多个起点并成一个事件 ✓（用户："统计环节可以使用合并" ✓）
    //
    // ⚠️ 我一度把它去掉过 ✗ 理由是"用户看到 3 绿 4 红、7 个问号" ✓
    //   以为那 7 个低置信起点被排除在匹配之外才导致红竖线 ✓
    //   但**实测不支持** ✗：天狼星上用 7 个音的谱面复现 ✓
    //     旧（只用高置信 7 个起点）-> 绿 6 红 1 ✓（不是 3 绿 4 红 ✗）
    //     新（用全部 12 个起点）  -> rep 反而被选成 2 ✗ 更差 ✓
    //   所以撤回来了 ✓ —— 假设不成立就不该改 ✓
    const statEvents = mergeChordEvents(
      onsets.filter((o) => !o.weak),
      dbByBand,
      picked,
      log.rate
    )
    const onsetTimes = statEvents.map((o) => o.time)
    const strengths = statEvents.map((o) => o.strengthDb)
    const span = onsetTimes.length ? onsetTimes[onsetTimes.length - 1] - onsetTimes[0] : 0
    // 上限：就算按 40 BPM 弹，一遍也要 periodQ*1.5 秒，据此估最多能有几遍
    // ★ 检测出来的音高**不再拿去影响对齐** ✓✓
    //
    // 原来用它做"音高吻合率"给候选锚点加分 ✓ 想法是对的（时间对+音高对很难是巧合）✓
    // 但前提是**音高认得准** ✗ 而现在只对 1/7 ✓
    // 认错的音高去加分 ✓ 等于把对齐往错的方向拽 ✗ 有害无益 ✓
    //
    // 用户也明确说了：「放弃展示演奏了什么音，能确认演奏了就行」✓
    // 所以这一路整个撤掉 ✓ 对齐只靠**时间**
    // （"期望音名"那一层保留 ✓ 那是**谱面**上的音 ✓ 不是检测出来的 ✓）

    const maxRep = Math.max(1, Math.min(16, Math.ceil(span / Math.max(periodQ * 1.5, 0.5)) + 1))

    let match: TempoMatch | null = null
    let bestRep = 1
    const reps: { rep: number; bpm: number; f1: number; matches: number; expected: number; extras: number }[] = []
    for (let rep = 1; rep <= maxRep; rep++) {
      const exp = expectedOnsets(rhythmBars, rep)
      if (exp.length === 0) break
      const m = matchTempo(onsetTimes, exp, {
        strengths,
        expectedPitches: expectedPitchSequence(rhythmBars, tuning, rep),
        // ★ 相位锚在起奏处 ✓✓
        // "第一个音就在起奏那一刻"是物理事实 ✓ 而自由搜相位在起点密集时会漂一整拍 ✗
        // 实测 (6)：自由搜给出 2.21s ✓ 起奏是 1.64s ✗ 差 0.57s（正好一拍）
        // ★ 锚点：用户手动指定优先 ✓ 没指定才用自动检测的 ✓
    ...(perfStartManual != null
      ? { anchorOffset: perfStartManual }
      : perfStart
        ? { anchorOffset: perfStart.time }
        : {})
      })
      if (!m) continue
      reps.push({
        rep,
        bpm: m.bpm,
        f1: m.f1,
        matches: m.matches,
        expected: m.expectedCount,
        extras: m.extras.length
      })
      if (!match || m.f1 > match.f1 + 1e-9) {
        match = m
        bestRep = rep
      }
    }
    detectedReps = reps

    // 用户手动指定了遍数就按它的结果来 —— 拟合是自动的，但最终该由弹的人说了算
    if (forcedReps > 0) {
      const chosen = reps.find((r) => r.rep === forcedReps)
      if (chosen) {
        const m2 = matchTempo(onsetTimes, expectedOnsets(rhythmBars, forcedReps), {
          strengths,
          expectedPitches: expectedPitchSequence(rhythmBars, tuning, forcedReps),
          // ★ 锚点：用户手动指定优先 ✓ 没指定才用自动检测的 ✓
    ...(perfStartManual != null
      ? { anchorOffset: perfStartManual }
      : perfStart
        ? { anchorOffset: perfStart.time }
        : {})
        })
        if (m2) {
          match = m2
          bestRep = forcedReps
        }
      }
    }
    detectedRepsUsed = bestRep
    // 检测图要把**整段录音**铺满，不能只画用户输入的那几个小节 ——
    // 否则后面弹的全落在画布外面，等于没显示（用户实测报的就是这个）。
    // 做法：把用户那一遍的小节时值**原样重复**，直到盖住整段。
    const onePass = rhythmBars.map(barTotal)
    const passSeconds =
      match && onePass.length
        ? onePass.reduce((a, b) => a + b, 0) * match.secondsPerQuarter
        : 0
    const totalSeconds = log.rate > 0 ? energies.length / log.rate : 0
    let barTotals = onePass
    if (passSeconds > 0.2 && totalSeconds > passSeconds) {
      // 上限只是防极端情况（小节特别短时会铺出很多行，画布高到卡死）。
      // 正常情况远够用：26 秒的录音、一遍 6.7 秒、一遍 12 个小节 -> 约 24 个而不是 200 个。
      const reps = Math.min(200, Math.ceil(totalSeconds / passSeconds))
      barTotals = []
      for (let k = 0; k < reps; k++) barTotals.push(...onePass)
    }
    detection = { onsets, match, energies, rate: log.rate, barTotals }
    // 预览的重画交给下面的 $effect —— 它跑在 DOM 更新**之后** ✓
    // 在这里直接调是没用的 ✗ 这一刻 {#if detection} 还没重新渲染、画布还没绑上 ✓
    detectionVersion++
    hasDetection = true
    detectionVersion++

    if (bandLimited) {
      detectMessage = `频带记录只到 ${energies.length} 列（约 ${(energies.length / log.rate).toFixed(0)} 秒），检测只覆盖到那里。`
    }

    if (onsets.length === 0) {
      detectMessage =
        '没检测到任何起点。可能是声音太轻、或者音与音之间是连着的（没有明显起音），也可能是录音里还没有演奏。'
      return
    }
    if (!match) {
      detectMessage = `检测到 ${onsets.length} 个起点，但没法对齐。`
      return
    }

    detectStats = {
      onsets: onsets.length,
      matched: match.matches,
      expected: match.expectedCount,
      extras: match.extras.length,
      bpm: match.bpm,
      meanMs: match.meanAbsError * 1000,
      maxMs: match.maxAbsError * 1000,
      f1: match.f1
    }

    const parts: string[] = []
    parts.push(
      match.matches === match.expectedCount
        ? `${match.expectedCount} 个音全部对上`
        : `对上了 ${match.matches} / ${match.expectedCount} 个音`
    )
    if (match.expectedCount - match.matches > 0) {
      parts.push(`漏了 ${match.expectedCount - match.matches} 个（没弹出来，或太轻没检到）`)
    }
    if (match.extras.length > 0) parts.push(`多出 ${match.extras.length} 个起点（多打或误检）`)
    parts.push(`平均偏差 ${(match.meanAbsError * 1000).toFixed(0)}ms`)
    detectMessage = parts.join(' · ')
  }

  function drawDetection(c: HTMLCanvasElement) {
    const d = detection
    if (!d) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(c.getBoundingClientRect().width))
    // 高度随「要分几行」变化：3 个小节、每行 2 个 → 2 行
    const h = detectionViewHeight(d.barTotals.length, DETECTION_BARS_PER_ROW)
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    if (c.width !== bw || c.height !== bh) {
      c.width = bw
      c.height = bh
    }
    c.style.height = h + 'px'

    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // ---- 把两边的输出整理成**干净的三样东西** ✓✓ ----
    //
    // 检测函数给的：onsets（时刻 + 置信）+ match（谁配上了谁）
    // 读谱函数给的：期望音的时刻 + 音名
    // 这个界面**不需要**别的 ✓（拍号、调弦那些在这一层看不见 ✓）
    const pairs = d.match?.pairs ?? []
    const m0 = d.match
    const labels = expectedPitchSequence(rhythmBars, tuning, detectedRepsUsed).map((m) =>
      m == null ? null : midiName(m)
    )
    const expected: ViewExpected[] = m0
      ? pairs.map((p, i) => ({
          // ★ 期望时刻用**局部速度映射**（expectedTime）✓✓
          //
          //   最早用直线 ✗ -> 5323 这种"前慢后快"，越往后期望时刻越偏 ✓
          //                  红线一大片 ✓ 用户说"看起来好像弹得很差" ✓
          //                  但音和谱子**其实对得上** ✓ 是**模型**不好 ✗
          //   现在用局部映射 ✓ -> 慢的速度变化被跟上 ✓ 剩下的才是真偏差 ✓✓
          //   而且它就是**画图的位置** ✓ 和统计里的"平均/最大偏差"是同一个量 ✓✓
          time: p.expectedTime ?? m0.offset + (p.expected - pairs[0].expected) * m0.secondsPerQuarter,
          label: labels[i] ?? null,
          // 配对连线用 ✓（**不用来上色** ✗ 那一栏永远中性 ✓）
          matchedTime: p.detected
        }))
      : []
    // ★ 哪些检测起点被配上了？**直接读配对表** ✓✓
    //   pairs[].detected 就是"这条期望音配上的是哪个实际时刻" ✓
    //   容差 0.02 秒：和弦合并后只有**最早**那根弦在表里 ✓ 第二根保持"多打"色 ✓（如实 ✓）
    const matchedTimes = pairs.filter((p) => p.detected !== null).map((p) => p.detected as number)
    const onsets: ViewOnset[] = d.onsets.map((o) => ({
      time: o.time,
      weak: o.weak,
      matched: matchedTimes.some((t) => Math.abs(t - o.time) < 0.02)
    }))
    // 小节在**时间**上的边界 —— 用**同一个局部映射**把拍位换算成时刻 ✓
    // （继续用直线的话，后面的小节线会和期望音脱节 ✗ 看着又乱了 ✓）
    const qToT = (q: number): number => {
      if (!m0 || !pairs.length) return 0
      if (q <= pairs[0].expected) {
        const t0 = pairs[0].expectedTime ?? m0.offset
        return t0 + (q - pairs[0].expected) * m0.secondsPerQuarter
      }
      for (let i = 0; i + 1 < pairs.length; i++) {
        const a = pairs[i]
        const b = pairs[i + 1]
        if (q >= a.expected && q <= b.expected) {
          const dq = b.expected - a.expected
          const f = dq > 0 ? (q - a.expected) / dq : 0
          const ta = a.expectedTime ?? m0.offset
          const tb = b.expectedTime ?? ta + dq * m0.secondsPerQuarter
          return ta + f * (tb - ta)
        }
      }
      const last = pairs[pairs.length - 1]
      const tl = last.expectedTime ?? m0.offset
      return tl + (q - last.expected) * m0.secondsPerQuarter
    }
    const edges: number[] = []
    if (m0) {
      let q = 0
      for (const tot of d.barTotals) {
        edges.push(qToT(q))
        q += tot
      }
      edges.push(qToT(q))
    }
    renderDetectionView({
      ctx,
      width: w,
      height: h,
      energies: d.energies,
      rate: d.rate,
      onsets,
      expected,
      barEdges: edges,
      barsPerRow: DETECTION_BARS_PER_ROW,
      maxTime:
        source === 'file'
          ? (analysis && analysis.durationSeconds > 0 ? analysis.durationSeconds : null)
          : (recording && recording.seconds > 0 ? recording.seconds : null),
      startTime: perfStartManual ?? perfStart?.time ?? null,
      playhead,
      ink: ink()
    })
  }

  $effect(() => {
    void detectionWidth
    void detectionVersion
    void playhead
    // ★ 调弦也要列进来 ✗ 否则拨了变调夹，图上的期望音名不会更新 ✓
    void tuning
    const c = detectionCanvas
    if (!c) return
    drawDetection(c)
  })

  // 回放头要跟得上声音：timeupdate 只有 ~4 次/秒，会一格一格地跳，所以播放期间用 rAF
  //
  // ★ 这里必须用 activeAudio()，**不能写死 recAudioEl** ✗✗
  //
  // 写死的后果（用户实测报的）：在**文件模式**下播放时，rAF 每帧都去读
  // **录音元素**的 currentTime ✓ 那当然是 0 ✓ 于是回放头被一直钉在 0 秒 ✓
  // 而 0 秒多半落在第一行窗口之外 ✓ -> **播放时看不到回放头** ✓
  // 一暂停 rAF 停了 ✓ 文件的 ontimeupdate 才把真实时刻写进去 ✓ -> **又出现了** ✓
  // 症状就是"播放没进度条、暂停反倒有" ✓✓
  /**
   * 把回放位置同步成"**当前正在播的那个源**"的时间。
   *
   * 抽成具名函数有两个好处：
   *   · 逻辑一眼能看懂、也能被直接调到（不用等 rAF）✓
   *   · 之前它是写在 rAF 回调里的内联代码 ✓ 于是"读错了源"这种错
   *     只能靠肉眼发现 ✗ 现在能测 ✓
   */
  function syncPlayheadFromAudio() {
    const a = activeAudio()
    // ★ 三件事一起看：在播、没暂停、**用户没在拖** ✓✓
    //
    // 少了最后一条就会出这个症状（用户实测报的）：
    //   "播放过程中进度条完全失效" ✗
    // 因为 rAF 每帧都在写 playPos ✓ 而滑块是 bind:value 的 ✓
    // 于是你拖到哪、下一帧就被声音的真实位置覆盖回去 ✗ 手感上就是"拖不动" ✓
    // 而 ±2 秒按钮不走 playPos ✓ 是直接改 currentTime ✓ 所以它们好使 ✓✓
    if (a && !a.paused && !seeking) {
      playPos = a.currentTime
      playhead = playheadAt(a.currentTime)
      detectionVersion++
    }
  }

  $effect(() => {
    if (!audioPlaying) return
    let raf = 0
    const tick = () => {
      syncPlayheadFromAudio()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  })

  // 检测画布是条件渲染的，出现时才挂观察者；effect 的清理函数负责摘掉
  $effect(() => {
    const c = detectionCanvas
    if (!c) return
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, Math.round(c.getBoundingClientRect().width))
      if (detectionWidth !== w) detectionWidth = w
    })
    ro.observe(c)
    return () => ro.disconnect()
  })

  /**
   * MuseScore 式键盘输入。
   *
   * 逻辑照搬 MuseScore：**先选时值，再打字输入音高** ✓
   *   · `1`~`5` 选时值（全 / 二分 / 四分 / 八分 / 十六分）
   *   · `A`~`G` 输入音名（落在当前八度上）
   *   · `Z` / `X` 八度降 / 升
   *   · `.` 附点　`R`（或 `0`）休止　`退格` 撤销
   *   · `↑` / `↓` 把**刚输入的那个音**升 / 降半音（MuseScore 也是这样）
   *
   * ⚠️ 鼠标点时值按钮**只改时值、不插音符** ✓ 音符一律由键盘产生 ✓
   * （这两条路都落到 addNote，但只有键盘会调它 ✓）
   */
  let importInput = $state<HTMLInputElement | undefined>(undefined)

  let entryDuration = $state('quarter')
  let entryOctave = $state(4)

  /**
   * 待用的升降号：-1 降 / 0 还原 / +1 升。
   *
   * 和附点、休止一样是**一次性修饰** ✗ —— 打完一个音就弹回还原 ✓
   * 否则用户输入下一个音时会莫名其妙带上升号 ✓
   */
  let accidental = $state(0)

  /* ---------------------------- 六线谱 ---------------------------- */

  /** 记谱方式：staff-tab = 上五线谱下六线谱（吉他谱最常见的排法）*/
  let notationMode = $state<'both' | 'staff-tab' | 'tab'>('staff-tab')

  /**
   * 当前调弦（含变调夹）。改了它，六线谱上的把位不变、音高自动跟着变。
   *
   * 从草稿里恢复 ✓ —— 老草稿没这个字段时 parseDraft 会退化成 STANDARD ✓
   */
  let tuning = $state<Tuning>(
    savedDraft ? { ...savedDraft.tuning, open: [...savedDraft.tuning.open] } : { ...STANDARD }
  )

  /**
   * 已选中的输入位置：第几小节的第几弦。
   * 点六线谱的某根弦线就设它 ✓ 之后键盘输入的数字就是**品位** ✓
   */
  let tabPick = $state<{ bar: number; string: number } | null>(null)

  /** 正在输入的品位数字（还没按空格）*/
  let fretBuf = $state('')

  /**
   * **待输入的和弦**：按了空格、还没回车的那些「弦 + 品」。
   *
   * 用户要求的流程 ✓：
   *   打第一个品格数 → **空格** → 它就显示出来（进这个数组）✓
   *   → 继续点别的弦、打别的品、再空格 ✓
   *   → 最后 **回车** 把整个和弦落成一个时间点 ✓
   */
  let pendingChord = $state<{ string: number; fret: number }[]>([])

  /* ---------------- 音符选区（像文本编辑那样） ---------------- */

  /**
   * 选区的**两端**。anchor = 起点（按下时定的），focus = 活动端（拖到哪算哪）✓
   *
   * 为什么存两端而不是存一个数组：拖动时每一帧都要重算选区 ✓
   * 存两端的话"反向拖"是天然支持的 ✓ 不用特殊处理 ✓
   */
  let selAnchor = $state<{ bar: number; index: number } | null>(null)
  let selFocus = $state<{ bar: number; index: number } | null>(null)
  /** 正在拖选（按下鼠标到松开之间）*/
  let selDragging = $state(false)

  /** 把 (小节, 下标) 线性化成一个全局序号 —— 选区就是两个序号之间的一段 */
  function flatIndexOf(ref: { bar: number; index: number }): number {
    let n = 0
    for (let b = 0; b < ref.bar && b < rhythmBars.length; b++) n += rhythmBars[b].length
    return n + ref.index
  }

  /** 反过来：全局序号 -> (小节, 下标)。越界返回 null */
  function refFromFlat(k: number): { bar: number; index: number } | null {
    let n = 0
    for (let b = 0; b < rhythmBars.length; b++) {
      const len = rhythmBars[b].length
      if (k < n + len) return { bar: b, index: k - n }
      n += len
    }
    return null
  }

  /**
   * 当前选中的音符（文档序，含两端）。
   *
   * 空选区返回空数组 ✓ 调用方一律用 .length 判断有没有选区 ✓
   */
  const selRefs = $derived.by(() => {
    if (!selAnchor || !selFocus) return [] as { bar: number; index: number }[]
    const a = flatIndexOf(selAnchor)
    const b = flatIndexOf(selFocus)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const out: { bar: number; index: number }[] = []
    for (let k = lo; k <= hi; k++) {
      const r = refFromFlat(k)
      if (r) out.push(r)
    }
    return out
  })

  function clearSel() {
    selAnchor = null
    selFocus = null
  }

  /**
   * 一个音符的"和弦兄弟"范围 —— 和弦音必须和基音**时值一致** ✗
   * 所以改时值/删除时要把整组一起处理 ✓
   */
  function chordSpan(bar: number, index: number): { from: number; to: number } {
    const notes = rhythmBars[bar] ?? []
    let from = index
    while (from > 0 && notes[from]?.chord) from--
    let to = index
    while (to + 1 < notes.length && notes[to + 1]?.chord) to++
    return { from, to }
  }

  /** 把鼠标位置换算成画布坐标（绘制用的是 CSS 像素，两边一致） */
  function canvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
    const c = rhythmCanvas
    if (!c) return null
    const rect = c.getBoundingClientRect()
    if (!rect.height || !rect.width) return null
    return {
      x: ((e.clientX - rect.left) / rect.width) * rect.width,
      y: ((e.clientY - rect.top) / rect.height) * RHYTHM_H
    }
  }

  /**
   * 在录谱画布上按下鼠标。
   *
   * 两种意图要分开 ✓：
   *   ① 点在**符头**上 → 开始选音符（像文本编辑那样拖选）✓
   *   ② 点在**六线谱的弦线**上 → 选那根弦准备打品号（原来的行为）✓
   * 先试符头 ✓ 没中再退到选弦 ✓
   */
  function onRhythmPointerDown(e: PointerEvent) {
    const pt = canvasPoint(e)
    if (!pt) return

    const hit = staffHitTest(pt.x, pt.y)
    if (hit) {
      selAnchor = hit
      selFocus = hit
      selDragging = true
      rhythmCanvas?.setPointerCapture?.(e.pointerId)
      e.preventDefault()
      return
    }

    // 没点到符头：清掉选区，按原来的逻辑选弦
    clearSel()
    if (notationMode === 'both') return
    const s = tabStringAt(pt.y, RHYTHM_H, notationMode)
    if (s === null) {
      tabPick = null
      fretBuf = ''
      return
    }
    tabPick = { bar: activeBar, string: s }
    fretBuf = ''
  }

  /** 拖选：按住左键划过符头，选区就跟着长 */
  function onRhythmPointerMove(e: PointerEvent) {
    if (!selDragging) return
    const pt = canvasPoint(e)
    if (!pt) return
    const hit = staffHitTest(pt.x, pt.y)
    if (hit) selFocus = hit
  }

  function onRhythmPointerUp() {
    selDragging = false
  }

  /**
   * 把选区里的音符（**连同和弦兄弟**）改成某个时值。
   *
   * 和弦音必须和基音时值一致 ✗ 所以改一个就要改一整组 ✓
   * 音高、弦品、附点、休止这些属性一律原样保留 ✓ 只换时值 ✓
   */
  function applyDurationToSelection(id: string) {
    const spec = DURATIONS.find((d) => d.id === id)
    if (!spec || !selRefs.length) return
    const byBar = new Map<number, Set<number>>()
    for (const r of selRefs) {
      const { from, to } = chordSpan(r.bar, r.index)
      const set = byBar.get(r.bar) ?? new Set<number>()
      for (let i = from; i <= to; i++) set.add(i)
      byBar.set(r.bar, set)
    }
    rhythmBars = rhythmBars.map((notes, b) => {
      const set = byBar.get(b)
      if (!set) return notes
      return notes.map((n, i) =>
        set.has(i)
          ? makeNote(spec.id, {
              dotted: n.dotted,
              rest: n.rest,
              midi: n.midi,
              string: n.string,
              fret: n.fret,
              chord: n.chord
            })
          : n
      )
    })
    // 时值变了，各小节长度跟着变 —— 选区下标可能已经不对了，直接收起来最稳
    clearSel()
  }

  /** 删掉选区里的音符（连同和弦兄弟） */
  function deleteSelection() {
    if (!selRefs.length) return
    const byBar = new Map<number, Set<number>>()
    for (const r of selRefs) {
      const { from, to } = chordSpan(r.bar, r.index)
      const set = byBar.get(r.bar) ?? new Set<number>()
      for (let i = from; i <= to; i++) set.add(i)
      byBar.set(r.bar, set)
    }
    rhythmBars = rhythmBars.map((notes, b) => {
      const set = byBar.get(b)
      if (!set) return notes
      return notes.filter((_, i) => !set.has(i))
    })
    clearSel()
  }

  /**
   * 改时值的**唯一入口**（鼠标点按钮、键盘按 1~5 都走这里）。
   *
   * 有选区就改选中的那些 ✓ 没有就改"接下来要输入"的时值 ✓
   * —— 这正是文本编辑器的行为 ✓
   */
  function setDuration(id: string) {
    if (selRefs.length) {
      applyDurationToSelection(id)
      return
    }
    entryDuration = id
  }

  /** 确认输入：把「弦 + 品」变成一个音符 */
  /**
   * 回车：把「待输入和弦 + 缓冲区里那一个」一起落成**一个时间点** ✓
   *
   * 第一个音独立 ✓ 其余标 `chord` —— 它们和第一个同时起、不占额外时值 ✓
   * 这正是 MusicXML 的 <chord/> 语义 ✓ 所以导出到 MuseScore 也是和弦而不是琶音 ✓
   */
  function commitFret() {
    if (!tabPick) return
    const list = [...pendingChord]
    if (fretBuf !== '') {
      const fret = Math.max(0, Math.min(24, Number(fretBuf) || 0))
      const i = list.findIndex((p) => p.string === tabPick!.string)
      if (i >= 0) list[i] = { string: tabPick!.string, fret }
      else list.push({ string: tabPick!.string, fret })
      list.sort((a, b) => a.string - b.string)
    }
    if (!list.length) return

    // ★ 写到**当前**小节，不是"当初点弦时那个小节" ✗✗
    //
    // 这里原来用的是 tabPick.bar ✓ 而它只在"点弦线"那一刻更新 ✓
    // 用户录完一个和弦不会重新点弦（选择还在那根弦上）✓
    // 于是后面每个和弦都写回同一个小节 ✗ 不管小节满没满 ✓
    // 症状就是"所有音全挤在一个小节里" ✓✓
    //
    // activeBar 才是"现在该往哪写" ✓ 它由 advanceIfFull 推进 ✓
    const bar = activeBar
    const notes = list.map((p, i) =>
      makeNote(entryDuration, {
        dotted: dotNext,
        midi: stringFretToMidi(tuning, p.string, p.fret),
        string: p.string,
        fret: p.fret,
        chord: i > 0
      })
    )
    rhythmBars = rhythmBars.map((b, i) => (i === bar ? [...b, ...notes] : b))
    dotNext = false
    accidental = 0
    fretBuf = ''
    pendingChord = []
    advanceIfFull()
    // 推进之后把选中位置也跟过去 ✓ 否则下一个和弦又写回旧小节 ✓
    tabPick = { bar: activeBar, string: tabPick.string }
  }

  /** 换调弦：把当前预设的名字和值都换掉 */
  function pickTuning(id: string) {
    const p = TUNING_PRESETS.find((t) => t.id === id)
    if (p) tuning = { ...p, open: [...p.open] }
  }

  /** 改某一根弦的空弦音（特殊调弦就是这么调出来的）*/
  function setStringOpen(stringNo: number, midi: number) {
    const open = [...tuning.open]
    open[stringNo - 1] = Math.max(12, Math.min(96, Math.round(midi)))
    tuning = { ...tuning, open, id: 'custom', name: '自定义' }
  }

  /** 音名 -> 音级（C 大调自然音级；升降号用 ↑↓ 单独调）*/
  const LETTER_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

  /**
   * 当前八度下，按 A~G 分别会输入什么音。
   *
   * 这是把「Z/X 换八度」讲清楚的最直接办法 ✗ —— 与其解释"降一个八度"，
   * 不如直接把结果列出来 ✓ 用户看一眼就知道自己会得到什么 ✓
   */
  const octaveNotes = $derived(
    ['c', 'd', 'e', 'f', 'g', 'a', 'b'].map((k) => {
      const midi = entryOctave * 12 + LETTER_PC[k] + 12
      return { key: k.toUpperCase(), name: midiName(midi) }
    })
  )
  /** `1`~`5` 对应 DURATIONS 里的第几个 */
  const DUR_KEYS = ['whole', 'half', 'quarter', 'eighth', 'sixteenth']

/**
 * 拍号候选。
 *
 * 用户要求"录入界面要能选拍号" ✓ —— 原来只在右上角把 `拍号 4/4` 当**文字**显示 ✗
 * 改拍号会影响：每小节的容量（校验 ✓）、连桁分组 ✓、简谱破折号 ✓、导出 MusicXML ✓
 * 它们全都读 beatsPerBar / beatUnit ✓ 所以改一处就够 ✓
 */
const TIME_SIGNATURES: { beats: number; unit: number }[] = [
  { beats: 2, unit: 4 },
  { beats: 3, unit: 4 },
  { beats: 4, unit: 4 },
  { beats: 5, unit: 4 },
  { beats: 6, unit: 4 },
  { beats: 2, unit: 2 },
  { beats: 3, unit: 8 },
  { beats: 6, unit: 8 },
  { beats: 9, unit: 8 },
  { beats: 12, unit: 8 },
  { beats: 4, unit: 8 }
]

/**
 * 当前选中时值的**时值**（四分音符为单位）。
 *
 * 预览要用它算"新音会落在小节的哪个位置" ✓
 * 横坐标必须和 layoutStaff 用同一套算法 ✗ 否则预览和落谱后对不上 ✓
 */
function entryValue(): number {
  return DURATIONS.find((d) => d.id === entryDuration)?.value ?? 1
}

  /** 当前小节装满了就自动进下一小节（MuseScore 也是这个行为）*/
  function advanceIfFull() {
    const cap = barCapacity(beatsPerBar, beatUnit)
    if (barTotal(rhythmBars[activeBar] ?? []) + 1e-9 < cap) return
    if (activeBar < rhythmBars.length - 1) activeBar++
    else {
      rhythmBars = [...rhythmBars, []]
      activeBar = rhythmBars.length - 1
    }
  }

  function addNote(id: string, midi: number | null = null) {
    const note = makeNote(id, { dotted: dotNext, rest: restNext, midi })
    rhythmBars = rhythmBars.map((bar, i) => (i === activeBar ? [...bar, note] : bar))
    // 一次性修饰键：用完就弹起，避免后面所有音符都被意外加上附点
    dotNext = false
    restNext = false
    accidental = 0
    advanceIfFull()
  }

  function undoNote() {
    rhythmBars = rhythmBars.map((bar, i) => (i === activeBar ? bar.slice(0, -1) : bar))
  }

  function clearRhythm() {
    // 只清音符，**小节数保留** —— 用户辛苦加出来的小节结构不该被一起抹掉
    rhythmBars = rhythmBars.map(() => [])
    // 显式清空就是用户的意图，本地草稿也一并清掉，别下次又"恢复"出来
    clearDraft()
    restoredNote = false
  }

  // 节奏变化、拍号变化、画布宽度变化都要重画
  $effect(() => {
    void rhythmWidth
    void rhythmBars
    void beatsPerBar
    void beatUnit
    const c = rhythmCanvas
    if (!c) return
    drawRhythm(c)
  })

  /** 实时模式下清空记录；文件模式下这个按钮变成「移除文件」 */
  function clearLogOrUnload() {
    if (source === 'file') {
      unloadFile()
      return
    }
    engine.clearLog()
    logCount = 0
    logBytes = 0
    logFull = false
    // 记录清空了 = 没东西可分析了 → 旧的检测结果也要清 ✗
    resetDetection()
  }

  function unloadFile() {
    loadGeneration++
    analysis = null
    overviewCanvas = null
    source = 'mic'
    // 文件没了 —— 基于它的检测结果也必须一起没 ✗（和分析新录音同一个道理 ✓）
    resetDetection()
    // 换源了：播放位置归零，免得还指着上一段音频的进度
    playPos = 0
    audioPlaying = false
    playhead = 0
    fileName = ''
    fileError = ''
    analyzing = false
    analyzeProgress = 0
    fileEnergyMax = 0
    if (fileUrl) {
      URL.revokeObjectURL(fileUrl)
      fileUrl = ''
    }
    // 切回麦克风的记录（可能之前已经录了一些）
    logCount = engine.log?.length ?? 0
    logRate = engine.log?.rate ?? 0
    logBytes = engine.log?.bytes ?? 0
    logFull = engine.log?.full ?? false
  }

  function describeFileError(e: unknown): string {
    const msg = (e as Error)?.message ?? ''
    if (msg.includes('太短')) return msg
    return `无法解码这个文件：${msg || '浏览器不支持该格式，或文件已损坏'}。mp3 / wav / m4a / ogg / flac 一般都可以，但具体支持哪些取决于浏览器。`
  }

  async function loadFile(file: File) {
    fileError = ''
    const generation = ++loadGeneration
    // 换文件 = 换了音频源 ✓ 上一次的检测结果必须清掉 ✗（和新录音同一个道理 ✓）
    resetDetection()

    // 两种来源互斥：加载文件前先把麦克风停掉
    if (running) {
      await engine.stop()
      running = false
      hasData = false
    }

    analyzing = true
    analyzeProgress = 0
    try {
      const buffer = await decodeAudioFile(file, 48000)
      if (generation !== loadGeneration) return

      const result = await analyseAudioBuffer(
        buffer,
        file.name,
        {
          fftSize: FFT_SIZE,
          hop: HOP,
          specRows: FILE_SPEC_ROWS,
          fMin: F_MIN,
          fMax: F_MAX,
          rasterMaxWidth: RASTER_MAX_WIDTH,
        },
        (p) => {
          if (generation === loadGeneration) analyzeProgress = p.total ? p.done / p.total : 0
        },
        () => generation !== loadGeneration
      )
      if (!result || generation !== loadGeneration) return

      analysis = result
      source = 'file'
      fileName = result.name
      fileEnergyMax = Math.max(ENERGY_FLOOR, result.log.max)
      fileInfo = {
        seconds: result.durationSeconds,
        columns: result.columns,
        kb: Math.round((result.raster.length + result.log.bytes) / 1024),
        sampleRate: result.sampleRate,
        channels: result.channels,
      }

      if (fileUrl) URL.revokeObjectURL(fileUrl)
      fileUrl = URL.createObjectURL(file)

      // 谱面视图直接吃文件分析出来的记录
      logCount = result.log.length
      logRate = result.log.rate
      logBytes = result.log.bytes
      logFull = false

      rebuildOverview()
    } catch (e) {
      fileError = describeFileError(e)
    } finally {
      if (generation === loadGeneration) analyzing = false
    }
  }

  function onFileChosen(e: Event) {
    const input = e.target as HTMLInputElement
    const picked = input.files?.[0]
    if (picked) void loadFile(picked)
    // 清空 value：否则再选同一个文件不会触发 change
    input.value = ''
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    dragging = true
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    const dropped = e.dataTransfer?.files?.[0]
    if (dropped) void loadFile(dropped)
  }

  /**
   * 把整首歌画进一张离屏画布：上面是频谱栅格，下面是整曲能量曲线。
   * 之后每帧只做一次贴图 + 画播放头，不重复算像素。
   */
  function rebuildOverview() {
    if (source !== 'file' || !analysis || view.w < 2 || view.h < 2) {
      overviewCanvas = null
      return
    }
    const a = analysis
    const w = view.w
    const h = view.h

    const ov = overviewCanvas ?? document.createElement('canvas')
    if (ov.width !== w) ov.width = w
    if (ov.height !== h) ov.height = h
    const ctx = ov.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = BG()
    ctx.fillRect(0, 0, w, h)

    // 1) 频谱：栅格存的是 dB 字节，这里才套 gainDb 转成颜色（所以改灵敏度不用重新分析）
    const rc = rasterCanvas ?? document.createElement('canvas')
    if (rc.width !== a.rasterWidth) rc.width = a.rasterWidth
    if (rc.height !== a.specRows) rc.height = a.specRows
    const rctx = rc.getContext('2d')
    if (rctx) {
      const img = rctx.createImageData(a.rasterWidth, a.specRows)
      const data = img.data
      for (let i = 0; i < a.raster.length; i++) {
        const p = dbByteToIndex(a.raster[i], gainDb) * 3
        const o = i * 4
        data[o] = palette[p]
        data[o + 1] = palette[p + 1]
        data[o + 2] = palette[p + 2]
        data[o + 3] = 255
      }
      rctx.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(rc, 0, 0, a.rasterWidth, a.specRows, 0, 0, w, view.specRows)
    }

    // 2) 分隔线
    ctx.fillStyle = ink().line
    ctx.fillRect(0, view.specRows, w, view.sepRows)

    // 3) 能量：整首歌铺满整个宽度，一行，不要网格
    const energyH = h - view.energyTop
    if (energyH > 0) {
      const strip = ctx.createImageData(w, energyH)
      renderScoreRow(
        (i) => a.log.at(i),
        0,
        a.log.length,
        {
          width: w,
          height: energyH,
          contentLeft: 0,
          barsPerRow: 1,
          beatsPerBar: 1,
          beatsPerRow: 0, // 0 = 不要小节线/拍线，当纯面积图用
          readingsPerRow: Math.max(1, a.log.length),
          scale: fileEnergyMax,
          mode: scaleMode,
        },
        energyRamp,
        strip.data
      )
      ctx.putImageData(strip, 0, view.energyTop)
    }

    overviewCanvas = ov
  }

  /** 文件模式每帧：贴概览图 + 画播放头 */
  function drawFileFrame(ctx: CanvasRenderingContext2D) {
    const ov = overviewCanvas
    if (!ov || ov.width !== view.w || ov.height !== view.h) {
      ctx.fillStyle = BG()
      ctx.fillRect(0, 0, view.w, view.h)
      return
    }
    ctx.drawImage(ov, 0, 0)

    const a = analysis
    const el = audioEl
    if (!a || !el || a.durationSeconds <= 0) return
    const t = el.currentTime
    if (!(t >= 0)) return
    const x = Math.max(0, Math.min(view.w - 1, Math.round((t / a.durationSeconds) * view.w)))
    ctx.fillStyle = ink().accent
    ctx.fillRect(x, 0, view.sepRows, view.h)
  }

  // 改灵敏度 / 刻度只影响显示：栅格存的是 dB，重画一遍概览就行，不用重新分析
  $effect(() => {
    void gainDb
    void scaleMode
    rebuildOverview()
  })

  // 记录增长、来源切换、BPM / 拍号 / 每行小节数变化、画布宽度变化，都会重画谱面
  $effect(() => {
    void scoreWidth
    void logCount
    void source
    const c = scoreCanvas
    if (!c) return
    drawScore(c, scoreLayout, Math.min(scoreRowTotal, ROW_CAP))
  })

  function describeError(e: unknown): string {
    const err = e as { name?: string; message?: string }
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '麦克风权限被拒绝。请检查地址栏左侧的权限图标，允许后重试。'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '没有检测到可用的麦克风设备。'
      case 'NotReadableError':
      case 'TrackStartError':
        return '麦克风被其它程序占用，请关闭后重试。'
      default:
        return err?.message || '麦克风启动失败。'
    }
  }

  async function toggle() {
    if (starting) return

    if (running) {
      await engine.stop()
      running = false
      hasData = false
      buffered = 0
      sampleRate = 0
      clearRaster()
      return
    }

    starting = true
    errorText = ''
    try {
      await engine.start()
      running = true
      clearRaster()
      rebuildTargets()
    } catch (e) {
      errorText = describeError(e)
    } finally {
      starting = false
    }
  }


  // PERSIST-HOOK —— 只在开发模式生效，配合 tools/check-persist.ps1 用
  //
  // 它做的是一件人工验证的事：建一份谱子 -> 等自动保存落盘 -> 换个进程重新加载 -> 比对。
  // 之所以要这么测：草稿路径出过好几次"存回来全挤在一个小节"的 bug，
  // 而单测抓不到 —— 因为库函数的往返一直是对的，坏是坏在**存之前**。
  if (import.meta.env.DEV) {
    onMount(() =>
      setTimeout(() => {
        try {
          const mode = new URLSearchParams(location.search).get("persist")
          if (mode === "write") {
            rhythmBars = [[]]
            activeBar = 0
            entryDuration = "quarter"
            const fire = (k: string, code: string) =>
              window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true }))
            const names = ["g", "a", "b", "c", "d", "e", "f", "g"]
            for (let i = 0; i < 8; i++) fire(names[i], "Key" + names[i].toUpperCase())
            fire(".", "Period")
            fire("h", "KeyH")
            fire("r", "KeyR")
            // ★ 顺便把变调夹拨到 3 品 —— 它必须活过刷新 ✓
            tuning = { ...tuning, capo: 3 }
            setTimeout(() => {
              const stored = localStorage.getItem("beatlooker.score-draft")
              const parsed = stored ? JSON.parse(stored) : null
              // 输出**纯 ASCII** 标记 —— PowerShell 5.1 把无 BOM 脚本当 ANSI 读，
              // 中文正则会乱码，所以这里不能带中文 ✓
              document.title = "PERSIST-WRITE STORED=" + (stored ? "yes" : "no") +
                " BARS=" + (parsed && parsed.bars ? parsed.bars.map((b: unknown[]) => b.length).join("/") : "?") +
                " CAPO=" + (parsed && parsed.tuning ? parsed.tuning.capo : "?")
            }, 900)
          } else if (mode === "read") {
            const stored = localStorage.getItem("beatlooker.score-draft")
            document.title = "PERSIST-READ STORED=" + (stored ? "yes" : "no") +
              " BARS=" + rhythmBars.map((b) => b.length).join("/") +
              " NOTES=" + rhythmBars.reduce((a, b) => a + b.length, 0) +
              " CAPO=" + tuning.capo +
              " WARN=" + (draftWarnings.length ? draftWarnings.length : 0)
          }
        } catch (err) {
          document.title = "PERSIST-ERR::" + (err as Error).message
        }
      }, 800)
    )
  }

  onMount(() => {
    // URL 上的 ?theme= 优先（可分享的深链），否则用上次选的
    const params = new URLSearchParams(location.search)
    const wanted = params.get('theme')
    if (wanted && THEMES.some((t) => t.id === wanted)) themeId = wanted
    setTheme(themeId)
    // ?tab=score|record|analyze —— 方便直接进到某一步，也方便分享
    const wantTab = params.get('tab')
    if (wantTab === 'score' || wantTab === 'record' || wantTab === 'analyze') tab = wantTab
    // ?fifths=3 —— 直接指定调号（正数升号、负数降号），方便分享和做视觉验证
    const wantFifths = params.get('fifths')
    if (wantFifths !== null && /^-?\d+$/.test(wantFifths)) {
      keySignature = Math.max(-7, Math.min(7, Number(wantFifths)))
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', onKeyDown)

    // 录完一段就把它挂到检测区，方便回放对照
    engine.recorder.onResult = (r) => {
      recording = r
      playhead = null
      audioPlaying = false
      playPos = 0
      // ★ 新录音 = 换了音频源 ✓ 上一次的检测结果必须清掉 ✗✗
      // 否则播放器放的是新录音、分析图画的还是旧的 ✓（用户实测报的就是这个）
      resetDetection()
      // 自动存一份，刷新页面 / 关掉重开都还在
      if (r) {
        void saveRecording({
          blob: r.blob,
          seconds: r.seconds,
          mimeType: r.mimeType,
          savedAt: Date.now()
        })
      } else {
        void clearStoredRecording()
      }
    }

    // 上次的录音如果还存着，直接挂回来 —— 不用重录就能继续对着检测结果看
    void loadRecording().then((stored) => {
      if (!stored || recording) return
      recording = {
        url: URL.createObjectURL(stored.blob),
        blob: stored.blob,
        seconds: stored.seconds,
        bytes: stored.blob.size,
        mimeType: stored.mimeType
      }
    })

    // 手机上切走 / 关页面前，把还没到点的这次改动立刻写掉。
    // 防抖窗口只有 300ms，但"点了音符立刻切走"这种操作是存在的。
    const flushDraft = () => {
      clearTimeout(draftTimer)
      saveDraft(currentDraft())
    }
    window.addEventListener('pagehide', flushDraft)

    // 谱面画布宽度单独跟踪：行数增长会带出/收掉滚动条，宽度得跟着重算
    const scoreRo = new ResizeObserver(() => {
      const sc = scoreCanvas
      if (!sc) return
      const sw = Math.max(1, Math.round(sc.getBoundingClientRect().width))
      if (scoreWidth !== sw) scoreWidth = sw
    })
    if (scoreCanvas) scoreRo.observe(scoreCanvas)

    // 节奏那边跟踪的是**外层滚动容器**的宽度 —— 画布自己会被撑宽，
    // 观察它就会自己触发自己，转圈。
    const rhythmBox = rhythmCanvas?.parentElement
    const rhythmRo = new ResizeObserver(() => {
      if (!rhythmBox) return
      const rw = Math.max(1, Math.round(rhythmBox.getBoundingClientRect().width))
      if (rhythmWidth !== rw) rhythmWidth = rw
    })
    if (rhythmBox) rhythmRo.observe(rhythmBox)

    // 舞台画布也交给 ResizeObserver：只靠 window.resize 会漏掉
    // 「窗口没变但容器宽度变了」的情况（比如谱面变长把页面滚动条挤出来）。
    const stageRo = new ResizeObserver(() => resize())
    if (canvas) stageRo.observe(canvas)

    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop)
      render(t)
    })

    return () => {
      cancelAnimationFrame(raf)
      scoreRo.disconnect()
      rhythmRo.disconnect()
      stageRo.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pagehide', flushDraft)
      void engine.stop()
    }
  })
</script>

<main>
  <header>
    <h1>BeatLooker <span>频谱图 + 能量图</span></h1>
    <label class="theme-pick">
      配色
      <select value={themeId} onchange={(e) => pickTheme(e.currentTarget.value)}>
        {#each THEMES as t (t.id)}
          <option value={t.id}>{t.name}</option>
        {/each}
      </select>
    </label>
    <p class="sub">
      两图共用同一条时间轴，同步滚动 · 上图 Y 轴 = 频率 · 下图 Y 轴 = 总能量（0
      到无穷，满量程自适应）
    </p>
    <div class="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'score'}
        class:active={tab === 'score'}
        onclick={() => (tab = 'score')}>① 录入谱子</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'record'}
        class:active={tab === 'record'}
        onclick={() => (tab = 'record')}>② 录音 / 音频</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'analyze'}
        class:active={tab === 'analyze'}
        onclick={() => {
          tab = 'analyze'
          // 切过去时画布刚可见，补一次绘制（隐藏时画的内容看不到但还在）
          queueMicrotask(drawScorePreview)
        }}>③ 分析</button
      >
    </div>
  </header>

  <!--
    吸顶播放条：**两个页签共用一份** ✓✓

    原来是只在「分析」页里写着 ✓ 用户要求「录音 / 音频」页也要有 ✓
    抽成 snippet 而不是复制一份 ✗ —— 复制的话两边的"当前放哪个源 ✓、
    拖动时不让回放同步抢 ✓"这些细节迟早会跑偏 ✓（我已经在这上面栽过一次 ✓）
  -->
  {#snippet playbar()}
    {#if hasPlayback}
      <div class="playbar" class:playing={audioPlaying}>
        <button
          type="button"
          class="playbtn"
          onclick={togglePlay}
          aria-label={audioPlaying ? '暂停' : '播放'}
          title={audioPlaying ? '暂停（空格）' : '播放（空格）'}
        >
          {audioPlaying ? '❚❚' : '▶'}
        </button>
        <button type="button" class="skipbtn" onclick={() => nudge(-2)} title="后退 2 秒">−2s</button>
        <button type="button" class="skipbtn" onclick={() => nudge(2)} title="前进 2 秒">+2s</button>
        <input
          class="seek"
          type="range"
          min="0"
          max={Math.max(0.1, mediaDuration || playTotal)}
          step="0.01"
          bind:value={playPos}
          onpointerdown={() => (seeking = true)}
          onpointerup={() => (seeking = false)}
          onpointercancel={() => (seeking = false)}
          oninput={(e) => seekTo(Number(e.currentTarget.value))}
          onchange={() => (seeking = false)}
          aria-label="播放位置"
        />
        <span class="playtime">
          <b>{playPos.toFixed(2)}</b> / {playTotal.toFixed(2)}s
        </span>
        <span class="playhint">
          当前在放<b>{source === 'file' ? '加载的文件' : '这次录的音'}</b> · 图上回放头 = 真实时间
        </span>
      </div>
    {/if}
  {/snippet}

  <div class="tabpane" class:active={tab === 'record'}>
  {@render playbar()}

  <!--
    ★ 开始点（截取）—— 就在**录音 / 音频**这一页设 ✓✓

    用户的原话："应该在录音音频界面直接截取哪里是开始的地方，
                而不是在分析界面那么复杂的去弄" ✓
    所以分析页那套"改起奏点"撤掉了 ✓ 入口只留在这里 ✓

    为什么要有这个开关 ✗：自动判据**一定会误判** ✓ 那不是 bug ✓
      实测 5323.webm：0.416s 那个椅子声是
        **70Hz 基频 + 成整数倍谐波 + 陡然抬起 +13.7dB + 不归零 + 持续**
        —— 和"弹了一个低音"在声学特征上**完全一样** ✗ 判据没有理由拒绝它 ✓
      硬调判据只会把真起奏也一起漏掉 ✗
  -->
  <div class="trim-start-row">
    <span>开始点：</span>
    {#if perfStartManual != null}
      <b>{perfStartManual.toFixed(2)}s</b>
      <em style="font-style:normal;color:var(--muted)">（手动指定）</em>
    {:else}
      <b>自动</b>
      <em style="font-style:normal;color:var(--muted)">（检测出来的起奏）</em>
    {/if}
    <span style="color:var(--muted-2,#8a8a9a);font-size:11px">
      在下面的图上按住拖动那条绿色竖线，放到音乐真正开始的地方
    </span>
    {#if perfStartManual != null}
      <button
        type="button"
        class="trim-btn"
        onclick={() => {
          perfStartManual = null
          detectMessage = '开始点已改回自动检测'
        }}>清除</button
      >
    {/if}
    <span style="color:var(--muted-2,#8a8a9a);font-size:11px">
      检测那一步会从这一刻开始对齐 ✓ 之前的波动一律不算起点
    </span>
  </div>

  <div
    class="stage"
    class:dragging
    class:can-mark={source === 'file' && analysis !== null}
    role="application"
    aria-label="频谱图与能量图"
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <canvas bind:this={canvas}></canvas>

    {#if dragging}
      <div class="drop-veil">松手即分析这个音频文件</div>
    {/if}

    <!--
      ★ "开始"竖线：**直接拖到音乐开始的地方** ✓✓
      只在文件模式下出现 ✓ —— 那时整首歌按比例铺满宽度 ✓ 拖到哪儿就是哪儿 ✓
      （录音模式画布是滚动的最近一段 ✗ 没有整曲坐标系 ✓ 所以那边用上面那排按钮 ✓）
    -->
    {#if stageFracOf(perfStartManual ?? perfStart?.time ?? 0) != null}
      {@const frac = stageFracOf(perfStartManual ?? perfStart?.time ?? 0) ?? 0}
      <div class="start-line" style="left: {frac * 100}%"></div>
      <div class="start-tag" style="left: {frac * 100}%">
        开始 {(perfStartManual ?? perfStart?.time ?? 0).toFixed(2)}s
      </div>
      <div
        class="start-grip"
        role="slider"
        tabindex="0"
        aria-label="开始点"
        aria-valuemin="0"
        aria-valuemax={Math.round((stageTimeAt(1) ?? 0) * 100)}
        aria-valuenow={Math.round((perfStartManual ?? perfStart?.time ?? 0) * 100)}
        style="left: {frac * 100}%"
        title="按住拖到音乐真正开始的地方（← → 可以微调）"
        onpointerdown={onStartDrag}
        onkeydown={(e) => {
          // 键盘也能微调 ✓ 每次 0.05 秒 ✓（按住 Shift 是 0.01）
          const maxT = stageTimeAt(1)
          if (maxT == null) return
          const step = e.shiftKey ? 0.01 : 0.05
          const cur = perfStartManual ?? perfStart?.time ?? 0
          if (e.key === 'ArrowLeft') perfStartManual = Math.max(0, cur - step)
          else if (e.key === 'ArrowRight') perfStartManual = Math.min(maxT, cur + step)
          else return
          e.preventDefault()
        }}
      ></div>
    {/if}

    <!--
      标记层：一层**透明的 button** 盖在画布上 ✓✓
      为什么不给 .stage 这个 div 挂 onclick ✗ ——
      那在无障碍上是两条警告（非交互元素挂监听、还要配键盘处理 ✓）
      真做成 button 就都合规了 ✓ 而且 Tab 能聚焦、Esc 能清除 ✓
    -->
    {#if source === 'file' && analysis}
      <button
        type="button"
        class="mark-layer"
        aria-label="在能量图上标出时刻，按 Esc 清除"
        title="点一下可以在能量图上标出时刻（Esc 清除）"
        onclick={onStageClick}
        onkeydown={(e) => {
          if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
            markTime = null
            e.preventDefault()
          }
        }}
      ></button>
    {/if}

    <!-- 时刻标记：竖线 + 时间/能量 -->
    {#if markInfo}
      <div class="mark-line" style="left: {markInfo.leftPct}%"></div>
      <div class="mark-tag" style="left: {markInfo.leftPct}%">
        <b>{markInfo.time.toFixed(2)}s</b>
        <span>{markInfo.db.toFixed(1)} dB</span>
      </div>
    {/if}

    <div class="axis" aria-hidden="true">
      {#each TICKS as f (f)}
        <span style="top: {tickTop(f)}">{tickLabel(f)}</span>
      {/each}
    </div>

    {#if overlayEnergyH > 0}
      <div
        class="energy-axis"
        aria-hidden="true"
        style="top: {overlayEnergyTop}px; height: {overlayEnergyH}px"
      >
        <span style="top: 0">{fmt(shownEnergyMax)}</span>
        <span style="top: 50%">{fmt(valueAtLevel(shownEnergyMax, 0.5, scaleMode))}</span>
        <span style="top: calc(100% - 9px)">0</span>
      </div>
      <div class="panel-tag" style="top: {overlayEnergyTop + 7}px">{energyTag}</div>
    {/if}

    {#if source === 'mic' && running && hasData}
      <div class="hud">
        <span>{fps} fps</span>
        <span>{sampleRate || '--'} Hz</span>
        <span>{Math.round(colsPerSecond)} 列/秒</span>
        <span>横轴 {spanSeconds.toFixed(1)}s</span>
        <span>整体延迟 {delay.toFixed(2)}s</span>
        <span>能量满量程 {fmt(energyScale)}</span>
      </div>
    {/if}

    {#if source === 'mic' && (!running || !hasData)}
      <div class="overlay">
        {#if starting}
          <p>正在请求麦克风权限…</p>
        {:else if running}
          <p>正在缓冲 {buffered.toFixed(1)}s…</p>
        {:else}
          <p>点击「开始」授权麦克风</p>
          <p class="hint">地址栏会弹出权限请求，选择「允许」</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if source === 'file' && fileName}
    <div class="filebar">
      <span class="fname" title={fileName}>{fileName}</span>
      <span class="fmeta">
        {formatTime(fileInfo.seconds)} · {fileInfo.columns} 列 · {fileInfo.sampleRate} Hz ·
        {fileInfo.channels} 声道 · 分析占用 {(fileInfo.kb / 1024).toFixed(1)} MB
      </span>
      {#if fileUrl}
        <audio
    bind:this={audioEl}
    src={fileUrl}
    controls
    onloadedmetadata={(e) => {
      const d = (e.currentTarget as HTMLAudioElement).duration
      fileDuration = Number.isFinite(d) ? d : 0
    }}
    onplay={() => (audioPlaying = true)}
    onpause={() => (audioPlaying = false)}
    onended={() => {
      audioPlaying = false
      playPos = 0
    }}
    ontimeupdate={(e) => {
      playPos = (e.currentTarget as HTMLAudioElement).currentTime
      playhead = playheadAt(playPos)
      detectionVersion++
    }}
  ></audio>
      {/if}
    </div>
  {/if}

  <div class="panel">
    <button type="button" class="primary" class:stop={running} disabled={starting} onclick={toggle}>
      {running ? '停止' : starting ? '请求权限中…' : '开始'}
    </button>

    <button type="button" class="ghost" onclick={() => fileInput?.click()} disabled={analyzing}>
      {analyzing ? `分析中 ${Math.round(analyzeProgress * 100)}%` : '选择音频文件'}
    </button>

    <input
      type="file"
      accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm"
      bind:this={fileInput}
      onchange={onFileChosen}
      hidden
    />

    <label class="field">
      <span>灵敏度 <b>{gainDb} dB</b></span>
      <input type="range" min="0" max="60" step="1" bind:value={gainDb} />
    </label>

    <label class="field" class:dim={source === 'file'}>
      <span>整体延迟 <b>{delay.toFixed(2)}s</b></span>
      <input
        type="range"
        min="0.1"
        max="3"
        step="0.05"
        bind:value={delay}
        disabled={source === 'file'}
      />
    </label>

    <label class="field">
      <span>能量纵轴刻度</span>
      <select bind:value={scaleMode}>
        <option value="db">dB（推荐）</option>
        <option value="sqrt">平方根</option>
        <option value="linear">线性（0 到无穷）</option>
      </select>
    </label>
  </div>

  {#if errorText}
    <p class="error">{errorText}</p>
  {/if}

  {#if fileError}
    <p class="error">{fileError}</p>
  {/if}

  <section class="score">
    <div class="score-head">
      <h2>能量记录</h2>
      <p class="score-stats">
        已记录 {logSeconds.toFixed(1)}s · {logCount} 个读数 · {(logBytes / 1024).toFixed(0)} KB ·
        共 {scoreRowTotal} 行
      </p>
    </div>

    <div class="score-controls">
      <label class="field">
        <span>速度 <b>{bpm} BPM</b></span>
        <input type="range" min="40" max="220" step="1" bind:value={bpm} />
      </label>

      <label class="field">
        <span>拍号 <b>{beatsPerBar}/{beatUnit}</b></span>
        <span class="meter-row">
          <input type="number" min="1" max="16" step="1" bind:value={beatsPerBar} />
          <span>/</span>
          <select bind:value={beatUnit}>
            <option value={2}>2</option>
            <option value={4}>4</option>
            <option value={8}>8</option>
            <option value={16}>16</option>
          </select>
        </span>
      </label>

      <label class="field">
        <span>每行小节数 <b>{barsPerRow}</b></span>
        <input type="range" min="1" max="16" step="1" bind:value={barsPerRow} />
      </label>

      <div class="field">
        <span>每小节 <b>{scoreLayout.barSeconds.toFixed(3)}s</b></span>
        <span class="hint">
          每拍 {scoreLayout.beatSeconds.toFixed(3)}s · 每行 {scoreLayout.rowSeconds.toFixed(1)}s
        </span>
      </div>

      <button type="button" class="ghost" onclick={clearLogOrUnload} disabled={logCount === 0}>
        {source === 'file' ? '移除文件' : '清空记录'}
      </button>
    </div>

    <div class="score-scroll">
      <canvas bind:this={scoreCanvas}></canvas>
      {#if scoreRowTotal === 0}
        <p class="score-empty">
          还没有记录。点上面的「开始」，放歌给麦克风听，每 10.7ms 会自动记一个读数。
        </p>
      {/if}
    </div>

    <p class="hint">
      横轴 = 行内时间（亮线是小节线，暗线是拍线）· 纵轴 = 总能量（所有行共用同一满量程）·
      BPM 按拍号分母的时值计：{beatsPerBar}/{beatUnit} 表示以{beatUnit === 4
        ? '四分'
        : beatUnit === 8
          ? '八分'
          : beatUnit === 2
            ? '二分'
            : '十六分'}音符为一拍
    </p>
  </section>
  </div>

  <div class="tabpane" class:active={tab === 'score'}>
  <section class="rhythm">
    <div class="score-head">
      <h2>节奏（{rhythmBars.length} 小节）</h2>
      <p class="score-stats">
        {#if restoredNote}
          <span class="restored" class:bad={draftWarnings.length > 0}>
            已恢复上次存的谱子（{rhythmBars.length} 小节 / {rhythmBars.reduce((a, b) => a + b.length, 0)} 个音）
            {#if draftWarnings.length}· 数据有异常{/if}
          </span>
        {/if}
        <label class="sig-pick">
          拍号
          <select
            value="{beatsPerBar}/{beatUnit}"
            title="改拍号会影响每小节容量、连桁分组、简谱破折号和导出的 MusicXML"
            onchange={(e) => {
              const [b, u] = e.currentTarget.value.split('/').map(Number)
              if (b > 0 && u > 0) {
                beatsPerBar = b
                beatUnit = u
              }
            }}
          >
            {#each TIME_SIGNATURES as ts (ts.beats + '/' + ts.unit)}
              <option value="{ts.beats}/{ts.unit}">{ts.beats}/{ts.unit}</option>
            {/each}
          </select>
        </label>
        · 一小节 {beatsPerBar} 拍（{beatUnit === 4
          ? '四分'
          : beatUnit === 8
            ? '八分'
            : beatUnit === 2
              ? '二分'
              : '十六分'}音符记 1 拍）· 当前第 {activeBar + 1} 小节
      </p>
    </div>

    <div class="rhythm-bars">
      {#each rhythmBars as _bar, i (i)}
        <button
          type="button"
          class="bar-btn"
          class:active={activeBar === i}
          class:pickup={rhythmChecks[i]?.status === 'pickup'}
          class:bad={rhythmChecks[i]?.status === 'long'}
          onclick={() => (activeBar = i)}
        >
          <b>第 {i + 1} 小节</b>
          <span>{beats(barTotal(rhythmBars[i]))} / {beatsPerBar} 拍</span>
        </button>
      {/each}
    </div>

    <div class="entry-bar">
      <span class="entry-cur">
        当前时值
        <b>{DURATIONS.find((d) => d.id === entryDuration)?.label ?? '四分'}</b>
        · 八度 <b>C{entryOctave}</b>
        {#if accidental !== 0}
          · 待用<b>{accidental > 0 ? '升号 ♯' : '降号 ♭'}</b>
        {/if}
        {#if tabPick}
          · 已选<b>第 {tabPick.string} 弦</b>
          {#if fretBuf !== ''}
            · 品位 <b>{fretBuf}</b>（<b>空格</b>加入和弦 · <b>回车</b>落谱）
          {:else}· 按数字键输入品位{/if}
        {/if}
        {#if pendingChord.length}
          · 和弦已有 <b>{pendingChord.length}</b> 个音:{pendingChord
            .map((p) => ' ' + p.string + '弦' + p.fret + '品')
            .join('、')}
        {/if}
      </span>
      <span class="entry-keys">
        键盘：<code>1</code>~<code>5</code> 时值 · <code>A</code>~<code>G</code> 音名 ·
        <code>Z</code>/<code>X</code> 降/升八度 · <code>.</code> 附点 · <code>R</code> 休止 ·
        <code>空格</code> 加入和弦 · <code>回车</code> 落谱 ·
        <code>↑</code><code>↓</code> 半音 · <code>退格</code> 撤销
      </span>
    </div>

    <div class="rhythm-pad">
      {#each durationIcons as ic (ic.id)}
        <button
          type="button"
          class="note-btn glyph-btn"
          class:on={entryDuration === ic.id}
          onclick={() => {
            // ★ 点按钮**只改当前时值** —— 绝不往里插音符 ✓✓
            //
            // 用户明确要求："不要我一用鼠标切换时值就往里面输入，等待我按键盘输入" ✓
            // 这里原来还有一句 commitFret()（把待输入的品位落下去），
            // 结果"选了弦 + 打了品位 + 再点时值"就会插一个音符进来 ✗ 已经去掉 ✓
            //
            // 现在走 setDuration：**有选区就改选中的那些** ✓
            // 没选区才改"接下来要输入的"时值 ✓ —— 和文本编辑器一样 ✓
            setDuration(ic.id)
          }}
          title="{ic.label}音符"
          aria-label="{ic.label}音符"
        >
          <svg viewBox={ic.viewBox} aria-hidden="true">
            {#each ic.paths as p, k (k)}
              {#if p.filled}
                <path d={p.d} fill="currentColor"></path>
              {:else}
                <path d={p.d} fill="none" stroke="currentColor" stroke-width={p.width}></path>
              {/if}
            {/each}
          </svg>
        </button>
      {/each}
      <span class="pad-sep"></span>
      <span class="pad-sep"></span>
      <button
        type="button"
        class="note-btn mod acc"
        class:on={accidental === -1}
        onclick={() => (accidental = accidental === -1 ? 0 : -1)}
        title="下一个音带降号（快捷键 -）"
      >
        ♭ 降号
      </button>
      <button
        type="button"
        class="note-btn mod acc"
        class:on={accidental === 0}
        onclick={() => (accidental = 0)}
        title="还原（不打升降号）"
      >
        ♮ 还原
      </button>
      <button
        type="button"
        class="note-btn mod acc"
        class:on={accidental === 1}
        onclick={() => (accidental = accidental === 1 ? 0 : 1)}
        title="下一个音带升号（快捷键 = 或 +）"
      >
        ♯ 升号
      </button>
      <span class="pad-sep"></span>
      <label class="key-pick">
        记谱
        <select bind:value={notationMode} title="六线谱模式下可以点弦线输入品位">
          <option value="staff-tab">五线谱 + 六线谱</option>
          <option value="tab">只有六线谱</option>
          <option value="both">五线谱 + 简谱</option>
        </select>
      </label>
      <span class="pad-sep"></span>
      <label class="key-pick">
        调弦
        <select value={tuning.id} onchange={(e) => pickTuning(e.currentTarget.value)}>
          {#each TUNING_PRESETS as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          {#if tuning.id === 'custom'}<option value="custom">自定义</option>{/if}
        </select>
      </label>
      <label class="key-pick" title="变调夹夹在第几品 —— 六根弦一起升高">
        变调夹
        <input
          type="number"
          min="0"
          max="12"
          value={tuning.capo}
          oninput={(e) =>
            (tuning = {
              ...tuning,
              // 取整 —— 解析端要求变调夹必须是整数 ✓ 我们自己写出去的就得先保证合法 ✓
              capo: Math.max(0, Math.min(12, Math.round(Number(e.currentTarget.value) || 0)))
            })}
        />
        品
      </label>
      <span class="pad-sep"></span>
      <label class="key-pick">
        调号
        <select
          bind:value={keySignature}
          title="决定五线谱上画几个升/降号，也决定导出 MusicXML 的调号"
        >
          {#each KEY_OPTIONS as k (k.label)}
            <option value={k.sig}>{k.label}</option>
          {/each}
        </select>
      </label>
      <span class="pad-sep"></span>
      <button
        type="button"
        class="note-btn mod"
        class:on={dotNext}
        onclick={() => (dotNext = !dotNext)}
      >
        附点
      </button>
      <button
        type="button"
        class="note-btn mod"
        class:on={restNext}
        onclick={() => (restNext = !restNext)}
      >
        休止
      </button>
      <button type="button" class="note-btn" onclick={undoNote}>退格</button>
      <button type="button" class="note-btn" onclick={clearRhythm}>清空</button>
      <button
        type="button"
        class="note-btn"
        onclick={exportMusicXml}
        title="导出为 MusicXML —— MuseScore / Finale / Sibelius / Dorico 都能直接打开"
      >导出 MusicXML</button>
      <button type="button" class="note-btn" onclick={() => importInput?.click()}>导入 MusicXML</button>
      <input
        type="file"
        accept=".musicxml,.xml,application/vnd.recordare.musicxml+xml,text/xml,application/xml"
        bind:this={importInput}
        onchange={onImportFile}
        hidden
      />
      <span class="pad-sep"></span>
      <button type="button" class="note-btn" onclick={addBar}>＋小节</button>
      <button type="button" class="note-btn" onclick={removeBar}>－小节</button>
    </div>

    <div class="string-editor">
      <span class="se-label">逐弦空弦音（想只改某几根弦就改这里）：</span>
      {#each [6, 5, 4, 3, 2, 1] as s (s)}
        <label class="se-item">
          <span>{s} 弦</span>
          <input
            type="number"
            min="12"
            max="96"
            value={tuning.open[s - 1]}
            title="MIDI 音符号：60 = C4，40 = 低音 E"
            oninput={(e) => setStringOpen(s, Number(e.currentTarget.value) || tuning.open[s - 1])}
          />
          <em>{midiName(tuning.open[s - 1] + tuning.capo)}</em>
        </label>
      {/each}
    </div>

    <div class="rhythm-scroll">
      <canvas
        bind:this={rhythmCanvas}
        onpointerdown={onRhythmPointerDown}
        onpointermove={onRhythmPointerMove}
        onpointerup={onRhythmPointerUp}
        onpointercancel={onRhythmPointerUp}
        class:tab-cursor={tabPick !== null}
        title="点弦线选中它再按数字键打品号；拖过几个符头可以选中它们，然后改时值或删除"></canvas>
    </div>

    <p class="rhythm-msg" class:ok={rhythmOk}>
      {#each rhythmChecks as c (c.index)}
        <span>{c.message}</span>
      {/each}
    </p>

    <p class="import-hint">
      <b>导入要什么文件？</b> 用 <b>MusicXML</b>（扩展名 <code>.musicxml</code> 或 <code>.xml</code>）——
      这是 MuseScore、Sibelius、Finale、Dorico 通用的交换格式。
      在 MuseScore 里选「<b>文件 → 导出 → MusicXML</b>」即可。
      只读第 1 声部：和弦、装饰音、其它声部会被跳过并如实告知。
    </p>
    {#if importMsg}
      <p class="import-msg" class:bad={importBad}>
        {#if importName}<span class="fname">{importName}</span>{/if}
        {importMsg}
      </p>
    {/if}

    {#if draftWarnings.length}
      <p class="draft-warn">
        ⚠️ 从本地草稿恢复时发现异常：{draftWarnings.join("、")}。
        数据没有被丢弃，但可能不是你想要的样子 ——
        如果确实乱了，点「清空」重新录，或者用「导入 MusicXML」载入之前导出的备份。
      </p>
    {/if}

    <div class="entry-help">
      <h3>怎么录</h3>
      <ol class="help-steps">
        <li><b>先选时值</b> —— 按 <code>1</code><code>2</code><code>3</code><code>4</code><code>5</code>
          （全 / 二分 / 四分 / 八分 / 十六分），或直接点上面的音符按钮。</li>
        <li><b>再打音名</b> —— 按 <code>A</code>~<code>G</code>，音符就落在<b>当前八度</b>上。</li>
        <li><b>八度不对就换</b> —— <code>Z</code> 降一个八度，<code>X</code> 升一个八度。</li>
        <li><b>六线谱上按和弦</b> —— 点最下面那根弦，打品格数，按<b>空格</b>（这个音就显示出来，并自动跳到下一根弦），
          继续按其它弦；最后按<b>回车</b>把整个和弦落成<b>一个时间点</b>。和弦音<b>不占额外时值</b>。</li>
        <li><b>要黑键就加升降号</b> —— 按 <code>-</code> 是降号 <b>♭</b>，按 <code>=</code>（或 <code>+</code>）是升号 <b>♯</b>，
          再按一次回到还原 <b>♮</b>；也可以直接点上面的「♭ 降号 / ♮ 还原 / ♯ 升号」。
          升降号是<b>一次性</b>的，只作用于下一个音。</li>
      </ol>

      <p class="octave-now">
        当前八度 <b>C{entryOctave}</b>，现在按 A~G 会依次得到：
        {#each octaveNotes as n, i (n.key)}<span class="pk">{n.key}</span><span class="parrow">→</span><span class="pn">{n.name}</span>{#if i < octaveNotes.length - 1}<span class="psep">·</span>{/if}{/each}
      </p>

      <p class="entry-example">
        <b>例</b>：要输入 <b>G3</b>，先按 <code>Z</code> 让八度变成 C3，再按 <code>G</code>；
        要输入 <b>C5</b>，按 <code>X</code> 让八度变成 C5，再按 <code>C</code>。
        按错了用 <code>退格</code> 撤销，或按 <code>↑</code><code>↓</code> 把刚输入的音升降半音（用来补升号/降号）。
      </p>

      <p class="entry-misc">
        <b>鼠标只负责选，不负责写</b>：点时值按钮只改"下一个音多长"，点六线谱的弦线只选"往哪根弦写"，
        <b>都不会插音符</b>。真正的输入一律等你按键 —— 打音名、或者打品位再回车 ✓
      </p>

      <p class="entry-misc">
        <b>调号</b>选了几个升/降号，五线谱上就会画出几个 ♯ / ♭（位置按记谱法规定），
        导出 MusicXML 时也写进 <code>&lt;fifths&gt;</code>，MuseScore 打开就是同一个调。
        它不是硬限制：分析时调到调外的音照样认得出来，只是权重低一些。
      </p>

      <p class="entry-misc">
        其它：<code>.</code> 附点 · <code>R</code>（或 <code>0</code>）休止 · <code>空格</code> 播放/暂停 ·
        小节满了会自动跳到下一小节 ·「＋小节 / －小节」调整小节数。
        <b>第 1 小节</b>（弱起）和<b>最后一个小节</b>允许不满，中间的小节必须正好填满。
      </p>
    </div>
  </section>
  </div>

  <div class="tabpane" class:active={tab === 'analyze'}>
  <section class="detect">
    {@render playbar()}

    <div class="score-head">
      <h2>演奏检测</h2>
      <p class="score-stats">按总能量峰值 + 各音带的能量突变找演奏起点，并识别音名</p>
    </div>

    <div class="detect-bar">
      <div class="fold-row">
        <label class="fold-toggle">
          <input type="checkbox" bind:checked={useFold} />
          循环折叠检测
        </label>
        <label class="fold-period">
          一遍时长
          <input type="number" min="0" step="0.01" bind:value={loopPeriod} />
          秒
        </label>
        <span class="fold-tip">把同一段弹 2 遍以上；填 0 会从数据里自动估</span>
      </div>

      <button type="button" class="detect-btn" onclick={runDetection}>检测起点</button>

      {#if perfStart}
        <span
          class="start-chip"
          class:manual={perfStartManual != null}
          title={'绝对判断：能量连续超过底噪门槛才算开始。它之前的波动一律不算起点。椅子的咯吱声在声学上和弹一个低音是一样的（成谐波、不归零、能持续），所以判据一定会误判 —— 点这里可以手动指定'}
        >
          起奏 <b>{(perfStartManual ?? perfStart.time).toFixed(2)}s</b>
          {#if perfStartManual != null}<em>手动</em>{/if}
          <em>底噪 {perfStart.floorDb.toFixed(0)}dB → 抬升 {perfStart.riseDb.toFixed(0)}dB</em>
        </span>
      {/if}

      <label class="detect-pick">
        乐器
        <select bind:value={instrumentId}>
          <option value="all">不限定（全部音域）</option>
          {#each INSTRUMENTS as ins (ins.id)}
            <option value={ins.id}>{ins.name}</option>
          {/each}
        </select>
      </label>

      <label class="detect-pick">
        调号
        <select bind:value={keySignature}>
          {#each KEY_OPTIONS as k (k.label)}
            <option value={k.sig}>{k.label}</option>
          {/each}
        </select>
      </label>

      <button type="button" class="note-btn" class:on={showRef} onclick={() => (showRef = !showRef)}>
        音高频率表
      </button>
    </div>

    <p class="detect-msg key-hint">{keyHint}</p>

    {#if foldNote}
      <p class="detect-msg fold-note">{foldNote}</p>
    {/if}

    {#if detectMessage}
      <p class="detect-msg">{detectMessage}</p>
    {/if}

    {#if detectedReps.length > 1}
      <div class="rep-pick">
        <p class="rep-head">
          这段弹了几遍？程序按 F1 自动挑了 <b>{detectedRepsUsed} 遍</b> —— 不对就点下面的。
          遍数选错会连带把速度算错（少算一遍，速度就会慢一半左右）。
        </p>
        <div class="rep-row">
          <button
            type="button"
            class="rep-chip"
            class:on={forcedReps === 0}
            onclick={() => {
              forcedReps = 0
              runDetection()
            }}
          >
            <b>自动</b>
            <span>　</span>
            <i>　</i>
          </button>
          {#each detectedReps as r (r.rep)}
            <button
              type="button"
              class="rep-chip"
              class:on={forcedReps === r.rep}
              onclick={() => {
                forcedReps = r.rep
                runDetection()
              }}
            >
              <b>{r.rep} 遍</b>
              <span>{r.bpm.toFixed(0)} BPM</span>
              <i>对上 {r.matches}/{r.expected} · F1 {r.f1.toFixed(2)}</i>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if showRef}
      <div class="ref">
        <p class="ref-head">
          音高频率参考 · 当前乐器 <b>{instrument.name}</b>（{midiName(instrument.minMidi)} ~ {midiName(instrument.maxMidi)}）
        </p>
        <div class="ref-scroll">
          <table>
            <thead>
              <tr>
                <th>八度</th>
                {#each ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as n (n)}
                  <th>{n}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each refRows as row (row.octave)}
                <tr>
                  <td class="oct">C{row.octave}</td>
                  {#each row.cells as midi, k (k)}
                    {#if midi === null}
                      <td class="out">·</td>
                    {:else}
                      <td><b>{midiToFreq(midi).toFixed(1)}</b></td>
                    {/if}
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="ref-foot">
          从 <code>A4 = 440Hz</code> 按十二平均律算出来。低频区分辨不出半音，会合并成音组。
        </p>
      </div>
    {/if}

      <!-- 能量图上方显示五线谱：对着起伏就能看出是哪个音 -->
      <div class="score-preview">
        <div class="preview-label">谱面（和「录入谱子」里的一致）</div>
        <div class="preview-scroll">
          <canvas bind:this={scorePreviewCanvas}></canvas>
        </div>
      </div>

    {#if hasDetection}
      <div class="detect-stats">
        <div>
          <span>检出起点</span>
          <b>{detectStats.onsets} 个</b>
        </div>
        <div>
          <span>对上期望音</span>
          <b>{detectStats.matched} / {detectStats.expected}</b>
        </div>
        <div>
          <span>多打</span>
          <b>{detectStats.extras} 个</b>
        </div>
        <div>
          <span>实测速度</span>
          <b class="big">{detectStats.bpm.toFixed(1)}</b>
        </div>
        <div>
          <span>平均偏差</span>
          <b>{detectStats.meanMs.toFixed(0)} ms</b>
        </div>
        <div>
          <span>最大偏差</span>
          <b>{detectStats.maxMs.toFixed(0)} ms</b>
        </div>
      </div>

      {#if tempoMismatch}
        <div class="tempo-sync" class:off={!tempoMismatch}>
          <span>
            谱面标的是 <b>{bpm} BPM</b>，实测是 <b class="ok">{detectStats.bpm.toFixed(1)} BPM</b> ——
            对不上的话按实测的来更准。
          </span>
          <button type="button" class="ghost small" onclick={applyMeasuredTempo}>
            按实测速度改谱面
          </button>
        </div>
      {/if}

      <div class="detect-scroll">
        <canvas bind:this={detectionCanvas} onclick={onDetectionClick}></canvas>
      </div>

      <!-- 检测出来的音名撤掉了：识别不准，展示只会误导（见 detectionView.ts 的说明）-->
    {/if}

    {#if recording}
      <div class="playback">
        <p class="playback-head">
          上次的录音还留着（<b>{recording.seconds.toFixed(1)}s</b> ·
          <b>{(recording.bytes / 1024).toFixed(0)} KB</b>）
        </p>
        <!-- 播放按钮已经搬到顶部吸顶了 ✓ 这个元素留着只为了有 audio 对象可控制 -->
        <audio
          bind:this={recAudioEl}
          src={recording.url}
          onplay={() => (audioPlaying = true)}
          onpause={() => (audioPlaying = false)}
          onended={() => {
            audioPlaying = false
            playPos = 0
          }}
          ontimeupdate={(e) => {
            playPos = (e.currentTarget as HTMLAudioElement).currentTime
            playhead = playheadAt(playPos)
            detectionVersion++
          }}
        ></audio>
        <p class="playback-pos">
          录音位置 <b>{playPos.toFixed(2)}s</b> ＝ 图上同一时刻（检测图的横轴就是真实时间，没有偏移）
        </p>
        <div>
          <a
            class="note-btn"
            href={recording.url}
            download={`beatlooker-recording.${extensionFor(recording.mimeType)}`}
          >
            下载录音
          </a>
          <button type="button" class="note-btn" onclick={clearRecording}>清掉录音</button>
        </div>
      </div>
    {/if}
  </section>
  </div>
</main>

<style>
/**
 * 兜底配色 = **纸白（浅色）**。
 *
 * 这里的值必须和 theme.ts 里 DEFAULT_THEME_ID 那一套保持一致 ✗
 * 因为它是"JS 还没跑"时的状态 ✓ 不一致的话刷新瞬间会闪一下别的颜色 ✓
 *
 * ⚠️ 这里原来是 --panel:var(--panel) 这种**自引用** ✗
 * 是上一轮把颜色换成变量时误伤的 —— 自引用等于没定义 ✓
 * 再加上 color-scheme:dark，JS 执行前整个页面就是深色的 ✓
 */
:global(:root) {
  --bg:#f4f4f2;
  --panel:#ffffff;
  --panel-2:#eaeaea;
  --panel-3:#f2f2f6;
  --ghost:#ececf2;
  --stage-bg:#fbfbf9;
  --line:#d6d6de;
  --text:#1a1a22;
  --text-2:#3a3a48;
  --muted:#6a6a7a;
  --muted-2:#74748a;
  --fg-dim:#4a4a5a;
  --dim2:#6e6e80;
  --accent:#0e7490;
  --accent-2:#0369a1;
  --brand:#5b4bd6;
  --ok:#047857;
  --warn:#b91c1c;
  --onset:#b45309;
  --axis-fg:rgba(38,44,58,0.92);
  --axis-shadow:0 0 4px rgba(255,255,255,0.95);
  --energy-axis-fg:rgba(12,90,120,0.95);
  --tag-fg:rgba(38,44,58,0.72);
  --badge-bg:#7c3aed1f;
  --badge-fg:#5b21b6;
  --btn-hover:#e8e8f0;
  --btn-on:#dfe6ff;
  --sans:system-ui, -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
  --mono:ui-monospace, SFMono-Regular, Consolas, monospace;
  --lightningcss-light: ;
  --lightningcss-dark:initial;
  color-scheme:light;
  font-family:var(--sans);
  color:var(--text);
  background:var(--bg);
  -webkit-font-smoothing:antialiased}
:global(*) {
  box-sizing:border-box}
:global(body) {
  background:var(--bg);
  min-height:100vh;
  margin:0}
main {
  flex-direction:column;
  gap:16px;
  max-width:1000px;
  margin:0 auto;
  padding:24px 20px 40px;
  display:flex}
header h1 {
  letter-spacing:.3px;
  margin:0;
  font-size:22px;
  font-weight:650}
header h1 span {
  color:var(--badge-fg);
  vertical-align:middle;
  background:var(--badge-bg);
  border:1px solid var(--brand);
  border-radius:999px;
  margin-left:8px;
  padding:2px 8px;
  font-size:12px;
  font-weight:500}
.sub {
  color:var(--muted);
  margin:6px 0 0;
  font-size:13px}
.stage {
  border:1px solid var(--line);
  background:var(--stage-bg);
  border-radius:14px;
  height:560px;
  position:relative;
  overflow:hidden}
canvas {
  width:100%;
  height:100%;
  display:block}
.axis {
  pointer-events:none;
  position:absolute;
  inset:0}
.axis span {
  font:10px/1 var(--mono);
  /* 原来是写死的浅灰 + 黑色阴影：深色底勉强能看，浅色底直接糊掉 */
  color:var(--axis-fg);
  text-shadow:var(--axis-shadow);
  position:absolute;
  left:7px;
  transform:translateY(-50%)}
.energy-axis {
  pointer-events:none;
  position:absolute;
  left:0;
  right:0}
.energy-axis span {
  font:10px/1 var(--mono);
  color:var(--energy-axis-fg);
  text-shadow:var(--axis-shadow);
  position:absolute;
  left:7px;
  transform:translateY(-50%)}
.panel-tag {
  font:10px/1 var(--mono);
  color:var(--tag-fg);
  text-shadow:var(--axis-shadow);
  pointer-events:none;
  position:absolute;
  right:12px}
.hud,.overlay {
  position:absolute}
.hud {
  font:11px/1 var(--mono);
  color:var(--text)b3;
  background:var(--stage-bg)a6;
  border:1px solid var(--line);
  border-radius:999px;
  flex-wrap:wrap;
  gap:12px;
  padding:6px 10px;
  display:flex;
  top:10px;
  right:12px}
.overlay {
  text-align:center;
  color:var(--muted);
  pointer-events:none;
  flex-direction:column;
  justify-content:center;
  align-items:center;
  gap:8px;
  padding:24px;
  font-size:14px;
  display:flex;
  inset:0}
.overlay p {
  margin:0;
  line-height:1.6}
.overlay .hint {
  opacity:.7;
  font-size:12px}
.panel {
  border:1px solid var(--line);
  background:linear-gradient(180deg, var(--panel), var(--panel-2));
  border-radius:14px;
  flex-wrap:wrap;
  align-items:flex-end;
  gap:16px 24px;
  padding:14px 16px;
  display:flex}
.primary {
  appearance:none;
  cursor:pointer;
  color:#fff;
  background:linear-gradient(135deg,#7c3aed,var(--accent));
  border:0;
  border-radius:11px;
  min-width:120px;
  padding:11px 22px;
  font-size:15px;
  font-weight:600}
.primary:disabled {
  opacity:.6;
  cursor:progress}
.primary.stop {
  background:linear-gradient(135deg,#ef4444,#f97316)}
.field {
  color:var(--muted);
  flex-direction:column;
  gap:8px;
  font-size:12px;
  display:flex}
.field select {
  appearance:none;
  border:1px solid var(--line);
  color:var(--text);
  background:var(--ghost);
  border-radius:9px;
  padding:7px 12px;
  font-size:13px}
.field b {
  color:var(--accent);
  font-variant-numeric:tabular-nums;
  font-weight:600}
input[type=range] {
  appearance:none;
  cursor:pointer;
  background:0 0;
  width:200px;
  height:20px}
input[type=range]::-webkit-slider-runnable-track {
  background:linear-gradient(90deg,var(--accent),var(--brand));
  border-radius:999px;
  height:4px}
input[type=range]::-webkit-slider-thumb {
  -webkit-appearance:none;
  background:#fff;
  border-radius:50%;
  width:16px;
  height:16px;
  margin-top:-6px}
input[type=range]::-moz-range-track {
  background:linear-gradient(90deg,var(--accent),var(--brand));
  border-radius:999px;
  height:4px}
input[type=range]::-moz-range-thumb {
  background:#fff;
  border:0;
  border-radius:50%;
  width:16px;
  height:16px}
.score {
  border:1px solid var(--line);
  background:linear-gradient(180deg, var(--panel), var(--panel-2));
  border-radius:14px;
  flex-direction:column;
  gap:12px;
  padding:16px;
  display:flex}
/* ---------------- 吸顶播放条 ---------------- */
/* ---- 能量图上的时刻标记 ---- */
/* 透明按钮层：盖住整个画布，负责接收点击（用 button 而不是给 div 挂监听 ✓ 见模板里的说明）*/
.mark-layer {
  position:absolute;
  inset:0;
  z-index:6;
  cursor:crosshair;
  background:none;
  border:0;
  padding:0}
.mark-layer:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:-3px}
.mark-line {
  position:absolute;
  top:0;
  bottom:0;
  z-index:7;
  pointer-events:none;
  background:var(--accent);
  width:2px;
  transform:translateX(-1px)}
.mark-tag {
  position:absolute;
  top:6px;
  z-index:8;
  pointer-events:none;
  white-space:nowrap;
  font:11px/1 var(--mono);
  color:#fff;
  background:var(--accent);
  border-radius:5px;
  padding:4px 7px;
  transform:translateX(-50%)}
.mark-tag span {
  opacity:.85;
  margin-left:6px}

.playbar {
  border:1px solid var(--line);
  background:var(--panel);
  box-shadow:0 6px 18px #00000022;
  border-radius:12px;
  align-items:center;
  gap:10px;
  margin:0 0 12px;
  padding:8px 12px;
  display:flex;
  position:sticky;
  top:8px;
  z-index:20}
.playbar.playing {
  border-color:var(--accent-2)}
.playbtn {
  border:0;
  background:var(--brand);
  color:#fff;
  cursor:pointer;
  border-radius:50%;
  flex:none;
  width:38px;
  height:38px;
  font:14px/1 var(--sans)}
.playbtn:hover {
  filter:brightness(1.12)}
.skipbtn {
  border:1px solid var(--line);
  background:var(--ghost);
  color:var(--muted);
  cursor:pointer;
  border-radius:6px;
  flex:none;
  padding:6px 8px;
  font:11px var(--mono)}
.skipbtn:hover {
  color:var(--text);
  border-color:var(--brand)}
.seek {
  accent-color:var(--brand);
  flex:1;
  min-width:90px}
.playtime {
  color:var(--muted);
  flex:none;
  font:12px var(--mono)}
.playtime b {
  color:var(--accent-2)}
.playhint {
  color:var(--muted-2);
  flex:none;
  font:11px var(--mono)}
/* ---------------- 分析图上方的五线谱 ---------------- */
.score-preview {
  /* 贴合内容：画布宽度是按小节数算的，别让外框空一大截 */
  width:fit-content;
  max-width:100%;
  border:1px solid var(--line);
  background:var(--stage-bg);
  border-radius:10px;
  margin:0 0 12px;
  padding:4px 0 0}
.preview-label {
  color:var(--muted);
  padding:2px 10px 4px;
  font:11px var(--mono)}
.preview-scroll {
  overflow-x:auto}
.score-head {
  flex-wrap:wrap;
  justify-content:space-between;
  align-items:baseline;
  gap:10px;
  display:flex}
.score-head h2 {
  margin:0;
  font-size:15px;
  font-weight:650}
.score-stats {
  font:11px/1 var(--mono);
  color:var(--muted);
  margin:0}
.score-controls {
  flex-wrap:wrap;
  align-items:flex-end;
  gap:14px 20px;
  display:flex}
.meter-row {
  color:var(--muted);
  align-items:center;
  gap:6px;
  font-size:12px;
  display:flex}
.meter-row input[type=number],.meter-row select {
  appearance:none;
  border:1px solid var(--line);
  width:60px;
  color:var(--text);
  font-family:var(--mono);
  text-align:center;
  background:var(--ghost);
  border-radius:8px;
  padding:5px 8px;
  font-size:13px}
.ghost {
  appearance:none;
  border:1px solid var(--line);
  color:var(--text);
  cursor:pointer;
  background:0 0;
  border-radius:10px;
  padding:9px 16px;
  font-size:13px}
.ghost:disabled {
  opacity:.4;
  cursor:default}
.score-scroll {
  border:1px solid var(--line);
  background:var(--stage-bg);
  border-radius:10px;
  max-height:520px;
  position:relative;
  overflow-y:auto}
.score-scroll canvas {
  width:100%;
  display:block}
.rhythm,.detect {
  border:1px solid var(--line);
  background:linear-gradient(180deg, var(--panel), var(--panel-2));
  border-radius:14px;
  padding:16px}
.rhythm-bars {
  gap:8px;
  margin:12px 0 10px;
  display:flex}
.bar-btn {
  border:1px solid var(--line);
  color:var(--fg-dim);
  text-align:left;
  cursor:pointer;
  background:var(--panel-2);
  border-radius:8px;
  flex-direction:column;
  flex:1;
  gap:3px;
  padding:8px 10px;
  font:12px/1.3 inherit;
  display:flex}
.bar-btn b {
  font:600 13px/1.2 var(--mono);
  color:var(--text)}
.bar-btn.active {
  color:var(--text-2);
  background:var(--panel-2);
  border-color:var(--brand)}
.bar-btn.pickup b {
  color:var(--muted)}
.bar-btn.bad {
  border-color:var(--warn)}
.bar-btn.bad b {
  color:var(--warn)}
.rhythm-pad {
  flex-wrap:wrap;
  align-items:stretch;
  gap:8px;
  margin-bottom:12px;
  display:flex}
.note-btn {
  border:1px solid var(--line);
  color:var(--text-2);
  cursor:pointer;
  background:var(--ghost);
  border-radius:8px;
  min-width:56px;
  padding:9px 12px;
  font:13px/1 inherit}
.note-btn:hover {
  /* 原来是写死的深色 —— 浅色主题下按钮一悬停就变黑 */
  background:var(--btn-hover);
  border-color:var(--brand)}
.note-btn.mod.on {
  color:var(--text-2);
  /* 同上：原来是写死的深紫，浅色下"选中就变黑块" */
  background:var(--btn-on);
  border-color:var(--brand)}
.pad-sep {
  background:var(--line);
  width:1px;
  margin:2px 4px}
.rhythm canvas {
  border:1px solid var(--line);
  background:var(--stage-bg);
  border-radius:10px;
  width:100%;
  display:block}
.rhythm-msg {
  font:12px/1.6 var(--mono);
  color:var(--warn);
  margin:10px 0 0}
.rhythm-msg.ok {
  color:var(--ok)}
.restored {
  color:var(--brand)}
.detect-bar {
  align-items:center;
  flex-wrap:wrap;
  gap:12px;
  margin:12px 0 10px;
  display:flex}

/* 循环折叠那行要独占一行，否则挤着「检测起点」按钮 */
.fold-row {
  flex:1 1 100%}
.fold-row {
  color:var(--fg-dim);
  flex-wrap:wrap;
  align-items:center;
  gap:14px;
  margin:0 0 10px;
  font-size:13px;
  display:flex}
.fold-toggle,.fold-period {
  cursor:pointer;
  align-items:center;
  gap:6px;
  display:inline-flex}
.fold-period input {
  border:1px solid var(--line);
  background:var(--panel);
  width:76px;
  color:var(--fg);
  font:inherit;
  border-radius:6px;
  padding:4px 6px}
.fold-tip {
  opacity:.7}
.fold-note {
  color:var(--ok)}
.key-hint {
  color:var(--muted)}
.tabs {
  border-bottom:1px solid var(--line);
  gap:4px;
  margin:14px 0 0;
  display:flex}
.tabs button {
  color:var(--muted);
  cursor:pointer;
  background:none;
  border:0;
  border-bottom:2px solid transparent;
  margin-bottom:-1px;
  padding:10px 16px;
  font:600 14px/1 var(--sans)}
.tabs button:hover {
  color:var(--text)}
.tabs button.active {
  color:var(--accent-2);
  border-bottom-color:var(--accent-2)}
.tabpane {
  display:none}
.tabpane.active {
  display:block}
.theme-pick {
  float:right;
  align-items:center;
  gap:6px;
  margin-top:6px;
  font:12px/1 var(--mono);
  color:var(--muted);
  display:inline-flex}
.theme-pick select {
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  font:inherit;
  border-radius:6px;
  padding:4px 8px}
.entry-help {
  border-top:1px solid var(--line);
  color:var(--muted);
  margin:16px 0 0;
  padding:14px 0 2px;
  font:13px/1.9 var(--sans)}
.entry-help h3 {
  color:var(--text);
  margin:0 0 8px;
  font:600 13px/1 var(--sans)}
.help-steps {
  margin:0 0 12px;
  padding-left:20px}
.help-steps li {
  margin:2px 0}
.entry-help b {
  color:var(--text)}
.entry-help code {
  background:var(--ghost);
  color:var(--text-2);
  border-radius:3px;
  margin:0 1px;
  padding:1px 6px;
  font:12px var(--mono)}
.octave-now {
  background:var(--badge-bg);
  border-radius:8px;
  margin:0 0 10px;
  padding:9px 12px}
.octave-now b {
  color:var(--accent-2)}
.pk {
  background:var(--ghost);
  color:var(--muted);
  border-radius:3px;
  margin-left:8px;
  padding:1px 5px;
  font:11px var(--mono)}
.parrow {
  color:var(--muted-2);
  margin:0 3px}
.pn {
  background:var(--panel-3);
  color:var(--text);
  border-radius:3px;
  padding:1px 7px;
  font:600 12px var(--mono)}
.psep {
  color:var(--line);
  margin:0 1px}
.entry-example, .entry-misc {
  margin:0 0 8px}
.entry-misc {
  color:var(--muted-2)}
.restored.bad {
  color:var(--warn);
  border-color:var(--warn)}
.draft-warn {
  border-left:3px solid var(--warn);
  background:var(--panel-2);
  color:var(--text-2);
  border-radius:0 6px 6px 0;
  margin:12px 0 0;
  padding:8px 12px;
  font:12px/1.7 var(--sans)}
.import-hint {
  border-left:3px solid var(--accent-2);
  background:var(--panel-2);
  color:var(--muted);
  border-radius:0 6px 6px 0;
  margin:12px 0 0;
  padding:8px 12px;
  font:12px/1.7 var(--sans)}
.import-hint b {
  color:var(--text)}
.import-hint code {
  background:var(--ghost);
  color:var(--text-2);
  border-radius:3px;
  padding:1px 5px;
  font:12px var(--mono)}
.import-msg {
  color:var(--ok);
  margin:8px 0 0;
  font:12px/1.6 var(--mono);
  word-break:break-all}
.import-msg.bad {
  color:var(--warn)}
.import-msg .fname {
  background:var(--ghost);
  border-radius:3px;
  margin-right:6px;
  padding:1px 6px}
.acc {
  min-width:52px}
.key-pick,
.sig-pick {
  color:var(--muted);
  align-items:center;
  gap:6px;
  font:12px var(--mono);
  display:inline-flex}
.sig-pick select {
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  font:inherit;
  border-radius:6px;
  padding:4px 6px}
.key-pick input {
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  width:58px;
  font:inherit;
  border-radius:6px;
  padding:8px 6px;
  text-align:center}
.string-editor {
  flex-wrap:wrap;
  align-items:center;
  gap:10px;
  margin:0 0 10px;
  font:12px var(--mono);
  color:var(--muted);
  display:flex}
.se-label {
  width:100%;
  margin-bottom:-2px}
.se-item {
  border:1px solid var(--line);
  background:var(--ghost);
  border-radius:8px;
  align-items:center;
  gap:5px;
  padding:5px 8px;
  display:inline-flex}
.se-item input {
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  width:52px;
  font:12px var(--mono);
  border-radius:5px;
  padding:3px 4px;
  text-align:center}
.se-item em {
  color:var(--accent-2);
  min-width:26px;
  font:600 12px var(--mono);
  font-style:normal}
.tab-cursor {
  cursor:crosshair}
.key-pick select {
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  font:inherit;
  border-radius:6px;
  padding:8px 8px}
.entry-bar {
  flex-wrap:wrap;
  align-items:center;
  gap:14px;
  margin:10px 0 0;
  font:12px/1.6 var(--mono);
  color:var(--muted);
  display:flex}
.entry-cur b {
  color:var(--accent-2)}
.entry-keys {
  opacity:.9}
.entry-keys code {
  background:var(--ghost);
  color:var(--text-2);
  border-radius:3px;
  padding:1px 5px;
  font:inherit}
.glyph-btn {
  justify-content:center;
  align-items:center;
  width:52px;
  height:46px;
  padding:0;
  display:inline-flex;
  color:var(--text-2)}
.glyph-btn svg {
  height:34px;
  width:auto;
  display:block;
  overflow:visible}
.glyph-btn:hover {
  color:var(--accent-2)}
.glyph-btn.on {
  color:var(--accent-2);
  border-color:var(--accent-2)}
.rhythm-scroll {
  overflow-x:auto;
  margin:0 0 10px}
.rep-pick {
  border:1px solid var(--line);
  background:var(--ghost);
  border-radius:10px;
  margin:0 0 12px;
  padding:10px 12px}
.rep-head {
  font:12px/1.6 var(--mono);
  color:var(--muted);
  margin:0 0 8px}
.rep-head b {
  color:var(--accent-2)}
.rep-row {
  flex-wrap:wrap;
  gap:8px;
  display:flex}
.rep-chip {
  cursor:pointer;
  color:var(--text-2);
  text-align:left;
  background:var(--panel-2);
  border:1px solid var(--line);
  border-radius:8px;
  flex-direction:column;
  gap:2px;
  padding:6px 12px;
  font:11px/1.4 var(--mono);
  display:flex}
.rep-chip:hover {
  border-color:var(--brand)}
.rep-chip.on {
  border-color:var(--accent-2);
  background:var(--panel-2)}
.rep-chip b {
  font-size:13px;
  color:var(--text)}
.rep-chip i {
  color:var(--muted-2);
  font-style:normal}
.start-chip {
  border:1px solid var(--ok);
  background:var(--panel-2);
  color:var(--text-2);
  border-radius:8px;
  align-items:baseline;
  gap:6px;
  padding:7px 10px;
  font:12px var(--mono);
  display:inline-flex}
.start-chip b {
  color:var(--ok);
  font-size:14px}
.start-chip em {
  color:var(--muted);
  font:11px var(--mono);
  font-style:normal}
/* 手动指定过起奏点：换个边框色，一眼知道"这个不是自动的" */
.start-chip.manual {
  border-color:var(--warn-2,var(--accent));}
.start-chip.manual b {
  color:var(--accent)}
/* 开始点竖线的抓手（键盘也能微调 ✓ 见模板） */
.start-grip:focus-visible {
  outline:2px solid var(--start);
  outline-offset:-2px;
  background:color-mix(in oklab, var(--start) 20%, transparent)}
.trim-start-row {
  align-items:center;
  gap:8px;
  margin:0 0 10px;
  font:12px var(--mono);
  color:var(--muted);
  display:flex;
  flex-wrap:wrap}
.trim-start-row b {
  color:var(--accent);
  font-size:13px}
.trim-btn {
  cursor:pointer;
  color:var(--text-2);
  background:var(--panel-2);
  border:1px solid var(--line);
  border-radius:6px;
  padding:5px 9px;
  font:12px var(--mono)}
.trim-btn:hover {
  border-color:var(--accent);
  color:var(--text)}

/* 录音页画布上的"开始"竖线（可拖） */
.start-line {
  pointer-events:none;
  z-index:7;
  position:absolute;
  top:0;
  bottom:0;
  width:2px;
  /* ★ 和回放头(var(--accent) 粉红)、配对连线(蓝)都不一样的颜色 ✓
     用户要求："让鼠标选择的线和播放进度条的线颜色不同" ✓✓ */
  background:var(--start)}
.start-grip {
  pointer-events:auto;
  cursor:ew-resize;
  z-index:8;
  position:absolute;
  top:0;
  bottom:0;
  width:16px;
  margin-left:-7px}
.start-tag {
  pointer-events:none;
  z-index:8;
  position:absolute;
  top:4px;
  white-space:nowrap;
  font:11px/1 var(--mono);
  color:#fff;
  background:var(--start);
  border-radius:5px;
  padding:3px 6px;
  transform:translateX(-50%)}
.detect-btn {
  color:var(--bg);
  cursor:pointer;
  background:linear-gradient(135deg,var(--accent-2),var(--brand));
  border:0;
  border-radius:9px;
  padding:10px 20px;
  font:600 14px/1 inherit}
.detect-btn:hover {
  filter:brightness(1.1)}
.detect-stats {
  flex-wrap:wrap;
  gap:10px;
  margin-bottom:12px;
  display:flex}
.detect-stats>div {
  border:1px solid var(--line);
  background:var(--panel-2);
  border-radius:8px;
  flex-direction:column;
  gap:4px;
  min-width:90px;
  padding:8px 14px;
  display:flex}
.detect-stats span {
  font:11px/1 var(--mono);
  color:var(--muted)}
.detect-stats b {
  font:600 15px/1.2 var(--mono);
  color:var(--text)}
.detect-stats b.big {
  color:var(--accent-2);
  font-size:20px}
.detect canvas {
  border:1px solid var(--line);
  background:var(--stage-bg);
  border-radius:10px;
  width:100%;
  display:block}
.detect-msg {
  font:12px/1.6 var(--mono);
  color:var(--fg-dim);
  margin:0 0 10px}
.playback {
  border:1px solid var(--line);
  background:var(--panel-3);
  border-radius:10px;
  margin:0 0 12px;
  padding:10px 12px}
.playback-head {
  font:12px/1.4 var(--mono);
  color:var(--fg-dim);
  flex-wrap:wrap;
  align-items:center;
  gap:10px;
  margin-bottom:8px;
  display:flex}
.playback-head b,.playback-pos {
  color:var(--accent-2)}
.playback-pos b {
  color:var(--accent-2)}
a.note-btn {
  box-sizing:border-box;
  align-items:center;
  text-decoration:none;
  display:inline-flex}
.playback audio {
  width:100%;
  height:36px;
  display:block}
.detect-pick {
  font:12px/1 var(--mono);
  color:var(--muted);
  align-items:center;
  gap:6px;
  display:flex}
.detect-pick select {
  border:1px solid var(--line);
  color:var(--text-2);
  background:var(--ghost);
  border-radius:8px;
  padding:7px 10px;
  font:12px/1 inherit}
.tempo-sync {
  font:12px/1.5 var(--mono);
  color:var(--onset);
  background:var(--panel-2);
  border:1px solid var(--warn);
  border-radius:10px;
  flex-wrap:wrap;
  align-items:center;
  gap:10px;
  margin:0 0 12px;
  padding:10px 12px;
  display:flex}
.tempo-sync.off {
  border-color:var(--line);
  color:var(--ok);
  background:var(--panel-3)}
.tempo-sync b {
  color:var(--accent-2)}
.tempo-sync .ok {
  color:var(--ok)}
.ref {
  border:1px solid var(--line);
  background:var(--panel-3);
  border-radius:10px;
  margin:0 0 12px;
  padding:10px 12px}
.ref-head {
  font:12px/1.6 var(--mono);
  color:var(--fg-dim);
  margin:0 0 8px}
.ref-head b {
  color:var(--accent-2)}
.ref-scroll {
  overflow-x:auto}
.ref table {
  border-collapse:collapse;
  font:10px/1.4 var(--mono)}
.ref th,.ref td {
  text-align:right;
  white-space:nowrap;
  padding:3px 6px}
.ref th {
  color:var(--muted-2);
  font-weight:400}
.ref td {
  color:var(--text-2)}
.ref td.out {
  color:var(--text-2)}
.ref td.oct {
  color:var(--muted-2);
  text-align:center}
.ref td b {
  font-weight:400}
.ref-foot {
  font:11px/1.6 var(--mono);
  color:var(--muted-2);
  margin:8px 0 0}
.ref-foot code {
  background:var(--ghost);
  border-radius:3px;
  padding:1px 4px}
.score-empty {
  color:var(--muted);
  pointer-events:none;
  justify-content:center;
  align-items:center;
  margin:0;
  padding:24px;
  font-size:13px;
  display:flex;
  position:absolute;
  inset:0}
.stage.dragging {
  border-color:var(--brand)cc}
.drop-veil {
  color:var(--badge-fg);
  pointer-events:none;
  background:var(--badge-bg);
  border:2px dashed var(--brand);
  border-radius:14px;
  justify-content:center;
  align-items:center;
  font-size:14px;
  display:flex;
  position:absolute;
  inset:0}
.filebar {
  border:1px solid var(--line);
  background:linear-gradient(180deg, var(--panel), var(--panel-2));
  border-radius:12px;
  flex-wrap:wrap;
  align-items:center;
  gap:10px 16px;
  padding:10px 14px;
  display:flex}
.fname {
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--badge-fg);
  max-width:280px;
  font-size:13px;
  font-weight:600;
  overflow:hidden}
.fmeta {
  font:11px/1.5 var(--mono);
  color:var(--muted);
  flex:auto}
.filebar audio {
  max-width:320px;
  height:34px}
.field.dim {
  opacity:.45}
.error {
  color:var(--warn);
  background:var(--warn)1a;
  border:1px solid var(--warn)66;
  border-radius:12px;
  margin:0;
  padding:12px 14px;
  font-size:13px;
  line-height:1.6}

</style>

/**
 * 乐器起点检测 + 演奏速度测算。纯逻辑，不碰 DOM，可以用 node 跑测试。
 *
 * 需求是「根据能量的峰值跳跃检测演奏，记录每次起点的时刻，和用户输入的节拍匹配，
 * 算出弹奏速度」，所以这里分三步：
 *
 *   1. detectOnsets()   能量序列 -> 起点时刻
 *   2. expectedOnsets() 用户输入的节奏 -> 每个音应该在「第几拍」上
 *   3. matchTempo()     两者对齐 -> BPM + 每一个音弹早/弹晚了多少
 *
 * 为什么全程在对数域（dB）里做：总能量的动态范围极大（实测中位数只有满量程的 3%），
 * 用线性幅度判断「跳变」会被响度带偏 —— 轻弹的一段一个起点都检不出来。
 * 转成相对峰值的 dB 之后，「跳了多少 dB」对强弱就基本免疫了。
 */

import type { RhythmNote } from './notation/rhythm.ts'
import { midiName } from './noteBands.ts'
import { rankPitchesMulti, type SpectralPeak } from './harmonic.ts'
import { soundingMidi, type Tuning } from './notation/tab.ts'

/* ============================ 1. 起点检测 ============================ */

export interface Onset {
  /** 在输入数组里的下标 */
  index: number
  /** 时刻（秒） */
  time: number
  /** 这一下的强度：相对前一帧抬升了多少 dB */
  strengthDb: number
}

export interface OnsetOptions {
  /** 自适应阈值的滑窗时长（秒）。窗口要比「一小节」长，才不会被自己的鼓点抬高阈值 */
  windowSeconds?: number
  /** 阈值 = 局部均值 + k × 局部标准差。越大越挑，越不容易误检 */
  k?: number
  /** novelty 的绝对下限（dB/帧），低于它的起伏一律不算起点 */
  minJumpDb?: number
  /** 两个起点至少间隔多久（秒），防止一个音被拆成两个 */
  minGapSeconds?: number
  /** 相对整段峰值的下限（dB）：比峰值弱这么多的地方直接压到地板 */
  floorDb?: number
  /**
   * 起音之后要**撑住**多久才算真音符（秒）。
   *
   * 这是区分「音符」和「底噪毛刺」的关键判据，也是第一版最大的漏洞：
   * 底噪永远在产生 novelty，而自适应阈值又是从 novelty 自己的统计量算出来的 ——
   * 用底噪算出来的阈值必然被底噪自己突破。实测纯底噪能报出几十个假起点。
   *
   * 但音符和毛刺有个本质区别：**毛刺是一根针，音符是一段台阶**。
   * 所以起音之后过一小会儿再看一眼，电平掉回去的就是噪声。
   */
  holdSeconds?: number
  /** 撑住期内至少要比起音前高多少 dB */
  sustainDb?: number
  /**
   * 抬升还必须大于「本底抖动」的这么多倍。
   *
   * 这是把固定阈值换成自适应判据的关键一步。光有 sustainDb 会陷入两难：
   *   · 定 3dB —— 底噪干净了，但"总能量只涨 3dB"的真实轻声被误杀
   *   · 定 2dB —— 轻声保住了，纯底噪又漏出十几个假起点
   * 因为固定阈值根本区分不了这两种情况。真正的区别是：**真实起音的本底是稳的，
   * 底噪的本底是抖的**。所以拿本底的标准差当尺子 —— 抖动大的地方，抬升要求自然就高。
   */
  jitterFactor?: number
  /**
   * 估本底抖动要往回看多久（秒）。
   * 必须比"本底电平"的窗口长得多 —— 只有 5 个样本时标准差估计本身就不稳，
   * 偶尔估出个偏小的值门槛就塌了，底噪立刻漏进来。
   */
  jitterSeconds?: number
  /**
   * 一次起点至少要有几条频带同时起来。
   *
   * 这是针对真实录音补上的一条判据，而且在实测数据上比"抬升多少 dB"有效得多：
   *   · 真实乐器的起音是**宽频瞬态** —— 拨弦、击键、气息冲击，会同时点亮几十条带
   *   · 而底噪/房间噪声的抖动只影响一两条带
   * 实测某段 26 秒的真实录音：单靠抬升阈值，即使提到 20dB 仍有 37 个假起点；
   * 加上"至少 10 条带"之后降到 14 个。
   */
  minBands?: number
  /**
   * 「参与计数」用的门槛（dB），决定 bandCount、进而决定 minBands 过滤。
   *
   * 和 noteRiseDb 分开是有意的：noteRiseDb 管"要不要报出音名"（门槛高，报错音名比不报更糟），
   * 这个管"这一下够不够格算一次起音"（门槛低，宁可多留）。
   * 两者共用一个参数时，"提高认音阈值"会连带把起点删掉 —— 实测踩过。
   */
  countRiseDb?: number
  /**
   * 「曲子开始弹」的绝对门槛：相对底噪至少抬多少 dB（不填按动态范围自适应，夹在 6~30）。
   *
   * ★ 和 minJumpDb / countRiseDb 那些**相对**判据是两回事 ✗
   * 这里管的是"有没有开始演奏"，它们管的是"是不是又弹了一个新音" ✓
   */
  startMarginDb?: number
  /** 起奏要持续多久才算数（秒，默认 0.20）*/
  startSeconds?: number
  /**
   * 每列的**谱峰**（来自 PeakLog）。给了就用**谐波求和**认音名，
   * 不再用"哪条频带能量最强就报哪个音"。
   *
   * 为什么必须换：实测四份真实录音，**「基频缺失」是常态而不是例外**
   * （user-3 里 0/7 帧有基频）✓ 基频缺失时最强的往往是 4、5 次谐波 ✓
   * 于是"最强带 = 音名"必然把 G2 报成 D5 之类 —— 这正是之前音名一直很怪的原因 ✓
   *
   * 谐波求和是**假设检验**（"如果基频是 X，它的谐波该落在哪、对得上吗"），
   * 不要求基频真的存在 ✓ 实测换上之后音名落在合理音域内，
   * 而且候选排序里自发出现了八度和五度（谐波系列的头几个）—— 这是它正确的强证据 ✓
   */
  peakLog?: { rate: number; at(col: number): SpectralPeak[] } | null
  /** 调号先验：几个升号（正）/ 降号（负）；不填 = 不用 */
  keySignature?: number | null
  /** 谐波求和的最高谐波次数，默认 10 */
  maxHarmonics?: number
  /**
   * 起音的电平必须落在**该带自己峰值**的这么多 dB 以内。
   *
   * 这条是针对真实乐器补的，依据来自一段 26 秒的实测录音：那是一段衰减型的声音，
   * 真正的音只有 ~30 个，却被检出 137 个起点 —— 多出来的全在**音的衰减过程里**。
   * 原因是真实乐器的泛音彼此拍频，单条带在衰减中会上下起伏，被当成了起音。
   *
   * 但拍频抖动和真正的起音有个本质区别：**起音能冲到该带自己的峰值附近，
   * 而衰减中的起伏差得远**。设 0 表示不启用这条判据。
   */
  peakMarginDb?: number
  /**
   * 起音的电平必须落在**整段最响电平**的这么多 dB 以内（0 = 不启用）。
   *
   * 和 peakMarginDb 的区别很关键，是实测踩出来的：
   *   · peakMarginDb 拿**每条带自己的历史最大值**当基准 —— 遇到强弱起伏大的演奏就完了，
   *     后面的弱音够不到前面强音创下的峰值，全被吃掉。
   *   · levelMarginDb 拿**整段最大电平**当基准，只要求"这一下得是像样的响度"。
   *
   * 判据仍然作用在每条带上（总能量不参与），只是基准取全局。
   * 它拦掉的是"衰减过程中的拍频起伏"——那些都远低于整段最响电平。
   */
  levelMarginDb?: number
  /**
   * 起音前用来做对比的窗口长度（秒，默认 0.05）。
   *
   * 这条是冲着一个很具体的物理现象去的：**同一根弦的泛音不是严格整数倍**
   * （弦有劲度，高次泛音偏高），于是它们彼此拍频，衰减过程中总能量上下振荡 ——
   * 每次从波谷升起来都长得像一次起音。
   *
   * 两者的区别在于**起音之前那一段时间**：
   *   · 真起音：上一个音已经衰减下去了，前 200~400ms 整体是安静的
   *   · 拍频的"上升"：波峰就在 50~200ms 之内，只是窗口太短没看见
   * 所以把对比窗口放宽，拍频的抬升就被抹平，真起音不受影响。
   */
  levelBackSeconds?: number
  /**
   * novelty 用几阶差分：1 = 与上一窗口的差值（默认），2 = 差值的再差值（斜率的变化）。
   *
   * 二阶是冲着**泛音拍频**去的：拍频在衰减里是一条平滑周期曲线，斜率连续变化，
   * 二阶差分很小；新音的起始是台阶，斜率会突然翻正，二阶差分甩出尖峰。
   */
  noveltyOrder?: 1 | 2
  /**
   * 直接给定起点时刻（秒），**跳过检测**，只做音名识别。
   *
   * 循环折叠检测（见 loop.ts）就是这么用的：它自己算出时刻，
   * 这里负责认音名、算带宽，产出同样形状的 DetectedOnset[]。
   */
  presetTimes?: number[] | null
  /** 由 detectOnsetsWithNotes 算好后传进来，调用方不用管 */
  gatePeakDb?: number
  /**
   * **触发用**的能量序列（每列一个数），来自锯齿窗那一路。
   *
   * 这是检测起点的主路径：和认音高用的汉宁窗完全独立。
   * 汉宁窗两侧平滑、时间定位糊；锯齿窗（左高右低）把重心压在前半段，
   * 起音时"前半段还安静、后半段已有声"的过渡会被放大成明显的台阶。
   *
   * 不传的话退回"各带之和"的包络（老行为，也方便单测）。
   */
  triggerEnergies?: Float32Array | number[] | null
  /**
   * 「宽带包络」上的最小跳变（dB）。包络 = 各条带能量之和。
   *
   * 为什么要这条包络 —— 是实测逼出来的，不是设计上的偏好：
   * 拿一段 26 秒的真实录音（衰减型音色、约 30 个音）测，**只用单条带**检出 137 个起点。
   * 多出来的全在音的衰减里：真实乐器的泛音彼此拍频，单条带上下起伏，
   * 在**单条带这个尺度上**和真正的起音长得一模一样。
   * 试过四种单带判据（最小跳变、持续检查、带内峰值、整段电平门），
   * 没有一个能把两者干净地分开。
   *
   * 但把各条带**加起来**之后两者立刻分开了：一个音的所有泛音是同时起来的，
   * 加起来就是一次干净的台阶；而拍频起伏在不同带上此消彼长，加起来互相抵消。
   *
   * 注意这条包络**仍然完全是从频带算出来的** —— 没有再去读那份总能量日志。
   */
  envMinJumpDb?: number
}

/**
 * 起音之后的一整段，电平是否仍明显高于起音之前。
 *
 * 用「比起音前高多少」而不是「比峰值掉多少」，是为了同时容纳两种音：
 *   · 长音符：撑住期内几乎不衰减
 *   · 短促的打击音：衰减很快，但只要还明显高于起音前的本底，就仍是真的起音
 *
 * ⚠️ 关键是取**一整段的平均值**，不是单看某一个点。
 *    第一版只看 db[i+hold] 一个点：底噪是白噪声、样本之间不相关，那一个点碰巧也高的
 *    概率并不低，于是阈值被迫定得很高（4dB），反而把"总能量只涨 3dB"的轻声打掉了。
 *    取一段平均之后，白噪声的平均值必然回到本底，而音符不会 —— 阈值就能放低。
 */
function sustains(
  db: Float64Array,
  i: number,
  rate: number,
  holdSeconds: number,
  sustainDb: number,
  jitterFactor: number,
  jitterSeconds: number,
  globalJitter: number,
  levelBackSeconds: number
): boolean {
  const hold = Math.max(1, Math.round(holdSeconds * rate))

  // 本底**电平**：起音之前的一段。默认 0.05s，可放宽 —— 见 levelBackSeconds 的说明
  const back = Math.max(1, Math.round(levelBackSeconds * rate))
  let sumBefore = 0
  let cntBefore = 0
  for (let k = Math.max(0, i - back); k < i; k++) {
    sumBefore += db[k]
    cntBefore++
  }
  const before = cntBefore > 0 ? sumBefore / cntBefore : db[i]

  // 本底**抖动**：往回看很长一段（默认 0.25s），但统计的是**相邻帧差分**的标准差，
  // 而不是电平本身的标准差。这个区别是决定性的：
  //
  //   · 一个音的**衰减**是"电平大幅变化、但逐帧变化很平滑" —— 用电平标准差会把它
  //     当成巨大抖动，把紧随其后的下一个音误杀（实测：间隔 200ms 的两个音，第二个被拒）。
  //     而差分是个常数，标准差接近 0。
  //   · 白噪声的逐帧跳变很大 —— 差分标准差大，门槛自然抬高。
  //
  // 也就是说：这把尺子量的是"逐帧有多毛躁"，正好对应"这里是噪声还是乐音"。
  const jitterBack = Math.max(back, Math.round(jitterSeconds * rate))
  let sumD = 0
  let sumD2 = 0
  let cntD = 0
  for (let k = Math.max(1, i - jitterBack); k < i; k++) {
    const d = db[k] - db[k - 1]
    sumD += d
    sumD2 += d * d
    cntD++
  }
  const meanD = cntD > 0 ? sumD / cntD : 0
  const variance = cntD > 0 ? Math.max(0, sumD2 / cntD - meanD * meanD) : 0
  // 历史不够时（录音最开头）局部估计没有意义 —— 只有一两个样本时标准差会估成 0，
  // 门槛直接塌掉。实测纯底噪在 t=0.02s 处就是这么漏进来一个假起点的。
  // 这时退回用整段的抖动，尺子虽然粗，但不会失效。
  const minLocal = Math.max(2, Math.round(0.08 * rate))
  const jitter = cntD >= minLocal ? Math.sqrt(variance) : Math.max(Math.sqrt(variance), globalJitter)

  // 本底抖得越厉害，对抬升的要求就越高
  const required = Math.max(sustainDb, jitterFactor * jitter)

  // 起音之后一整段的平均电平
  let sumAfter = 0
  let cntAfter = 0
  const last = Math.min(db.length - 1, i + hold)
  for (let k = i + 1; k <= last; k++) {
    sumAfter += db[k]
    cntAfter++
  }
  // 结尾处往后看不到，没法验"撑住"。这时退化成**电平检查**而不是直接放行 ——
  // 直接放行等于在录音末尾开一个洞，底噪在那儿怎么报都过。
  if (cntAfter === 0) return db[i] - before >= required

  return sumAfter / cntAfter - before >= required
}

/** 任何「等间隔、能按下标取值」的序列，EnergyLog 就满足 */
export interface SampleSource {
  readonly length: number
  readonly rate: number
  at(i: number): number
}

export function readEnergies(src: SampleSource): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src.at(i)
  return out
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 能量序列 -> 相对峰值的 dB 序列 */
export function toDb(energies: Float32Array | number[], peak: number): Float64Array {
  const n = energies.length
  const db = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = peak > 0 ? energies[i] / peak : 0
    db[i] = v > 0 ? 10 * Math.log10(v) : -Infinity
  }
  return db
}

/**
 * 核心：输入**已经是 dB 序列**，找上升沿。
 *
 * 拆出来是为了让「按频率带检测」直接复用 —— 带能量本来就是 dB 序列，
 * 再走一遍「能量 -> dB」的换算会把它算成垃圾。
 */
export function detectRisesFromDb(
  dbIn: Float64Array | Float32Array,
  rate: number,
  opts: OnsetOptions = {}
): Onset[] {
  const n = dbIn.length
  if (n < 4 || !(rate > 0)) return []

  const win = Math.max(2, Math.round((opts.windowSeconds ?? 0.3) * rate))
  const k = opts.k ?? 1.5
  const minJump = opts.minJumpDb ?? 1.2
  const minGap = Math.max(1, Math.round((opts.minGapSeconds ?? 0.07) * rate))
  const floorDb = opts.floorDb ?? -45
  const holdSeconds = opts.holdSeconds ?? 0.035
  const peakMarginDb = Math.max(0, opts.peakMarginDb ?? 0)
  const levelMarginDb = Math.max(0, opts.levelMarginDb ?? 0)
  const levelBackSeconds = Math.max(0.01, opts.levelBackSeconds ?? 0.05)
  /**
   * 取一段平均之后白噪声必然回落到本底，所以这个阈值可以定得很低。
   *
   * 定 3 会误杀真实场景：三条频带里只有一条起来时，**总能量只涨 3.0dB**
   * （被另外两条没动的带稀释），正好卡在门槛上。那是"轻声藏在响音里"，
   * 是最该被检出来的情况之一，不能砍。取 2 即可 —— 4 个白噪声样本的平均值
   * 偏离本底 2dB 约等于 3.4 个标准差，概率约万分之三。
   */
  const sustainDb = opts.sustainDb ?? 2
  // 抬升要达到本底抖动的 3 倍。注意 1 倍是不够的：
  // 「本底抖动」本身是个估计量，抬升与它的差也是随机量，倍数太小照样会漏。
  const jitterFactor = opts.jitterFactor ?? 3
  const jitterSeconds = opts.jitterSeconds ?? 0.25

  // 以本序列自己的峰值为基准压到地板
  let peak = -Infinity
  for (let i = 0; i < n; i++) if (dbIn[i] > peak) peak = dbIn[i]
  if (!Number.isFinite(peak)) return []
  const floor = peak + floorDb

  const db = new Float64Array(n)
  for (let i = 0; i < n; i++) db[i] = dbIn[i] > floor ? dbIn[i] : floor

  // 整段的逐帧抖动，给"历史不够"的地方兜底用
  let gSum = 0
  let gSum2 = 0
  for (let k = 1; k < n; k++) {
    const d = db[k] - db[k - 1]
    gSum += d
    gSum2 += d * d
  }
  const gCnt = n - 1
  const gMean = gCnt > 0 ? gSum / gCnt : 0
  const globalJitter = gCnt > 0 ? Math.sqrt(Math.max(0, gSum2 / gCnt - gMean * gMean)) : 0

  // novelty：只保留上升沿（半波整流）。
  //
  // order = 1（原来的做法）：就是「与上一窗口的差值」本身。
  // order = 2：差值的**变化量** —— 也就是斜率的变化（二阶差分）。
  //
  // 为什么要二阶：泛音拍频在衰减里造成的起伏，是一条**平滑的周期曲线**，
  // 它的斜率是连续变化的，二阶差分很小；而一个新音的开始是一个**台阶**，
  // 斜率会从"在下降"突然翻转成"在上升"，二阶差分甩出一个尖峰。
  // 一阶差分分不开这两者（拍频的波峰照样是正的），二阶可以。
  const order = opts.noveltyOrder ?? 1
  const nov = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const d = db[i] - db[i - 1]
    if (order === 2) {
      const dPrev = i >= 2 ? db[i - 1] - db[i - 2] : 0
      const acc = d - dPrev
      nov[i] = acc > 0 ? acc : 0
    } else {
      nov[i] = d > 0 ? d : 0
    }
  }

  // 前缀和，把「局部均值 / 局部标准差」压到 O(n)
  const sum = new Float64Array(n + 1)
  const sum2 = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + nov[i]
    sum2[i + 1] = sum2[i] + nov[i] * nov[i]
  }

  // 峰选：局部极大 + 过自适应阈值 + 过绝对下限
  const candidates: Onset[] = []
  for (let i = 1; i < n - 1; i++) {
    const v = nov[i]
    if (v < minJump) continue
    if (!(v > nov[i - 1] && v >= nov[i + 1])) continue

    const a = Math.max(0, i - win)
    const b = Math.min(n, i + win + 1)
    const cnt = b - a
    const mean = (sum[b] - sum[a]) / cnt
    const variance = Math.max(0, (sum2[b] - sum2[a]) / cnt - mean * mean)
    if (v <= mean + k * Math.sqrt(variance)) continue

    // ★ 撑不住的就是底噪毛刺，不是起音
    if (
      !sustains(db, i, rate, holdSeconds, sustainDb, jitterFactor, jitterSeconds, globalJitter, levelBackSeconds)
    )
      continue

    // ★ 够不到该带自己峰值的，是衰减中的拍频抖动，不是起音
    if (peakMarginDb > 0 && dbIn[i] < peak - peakMarginDb) continue

    // ★ 连整段最响电平都远远够不到的，直接不算数
    const gp = opts.gatePeakDb
    if (levelMarginDb > 0 && gp !== undefined && Number.isFinite(gp) && dbIn[i] < gp - levelMarginDb)
      continue

    // 抛物线插值细化峰值位置 —— 一个 hop 是 10.7ms，插值能把这层量化误差压掉
    const y0 = nov[i - 1]
    const y1 = v
    const y2 = nov[i + 1]
    const denom = y0 - 2 * y1 + y2
    const shift = denom !== 0 ? clamp((0.5 * (y0 - y2)) / denom, -1, 1) : 0

    candidates.push({ index: i, time: (i + shift) / rate, strengthDb: v })
  }

  // 最小间隔：靠得太近的只留更强的那一个
  const out: Onset[] = []
  for (const c of candidates) {
    const last = out[out.length - 1]
    if (last && c.index - last.index < minGap) {
      if (c.strengthDb > last.strengthDb) out[out.length - 1] = c
    } else {
      out.push(c)
    }
  }
  return out
}

/** 总能量序列 -> 起点（先转 dB，再交给 detectRisesFromDb） */
export function detectOnsets(
  energies: Float32Array | number[],
  rate: number,
  opts: OnsetOptions = {}
): Onset[] {
  const n = energies.length
  if (n < 4 || !(rate > 0)) return []
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = energies[i]
    if (v > peak) peak = v
  }
  if (!(peak > 0)) return []
  return detectRisesFromDb(toDb(energies, peak), rate, opts)
}

/* ====================== 2. 期望起点（用户输入的节奏） ====================== */

/**
 * 把用户输入的节奏摊平成「每个音应该在几分之几拍上」。
 *
 * 两个容易错的地方：
 *   · **休止符不产生起点** —— 休止就是没弹，但它照样占用时间，所以时间轴要往前走
 *   · 位置单位是四分音符，从 0 开始；弱起小节意味着第一个音就在 0 上
 */
export function expectedOnsets(bars: RhythmNote[][], repeats = 1): number[] {
  const one: number[] = []
  let t = 0
  // 上一个**非和弦音**的起点 —— 和弦音就和它同时起 ✓
  let lastStart = 0
  for (const bar of bars) {
    for (const n of bar) {
      // 和弦音**和前一个音同时起、不推进时间** ✗✗
      //
      // 这里原来对所有音都 t += n.value ✓ 于是一旦谱面里有和弦 ✓
      // 后面的期望时刻**全部往后漂** ✓ 用户看到的就是
      // "第三小节根本没按谱子上标的时刻" ✓✓
      // （barTotal 早就跳过和弦音了 ✓ 这里当时漏了 ✓）
      if (n.chord) {
        if (!n.rest) one.push(lastStart)
        continue
      }
      lastStart = t
      if (!n.rest) one.push(t)
      t += n.value
    }
  }
  // 一遍的总时值就是 t（休止也占时间）
  if (repeats <= 1 || one.length === 0 || t <= 0) return one

  // 把这一遍**原样重复**。练习录音里同一段会反复弹，若只拿一遍的期望音去对，
  // 第 2 遍之后的**真音全会被算成"多打"** —— 用户实测报过这个：
  // "中间好多点都是正在演奏的，不应当是粉色"。
  const out: number[] = []
  for (let k = 0; k < repeats; k++) {
    for (const p of one) out.push(p + k * t)
  }
  return out
}

/** 一遍（这三小节）的总时值，单位四分音符。用于按遍重复。 */
export function patternBeats(bars: RhythmNote[][]): number {
  let t = 0
  // 同样要跳过和弦音 ✗ 否则"一遍多长"会被算长 ✓ 重复展开全跟着错 ✓
  for (const bar of bars) for (const n of bar) if (!n.chord) t += n.value
  return t
}

/** 相邻期望起点之间最小的间隔（四分音符为单位）。只有一个音时返回 1。 */
export function shortestGap(expected: number[]): number {
  if (expected.length < 2) return 1
  let min = Infinity
  for (let i = 1; i < expected.length; i++) {
    const d = expected[i] - expected[i - 1]
    if (d > 0 && d < min) min = d
  }
  return Number.isFinite(min) ? min : 1
}

/* ========================= 3. 匹配与速度测算 ========================= */

export interface OnsetPair {
  /** 期望位置（四分音符为单位，从 0 起） */
  expected: number
  /** 匹配到的实际时刻（秒）；没匹配上是 null */
  detected: number | null
  /** detected - predicted，正数 = 弹晚了。没匹配上时为 0 */
  error: number
  /**
   * 这个期望音的**预测时刻**（秒），已经做过"每拍锁相"。
   *
   * ★ 光有 offset + spq 是一条**直线** ✗ 而锁相之后每个音的落点是**逐拍修正**过的 ✓
   * 所以画图那边必须用这个字段，不能再用直线公式算 ✗✗
   * 没开锁相时它就是直线公式的值 ✓ 两边一致 ✓
   */
  expectedTime?: number
}

export interface TempoMatch {
  bpm: number
  secondsPerQuarter: number
  /** 第一个期望音对应的时刻（秒） */
  offset: number
  pairs: OnsetPair[]
  /** 多出来的检测点：没对应上任何音符（多打/误检） */
  extras: number[]
  matches: number
  expectedCount: number
  detectedCount: number
  precision: number
  recall: number
  f1: number
  /** 匹配上的音的平均 / 最大绝对偏差（秒） */
  meanAbsError: number
  maxAbsError: number
  /**
   * 匹配上的音对里，音高（按音级）也吻合的个数 —— 没传音高时恒为 0。
   *
   * 「时间对 + 音高也对」几乎不可能是巧合 ✓ 所以这个数比 F1 更能说明"真对齐了" ✓
   */
  pitchAgree: number
  /** 音高吻合率 = pitchAgree / matches */
  pitchRate: number
  /** 综合分 = f1 + 音高权重 × 吻合率。**锚点就是按它选的** */
  score: number
}

export interface MatchOptions {
  minBpm?: number
  maxBpm?: number
  /** 网格搜索步长（BPM）。搜完还会用最小二乘再拟合一次，所以不需要太细。 */
  step?: number
  /**
   * 最多拿前几个检测点当候选锚点。
   *
   * 为什么要"试多个锚点"：最初的做法是死认"第一个检测点就是第一个音"。只要开头
   * 有一声杂音被误检成起点，整段拟合就会按它对齐，真正的第一个音被推到后面的期望
   * 音符上 —— 实测表现是"2 秒弹的第一个音被标成了第 2 小节"。
   */
  anchorCandidates?: number
  /**
   * 每个起点的强度（dB），和 onsetTimes 一一对应。
   *
   * 为什么要它：F1 在**起点密集**时几乎没有区分力。实测一段 26 秒的真实录音有 90 多个
   * 起点，F1 的分母被"多打"撑大，真正的对齐和错误的对齐得分只差 0.01 ——
   * 于是无论怎么裁决（比误差、比谁更早）都会翻车。
   *
   * 但两者有个本质区别：**正确的对齐匹配到的是那些强的起点，错误的对齐匹配到的是
   * 一堆弱的噪声起点加几个真音**。所以 F1 打平时，比"匹配上的起点强度之和"。
   */
  strengths?: number[]
  /**
   * 每个起点的**音高**（MIDI），和 onsetTimes 一一对应；认不出来就填 null。
   *
   * ★ 为什么要它：只有时间判据时，算法没法"优先信那些认对的音" ✗
   * 而"时间对 + 音高也对"这种巧合概率很低 ✓✓ —— 所以这种对齐几乎一定是对的 ✓
   * 拿它定相位，比在几十个候选里靠 F1 小数点后两位去猜可靠得多 ✓
   */
  /**
   * **相位锚点**（秒）—— 第一个期望音**应该**落在哪一刻。
   *
   * ★ 为什么需要它：对齐模型有两个正交参数 —— 速度 s 和相位 φ ✓
   * 起点密集时 F1 对 φ **几乎是平的** ✗ 于是"最优 φ"其实是噪声选出来的 ✓
   * 实测 beatlooker-recording (6)：它挑的 φ 比起奏晚**整整一拍** ✗✗
   *
   * 而"第一个音就在起奏那一刻"是**物理事实** ✓✓ ——
   * 声音从那儿开始 ✓ 休止符不发声 ✓ 所以起奏判据（绝对判据 ✓）给的就是 φ ✓
   *
   * 给了它以后：
   *   · 候选锚点只在 anchorOffset ± anchorSlackSeconds 内找 ✓
   *   · 最小二乘**只拟合斜率、截距固定**在这个锚点上 ✓✓
   *     （自由拟合就是漂一拍的地方 ✗）
   */
  anchorOffset?: number
  /**
   * 锚点两侧允许多少秒（默认 0.35）。
   *
   * 为什么是这个量级：
   *   · 起奏判据要求"持续 200ms" ✓ 所以它天生比真起音**晚**最多约 0.2s ✓ 得容得下 ✓
   *   · 而一拍（实测 0.537s）是**错**的那一侧 ✗ 必须挡住 ✓✓
   * 0.35 正好卡在中间 ✓ 两边都照顾到 ✓
   */
  anchorSlackSeconds?: number
  /**
   * **每拍锁相**（**默认关** ✗ —— 见下面的实测结论）。
   *
   * 做法：对齐之后逐音走一遍 ✓ 把每个期望音的时刻拉到最近的起点上 ✓
   * 只在 ±lockSnapBeats 拍内拉 ✓（默认 0.35）✓ 防止整串滑掉 ✓
   *
   * ⚠️ 为什么默认关掉（我本来打算默认开 ✓ 实测之后改了主意 ✗）：
   *
   *   1. **收益弱且不一致** ✗ —— 用生产代码端到端量（识别出的音 == 谱面那个音）：
   *        (5) 锁相关 6% / 锁相开 6%（9帧都是 38%）—— 没差别
   *        (6) 锁相关 14% / 锁相开 0%（1帧）；9帧时 7% → 16% ✓ 但样本只有 28 个
   *   2. **它会毁掉"对上 / 多打"统计** ✗✗ —— 锁相**强制**给每个期望音找一个最近起点 ✓
   *      于是 (6) 的"对上"从 28 变成 32（= 期望总数 ✓）✓
   *      那个用户一直在看的统计**当场失去意义** ✓
   *   3. **它和那张图的目的冲突** ✗✗ —— 锁相把期望位置吸到起点上 ✓
   *      图上"期望刻度"和"实际起点"就重合了 ✓ → **弹早弹晚的斜连线全没了** ✗
   *      而"看出你弹早还是弹晚"正是那张图存在的意义 ✓✓
   *
   * 所以：功能留着（可以用它做实验 ✓）✓ 但默认走原来的直线对齐 ✓✓
   */
  lockPhases?: boolean
  /** 锁相的限幅（拍）。默认 0.35 */
  lockSnapBeats?: number
  /**
   * 局部时间映射的平滑半径（单位：拍，默认 2）。
   *
   * 见 matchTempo 里"平滑后的局部时间映射"那段 ✓
   * 0 = 不平滑（映射会逐音贴着实际 ✓ 残差恒为 0 ✗ 那就等于把答案抄进题目 ✓ 不能用）
   */
  smoothRadiusBeats?: number
  pitches?: (number | null)[]
  /** 谱面上每个期望音的**音高**（MIDI），和 expected 一一对应 */
  expectedPitches?: (number | null)[]
  /**
   * 音高吻合率在总分里占多重（默认 0.3）。
   *
   * 用的是**比率**（吻合数 / 匹配数）而不是计数 ✗ ——
   * 计数会奖励"只匹配上一个音但恰好音高对"这种取巧 ✓
   * 比率衡量的是"这批对齐里有多少真的对上了" ✓
   */
  pitchWeight?: number
}

interface RawMatch {
  secondsPerQuarter: number
  offset: number
  pairs: OnsetPair[]
  extras: number[]
  matches: number
  meanAbsError: number
  f1: number
  /** 匹配上的那些起点的强度之和（没给 strengths 时就是匹配个数） */
  matchedWeight: number
  /** 匹配上的音对里，音高（按音级）也吻合的个数 */
  pitchAgree: number
  /** 音高吻合率 = pitchAgree / matches，没给音高时恒为 0 */
  pitchRate: number
  /** 综合分 = f1 + pitchWeight × pitchRate —— 锚点排序就用它 */
  score: number
}

/**
 * **每拍锁相**：把每个期望音的预测时刻拉到最近的起点上。
 *
 * 用**单向游标**扫 ✓ 所以保证：
 *   · 每个起点最多被一个期望音用掉 ✓（不会两个音抢同一个起点 ✗）
 *   · 结果**单调不减** ✓（不会出现后一个音跑到前一个前面 ✗）
 *
 * 限幅很关键 ✗：只在 ±maxSnapBeats 拍内拉 ✓
 * 否则一串噪声起点能把整条对齐**拽跑** ✗✓
 *
 * @returns 每个期望音的最终时刻，以及它用掉的起点下标（没用上就是 null）
 */
export function lockPhases(
  onsetTimes: number[],
  expected: number[],
  offset: number,
  spq: number,
  maxSnapBeats = 0.35
): { time: number; onset: number | null }[] {
  const tol = Math.max(0, maxSnapBeats) * spq
  const times = [...onsetTimes].sort((a, b) => a - b)
  const out: { time: number; onset: number | null }[] = []
  // ★ 从"最近一次吸附点"重新拉一条线 ✓ 按**拍位差**推进 ✓✓
  //
  // 不能写成"每处理一个音就 cur += spq" ✗✗ ——
  // 期望音之间**可能隔着休止或长音** ✓ 拍位是 0,1,3,4 这种 ✓
  // 按"一个音一拍"推进会当场错位 ✓
  // （第一版就是这么写的 ✓ "含休止的节奏"那条测试立刻逮住：匹配数 4 变成 3 ✓）
  let baseQ = expected.length ? expected[0] : 0
  let baseT = offset
  let j = 0
  for (let i = 0; i < expected.length; i++) {
    const cur = baseT + (expected[i] - baseQ) * spq
    // 落在本音窗口之前的起点，后面也用不上了 ✓ 游标直接推过去
    while (j < times.length && times[j] < cur - tol) j++
    let best = -1
    let bd = Infinity
    for (let k = j; k < times.length && times[k] <= cur + tol; k++) {
      const d = Math.abs(times[k] - cur)
      if (d < bd) { bd = d; best = k }
    }
    if (best >= 0) {
      baseT = times[best]
      baseQ = expected[i]
      out.push({ time: baseT, onset: best })
      j = best + 1
    } else {
      out.push({ time: cur, onset: null })
    }
  }
  return out
}

function tryMatch(
  times: number[],
  expected: number[],
  spq: number,
  offset: number,
  tol: number,
  weights: number[] | null,
  pitches: (number | null)[] | null = null,
  expectedPitches: (number | null)[] | null = null,
  pitchWeight = 0
): RawMatch {
  const pairs: OnsetPair[] = []
  const extras: number[] = []
  const p0 = expected[0]
  let j = 0
  let sumAbs = 0
  let matchedWeight = 0
  let pitchAgree = 0
  let expectedIdx = -1

  for (const p of expected) {
    expectedIdx++
    const predicted = offset + (p - p0) * spq

    // 落在本音窗口之前的检测点，只能是多打的
    while (j < times.length && times[j] < predicted - tol) {
      extras.push(times[j])
      j++
    }

    // 在容差窗口里挑**最近**的那个，而不是第一个。
    // 这一点是实测逼出来的：锚在真正的 2.0s 时，若取"第一个"，
    // 期望音会去匹配旁边 1.95s 那个弱噪声起点（距离 0.05），
    // 把正好落在 2.00 的强起点让给下一个音 —— 于是真对齐和假对齐的强度和打平，
    // 裁决又退化成随机。
    let bestK = -1
    let bestD = Infinity
    for (let k = j; k < times.length && times[k] <= predicted + tol; k++) {
      const d = Math.abs(times[k] - predicted)
      if (d < bestD) {
        bestD = d
        bestK = k
      }
    }

    if (bestK >= 0) {
      // 窗口里被跳过的（离得更远的）同样算多打
      for (let k = j; k < bestK; k++) extras.push(times[k])
      const err = times[bestK] - predicted
      pairs.push({ expected: p, detected: times[bestK], error: err })
      sumAbs += Math.abs(err)
      matchedWeight += weights ? (weights[bestK] ?? 0) : 1
      // 音高按**音级**比，不按八度 ✗ —— 检测出来的音常有八度差错 ✓
      // 但音级对了就足以说明"这里对上了" ✓ 用它当锚点足够可靠 ✓
      if (pitches && expectedPitches) {
        const a = pitches[bestK]
        const b = expectedPitches[expectedIdx]
        if (a != null && b != null && ((a % 12) + 12) % 12 === ((b % 12) + 12) % 12) {
          pitchAgree++
        }
      }
      j = bestK + 1
    } else {
      pairs.push({ expected: p, detected: null, error: 0 })
    }
  }
  while (j < times.length) {
    extras.push(times[j])
    j++
  }

  const matches = pairs.filter((x) => x.detected !== null).length
  const precision = matches + extras.length > 0 ? matches / (matches + extras.length) : 0
  const recall = expected.length > 0 ? matches / expected.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const pitchRate = matches > 0 ? pitchAgree / matches : 0
  // 综合分：F1 打底，再加上音高吻合率的奖励 ✓
  // 用比率而不是计数 ✗ 免得"只匹配上一个音但恰好音高对"取巧 ✓
  const score = f1 + pitchWeight * pitchRate

  return {
    secondsPerQuarter: spq,
    offset,
    pairs,
    extras,
    matches,
    meanAbsError: matches > 0 ? sumAbs / matches : Infinity,
    pitchAgree,
    pitchRate,
    score,
    f1,
    matchedWeight
  }
}

/**
 * 把检测到的起点和期望的节奏对上，并算出速度。
 *
 * 做法是**先锚定再网格搜索**：假设第一个检测点就是第一个音（人总是从头开始弹），
 * 在此前提下扫一遍 BPM，取 F1 最高的那个；最后再用最小二乘在匹配对上重新拟合
 * 斜率和截距，把网格的粗粒度补掉。
 *
 * 为什么不用「直接对 t 和 p 做一次线性回归」：那要求检测点和音符**一一对应**，
 * 多打一下或者漏掉一个音，回归结果就整个偏掉。这里允许漏音和多余起点，
 * 并且把 precision / recall 一并报出来 —— 那本身就是「弹得准不准」的度量。
 */
export function matchTempo(
  onsetTimes: number[],
  expected: number[],
  opts: MatchOptions = {}
): TempoMatch | null {
  if (onsetTimes.length === 0 || expected.length === 0) return null

  const times = [...onsetTimes].sort((a, b) => a - b)
  const minBpm = opts.minBpm ?? 40
  const maxBpm = opts.maxBpm ?? 240
  const step = opts.step ?? 0.5
  const gapQ = shortestGap(expected)
  // 音高要和 times 对齐 —— 调用方给的顺序可能没排过 ✓ 这里跟着排一次 ✓
  const order = onsetTimes.map((_, i) => i).sort((a, b) => onsetTimes[a] - onsetTimes[b])
  const pitchList = opts.pitches ? order.map((i) => opts.pitches![i] ?? null) : null
  const expectedPitchList = opts.expectedPitches ?? null
  const pitchWeight = pitchList && expectedPitchList ? (opts.pitchWeight ?? 0.3) : 0

  /**
   * 锚点评分。F1 相同时**取更早的锚点**，这是关键的一条。
   *
   * 原来的平局裁决比的是 meanAbsError，在起点稀疏的合成数据上没问题；
   * 但一放到真实录音上就崩了 —— 实测一段 26 秒的录音有 90 多个起点，
   * 起点间隔比期望音间隔还密，于是**几乎任何锚点都能凑出 F1=1 且误差极小**，
   * meanAbsError 变成了近乎随机地挑选，结果把 13 秒处锚成了"第一个音"。
   *
   * 而乐理上答案是确定的：**谱子的第一个音就是演奏的第一个音**。
   * 所以 F1 打平时，谁更早谁赢。这不会退化成"死认第一个检测点"——
   * 开头若有一声杂音，按它对齐会让后面的期望音全部落空，F1 自然很低，赢不了。
   */
  const better = (r: RawMatch, b: RawMatch | null): boolean => {
    if (!b) return true
    // ★ 第一顺位是**综合分** —— 它把"音高也吻合"算了进去 ✓✓
    // 只有时间判据时，算法没法"优先信那些认对的音" ✗ 几十个候选靠 F1 小数点后两位去猜 ✓
    // 而"时间对 + 音高也对"几乎不可能是巧合 ✓ 拿它定相位可靠得多 ✓
    if (r.score > b.score + 1e-9) return true
    if (Math.abs(r.score - b.score) > 1e-9) return false
    if (r.f1 > b.f1 + 1e-9) return true
    if (Math.abs(r.f1 - b.f1) < 1e-9) {
      // F1 打平时先比"匹配上的起点强度之和" —— 真对齐匹配的是强的真音，
      // 假对齐匹配的是一堆弱噪声起点。这一条是密集起点下唯一有效的东西。
      if (r.matchedWeight > b.matchedWeight + 1e-9) return true
      if (Math.abs(r.matchedWeight - b.matchedWeight) < 1e-9 && r.meanAbsError < b.meanAbsError)
        return true
    }
    return false
  }

  // 候选锚点：前若干个检测点。真正的第一个音几乎总在里面；
  // 靠后的点当锚点会让前面的期望音全部落空、recall 暴跌，评分自然会淘汰它们。
  // strengths 是按原始顺序给的，times 排过序，所以要把权重跟着一起重排
  let weights: number[] | null = null
  if (opts.strengths && opts.strengths.length === onsetTimes.length) {
    const order = onsetTimes.map((t, i) => ({ t, w: opts.strengths![i] }))
    order.sort((a, b) => a.t - b.t)
    weights = order.map((o) => o.w)
  }

  const maxAnchors = Math.max(1, Math.min(times.length, opts.anchorCandidates ?? 40))
  const anchorPt =
    typeof opts.anchorOffset === 'number' && Number.isFinite(opts.anchorOffset)
      ? opts.anchorOffset
      : null
  const anchors = (() => {
    if (anchorPt == null) return times.slice(0, maxAnchors)
    // ★ 相位锚定：只在起奏附近找锚点 ✓✓
    const slack = Math.max(0, opts.anchorSlackSeconds ?? 0.35)
    const inWin = times.filter((t) => t >= anchorPt - slack && t <= anchorPt + slack)
    // 窗口里一个起点都没有（起奏处恰好没检出）→ 就拿锚点本身当候选 ✓
    return inWin.length ? inWin : [anchorPt]
  })()

  let best: RawMatch | null = null
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += step) {
    const spq = 60 / bpm
    // 容差跟着速度走：音越密，允许的绝对偏差越小；再夹到一个合理区间
    const tol = clamp(0.3 * gapQ * spq, 0.035, 0.15)
    for (const anchor of anchors) {
      const r = tryMatch(times, expected, spq, anchor, tol, weights, pitchList, expectedPitchList, pitchWeight)
      if (better(r, best)) best = r
    }
  }
  if (!best) return null

  // 最小二乘再拟合：t = offset + (p - p0) * spq
  const matched = best.pairs.filter((x) => x.detected !== null)
  let spq = best.secondsPerQuarter
  let offset = best.offset
  if (matched.length >= 2) {
    const p0 = expected[0]
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (const m of matched) {
      const x = m.expected - p0
      const y = m.detected as number
      sx += x
      sy += y
      sxx += x * x
      sxy += x * y
    }
    const cnt = matched.length
    if (anchorPt != null) {
      // ★ 相位锚定：截距**固定**在锚点上，只拟合斜率 ✓✓
      //   t = φ + (p − p0)·s   →   s = Σ x·(y − φ) / Σ x²
      // 自由拟合会同时动两个参数 ✗ 那正是"漂一拍"的来源 ✓
      let axx = 0
      let axy = 0
      for (const m of matched) {
        const x = m.expected - expected[0]
        axx += x * x
        axy += x * ((m.detected as number) - anchorPt)
      }
      if (axx > 1e-12) {
        const slope = axy / axx
        if (slope > 0 && 60 / slope >= minBpm && 60 / slope <= maxBpm) {
          spq = slope
          offset = anchorPt
        }
      }
    } else {
      const denom = cnt * sxx - sx * sx
      if (Math.abs(denom) > 1e-12) {
        const slope = (cnt * sxy - sx * sy) / denom
        // 斜率必须落在合法 BPM 区间里，否则说明这组匹配不可信，保留网格结果
        if (slope > 0 && 60 / slope >= minBpm && 60 / slope <= maxBpm) {
          spq = slope
          offset = (sy - slope * sx) / cnt
        }
      }
    }
  }

  // 用拟合后的参数重算偏差
  const tol = clamp(0.3 * gapQ * spq, 0.035, 0.15)
  const final = tryMatch(times, expected, spq, offset, tol, weights, pitchList, expectedPitchList, pitchWeight)
  // tryMatch 里的 offset 语义是「第一个期望音的预测时刻」，这里保持一致
  let pairs = final.pairs.map((x) => ({
    ...x,
    error: x.detected === null ? 0 : x.detected - (offset + (x.expected - expected[0]) * spq),
    expectedTime: offset + (x.expected - expected[0]) * spq
  }))
  let extras = final.extras

  // ★★ 每拍锁相（默认开）★★
  //
  // 一条直线拟合不了人弹琴时的速度起伏 ✗ 于是越往后越偏 ✓
  // 锁相把每个期望音的时刻**逐拍拉回最近的起点** ✓ 但限幅 ±0.35 拍 ✓
  // 为什么限幅不能松 ✗：一串噪声起点能把整条对齐拽跑 ✗✓
  // （用单向游标扫 ✓ 保证一个起点不会被两个音抢、结果单调 ✓）
  // ★★★ 默认**开**，而且吸附窗要**宽** ✗✗ ★★★
  //
  // 用户报的："2.7s 3.4s 4.1s 4.8s 是我确实弹对了的地方，但是没有匹配上" ✓
  // 两个问题叠在一起 ✓：
  //   ① 人**中途放慢了** ✓ 起点间隔从 0.4 秒变成 0.7 秒 ✓
  //      而 t(q)=φ+(q−q₀)·s 是**一条直线** ✗ 假设全程匀速 ✓
  //      于是后面的期望时刻越累越偏 ✓ 偏出容差就显示"没配上" ✓
  //   ② 我早先做的"锁相"本来能治它 ✓ 但**默认关着** ✗ 而且窗口只有 ±0.35 拍 ✗
  //      实测 rep=2 时一拍 0.474 秒 ✓ 窗口只有 **130ms** ✓
  //      而漂移有 **400~540ms** ✗ —— 根本够不到 ✓ 所以"开了也没用" ✓
  //
  // 实测（天狼星，7 个高置信起点，8 个四分音符的谱面）：
  //   锁相关 ±0.35 (130ms)  rep=2  BPM=162  对上 7  没对上 **9**   F1 0.609
  //   锁相开 ±0.35 (130ms)  rep=2  BPM=162  对上 7  没对上 **9**   F1 0.609  ← 无变化
  //   锁相开 ±0.50 (277ms)  rep=**1**  BPM=**108**  没对上 **2**   F1 **0.800** ✓✓
  //   锁相开 ±0.70 (388ms)  rep=**1**  BPM=**108**  没对上 **2**   F1 **0.800** ✓✓
  //
  // 而且它**不影响画面** ✓✓：
  //   配对用锁相后的时刻 ✓ 但图上画的仍然是**直线** ✓
  //   所以"你弹晚了 0.4 秒"照样看得出来 ✓（绿斜线会拉得很长 ✓）
  if ((opts.lockPhases ?? true) && expected.length > 0 && times.length > 0) {
    // 默认 0.7 拍 —— 见上面那段实测 ✓ 0.35 拍（130ms）够不到人的速度漂移 ✗
  const locked = lockPhases(times, expected, offset, spq, opts.lockSnapBeats ?? 0.7)
    const used = new Set<number>()

    // ★★★ 平滑后的**局部时间映射** ★★★
    //
    // 用户的实测：5323.webm **前面慢、后面快** ✓
    // 而 t(q)=φ+(q−q₀)·s 是**一条直线** ✗ 假设全程匀速 ✓
    // 于是越往后期望时刻越偏 ✓ 偏出容差就显示"没配上" ✓ 看起来很差 ✗
    //
    // 做法：拿"吸附上了"的那些当**锚点** ✓ 先做**移动平均** ✓ 再过锚点做**分段线性** ✓
    //   锚点   = 每个配上的 (拍位, 实际时刻) ✓ 它们天然单调 ✓
    //   平滑   = 窗口 ±2 拍 ✓
    //   ★ 为什么必须平滑 ✗✗：
    //     不平滑的话映射会**逐音贴着实际** ✓ 残差恒为 0 ✗ 画面当然好看 ✓
    //     但那就等于"把答案抄进题目" ✓ 工具就没用了 ✗
    //     平滑之后：**慢的速度变化被跟上** ✓ **单个音的抖动留成残差** ✓✓
    //     也就是"这一段你整体快了"会被跟上 ✓ 而"这一个音你弹晚了 60ms"照样看得出来 ✓
    const anchorQ: number[] = []
    const anchorT: number[] = []
    for (let i = 0; i < expected.length; i++) {
      const L = locked[i]
      if (L && L.onset != null) {
        anchorQ.push(expected[i])
        anchorT.push(times[L.onset])
      }
    }
    const smoothR = Math.max(1, Math.round(opts.smoothRadiusBeats ?? 2))
    // ★ 平滑要用**局部线性拟合**（Savitzky–Golay 的思路）✗✗
    //
    // 试过两种"更简单"的写法 ✓ 都不行：
    //   ① 直接 clamp 取窗口 ✗ 端点窗口不对称 ✓ 匀速演奏在开头被算出假偏差 ✓
    //   ② 镜像取窗口     ✗ 也不保线性！{−2,−1,0,1,2} 镜像成 {2,1,0,1,2}
    //                       均值 = 1.2s ✗ 而不是 0 ✗（t₂ 被算了两次 ✓ t₋₂ 一次没有 ✓）
    //   测试当场逮住："完全吻合时平均偏差应接近 0" 挂了 ✓✓
    //
    // 局部线性拟合对**线性斜坡在任意位置都精确** ✓✓ —— 包括端点 ✓
    // 所以匀速演奏**不产生任何假偏差** ✓ 而真正的变速会被跟上 ✓✓
    const nA = anchorT.length
    const smoothT = anchorT.map((_, i) => {
      const lo = Math.max(0, i - smoothR)
      const hi = Math.min(nA - 1, i + smoothR)
      let sw = 0
      let sk = 0
      let st = 0
      let skk = 0
      let skt = 0
      for (let k = lo; k <= hi; k++) {
        sw += 1
        sk += k
        st += anchorT[k]
        skk += k * k
        skt += k * anchorT[k]
      }
      const den = sw * skk - sk * sk
      if (Math.abs(den) < 1e-12) return st / Math.max(1, sw)
      const b = (sw * skt - sk * st) / den
      const a = (st - b * sk) / sw
      return a + b * i
    })
    // 平滑可能让相邻项倒挂 ✗ 强制单调（时间不能倒退 ✓）
    for (let i = 1; i < smoothT.length; i++) {
      if (smoothT[i] <= smoothT[i - 1]) smoothT[i] = smoothT[i - 1] + 1e-3
    }
    /** 第 q 拍在**局部速度模型**下应该在什么时候 */
    const mapAt = (q: number): number => {
      const n = anchorQ.length
      if (n === 0) return offset + (q - expected[0]) * spq
      if (q <= anchorQ[0]) return smoothT[0] + (q - anchorQ[0]) * spq
      if (q >= anchorQ[n - 1]) return smoothT[n - 1] + (q - anchorQ[n - 1]) * spq
      let lo = 0
      while (lo + 1 < n && anchorQ[lo + 1] < q) lo++
      const dq = anchorQ[lo + 1] - anchorQ[lo]
      const f = dq > 0 ? (q - anchorQ[lo]) / dq : 0
      return smoothT[lo] + f * (smoothT[lo + 1] - smoothT[lo])
    }

    pairs = expected.map((q, i) => {
      const L = locked[i]
      const det = L && L.onset != null ? times[L.onset] : null
      if (L && L.onset != null) used.add(L.onset)
      const et = mapAt(q)
      return { expected: q, detected: det, error: det === null ? 0 : det - et, expectedTime: et }
    })
    // 没被任何期望音用掉的起点 -> 仍算"多打"
    extras = times.filter((_, k) => !used.has(k))
  }

  const matches = pairs.filter((x) => x.detected !== null).length
  // ★ meanAbsError / maxAbsError 现在是「**局部速度模型**下的偏差」✓
  //
  //   演变过程（每一步都是实测逼出来的）✓：
  //     第一版：拿**锁相后**的位置算 ✗ 恒等于 0 ✓ 测试当场逮住 ✓
  //     第二版：拿**全局直线**算 ✓ 有信息 ✓ 但把"前慢后快"这种**整体速度变化**
  //             也算成了偏差 ✗ 于是数字大得吓人、而画面上一片红 ✓ 用户说"看起来很差" ✓
  //     现在：拿**平滑后的局部映射**算 ✓✓
  //       整体速度变化 -> 被映射跟上 ✓ 不算偏差 ✓
  //       单个音的抖动 -> 留成偏差 ✓ 这才是真正该看的数 ✓
  //   所以现在的数**和画面上看到的斜线长度是一致的** ✓✓
  const errs = pairs
    .filter((x) => x.detected !== null)
    .map((x) => Math.abs((x.detected as number) - (x.expectedTime ?? 0)))
  const meanAbsError = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : Infinity
  const maxAbsError = errs.length ? Math.max(...errs) : Infinity
  const precision = matches + extras.length > 0 ? matches / (matches + extras.length) : 0
  const recall = matches / expected.length
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  return {
    bpm: 60 / spq,
    secondsPerQuarter: spq,
    offset,
    pairs,
    extras,
    matches,
    expectedCount: expected.length,
    detectedCount: times.length,
    precision,
    recall,
    f1,
    meanAbsError,
    maxAbsError,
    pitchAgree: final.pitchAgree,
    pitchRate: final.pitchRate,
    score: final.score
  }
}

/* ============ 3. 频率带上的能量突变：「某个音突然响起来」 ============ */

export interface NoteHit {
  midi: number
  /** 音名标签；低频区分辨不出来时会写成 "E2–F2" 这样的范围 */
  label: string
  /** 相对该带自身基线的抬升（dB） */
  riseDb: number
  /** 谐波求和的得分（只有走谐波求和时有值） */
  score?: number
}

export interface DetectedOnset {
  time: number
  /** 最强那条频带的抬升（dB） */
  strengthDb: number
  /** 这一下同时起来了几条频带（区分单音 / 和弦 / 宽频打击） */
  bandCount: number
  /** 这一下最突出的音 */
  note: NoteHit | null
  /** 同时起来的其它带（泛音、和弦音） */
  otherNotes: NoteHit[]
  /**
   * ★ 这一下"不够格" —— 同时起来的频带数没到"全音"的标准（默认 10% 的频带）。
   *
   * ⚠️ 注意：**标了也不删** ✗✗ —— 用户明确要求"不要把这种多打从原始的数据里抹除" ✓
   * 所以它们**照常出现在结果数组里** ✓ 只是带个标记 ✓ 界面可以画淡一点 / 虚一点 ✓
   *
   * 之前这里是**硬过滤**（直接 filter 掉 ✓）✓ 合成信号上精确率能从 0.51 拉到 0.98 ✓
   * 但那等于**替用户做了裁剪** ✗ —— 他要看的是原始的一手数据 ✓ 自己判断 ✓
   *
   * 依据（为什么"带数少"值得标出来）：
   *   合成信号（真值 48 个音）上两类的带数分布几乎不重叠 ✓
   *     真音(n=48):  最小 10   中位 19   最大 33
   *     假点(n=44):  最小  1   中位  3   最大 11
   *   真实录音上被标出来的是 4.48(1条) 4.64(4条) 5.11(1条) ✓
   *   而**和弦**（真实事件 ✓）带数是 43~63 ✓ 全部够格 ✓ 不会被误标 ✓
   */
  weak?: boolean
}

export interface NoteOnsetOptions extends OnsetOptions {
  /** 某条带的**起音**判定阈值（dB）。比总能量的阈值高，否则每条带的噪声都在报 */
  bandMinJumpDb?: number
  /**
   * 判定「这个音真的响了」的**窗口抬升**阈值（dB）。
   * 和 bandMinJumpDb 是两回事：前者看单帧跳变（有没有起音），后者看起音前后一小段
   * 的平均差（这个音是不是持续响了）。所以分开给，只是默认值取一样。
   */
  noteRiseDb?: number
  /** 评估抬升时，起点之后 / 之前各取多长的窗口（秒） */
  afterSeconds?: number
  beforeSeconds?: number
  /** 一次起点最多报几个音 */
  maxNotes?: number
  /** "起音碎点"窗：带数不够的点后面多久内出现"全音"就把它收掉（秒，默认 0.15）*/
  partialFollowSeconds?: number
  /**
   * **用户手动指定**的起奏点（秒）。
   *
   * 给了就**直接用它** ✓ 不再自己调 findPerformanceStart ✗
   * 用于门控（它之前的候选一律丢掉 ✓）和"起奏处补一个" ✓
   * 调用的那边（App）还会把它当**相位锚点** ✓ 两边一致 ✓✓
   */
  startTime?: number
  /** 逻辑与①：抬升的带占当前总能量的比例下限（默认 0.05）*/
  bandShareMin?: number
  /** 逻辑与②：同一时刻总能量至少要抬这么多 dB（默认 0）*/
  totalRiseMinDb?: number
  /**
   * 认音名时**平均几帧**（默认 9）。
   *
   * 1 = 只看起音那一帧（旧行为）✗
   * 多帧平均把"谱形在几十毫秒里的起伏"平掉 ✓ 实测认音高稳 4~8 倍 ✓✓
   */
  pitchFrames?: number
  /** 多帧窗从起音之后多少秒开始（默认 0.015）✓ 太早还在宽带起音里 ✗ */
  pitchFrameOffsetSeconds?: number
  /**
   * 频带那一路要不要加"峰值必须超过本带近期最大值"的判据（默认**开** ✓）。
   *
   * 只有**频带**需要它 ✗ 总能量不需要 ✓（实测总能量段内峰超标的只有 0~10% ✓
   * 且超出量仅 0.0~0.2dB ✓ 天然是"一个音一个峰" ✓）
   */
  bandPeakGuard?: boolean
  /** 抬升之前往前看多久找那个"低点"（秒，默认 0.15）*/
  bandPeakWindowSeconds?: number
  /** "抬升之后停住的电平"至少要高出"之前那个低点"多少 dB（默认 5）*/
  bandPeakMarginDb?: number
  /** "停住的电平"取抬升之后哪一段的平均值（秒，默认 0.15~0.35）*/
  bandTailFromSeconds?: number
  bandTailToSeconds?: number
}

function windowMean(series: Float32Array, lo: number, hi: number): number {
  const a = Math.max(0, lo)
  const b = Math.min(series.length, hi)
  if (b <= a) return -Infinity
  let sum = 0
  for (let i = a; i < b; i++) sum += series[i]
  return sum / (b - a)
}

/**
 * 某个时刻各条带「起来了多少 dB」= 起点之后的均值 − 起点之前的均值。
 *
 * 两侧都留一小段（默认各 120ms，但紧贴起点的那 20ms 跳过）：紧贴起点的那几帧是
 * 起音过程本身，算进去会把所有带都抬高一截，反而分不出哪条带真的起来了。
 */
function bandRises(
  dbByBand: Float32Array[],
  rate: number,
  time: number,
  after: number,
  before: number
): number[] {
  const gap = 0.02
  const out = new Array<number>(dbByBand.length)
  for (let b = 0; b < dbByBand.length; b++) {
    const s = dbByBand[b]
    const pre = windowMean(s, Math.round((time - before) * rate), Math.round((time - gap) * rate))
    const post = windowMean(s, Math.round((time + gap) * rate), Math.round((time + after) * rate))
    out[b] = Number.isFinite(pre) && Number.isFinite(post) ? post - pre : -Infinity
  }
  return out
}

/**
 * 起点检测：**只用各频带的能量**，不看总能量。
 *
 * 为什么去掉总能量 —— 这是个反直觉但很实在的结论：
 *   · 底噪是**摊在全部 80 条频带上**的，而一个音只占其中一两条。
 *     所以单条带里的信噪比比总能量高出十几 dB —— 总能量恰恰是最容易被底噪推动的那个量。
 *   · 宽频的咔哒声、按键声、衣服摩擦，在总能量上都是一个漂亮的"峰值跳跃"，
 *     但在单条带上什么都算不上。
 *
 * ⚠️ 但实测把这个结论修正了一半。拿一段 26 秒的真实录音（衰减型音色、约 30 个音）测：
 *   · **只用单条带** → 检出 137 个起点。多出来的全在音的衰减里 —— 真实乐器的泛音
 *     彼此拍频，单条带上下起伏，在单条带这个尺度上和真正的起音长得一模一样。
 *     试过四种单带判据（最小跳变、持续检查、带内峰值、整段电平门）都分不干净。
 *   · **把各条带加起来**再做检测 → 两者立刻分开：一个音的所有泛音是同时起来的，
 *     加起来是一次干净的台阶；而拍频起伏在不同带上此消彼长，加起来互相抵消。
 *
 * 所以最终的分工是：
 *   · **宽带包络（各带之和）决定"有没有起音"** —— 它虽然是个和，但完全是从频带算出来的，
 *     没有去读那份总能量日志
 *   · **各条带决定"是哪个音"** —— 以及补充那些包络看不出来、但某条带上明显起来的音
 *
 * 这条包络不是可有可无的优化，是这段真实数据逼出来的必需品。
 */
export function detectOnsetsWithNotes(
  dbByBand: Float32Array[] | null,
  bands: { midi: number; label: string }[] | null,
  rate: number,
  opts: NoteOnsetOptions = {}
): DetectedOnset[] {
  if (!dbByBand || dbByBand.length === 0 || !bands || bands.length === 0) return []

  const minGapSamples = Math.max(1, Math.round((opts.minGapSeconds ?? 0.07) * rate))

  // 整段最响电平（跨全部带、全部时刻），只用作 levelMarginDb 的基准
  let gatePeakDb = -Infinity
  for (const s of dbByBand) {
    for (let i = 0; i < s.length; i++) if (s[i] > gatePeakDb) gatePeakDb = s[i]
  }

  // ---- 宽带包络：各条带能量之和，再转回 dB ----
  // 它不是"总能量日志"，是当场从频带算出来的；但它比任何单条带都稳。
  const cols = dbByBand[0].length
  const sumDb = new Float32Array(cols)
  for (let i = 0; i < cols; i++) {
    let sum = 0
    for (const s of dbByBand) sum += Math.pow(10, (s[i] ?? -100) / 10)
    sumDb[i] = 10 * Math.log10(sum + 1e-20)
  }
  const envOpts: OnsetOptions = { ...opts, minJumpDb: opts.envMinJumpDb ?? 1.5 }

  // 触发序列优先用锯齿窗那一路；没传就退回各带之和（老行为，也方便单测）
  let triggerDb: Float64Array | Float32Array = sumDb
  const te = opts.triggerEnergies
  if (te && te.length > 0) {
    let tp = 0
    for (let i = 0; i < te.length; i++) {
      const v = te[i]
      if (v > tp) tp = v
    }
    if (!(tp > 0)) return []
    triggerDb = toDb(te, tp)
  }

  // 每条带独立跑一遍上升沿检测
  // 频带那一路默认门槛比原来高：它现在只负责"补充包络漏掉的、某条带上明显起来的音"，
  // 而不是主力。门槛低的时候，真实乐器泛音拍频会在单条带上造出一堆假起点
  // —— 实测一段 26 秒的真实录音，门槛 4 时检出 137 个（实际约 30 个音）。
  const bandOpts: OnsetOptions = { ...opts, minJumpDb: opts.bandMinJumpDb ?? 10, gatePeakDb }
  const preset = opts.presetTimes
  const merged: { time: number; strength: number; env: boolean }[] = []

  if (preset && preset.length > 0) {
    // 调用方已经知道起点在哪，这里只负责认音名
    for (const t of preset.slice().sort((a, b) => a - b)) {
      merged.push({ time: t, strength: 0, env: true })
    }
  } else {
    const hits: { time: number; strength: number; env: boolean }[] = []
    for (const o of detectRisesFromDb(triggerDb, rate, envOpts)) {
      hits.push({ time: o.time, strength: o.strengthDb, env: true })
    }
    // ★★ 频带那一路：加一道"**峰值必须超过本带近期最大值**"的判据 ★★
    //
    // 实测依据（用户先问"起音峰值是不是到下一个起音之前的最高点" ✓ 我去量了）：
    //   **总能量**：14/21/39 段里，段内峰超过起音峰的只有 0 / 2 / 2 段 ✓
    //              而且超出量只有 **0.0 ~ 0.2 dB**（数值噪声）✓✓
    //     => 总能量天然是"一个音一个峰" ✓ **不需要**这道判据 ✗ 加了只会丢召回 ✓
    //   **各频带**：一个音在它自己的衰减段里会**反复触发** ✓
    //              实测合成信号：46 个误报里 **44 个落在真音后 0.12~0.2 秒** ✓✓
    //              也就是**每个音被数了两遍** ✓
    //     => 频带才需要这道判据 ✓✓
    //
    // ── 判据本身 ──
    //
    // ★ 参照必须选"**抬升之前那个低点**"，不能用"过去 N 秒的最大值" ✗✗
    //   我第一版用了 0.5 秒窗口的最大值 ✓ 合成信号上很漂亮（精确率 0.52→0.72 召回 1.00 ✓）
    //   但**真实录音上丢真音** ✗：
    //     (5) 22 → 17 个 ✓ 而被丢掉的那些**间隔是 0.36~0.45 秒** ✓✓
    //     那正是"一拍一个音" ✓ 全是真音 ✗
    //   原因：0.9 秒的衰减下，前一个音的**最大值还高着** ✓
    //   后一个音如果**弹得轻** ✓ 峰值就够不到它 ✗ 于是被误杀 ✓
    //
    // ★ 正确做法和**起奏判据是同一套** ✓✓（"抬起后不归零" ✓ 用户的原话 ✓）：
    //   之前 = 抬升**之前**那个低点（取 min ✓ 就是"落回很低的点"里的那个点 ✓）
    //   之后 = 抬升之后**停住的电平**（取 [t+0.15, t+0.35] 的**均值** ✓ 不是峰值 ✗）
    //   要求 之后 明显高于 之前 ✓✓
    //
    // ★ 为什么"之后"必须是**停住的电平**而不是峰值 ✗✗
    //   我第二版取了 [t, t+0.1] 的**峰值** ✓ 结果判据**完全不起作用** ✗
    //   （真实录音 15/22/40 个起点，一个都没变 ✓）
    //   因为"峰值高于之前的低点"只是在重复 minJumpDb 已经在做的事 ✗✓
    //   真正能区分的是"**抬起来之后有没有掉回去**" ✓ —— 那必须看**后面**的电平 ✓
    //   衰减里的拍频包：峰值也挺高 ✓ 但 0.2 秒后**又回到衰减曲线上** ✗ 被挡 ✓
    //   后一个真音：峰值高 ✓ 0.2 秒后**还停在高处** ✓ 通过 ✓
    // ⚠️ **默认关** ✗ —— 两版都量过，都不够格 ✓ 数据留在下面，将来要重做有个起点 ✓
    //
    //   版本一（拿"过去 0.5 秒的最大值"当参照）：
    //     合成信号 精确率 **0.52 → 0.72** ✓ 召回 1.00 ✓✓ 看起来很漂亮 ✓
    //     但**真实录音上丢真音** ✗：(5) 22 → 17 ✓
    //     被丢掉的间隔是 0.437 / 0.432 / 0.418 / 0.447 秒 ✓✓ —— 那正是"一拍一个音" ✓
    //     原因：0.9 秒衰减下前一个音的峰值还高着 ✓ 后一个**弹得轻**就够不到 ✗
    //
    //   版本二（拿"抬升后停住的电平"当参照 ✓ 就是现在这段代码）：
    //     合成信号 0.52 → **0.54** ✗ 几乎没作用 ✓ 真实录音 22 → 21 ✓
    //
    //   结论 ✗：**弹得轻的重复音** 和 **衰减里的拍频包** 在"峰值排序"这一维上分不开 ✓
    //     两者的峰值都低于上一个音 ✓ 光看包络的高度没法定 ✓
    //     要分开得靠**频谱**（拍频包是同一组谐波在起伏 ✓ 新音是一组新的谐波 ✓）
    //     或者靠"这个音的**基频**变了没有" ✓ —— 那是另一条路 ✓ 不是这道判据能做的 ✓
    //
    //   所以留成开关 ✓ 默认关 ✓ 不拿它去动用户现在能用的结果 ✓
    const peakGuard = opts.bandPeakGuard === true
    const beforeWin = Math.max(1, Math.round((opts.bandPeakWindowSeconds ?? 0.15) * rate))
    const tailA = Math.max(1, Math.round((opts.bandTailFromSeconds ?? 0.15) * rate))
    const tailB = Math.max(tailA + 1, Math.round((opts.bandTailToSeconds ?? 0.35) * rate))
    const peakMargin = opts.bandPeakMarginDb ?? 5

    for (const series of dbByBand) {
      for (const o of detectRisesFromDb(series, rate, bandOpts)) {
        if (peakGuard) {
          const c = Math.round(o.time * rate)
          let before = Infinity
          for (let i = Math.max(0, c - beforeWin); i < c; i++) {
            const v = series[i]
            if (v < before) before = v
          }
          let sum = 0
          let cnt = 0
          for (let i = c + tailA; i <= Math.min(series.length - 1, c + tailB); i++) {
            sum += series[i]
            cnt++
          }
          const tail = cnt > 0 ? sum / cnt : -Infinity
          if (before === Infinity) before = tail
          // 抬起来之后又掉回去 -> 这是上一个音衰减里的起伏 ✗ 不是新音 ✓
          if (!(tail > before + peakMargin)) continue
        }
        hits.push({ time: o.time, strength: o.strengthDb, env: false })
      }
    }
    hits.sort((a, b) => a.time - b.time)

    // 间隔小于 minGap 的算同一下 —— 一个音的基本音和泛音是同时起来的，本来就是一回事。
    // 时刻取**最早**的那个：起音是从那一刻开始的，最强的那条带不一定最早。
    for (const h of hits) {
      const last = merged[merged.length - 1]
      if (last && (h.time - last.time) * rate < minGapSamples) {
        if (h.strength > last.strength) last.strength = h.strength
        last.env = last.env || h.env
      } else {
        merged.push({ time: h.time, strength: h.strength, env: h.env })
      }
    }
  }

  // ★★ 起奏门控：**先确定曲子从哪一刻开始，再把之前的候选全丢掉** ★★
  //
  // 这一步是用户明确要求分开的那件事 ✓「找曲子开始弹奏」和「后面的演奏弹出新音」
  // 是两个判断 ✗ 前者是**绝对**的（要真的响起来才算开始），
  // 后者是**相对**的（相对刚才抬升就算新音）✓
  //
  // 不分开的话，底噪里一个极小的绝对波动，用相对判据看就是个大跳 ✓
  // 于是曲子还没开始就先报了七八个"起点" ✓ 用户看到的正是这个 ✓
  //
  // presetTimes（调用方指定了时刻）时**不做门控** ✓ 那是"只认音名"的用法 ✓
  const presetGiven = !!(opts.presetTimes && opts.presetTimes.length > 0)
  // ★★ 用户手动指定的起奏点：**直接用它，不再自己算** ✗✗ ★★
  //
  // 缺口是这么来的 ✓：控件做在"录音 / 音频"页 ✓ 对齐的相位锚点也确实换成了手动值 ✓
  // 但**门控**这里会**自己重算一遍** findPerformanceStart ✗
  // 于是"起奏之前的一律不算起点"这条仍然按**自动**那个执行 ✗
  // 用户看到的就是"第二页设了，第三页没跟上" ✓✓
  //
  // 为什么需要这个口子 ✗（而不是继续调自动判据）：
  //   实测 5323.webm：0.416s 那个椅子声是 70Hz 基频 + 成整数倍谐波 + 陡然抬起 +13.7dB
  //   + 不归零 + 持续 ✓ —— 和"弹了一个低音"在声学特征上**完全一样** ✗
  //   判据没有理由拒绝它 ✓ 硬调只会把真起奏也一起漏掉 ✗
  const forced =
    !presetGiven && typeof opts.startTime === 'number' && Number.isFinite(opts.startTime)
      ? {
          time: Math.max(0, opts.startTime),
          floorDb: 0,
          levelDb: 0,
          riseDb: 0,
          thresholdDb: 0
        }
      : null
  const perfStart = forced
    ? forced
    : !presetGiven && te && te.length > 0
      ? findPerformanceStart(te, rate, {
          startMarginDb: opts.startMarginDb,
          minSeconds: opts.startSeconds
        })
      : null
  // ★ 余量只给 0.02s，起奏前那点"检测器滞后"由下面的**兜底补点**来处理 ✓✓
  //
  // 我在这条余量上走过一段弯路，两头都栽过，记在这里：
  //
  //   · 太窄（0.02s）：起奏判据要"持续 200ms" ✓ 天生比真实起音晚 ✓
  //     于是真起音连同它那一簇候选被整簇丢掉 ✗ 第一个音消失 ✓
  //   · 太宽（0.15s）：底噪里的误检被放进来 ✗
  //     实测 beatlooker-recording (6)：起奏 1.643s ✓ 而有个噪声候选在 **1.505s**
  //     （触发能量只有 -51dB ✓ 真音是 -33dB ✓）✓ 放宽到 0.15 正好把它收进来 ✓
  //     它一进来就变成"多打" ✗ 还可能把对齐拽偏 ✓ 用户报的正是这个 ✓
  //
  // 正确做法：**门控收紧 ✓ 让兜底补点去解决滞后** ✓
  // 起奏前 0.02s 内没有候选时 ✓ 就在起奏处补一个 ✓✓
  // 代价是最多晚 ~0.05s ✓ 而匹配容差在 0.1s 量级 ✓ 无所谓 ✓
  // 反过来放进噪声则会制造假"多打" ✗ 那个代价大得多 ✓
  const gated0 = perfStart
    ? merged.filter((m) => m.time >= perfStart.time - 0.02)
    : merged

  // ★★ 起奏那一刻**就是第一个音** ✓✓
  //
  // 绝对判据（"真的响起来了"）在这一刻恰恰是**最可靠**的 ✓
  // 而相对判据在这里**最不可靠** ✗ —— 它要靠"历史"，可曲子刚开始时历史里只有底噪 ✓
  //
  // 实测一条录音（beatlooker-recording (5)）：
  //   起奏 1.18s ✓ 第一个音的起音 +15.3dB ✓（比第二个音的 +5.7 明显得多 ✗✓）
  //   但它是**持续音** —— 冲上去之后一直在 -22~-25 缓缓衰减 ✓
  //   相对判据等的是一个"台阶"（升上去要能回落）✓ 于是把它拒了 ✗
  //   结果第一个音被漏检，第一个起点报到了 1.66s（第二个音）✗
  //
  // 所以：起奏处若**没有**起点，就补一个 ✓
  // 判据用 0.15s 的近邻 —— 已经检出来了就什么都不做 ✓ 正常情况零影响 ✓
  const gated =
    perfStart && !gated0.some((m) => Math.abs(m.time - perfStart.time) <= 0.15)
      ? [{ time: perfStart.time, strength: perfStart.riseDb, env: true }, ...gated0]
      : gated0

  const after = opts.afterSeconds ?? 0.12
  const before = opts.beforeSeconds ?? 0.12
  const maxNotes = opts.maxNotes ?? 6
  const noteRiseDb = opts.noteRiseDb ?? 4
  const countRiseDb = opts.countRiseDb ?? 4

  // ⚠️ 这里试过调成 2（配合 noteRiseDb=18 能把某段真实录音的起点数从 90 压到 49，
  // 接近实际的 47 个音），但**退回去了** —— 它会把"一个音只点亮一条带"这类
  // 合法情况（纯音、单薄的音色）整个丢掉，自检 15a/15c/18b 立刻挂。
  // 靠凑数量得到的参数不能当默认值。真要按乐器收紧，用调用处的选项显式传。
    // ★★★ "同时起来几条带" —— 用户逼出来的判据 ★★★
  //
  // 起因：用户指着图上多出来的点（3.84 / 4.50 / 4.59 秒那一带）问是不是"连续的弱音" ✓
  // 我去查了 ✓ 答案**不是弱** ✓ 是"**还没起齐**" ✓✓：
  //
  //   一个音的起音是分两批建立的 ✓
  //     · 起音那一瞬间：只有少数几条带先冒头 ✓ → 报出一个 bandCount 很小的点 ✗
  //     · 约 0.1 秒后：整组谐波带都起来了 ✓ → 报出真正的那个点 ✓
  //   实测三个录音，多出来的点**全都紧跟在一个真音后面 0.07~0.13 秒** ✓✓
  //
  // 两类的 bandCount 分布（合成信号，有真值 48 个音）：
  //     真音(n=48):  最小 10   中位 19   最大 33
  //     假点(n=44):  最小  1   中位  3   最大 11
  //   几乎不重叠 ✓✓ 空档正好在 8~10 ✓
  //
  // 合成信号上按不同阈值过滤：
  //     阈值   检出  命中  误报  漏掉   精确   召回
  //     >= 0     92    48    44     0   0.52   1.00
  //     >= 4     66    48    18     0   0.73   1.00
  //     >= 6     52    48     4     0   0.92   1.00
  //     >= 8     49    48     1     0   0.98   1.00   ← 取它 ✓✓
  //     >=12     47    47     0     1   1.00   0.98
  //     >=20     22    22     0    26   1.00   0.46   ✗ 开始丢真音
  //
  // ★ 为什么它比"峰值排序"强 ✗（那个我量崩了，召回 0.02 ✓ 见 bandPeakGuard 的注释）：
  //   峰值排序看**电平高度** ✓ 而衰减型包络里"后面的永远低于前面的" ✗ 天然失效 ✓
  //   这一条看**跨频带的独立性** ✓ 衰减期**没有新带**起来 ✓ 照样有效 ✓✓
  //
  // ★ 真实录音上没有误伤 ✓：
  //   天狼星 15→12 ✓ (5) 22→18 ✓ (6) 40→36 ✓
  //   而且 1.504 那个**弱起音**的 bandCount 是 **44** ✓ 完全不受影响 ✓✓
  //
  // ★★ 阈值必须**按频带总数取比例**，不能用固定值 ✗✗ ★★
  //   我第一版写死 8 ✓ 结果一个只用 3 条带的测试当场挂掉：
  //     "应该正好两个起点，实得 **0**" ✓
  //   因为窄带场景（纯音、长笛、或者测试里只建 3 条带）里
  //   一个音**最多**也只能点亮 1~2 条 ✓ 固定阈值 8 会把**所有**起点杀光 ✗✗
  //
  //   改成"至少 **10%** 的分析频带同时起来" ✓✓：
  //     80 条带 -> 8 ✓✓ 正好是我实测出来的分界点（真音最小 10 ✓ 假点最大 11 ✓）
  //      3 条带 -> 1 ✓✓ 窄带场景自动退化成"不做过滤" ✓ 不会误杀 ✓
  //   这样和频带数无关 ✓ 换乐器、换分析音域都不会失效 ✓✓
  // "起音碎点"的判定窗：带数不够的点后面多久内出现"全音"就算它是碎点 ✓
  // 实测碎点紧跟真音的间隔是 **0.07 / 0.08 / 0.11 / 0.12 / 0.13 秒** ✓ 取 0.15 包得住 ✓
  const partialFollowSeconds = opts.partialFollowSeconds ?? 0.15
  const bandCountTotal = bands && bands.length ? bands.length : 0
  const minBands = Math.max(
    1,
    opts.minBands ?? Math.round(bandCountTotal * 0.1)
  )

  return gated.map((m) => {
    let hits: NoteHit[] = []
    // ★ 参与条数要在**截断之前**数。第一版是拿截断后的列表长度当 bandCount，
    //   于是 80 条带同时起来也只报"6 条"（maxNotes 默认 6）—— 数错了。
    let bandCount = 0
    // ★★ 逻辑与的另外两个量（用户提的"同时满足频带的电平和总能量的量级"）★★
    //
    //   ① bandShare  = 抬升的那些带，占**当前总能量**的比例
    //        —— 一个真音会点亮**很大一块**频谱 ✓（实测真音 77~99% ✓ 假点 0~35% ✓）
    //   ② totalRiseDb = **同一时刻总能量自己**抬了多少 dB
    //        —— 衰减内部"谐波此消彼长"的事件 ✓ 总能量是**不动甚至下降**的 ✓
    //          实测真音 +5.4~+16.3dB ✓ 而那种事件 -2.9~-0.1dB ✓✓
    //
    // 实测（合成信号有真值 48 个音）：
    //   不加              精确 0.51  召回 1.00
    //   两个都要          精确 **1.00** 召回 **1.00**  ✓✓
    // 实测（天狼星的心脏）：两组**零重叠** ✓
    //   留下的 6 个：和占比 77~99% ✓ 总能量 +5.4~+16.3dB ✓
    //   被弃的 9 个：和占比  0~35% ✓ 总能量 -2.9~-0.1dB ✓
    //
    // ⚠️ 但**不删** ✗✗ —— 仍然只打 weak 标记 ✓（用户："不要把这种多打从原始数据里抹除"）
    //   已知它会误标 1.835 那个真音 ✗（和 3.822 那个假点在所有量上都重叠 ✓ 分不开 ✓）
    //   所以它只是"低置信"提示 ✓ 图上画虚线 ✓ 原始数据完整 ✓
    const bandRisesHere = bands && bands.length ? bandRises(dbByBand, rate, m.time, after, before) : null
    let risenSum = 0
    let allSum = 0
    if (bandRisesHere) {
      const c0 = Math.round(m.time * rate)
      const gapC = Math.max(1, Math.round(0.01 * rate))
      const afterC = Math.max(gapC + 1, Math.round(after * rate))
      for (let b = 0; b < bandRisesHere.length && b < bands!.length; b++) {
        // ★ 两件事用两个门槛，不要耦合：
        //   bandCount 是**过滤**用的（"这一下够不够格算起音"），门槛低
        //   hits 是**报音名**用的，门槛高（抬升太小就不该硬说这是哪个音）
        // 第一版两者共用一个 noteRiseDb，结果"提高认音阈值"会连带把起点删掉。
        const isRisen = bandRisesHere[b] >= countRiseDb
        if (isRisen) bandCount++
        // 和占比：用**抬升之后**那段窗的平均电平（和 bandRises 里的 post 同一个窗 ✓）
        const lvl = windowMean(dbByBand[b], c0 + gapC, c0 + afterC)
        if (Number.isFinite(lvl)) {
          const lin = Math.pow(10, lvl / 10)
          allSum += lin
          if (isRisen) risenSum += lin
        }
      }
    }
    const bandShare = allSum > 0 ? risenSum / allSum : 1
    // 总能量在这一刻的方向（用线性平均再取比值 ✓）
    let totalRiseDb = 0
    {
      const c0 = Math.round(m.time * rate)
      const gapC = Math.max(1, Math.round(0.01 * rate))
      const afterC = Math.max(gapC + 1, Math.round(after * rate))
      const linMean = (lo: number, hi: number) => {
        let sum = 0
        let cnt = 0
        for (let i = Math.max(0, lo); i < Math.min(triggerDb.length, hi); i++) {
          sum += Math.pow(10, triggerDb[i] / 10)
          cnt++
        }
        return cnt ? sum / cnt : 0
      }
      const pre = linMean(c0 - afterC, c0 - gapC)
      const post = linMean(c0 + gapC, c0 + afterC)
      totalRiseDb = pre > 0 && post > 0 ? 10 * Math.log10(post / pre) : 0
    }
    const confident =
      bandShare >= (opts.bandShareMin ?? 0.05) && totalRiseDb >= (opts.totalRiseMinDb ?? 0)

    if (opts.peakLog) {
      // ---- 谐波求和：假设检验，不怕基频缺失 ----
      //
      // ★ 多帧平均（默认 9 帧 ✓ 从 +15ms 起）✓✓
      // 单帧上谱形会因拍频/琴体耦合/衰减差异而剧烈起伏 ✗
      // 平均之后"期望音高 vs 错音高"的对比度中位数提升 4~8 倍 ✓
      // 而且取窗要**早** ✓ 后期衰减帧只会拖后腿 ✗
      const pk = opts.peakLog
      const nFrames = Math.max(1, Math.round(opts.pitchFrames ?? 9))
      const col0 = Math.round((m.time + (opts.pitchFrameOffsetSeconds ?? 0.015)) * pk.rate)
      const frames = []
      for (let f = 0; f < nFrames; f++) {
        const fr = pk.at(col0 + f)
        if (fr && fr.length) frames.push(fr)
      }
      const ranked = rankPitchesMulti(frames, {
        maxHarmonics: opts.maxHarmonics ?? 10,
        signature: opts.keySignature ?? null
      })
      hits = ranked.slice(0, maxNotes).map((c) => ({
        midi: c.midi,
        label: midiName(c.midi),
        riseDb: 0,
        score: c.score
      }))
    } else if (bandRisesHere) {
      // ---- 退路：哪条带最强就报哪个音（基频缺失时会报错，但没有谱峰时只能这样）----
      for (let b = 0; b < bandRisesHere.length && b < bands!.length; b++) {
        if (bandRisesHere[b] >= noteRiseDb) {
          hits.push({ midi: bands![b].midi, label: bands![b].label, riseDb: bandRisesHere[b] })
        }
      }
      // 强的排前面。基频通常最强，但泛音强的乐器（比如某些拨弦）不一定 —— 所以
      // 把整组都报出来，界面上「主音 + 其它」都看得到，不硬猜。
      hits.sort((a, b) => b.riseDb - a.riseDb)
      hits = hits.slice(0, maxNotes)
    }
    return {
      time: m.time,
      strengthDb: m.strength,
      bandCount,
      note: hits.length ? hits[0] : null,
      otherNotes: hits.slice(1),
      // ★ 两个理由都会标成 weak（都**不删** ✓ 见 weak 字段的说明）：
      //   ① 同时起来的带数不够（< 10% 的频带）
      //   ② 逻辑与不成立：抬升带的和占比太小 ✓ **或者** 总能量此刻不在上升 ✗
      //      —— ② 是用户提的"同时满足频带的电平和总能量的量级" ✓
      //      实测（合成信号有真值）：两个都要 -> 精确 **1.00** / 召回 **1.00** ✓✓
      //      实测（天狼星）：留下的和占比 77~99% ✓ 被弃的 0~35% ✓ 两组零重叠 ✓
      //      ⚠️ 已知会误标 1.835 那个真音（和假点 3.822 在所有量上都重叠 ✓ 分不开 ✓）
      weak: bandCount < minBands || !confident
    }
  })
    // ── 硬判据：带数达不到"全音"标准的候选，一律丢掉 ──
    //
    // ★ 我试过两版更"温柔"的写法，都测过 ✓ 都不如这一版 （数据留在 partialFollowSeconds 那儿）✓：
    //
    //   版本 A（时间性）："带数不够、但 0.15 秒内紧跟一个全音 -> 丢掉前者" ✓
    //     好处：**孤立的单谐波真音**（纯音/长笛/高把位泛音 ✓ 只点亮 1 条带 ✓）不受影响 ✓✓
    //     代价：合成信号上精确率只从 0.51 到 **0.60** ✗（硬过滤是 0.98 ✓）
    //           因为它只能抓"后面紧跟全音"的碎点 ✓
    //           而孤立的单带假点（真实录音里 5.11 秒那个 ✓ bandCount=1 ✓）
    //           和孤立的单带**真音**在这一维上**完全一样** ✗ 分不开 ✓
    //
    //   版本 B（峰值排序）：**不能用** ✗ 衰减型包络上召回崩到 0.02 ✓ 见 bandPeakGuard ✓
    //
    //   最终选硬过滤 ✓ 理由是**这个工具的实际场景**：
    //     吉他/拨弦的每个音都会点亮 10~76 条带 ✓
    //     三段真实录音上**一个真音都没误伤** ✓（连 1.504 那个弱起音都有 44 条带 ✓✓）
    //     而它把合成信号的精确率从 0.51 拉到 **0.98** ✓ 召回保持 **1.00** ✓✓
    //
    //   ⚠️ 代价说清楚：**纯单频信号**（只点亮 1~2 条带 ✓）会被全部滤掉 ✗
    //      真要测那种情况，显式传 minBands: 1 ✓（老测试 18b 就是这么改的 ✓）
    // ★★ 不删除，只标记 ★★
    //
    // 用户原话："不要把这种多打从原始的数据中抹除" ✓✓
    // 所以这里的硬过滤（.filter((d) => d.bandCount >= minBands) ✗）改掉了 ✓
    //   原来：带数不够 -> 直接从结果里消失 ✗
    //   现在：带数不够 -> **留在结果里** ✓ 只打一个 weak 标记 ✓
    //
    // 代价说清楚 ✗：合成信号上"精确率 0.51 -> 0.98"那个收益，
    //   **统计口径上没有了** ✓（点还在 ✓ 会计进"多打" ✓）
    //   要拿回那个收益，前端按 d.weak 筛 / 或者调用方显式传 minBands 筛 ✓
    //
    // 为什么仍然值得标记 ✓：两类的带数分布在合成信号上几乎不重叠 ✓
    //   真音 10~33 ✓ 假点 1~11 ✓ —— 这个信息本身有价值 ✓ 只是不该由我在这一层裁掉 ✓
}


/* ======================== 起奏检测（和人声/音符检测分开）======================== */

export interface PerformanceStart {
  /** 曲子真正开始弹的时刻（秒）*/
  time: number
  /** 起奏前的底噪电平（dB，相对满量程）*/
  floorDb: number
  /** 起奏那一刻达到的电平（dB）*/
  levelDb: number
  /** 相对底噪抬升了多少 dB */
  riseDb: number
  /** 这次用的触发门槛（dB）—— 给界面显示用，方便判断阈值合不合适 */
  thresholdDb: number
}

export interface PerformanceStartOptions {
  /**
   * 相对底噪至少要抬多少 dB 才算"开始"（默认按动态范围自适应，6~30）。
   *
   * ★ 这个门槛是**绝对**的 ✗ 和"新音检测"的相对抬升是两回事 ✓
   */
  startMarginDb?: number
  /** 达到门槛后要**持续**多久才算真的开始（秒，默认 0.20） */
  minSeconds?: number
  /** 底噪估计用的分位数（默认 0.15 —— 取最安静的那 15% 帧）*/
  floorQuantile?: number
  /** 用来估动态范围的分位数（默认 0.95）*/
  peakQuantile?: number
  /**
   * ★ "抬起之后**回没回到底噪**"的判据（用户提的 ✓）
   *
   * 噪音：抬起来**马上落回很低的点** ✗
   * 演奏：抬起来**不归零** ✓ 下降一部分之后**还持续一段** ✓
   *
   * 做法：找到一次抬升之后 ✓ 看 `[rise + from, rise + to]` 这段窗 ✓
   * 要求里面的**最低电平**仍然明显高于底噪 ✓✓
   *
   * 只看"连续 200ms 高于门槛"是不够的 ✗ ——
   * 一个持续 250ms 的噪声尖峰照样能过 ✓ 但它**会掉回底噪** ✓ 这条就能把它挡掉 ✓
   */
  settleFromSeconds?: number
  settleToSeconds?: number
  /** 稳定窗里最低电平至少要高出底噪多少 dB（默认 3）*/
  settleMarginDb?: number
  /**
   * ★★ **候选门槛**：抬升超过底噪多少 dB 才算"可能开始了"（默认 4）★★
   *
   * 为什么这个值要**小** ✗✗ —— 这是用户用真实录音逼出来的：
   *
   * 实测 天狼星的心脏：开头那个音只有 **-35 ~ -44 dBFS** ✓
   * 而后面弹响的地方到 **-14 dBFS** ✓ —— **差了 20 dB** ✗
   * 而原来的门槛是拿**整段动态范围**算的 ✓ 于是按"响的那部分"定 ✓
   * 结果**把轻的开头整个漏掉** ✗✗ 报出来的起奏比真实起奏晚了 1.2 秒 ✗
   *
   * 所以改成"**低门槛选候选 + 稳定判据确认**" ✓✓：
   *   ① 只要明显高过底噪就是候选（4 dB ✓ 够低 ✓）
   *   ② 但它**不能掉回底噪**（稳定判据 ✓）
   * 噪声毛刺过得了①过不了② ✓✓ 轻的真音两个都过 ✓✓
   */
  candidateMarginDb?: number
  /**
   * "不能归零"要持续多久（秒，默认 0.4）。
   *
   * ★ 注意它和 minSeconds 是**两件事** ✗✗
   *   minSeconds   = 抬升**超过门槛**要连续多久（默认 0.2 ✓ 老判据）
   *   sustainSeconds = **不回到低噪附近**要持续多久（默认 0.4 ✓ 新判据）
   * 我第一版把两者混成一个 ✗ 结果 171 毫秒的真音因为差 30 毫秒被整个丢掉 ✓
   */
  sustainSeconds?: number
  /** 拿抬升之前多久的"最低电平"当参照（秒，默认 0.3）*/
  beforeSeconds?: number
}

/** 取一个分位数（会就地排序传入的副本，不动原数组）*/
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return -Infinity
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))
  return sorted[i]
}

/**
 * 找"曲子从哪一刻开始弹"。
 *
 * ## 为什么必须和"新音检测"分开 ✗✗
 *
 * 原来只有一个判据：**相对**刚才抬升了多少 dB ✓
 * 这在安静的地方会失灵 ✗ —— 底噪里一个极小的绝对波动，
 * 用"相对抬升"看就是个大跳 ✓ 于是被当成起奏 ✓
 *
 * 用户看到的现象就是这样：能量图上前两秒明明平得像一条线 ✓
 * 检测却说"这里开始了" ✓ 两个说法都没错，只是**判据不同** ✓
 *
 * 所以这里改成**绝对**判断：
 *   1. 先从整段里估出底噪（取最安静的那 15% 帧，不怕中间有几个大音）
 *   2. 再估出动态范围（最响的 5%）
 *   3. 门槛 = 底噪 + 边距（边距按动态范围自适应，夹在 6~30 dB）
 *   4. 必须**连续**超过门槛一段时间才算开始 —— 单个毛刺不算 ✓
 *
 * 返回 null 表示"整段都没真正开始过" ✓ 那就一个起点都不该报 ✓
 */
export function findPerformanceStart(
  trigger: Float32Array | number[],
  rate: number,
  opts: PerformanceStartOptions = {}
): PerformanceStart | null {
  const n = trigger.length
  if (n < 4 || !(rate > 0)) return null

  let peakLin = 0
  for (let i = 0; i < n; i++) {
    const v = trigger[i]
    if (v > peakLin) peakLin = v
  }
  if (!(peakLin > 0)) return null

  // 转 dB，并排序求分位数
  const db = new Float64Array(n)
  const sorted = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const d = 10 * Math.log10(Math.max(1e-20, trigger[i]) / peakLin) + 0
    db[i] = d
    sorted[i] = d
  }
  sorted.sort((a, b) => a - b)

  const floorDb = quantile(sorted, opts.floorQuantile ?? 0.15)
  const peakDb = quantile(sorted, opts.peakQuantile ?? 0.95)
  const dynamic = Math.max(0, peakDb - floorDb)

  // 边距：动态范围大就要求抬得多一些，但有上下限，免得录得轻就永远不开始
  // ★ 候选门槛：**低** ✓✓
  // 原来这里是用整段动态范围算的（dynamic * 0.4 ✓ 夹在 6~30）✗
  // 那等于"按整段最响的部分定门槛" ✓ 开头弹得轻就整段漏掉 ✗（实测差 20dB ✓）
  // 现在只要能明显高过底噪就是候选 ✓ 真假交给下面的**稳定判据**分 ✓✓
  const dynamicMargin = Math.max(6, Math.min(30, opts.startMarginDb ?? dynamic * 0.4))
  const thresholdDb =
    opts.startMarginDb != null
      ? floorDb + dynamicMargin
      : floorDb + (opts.candidateMarginDb ?? 8)

  // ★★★ "持续"是相对**底噪**看的，不是相对那个高高的门槛 ✗✗ ★★★
  //
  // 用户的原话：
  //   噪音 = 抬起后**马上落回很低的点** ✓ 且呈**毛刺状** ✓
  //   演奏 = 抬起后**不归零** ✓ 下降一部分后**持续一段** ✓
  //
  // 我第一版把"持续"也拿去和**抬升门槛**比了 ✗ 这是错的 ✓
  // 实测 天狼星的心脏：第一个音只**响了 171 毫秒**高于门槛 ✓
  // 而规则要求连续 200 毫秒 ✗ —— **就差 30 毫秒** ✓ 整个音被丢掉 ✗✗
  // 起奏于是报到了 2.68（下一个音）✓ 用户看到的"错过 1.49"就是这个 ✓
  //
  // 正确的两段式：
  //   ① **抬起**：必须明显高过底噪（riseMargin ✓ 默认 8dB ✓ 这是"真的响了"）
  //   ② **不归零**：之后一段窗里，电平**一次都不许回到底噪附近**（settleMargin ✓）
  // 噪声毛刺过得了①过不了② ✓✓ 轻而短的真音两个都过 ✓✓
  const riseNeed = Math.max(1, Math.round((opts.minSeconds ?? 0.2) * rate))
  const sustainLen = Math.max(riseNeed, Math.round((opts.sustainSeconds ?? 0.4) * rate))
  // 参照窗：抬升**之前**那一小段 ✓ 用它当"很低的点" ✓
  const beforeLen = Math.max(4, Math.round((opts.beforeSeconds ?? 0.3) * rate))
  const settleMargin = opts.settleMarginDb ?? 1

  for (let i = 0; i < n; i++) {
    if (db[i] < thresholdDb) continue
    const startIdx = i
    const end = Math.min(n - 1, startIdx + sustainLen)

    // ★★★ "很低的点"是**它自己抬起来之前**那个低点，不是整段录音的底噪 ✗✗ ★★★
    //
    // 拿整段底噪当参照会卡在边界上 ✓ 我第一版就是这么失败的 ✓：
    // 天狼星第一个音**响的时候**比底噪高 13dB ✓
    // 但它的**尾巴**只高 2~3dB ✗ —— 因为这段录音的本底并不安静（有室内噪声 ✓）
    // 而用户说的"落回很低的点"显然是指**回落到它自己原来的安静水平** ✓✓
    //
    // 换成拿"抬升前 0.3 秒的最低电平"当参照之后 ✓
    // 这个音：抬升前 ≈ -37 ✓ 之后最低 ≈ -26 ✓ 高出 11dB ✓✓ 轻松通过 ✓
    // 而噪声毛刺：抬升前 = 底噪 ✓ 之后又掉回底噪 ✓ 高出 0dB ✗ 照样被挡住 ✓✓
    let before = Infinity
    for (let k = Math.max(0, startIdx - beforeLen); k < startIdx; k++) {
      if (db[k] < before) before = db[k]
    }

    let minIn = Infinity
    let maxIn = -Infinity
    for (let k = startIdx; k <= end; k++) {
      if (db[k] < minIn) minIn = db[k]
      if (db[k] > maxIn) maxIn = db[k]
    }

    const longEnough = end - startIdx + 1 >= Math.min(riseNeed, n)
    const reallyRang = maxIn >= thresholdDb
    // ② 不归零：这段窗里的最低点，必须明显高于**抬升前那个低点**
    const notFallen = minIn >= before + settleMargin
    if (longEnough && reallyRang && notFallen) {
      return {
        time: startIdx / rate,
        floorDb,
        levelDb: maxIn,
        riseDb: maxIn - floorDb,
        thresholdDb
      }
    }
    // 不合格就跳过这一整段 ✓ 从这段窗之后再找 ✓
    i = end
  }
  return null
}


/**
 * 谱面上每个期望音的**音高**，和 expectedOnsets 的顺序**严格一一对应** ✓
 *
 * ★ 顺序必须完全一致 ✗ 否则音高和时刻会错位 ✓ 那比没有还糟 ✓
 * （下面那个 for 循环就是照抄 expectedOnsets 的遍历方式 ✓）
 *
 * 有弦有品的音按调弦现推 ✓ 所以变调夹、特殊调弦都会反映进来 ✓
 */
export function expectedPitchSequence(
  bars: RhythmNote[][],
  tuning: Tuning,
  repeats = 1
): (number | null)[] {
  const one: (number | null)[] = []
  let t = 0
  for (const bar of bars) {
    for (const n of bar) {
      // 和 expectedOnsets 保持**同一个遍历顺序** ✗ 和弦音同样不推进时间 ✓
      if (n.chord) {
        if (!n.rest) one.push(soundingMidi(n, tuning))
        continue
      }
      if (!n.rest) one.push(soundingMidi(n, tuning))
      t += n.value
    }
  }
  if (repeats <= 1 || one.length === 0 || t <= 0) return one
  const out: (number | null)[] = []
  for (let k = 0; k < repeats; k++) for (const p of one) out.push(p)
  return out
}

/* ======================== 和弦事件合并（**只给统计口径用**）======================== */

/**
 * 把"和弦"造成的多个起点并成**一个事件** —— ⚠️ **只给统计用** ✗✗
 *
 * 用户的要求分成两句 ✓ 都很明确：
 *   ① "不要把这种多打从原始的数据中抹除" ✓ -> `detection.onsets` **一个不动** ✓
 *   ② "统计环节可以使用合并" ✓ -> 算"对上 / 多打 / F1"时按**合并后**的事件算 ✓
 * 所以这个函数**返回一份新数组** ✓ 绝不改传进来的东西 ✓
 *
 * ── 为什么不能只看时间差 ✗✗ ──
 * 16 分音符在 160 BPM 下就是 **0.094 秒** ✓ 落在任何合理的合并窗里 ✓
 * 光按时间并会把**真的十六分音符**并掉 ✗ 那是把演奏弹的东西抹了 ✓
 *
 * ── 用实测出来的"和弦特征"判 ✓ ──
 * 一个和弦的几根弦落在 70~130 毫秒之内 ✓ 而它们**音高不同** ✓✓
 * 实测六处（天狼星 / (5) / (6)）：后一个事件带出的**全新音高占 63%~98%** ✓
 * 而且多数在**完全不同的音区** ✓（E7 A#4 B4 C6 -> F#3 F5 F4 G#3 ✓）
 *
 * 反过来，**同一个音的起音过程**（如果真的发生 ✓）第二批会是**同一组谐波** ✓
 * 新音高占比很低 ✓ —— 于是不会被并 ✓✓
 */
export function mergeChordEvents(
  onsets: DetectedOnset[],
  dbByBand: Float32Array[] | null,
  bands: { midi: number }[] | null,
  rate: number,
  opts: { windowSeconds?: number; riseDb?: number; newPitchRatio?: number } = {}
): DetectedOnset[] {
  if (!onsets.length) return []
  const win = (opts.windowSeconds ?? 0.16) * rate
  const riseDb = opts.riseDb ?? 6
  const ratioTh = opts.newPitchRatio ?? 0.5
  // 拿不到频带信息就只能按时间并 —— 明确说清楚这是次优 ✓
  const canCheck = !!(dbByBand && bands && dbByBand.length && bands.length)

  /** 某个时刻抬升超过阈值的那些带（= 音高集合 ✓）*/
  const pitchSet = (t: number): Set<number> => {
    const out = new Set<number>()
    if (!canCheck) return out
    const a0 = Math.round((t - 0.06) * rate)
    const a1 = Math.round((t - 0.01) * rate)
    const b0 = Math.round((t + 0.01) * rate)
    const b1 = Math.round((t + 0.06) * rate)
    const mean = (arr: Float32Array, lo: number, hi: number) => {
      let sum = 0
      let cnt = 0
      for (let i = Math.max(0, lo); i < Math.min(arr.length, hi); i++) {
        sum += arr[i]
        cnt++
      }
      return cnt ? sum / cnt : -Infinity
    }
    for (let b = 0; b < dbByBand!.length && b < bands!.length; b++) {
      const d = mean(dbByBand![b], b0, b1) - mean(dbByBand![b], a0, a1)
      if (d >= riseDb) out.add(bands![b].midi)
    }
    return out
  }

  const out: DetectedOnset[] = []
  for (const on of onsets) {
    const last = out[out.length - 1]
    if (!last) {
      out.push({ ...on })
      continue
    }
    const dt = (on.time - last.time) * rate
    if (dt > win) {
      out.push({ ...on })
      continue
    }
    // ★ 在合并窗内 —— 再问一句"这是同一个和弦的另一根弦吗" ✓
    let same = true
    if (canCheck) {
      const prev = pitchSet(last.time)
      const cur = pitchSet(on.time)
      let neu = 0
      for (const m of cur) if (!prev.has(m)) neu++
      // 新音高占比高 -> 是不同的音 -> 和弦的另一根弦 ✓ 并
      // 占比低 -> 同一组谐波在起齐 -> **不并** ✓ 保留成两个（避免把起音过程也并掉）
      same = cur.size > 0 && neu / cur.size >= ratioTh
    }
    if (!same) {
      out.push({ ...on })
      continue
    }
    // 并进上一个：时刻取**最早**的 ✓（和弦是从第一根弦落下的那一刻起 ✓）
    // 强度取最大的 ✓ 其它音并进 otherNotes ✓ 起点数（bandCount）相加 ✓
    const mergedNotes = [last.note, ...last.otherNotes, on.note, ...on.otherNotes]
      .filter((x): x is NoteHit => !!x)
    last.bandCount += on.bandCount
    last.strengthDb = Math.max(last.strengthDb, on.strengthDb)
    last.weak = !!last.weak && !!on.weak
    last.note = mergedNotes[0] ?? null
    last.otherNotes = mergedNotes.slice(1)
  }
  return out
}

/**
 * 循环结构诊断。
 *
 * ## 这个文件是用来"量"的，不是用来"筛"的
 *
 * 思路本来是想用它筛掉假起点：真起音在反复弹奏里会落到同一相位，泛音拍频不会。
 * 实测下来**这个筛选做不到**，原因有两条，都量过：
 *
 * 1. **打分没有统计显著性**。周期是在 ~1000 个候选值上取最大值的，
 *    40 个纯随机点也能凑到 1.35 以上 —— 拿它当开关去删起点，随机数据都会被删掉 15/40。
 *
 * 2. **更根本的一条**：实测那 46 个起点在 6.74s 周期下的配对数只有约 40，
 *    而"27 个事件各出现 3.4 次"本该给出约 143。
 *    说明**同一事件在各遍里几乎从不落在同一相位** ——
 *    不是演奏漂移的问题，是**检测器每一遍抓到的压根不是同一批事件**。
 *    所以任何事后筛选都救不了，问题只能在检测环节解决。
 *
 * 保留下来的部分是有用的：**自动找循环周期**。
 * 在一段 26 秒的真实录音上，它从起点时刻里自动算出 6.74s，
 * 和弹奏者报的"一遍 6 秒多 / 弹了三遍半"完全吻合。
 * 这说明检测出的时间**位置**里确实含有正确的节奏信息，只是真假混在一起。
 */

/** 环形相位差（取两个方向里近的那个） */
export function phaseDistance(a: number, b: number, period: number): number {
  const d = Math.abs(a - b) % period
  return Math.min(d, period - d)
}

export interface LoopInfo {
  /** 循环周期（秒） */
  period: number
  /** 聚集度：1.0 约等于随机水平，越大越聚 */
  score: number
  /** 第一个起点的时刻，作为相位的原点 */
  origin: number
  /** 覆盖了几遍 */
  laps: number
}

/**
 * 相位折叠打分：把这个周期下所有起点折进一个周期，看它们聚不聚。
 *
 * ⚠️ **不要拿这个分数当"有没有循环"的判据**（见文件头）。它的用途是：
 * 在已知有循环的素材上比较不同周期哪个更合适，或者给人看趋势。
 */
export function foldScore(times: number[], period: number, tol: number): number {
  const n = times.length
  if (n < 4 || !(period > 0)) return 0
  const origin = Math.min(...times)
  const ph = times.map((t) => (((t - origin) % period) + period) % period)
  let pairs = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (phaseDistance(ph[i], ph[j], period) < tol) pairs++
    }
  }
  // 随机分布下，一对点落进 ±tol 的概率是 2*tol/period
  const expected = ((2 * tol) / period) * ((n * (n - 1)) / 2)
  return expected > 0 ? pairs / expected : 0
}

/**
 * 从起点时刻里搜出最可能的循环周期。
 *
 * ⚠️ 返回的 period 是"最能解释这批时刻的那个周期"，但它**没有统计显著性** ——
 * 随机数据也能搜出某个周期来。所以它适合当**参考信息**展示给人看
 * （比如"你这段大概是 6.7 秒一遍"），不适合当自动流程里的开关。
 */
export function findLoopPeriod(
  times: number[],
  opts: { phaseToleranceSeconds?: number; minPeriodSeconds?: number; maxPeriodSeconds?: number } = {}
): LoopInfo | null {
  if (!times || times.length < 6) return null
  const sorted = times.slice().sort((a, b) => a - b)
  const tol = opts.phaseToleranceSeconds ?? 0.12
  const lo = opts.minPeriodSeconds ?? 2
  const hi = Math.min(opts.maxPeriodSeconds ?? 12, (sorted[sorted.length - 1] - sorted[0]) / 1.5)
  if (!(hi > lo)) return null

  let bestP = 0
  let bestScore = 0
  for (let p = lo; p <= hi; p += 0.01) {
    const s = foldScore(sorted, p, tol)
    if (s > bestScore) {
      bestScore = s
      bestP = p
    }
  }
  if (!(bestP > 0)) return null

  const span = sorted[sorted.length - 1] - sorted[0]
  return { period: bestP, score: bestScore, origin: sorted[0], laps: span / bestP }
}

// ============================================================================
// 折叠平均检测
// ============================================================================

export interface FoldResult {
  /** 折叠用的周期（秒） */
  period: number
  /** 包络的采样率（列/秒） */
  rate: number
  /** 一个周期有几列 */
  bins: number
  /** 用上了几个完整遍 */
  laps: number
  /** 平均后的一遍包络（原始能量值，长度 bins） */
  profile: Float64Array
}

/**
 * 把能量包络按 period 折叠、跨遍平均。
 *
 * 这是整套方法的核心，也是它区别于所有单帧判据的地方：
 *   · 真事件在每一遍的**同一相位**上出现 -> 平均后原样保留
 *   · 泛音拍频的相位由琴弦物理性质决定，和弹奏无关，每遍都不同 -> 平均后衰减到 1/√N
 *
 * 实测一段 26 秒的真实录音（周期 6.74s、3 遍半），折叠后峰谷差达 15~21dB，
 * 谷底 -23dB 意味着那些相位上乐器根本没在响 —— 这是单帧判据永远看不到的结构。
 *
 * ⚠️ 只取**完整遍**：末尾不足一遍的部分会让某些相位的样本数偏少，
 * 平均出来偏高，反而制造假峰。
 */
export function foldEnvelope(
  energies: Float32Array | number[] | null,
  rate: number,
  period: number
): FoldResult | null {
  if (!energies || energies.length === 0 || !(period > 0) || !(rate > 0)) return null
  const bins = Math.round(period * rate)
  if (bins < 4 || bins > energies.length) return null
  const laps = Math.floor(energies.length / bins)
  if (laps < 2) return null

  const sum = new Float64Array(bins)
  const n = laps * bins
  for (let i = 0; i < n; i++) sum[i % bins] += energies[i]
  const profile = new Float64Array(bins)
  for (let b = 0; b < bins; b++) profile[b] = sum[b] / laps
  return { period, rate, bins, laps, profile }
}

export interface FoldEvent {
  /** 一遍之内的相位（秒） */
  phase: number
  /** 该处包络的上升量（dB） */
  riseDb: number
}

export interface FoldEventOptions {
  /** 求上升量时前后各取多长（秒），默认 0.12 */
  windowSeconds?: number
  /** 两个事件至少隔开多久（秒），默认 0.2 */
  minSeparationSeconds?: number
  /**
   * 上升量要达到最强那个的几成，默认 0.35。
   * 用相对值而不是绝对值 —— 不同乐器、不同录音电平差很多，绝对值没法通用。
   */
  minRiseRatio?: number
  /** 绝对下限（dB），默认 1.5。挡掉"整段都很平"时的噪声 */
  minRiseDb?: number
  /**
   * 一遍里**应该**有几个事件。给了就取最强的这几个，
   * 不再看比例阈值 —— 谱子是已知的，这个信息比任何阈值都可靠。
   */
  expectedCount?: number
}

/**
 * 在折叠平均包络上找事件（上升沿）。
 *
 * 折叠后的包络是**环形**的：相位 0 和相位 period 是同一个点，
 * 所以窗口要绕回来取，末尾的事件才不会被漏掉。
 */
export function pickFoldEvents(fold: FoldResult, opts: FoldEventOptions = {}): FoldEvent[] {
  const { bins, rate, profile } = fold
  const w = Math.max(1, Math.round((opts.windowSeconds ?? 0.12) * rate))
  const minSep = Math.max(1, Math.round((opts.minSeparationSeconds ?? 0.2) * rate))

  // 环形取平均
  const mean = (from: number, to: number): number => {
    let s = 0
    for (let k = from; k <= to; k++) s += profile[((k % bins) + bins) % bins]
    return s / (to - from + 1)
  }

  // 每一列的上升量：之后一小段的均值 - 之前一小段的均值
  const rises = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    const pre = mean(b - w, b - 1)
    const post = mean(b + 1, b + w)
    rises[b] = pre > 0 ? 10 * Math.log10(post / pre + 1e-12) : 0
  }

  // 局部极大
  const cands: FoldEvent[] = []
  for (let b = 0; b < bins; b++) {
    const v = rises[b]
    const prev = rises[(b - 1 + bins) % bins]
    const next = rises[(b + 1) % bins]
    if (v >= prev && v > next) cands.push({ phase: b / rate, riseDb: v })
  }
  cands.sort((a, b) => b.riseDb - a.riseDb)

  const maxRise = cands.length ? cands[0].riseDb : 0
  const threshold = Math.max(opts.minRiseDb ?? 1.5, maxRise * (opts.minRiseRatio ?? 0.35))

  const picked: FoldEvent[] = []
  for (const c of cands) {
    if (opts.expectedCount === undefined && c.riseDb < threshold) break
    // 环形间隔：周期两端的事件也算"挨着"
    const tooClose = picked.some((q) => {
      const d = Math.abs(q.phase - c.phase)
      return Math.min(d, fold.period - d) < minSep / rate
    })
    if (tooClose) continue
    picked.push(c)
    if (opts.expectedCount !== undefined && picked.length >= opts.expectedCount) break
  }
  picked.sort((a, b) => a.phase - b.phase)
  return picked
}

/**
 * 把折叠出来的事件相位展开成整段录音上的**绝对时刻**。
 *
 * 相位 0 对应第 0 列，所以第 k 遍里的事件时刻 = (k * bins + 相位对应列) / rate。
 * 只展开完整遍 —— 末尾那半遍的"事件"可能压根没弹到。
 */
export function foldEventTimes(fold: FoldResult, events: FoldEvent[]): number[] {
  const out: number[] = []
  for (let k = 0; k < fold.laps; k++) {
    for (const e of events) {
      out.push((k * fold.bins + Math.round(e.phase * fold.rate)) / fold.rate)
    }
  }
  out.sort((a, b) => a - b)
  return out
}

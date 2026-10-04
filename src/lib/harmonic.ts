import { midiToFreq } from './noteBands.ts'

/**
 * 谐波求和（harmonic summation）。
 *
 * ## 为什么需要它
 *
 * 原来的做法是"哪条频带能量最强就报哪个音" ✗ —— 实测这在真实录音上**系统性出错**：
 * 拿四份录音量过，**「基频缺失」是常态而不是例外**（user-3 里 0/7 帧有基频），
 * 基频缺失时最强的往往是 4、5 次谐波 ✓ 于是"最强带 = 音名"必然把 G2 报成 D5 之类 ✓
 *
 * 谐波求和反过来做：**假设基频是 X，看它的各次谐波位置上有没有谱峰、对得上吗** ✓
 * 这是假设检验，不是"谁最大谁赢" ✓ 所以：
 *   · 基频缺失不怕 ✓（它只是在检验一个假设，不要求基频真的存在）
 *   · 音名和起止是**同一次计算**出来的 ✓ 不再是两段
 *
 * ## 三个必须扛住的现实
 *
 * 1. **非谐性**：弦有劲度，高次泛音偏高，偏移大致正比于 h² ✓ 容差必须随 h² 放大
 * 2. **低音区谐波密集**：要限制最高次数和频率上限
 * 3. **高次谐波弱**：要按次数衰减加权，否则噪声当泛音
 */

/** 一个谱峰：抛物线插值后的真实频率和幅度 */
export interface SpectralPeak {
  /** 频率（Hz），已做亚 bin 插值 */
  f: number
  /** 幅度（和 magnitudes 同量纲） */
  m: number
}

/**
 * 找谱峰（抛物线插值）。
 *
 * 这一步不能省：FFT 的 bin 宽 23.4Hz（2048 点 @48kHz），
 * 而低音区一个半音只有 4.9Hz —— 不插值根本分不开，谐波位置也对不准 ✓
 */
export function findPeaks(
  magnitudes: Float32Array | number[],
  sampleRate: number,
  fftSize: number
): SpectralPeak[] {
  const binHz = sampleRate / fftSize
  const out: SpectralPeak[] = []
  const n = magnitudes.length
  for (let k = 2; k < n - 1; k++) {
    const a = magnitudes[k - 1]
    const b = magnitudes[k]
    const c = magnitudes[k + 1]
    if (!(b > a && b >= c) || !(b > 0)) continue
    const denom = a - 2 * b + c
    const d = Math.abs(denom) > 1e-20 ? 0.5 * ((a - c) / denom) : 0
    out.push({ f: (k + Math.max(-0.5, Math.min(0.5, d))) * binHz, m: b })
  }
  return out
}

/* ============================ 调号先验 ============================ */

/** 升号出现顺序的**音级**：F C G D A E B */
const SHARP_ORDER = [5, 0, 7, 2, 9, 4, 11]
/** 降号出现顺序的音级：B E A D G C F */
const FLAT_ORDER = [11, 4, 9, 2, 7, 0, 5]

/**
 * 调号 -> 自然音阶的 7 个音级。
 *
 * 参数就是**五线谱上那几个升降**：正数是升号个数，负数是降号个数（-7..7）。
 *
 * 注意**大小调共用同一套音级** ✓（C 大调和 a 小调都是那 7 个音 ✓）
 * 所以只需要"几个升降"这一个数，不必问大小调 ✓
 */
export function keyPitchClasses(signature: number): number[] {
  const out = [0, 2, 4, 5, 7, 9, 11] // C 大调音级
  const n = Math.min(7, Math.abs(Math.round(signature)))
  if (n === 0) return out
  const order = signature >= 0 ? SHARP_ORDER : FLAT_ORDER
  const shift = signature >= 0 ? 1 : -1
  for (let i = 0; i < n; i++) {
    const idx = out.indexOf(order[i])
    if (idx >= 0) out[idx] = (order[i] + shift + 12) % 12
  }
  return out
}

export interface KeyPrior {
  /** 几个升号（正）或降号（负）；不填或 null = 不用调号先验 */
  signature?: number | null
  /**
   * 调外音级的权重，默认 0.35。
   *
   * **故意不设成 0** —— 用户明确要求"别完全锁死，有的曲子偶尔也会出现谱号外的音" ✓
   * 0.35 意味着：调外音只要比调内竞争者强约 4.5dB 就能反超 ✓
   * 而纯粹靠噪声碰巧凑出来的调外候选，赢不了 ✓
   */
  outOfKeyWeight?: number
}

/** 某个音级在这个调号下的权重 */
export function pitchClassWeight(pitchClass: number, prior: KeyPrior): number {
  const sig = prior.signature
  if (sig === null || sig === undefined) return 1
  const pc = ((pitchClass % 12) + 12) % 12
  return keyPitchClasses(sig).includes(pc) ? 1 : (prior.outOfKeyWeight ?? 0.35)
}

/* ============================ 显著度 ============================ */

export interface SalienceOptions extends KeyPrior {
  /** 最高谐波次数，默认 12 */
  maxHarmonics?: number
  /** 谐波位置的频率上限（Hz），默认 8000 */
  maxHz?: number
  /** 谐波幅度按 h 的多少次方衰减加权，默认 0.5（即除以 √h） */
  harmonicWeightPower?: number
  /**
   * 容差的**绝对下限**（Hz），默认 2。
   *
   * 相对容差在低次谐波上会小于频率测量精度（FFT bin 宽 23.4Hz，
   * 抛物线插值还有零点几赫兹的误差），导致**真基频反而匹配不上** ✓
   */
  tolFloorHz?: number
  /** 候选音高范围（MIDI），默认 24..100 */
  minMidi?: number
  maxMidi?: number
  /**
   * 「该有谐波却没有」的惩罚系数（0~1），默认 0.7。
   *
   * 不设成 1 是有实测依据的：基频缺失是常态 ——
   * 四份真实录音里约一半的帧，最强的谐波是第 4、5 次，基频根本不存在。
   * 罚太狠会把这类真音一起罚掉。
   */
  missPenalty?: number
}

/**
 * 某个候选基频的**显著度**：把它的各次谐波位置上的谱峰加权加起来。
 *
 * 容差随 h² 放大 —— 弦的劲度让高次泛音偏高，偏移大致正比于 h² ✓
 * 这不是凑出来的经验值：一根理想柔弦的泛音是严格整数倍，
 * 真实弦因为**劲度**（stiffness）会有正比于 h² 的偏移 ✓
 */
export function harmonicSalience(
  peaks: SpectralPeak[],
  f0: number,
  opts: SalienceOptions = {}
): number {
  const H = Math.max(1, opts.maxHarmonics ?? 12)
  const maxHz = opts.maxHz ?? 8000
  const wp = opts.harmonicWeightPower ?? 0.5
  const missPenalty = Math.max(0, Math.min(1, opts.missPenalty ?? 0.7))
  const tolFloorHz = Math.max(0, opts.tolFloorHz ?? 2)

  let hit = 0
  let missWeight = 0
  let totalWeight = 0
  for (let h = 1; h <= H; h++) {
    const want = h * f0
    if (want > maxHz) break
    // ★ 容差必须有**绝对下限**。
    //
    // 只用相对容差（0.4%）时，低频谐波的容差会小到比测量精度还低：
    // 实测 G3 的基频理论值 196Hz、谱峰在 194Hz —— 差 2Hz > 196×0.4% = 0.78Hz ✗
    // 结果**它自己的基频匹配不上**，而某个次谐波的高次谐波（容差随 h 放大）
    // 反而卡上了 → G3 被认成 C2（196/3 = 65.4Hz）✓
    //
    // 这就是用户报的"总是从 C 开始"的根因 ✓ 加了下限之后第一个音立刻对了 ✓
    const tol = Math.max(want * (0.004 + 0.00012 * h * h), tolFloorHz)
    let best = 0
    for (const q of peaks) {
      if (Math.abs(q.f - want) <= tol && q.m > best) best = q.m
    }
    const w = 1 / Math.pow(h, wp)
    totalWeight += w
    if (best > 0) hit += best * w
    else missWeight += w
  }
  if (totalWeight <= 0) return 0

  // 两个方向都要对得上，不能只做"有峰就加分"。
  //
  // 只有正向时会栽在次谐波上：一个比真基频低好几倍的假设，其第 h 次谐波
  // 恰好覆盖真谐波的一部分，而且次数大意味着容差宽（容差正比于 h），
  // 于是少数几根大权重的谐波就能把分数顶到和真基频一样高。
  // 实测：G3(196Hz) 的谐波系列，38.9Hz 这个次谐波假设拿了 0.5251，
  // 真基频只有 0.5248 —— 差一点点就输了。
  //
  // 所以"该有峰却没有"必须扣分：38.9Hz 有 8/10 根谐波是空的，真基频只有 4/10。
  // 罚系数不能设成 1：基频缺失是实测里的常态（四份录音里约一半的帧），
  // 罚太狠会把"只有泛音、没有基频"的真音一起罚掉。
  return hit * (1 - missPenalty * (missWeight / totalWeight))
}

export interface PitchCandidate {
  midi: number
  hz: number
  /** 加过调号先验之后的分数 */
  score: number
  /** 没加先验的原始显著度 */
  salience: number
  /** 这一音级在调号下的权重 */
  weight: number
}

/**
 * 在候选音高里排序，最可能的在前。
 *
 * 先验是**乘上去的权重**，不是筛选 —— 调外音不会被删掉，只是需要更强才赢得过调内音 ✓
 */
export function rankPitches(
  peaks: SpectralPeak[],
  opts: SalienceOptions = {}
): PitchCandidate[] {
  const lo = Math.max(0, Math.round(opts.minMidi ?? 24))
  const hi = Math.min(127, Math.round(opts.maxMidi ?? 100))
  const out: PitchCandidate[] = []
  for (let midi = lo; midi <= hi; midi++) {
    const hz = midiToFreq(midi)
    const sal = harmonicSalience(peaks, hz, opts)
    if (sal <= 0) continue
    const w = pitchClassWeight(midi % 12, opts)
    out.push({ midi, hz, salience: sal, weight: w, score: sal * w })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/**
 * **多帧平均**的音高排序。
 *
 * ★ 为什么要平均（实测依据）：
 *   单帧上"期望音高 vs 错音高"的显著度比，中位数只有 4~13 倍 ✓
 *   而一个音在**起音之后**的几十毫秒里，谱形会因为拍频、琴体耦合、
 *   衰减速度不同而剧烈起伏 ✓ —— 这就是用户说的"扰动" ✓
 *   把 9~15 帧的显著度**加起来**再排序，比值中位数升到 17~110 倍 ✓✓
 *   也就是认音高稳了 4~8 倍 ✓
 *
 * ★ 取窗要**早**（实测）：从 +15ms 起比 +30ms 起明显更好 ✓
 *   后期的衰减帧能量低、噪声占比高 ✓ 只会拖后腿 ✗
 *
 * @param frames 若干帧的谱峰，按时间先后
 */
export function rankPitchesMulti(
  frames: SpectralPeak[][],
  opts: SalienceOptions = {}
): PitchCandidate[] {
  const lo = Math.max(0, Math.round(opts.minMidi ?? 24))
  const hi = Math.min(127, Math.round(opts.maxMidi ?? 100))
  const usable = frames.filter((f) => f && f.length)
  if (!usable.length) return []
  const out: PitchCandidate[] = []
  for (let midi = lo; midi <= hi; midi++) {
    const hz = midiToFreq(midi)
    let sal = 0
    for (const f of usable) sal += harmonicSalience(f, hz, opts)
    if (sal <= 0) continue
    const w = pitchClassWeight(midi % 12, opts)
    out.push({ midi, hz, salience: sal, weight: w, score: sal * w })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/* ============================ 旋律连续性 ============================ */

export interface TrackOptions {
  /**
   * 音程惩罚：每走一个半音的代价，默认 0.06。
   *
   * 这一条就是**基础乐理**：旋律的音程分布集中在 1~2 个半音，大跳很少 ✓
   * 所以"让整条线最平滑"比"每帧各自取最大"更接近真实旋律 ✓
   */
  intervalPenalty?: number
  /** 每个起点最多几个候选参与搜索，默认 8 */
  candidatesPerOnset?: number
}

/**
 * 在"每个起点一组候选音高"的图上，用动态规划找**全局最平滑**的一条旋律线。
 *
 * ## 为什么需要它
 *
 * 逐点独立取最大显著度会栽在**八度/五度/十二度歧义**上 ✗ ——
 * 因为同一个谐波系列里多个成员都说得通：
 *   · G3 的 ÷3 次谐波正好是 C2
 *   · C2 和 G2 共享 196Hz / 392Hz 两个谐波
 * 实测：真实旋律 G C D E F G D，逐点最大只能对 1~2 个 ✓
 *
 * 但这些歧义有个共同点：**它们都意味着大跳** ✗
 * 而旋律不会一帧之内跳十二度 ✓ 所以把"音程代价"加进去，
 * 歧义会自然被排除 ✓
 *
 * ## 算法
 *
 * 标准的 Viterbi：状态 = (第 i 个起点, 它的第 j 个候选)，
 * 代价 = Σ (1 − 归一化显著度) + λ Σ |相邻音的音程(半音)| ✓
 */
export function trackMelody(
  perOnset: PitchCandidate[][],
  opts: TrackOptions = {}
): number[] {
  const lam = Math.max(0, opts.intervalPenalty ?? 0.06)
  const keep = Math.max(1, Math.round(opts.candidatesPerOnset ?? 8))
  const n = perOnset.length
  if (n === 0) return []

  // 每个起点只留前 keep 个，并归一化分数（显著度的绝对大小没有可比性）
  const cand = perOnset.map((list) => {
    const top = list.slice(0, keep)
    const max = top.length ? top[0].score : 0
    return top.map((c) => ({ midi: c.midi, cost: max > 0 ? 1 - c.score / max : 1 }))
  })

  // dp[i][j] = 走到第 i 个起点的第 j 个候选的最小累计代价
  const dp: number[][] = []
  const from: number[][] = []
  dp.push(cand[0].map((c) => c.cost))
  from.push(cand[0].map(() => -1))

  for (let i = 1; i < n; i++) {
    const row: number[] = []
    const back: number[] = []
    for (let j = 0; j < cand[i].length; j++) {
      let bestV = Infinity
      let bestK = -1
      for (let k = 0; k < cand[i - 1].length; k++) {
        const step = Math.abs(cand[i][j].midi - cand[i - 1][k].midi)
        const v = dp[i - 1][k] + lam * step
        if (v < bestV) {
          bestV = v
          bestK = k
        }
      }
      row.push(bestV + cand[i][j].cost)
      back.push(bestK)
    }
    dp.push(row)
    from.push(back)
  }

  // 回溯
  let last = 0
  for (let j = 1; j < dp[n - 1].length; j++) if (dp[n - 1][j] < dp[n - 1][last]) last = j
  const out = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    out[i] = cand[i][last].midi
    last = from[i][last]
    if (last < 0 && i > 0) last = 0
  }
  return out
}

import type { ColorStop } from './spectrumImage.ts'

/**
 * 配色方案。
 *
 * ## 为什么要单独一个模块
 *
 * 这个项目的颜色散在两处：CSS 里的界面，和**画布里写死的颜色**。
 * 前者换成变量就行，后者必须走同一份数据源 —— 否则换个浅色主题，
 * 界面变白了、频谱图还是黑的，那就成了拼贴画。
 *
 * 所以这里把颜色收成一份数据：`css` 注入到 :root 给界面用，
 * `canvas` 给绘制代码用。两边同源，不可能对不上。
 *
 * ## 浅色主题的关键
 *
 * 频谱图的色阶方向要**反过来**：深色主题里"静音"是接近背景的黑、
 * "最强"是亮暖色；浅色主题里静音要接近**纸白**、最强要走**深饱和**，
 * 否则在浅底上什么都看不见。
 */

/** 画布用的语义色 —— 检测图、谱面这些"线条"画面用 */
export interface InkTheme {
  /** 画布底色 */
  bg: string
  /** 常规线条（格子、小节线） */
  line: string
  /** 强调线条（首小节、终止线） */
  lineStrong: string
  /** 交替小节底色 */
  shade: string
  /** 主文字 */
  text: string
  /** 次要文字 */
  dim: string
  /** 更淡的文字（刻度） */
  dim2: string
  /** 亮文字（色块上的字） */
  bright: string
  /** 起点标记（琥珀） */
  onset: string
  /** 起点竖线（很淡） */
  onsetSoft: string
  /** 正确 / 对上 */
  ok: string
  /** 错误 / 没对上 */
  warn: string
  /** 强调（另一类事件） */
  accent: string
  /**
   * **配对连线**的颜色（谱面期望音 <-> 实际检测起点）
   *
   * 用户要求："把互相匹配的检测和期望用**蓝色的线**连接" ✓
   * 单独给一个色位 ✓ 而不是借 accent ✓ —— accent 是粉/红的 ✓ 语义也不一样 ✓
   * 这条线的意思是"**这两个是同一个音**" ✓ 所以用冷色 ✓ 和"对/错"的红绿分开 ✓✓
   */
  link: string
  /**
   * **开始点**（用户手动截取的那个）的颜色。
   *
   * 用户要求："让鼠标选择的线和播放进度条的线**颜色不同**" ✓✓
   * 三种线必须一眼分开：
   *   start   开始点   -> 绿
   *   accent  回放头   -> 粉红
   *   link    配对连线 -> 蓝
   */
  start: string
  /** 能量曲线渐变：上 */
  energyTop: string
  /** 能量曲线渐变：下 */
  energyBottom: string
  /** 能量曲线描边 */
  energyStroke: string
  /** 小节号色块（首小节更亮一档） */
  tagFirst: string
  /** 小节号色块 */
  tag: string
  /** 小节号文字 */
  tagText: string
}

export interface CanvasTheme {
  /** 频谱图调色板色标（静音 → 最强） */
  spectrum: ColorStop[]
  /** 能量面板纵向渐变（底 → 顶） */
  energyRamp: ColorStop[]
  ink: InkTheme
}

export interface Theme {
  id: string
  name: string
  dark: boolean
  /** 注入到 :root 的 CSS 变量 */
  css: Record<string, string>
  canvas: CanvasTheme
}

/** 深色主题共用的墨色（画布线条用） */
const inkDark = (bg: string, text = '#e8e8f2', dim = '#8f8fa6'): InkTheme => ({
  bg,
  line: 'rgba(175,195,240,0.82)',
  lineStrong: 'rgba(215,222,245,0.95)',
  shade: 'rgba(140,150,200,0.09)',
  text,
  dim,
  dim2: '#70708c',
  bright: '#e8f4ff',
  onset: '#fbbf24',
  onsetSoft: 'rgba(251,191,36,0.25)',
  ok: '#6ee7b7',
  warn: '#f87171',
  accent: '#f472b6',
  link: 'rgba(120,170,255,0.85)',
  start: 'rgba(52,211,153,0.95)',
  energyTop: 'rgba(124,108,255,0.85)',
  energyBottom: 'rgba(56,189,248,0.18)',
  energyStroke: 'rgba(160,200,255,0.9)',
  tag: 'rgba(60,72,110,0.92)',
  tagFirst: 'rgba(56,130,190,0.9)',
  tagText: '#e8f4ff'
})

/** 浅色主题共用的墨色 */
const inkLight = (bg: string, text = '#1a1a22', dim = '#6a6a7a'): InkTheme => ({
  bg,
  line: 'rgba(60,80,130,0.5)',
  lineStrong: 'rgba(30,40,80,0.85)',
  shade: 'rgba(80,110,170,0.1)',
  text,
  dim,
  dim2: '#74748a',
  bright: '#ffffff',
  onset: '#b45309',
  onsetSoft: 'rgba(180,83,9,0.28)',
  ok: '#047857',
  warn: '#b91c1c',
  accent: '#be185d',
  link: 'rgba(37,99,235,0.75)',
  start: 'rgba(5,150,105,0.95)',
  energyTop: 'rgba(80,70,190,0.75)',
  energyBottom: 'rgba(40,140,200,0.15)',
  energyStroke: 'rgba(50,80,160,0.85)',
  tag: 'rgba(60,80,140,0.88)',
  tagFirst: 'rgba(30,80,170,0.92)',
  tagText: '#ffffff'
})

export const THEMES: Theme[] = [
  {
    id: 'deep',
    name: '深空（深色）',
    dark: true,
    css: {
      '--bg': '#07070c',
      '--panel': '#101018',
      '--panel-2': '#17171f',
      '--line': '#262634',
      '--text': '#e8e8f2',
      '--muted': '#8f8fa6',
      '--fg-dim': '#a8a8bd',
      '--axis-fg': 'rgba(214,220,240,0.95)',
      '--axis-shadow': '0 0 4px rgba(0,0,0,0.95)',
      '--energy-axis-fg': 'rgba(150,220,240,0.95)',
      '--tag-fg': 'rgba(214,220,240,0.8)',
      '--dim2': '#7d7d96',
      '--onset': '#fbbf24',
      '--btn-hover': '#1d1d2b',
      '--btn-on': '#241d4d',
      '--muted-2': '#6b6b85',
      '--text-2': '#cfcfe0',
      '--accent': '#22d3ee',
      '--accent-2': '#7dd3fc',
      '--brand': '#7c6cff',
      '--ok': '#6ee7b7',
      '--warn': '#f87171',
      '--start': '#10b981',
      '--panel-3': '#0d0d15',
      '--stage-bg': '#07070c',
      '--badge-bg': '#a855f72e',
      '--badge-fg': '#e9d5ff',
      '--ghost': '#17171f'
    },
    canvas: {
      spectrum: [
        [8, 8, 20],
        [40, 20, 90],
        [110, 40, 180],
        [200, 70, 190],
        [250, 150, 120],
        [255, 240, 190]
      ],
      energyRamp: [
        [58, 28, 110],
        [110, 50, 200],
        [34, 211, 238]
      ],
      ink: inkDark('#07070c')
    }
  },
  {
    id: 'midnight',
    name: '午夜蓝（深色）',
    dark: true,
    css: {
      '--bg': '#05070f',
      '--panel': '#0b1424',
      '--panel-2': '#101d33',
      '--line': '#1e3050',
      '--text': '#e6f0ff',
      '--muted': '#8aa0c0',
      '--fg-dim': '#a8c0dc',
      '--axis-fg': 'rgba(210,228,250,0.95)',
      '--axis-shadow': '0 0 4px rgba(0,0,0,0.95)',
      '--energy-axis-fg': 'rgba(150,232,246,0.95)',
      '--tag-fg': 'rgba(210,228,250,0.8)',
      '--dim2': '#7c90ac',
      '--onset': '#fcd34d',
      '--muted-2': '#6a7f9c',
      '--btn-hover': '#16233a',
      '--btn-on': '#16294d',
      '--text-2': '#c2d6ee',
      '--accent': '#38d9f0',
      '--accent-2': '#8ad8ff',
      '--brand': '#6d7cff',
      '--ok': '#5eead4',
      '--warn': '#fb7185',
      '--start': '#10b981',
      '--panel-3': '#081020',
      '--stage-bg': '#05070f',
      '--badge-bg': '#3b82f62e',
      '--badge-fg': '#bfdbfe',
      '--ghost': '#101d33'
    },
    canvas: {
      spectrum: [
        [5, 7, 15],
        [14, 40, 88],
        [20, 92, 160],
        [46, 165, 205],
        [150, 225, 225],
        [245, 253, 255]
      ],
      energyRamp: [
        [14, 48, 96],
        [28, 118, 188],
        [110, 232, 236]
      ],
      ink: inkDark('#05070f', '#e6f0ff', '#8aa0c0')
    }
  },
  {
    id: 'paper',
    name: '纸白（浅色）',
    dark: false,
    css: {
      '--bg': '#f4f4f2',
      '--panel': '#ffffff',
      '--panel-2': '#eaeaea',
      '--line': '#d6d6de',
      '--text': '#1a1a22',
      '--muted': '#6a6a7a',
      '--fg-dim': '#4a4a5a',
      '--axis-fg': 'rgba(38,44,58,0.92)',
      '--axis-shadow': '0 0 4px rgba(255,255,255,0.95)',
      '--energy-axis-fg': 'rgba(12,90,120,0.95)',
      '--tag-fg': 'rgba(38,44,58,0.72)',
      '--dim2': '#6e6e80',
      '--onset': '#b45309',
      '--muted-2': '#74748a',
      '--btn-hover': '#e8e8f0',
      '--btn-on': '#dfe6ff',
      '--text-2': '#3a3a48',
      '--accent': '#0e7490',
      '--accent-2': '#0369a1',
      '--brand': '#5b4bd6',
      '--ok': '#047857',
      '--warn': '#b91c1c',
      '--start': '#10b981',
      '--panel-3': '#f2f2f6',
      '--stage-bg': '#fbfbf9',
      '--badge-bg': '#7c3aed1f',
      '--badge-fg': '#5b21b6',
      '--ghost': '#ececf2'
    },
    canvas: {
      // 浅色主题色阶方向要反过来：静音接近纸白，最强走深饱和
      spectrum: [
        [250, 250, 248],
        [206, 224, 240],
        [136, 176, 218],
        [86, 112, 192],
        [176, 62, 132],
        [92, 8, 44]
      ],
      energyRamp: [
        [208, 226, 244],
        [110, 156, 220],
        [28, 70, 150]
      ],
      ink: inkLight('#fafaf8')
    }
  },
  {
    id: 'sand',
    name: '暖沙（浅色）',
    dark: false,
    css: {
      '--bg': '#f4efe6',
      '--panel': '#fffdf8',
      '--panel-2': '#f0e8da',
      '--line': '#e0d6c6',
      '--text': '#2a2018',
      '--muted': '#7a6a58',
      '--fg-dim': '#5c4c3a',
      '--axis-fg': 'rgba(58,44,30,0.92)',
      '--axis-shadow': '0 0 4px rgba(255,253,248,0.95)',
      '--energy-axis-fg': 'rgba(130,70,20,0.95)',
      '--tag-fg': 'rgba(58,44,30,0.72)',
      '--dim2': '#7a6a56',
      '--onset': '#b45309',
      '--muted-2': '#7a6650',
      '--btn-hover': '#f0e7d8',
      '--btn-on': '#f4e3c6',
      '--text-2': '#4a3c2c',
      '--accent': '#a1512a',
      '--accent-2': '#8a5a1e',
      '--brand': '#8b5cf6',
      '--ok': '#15803d',
      '--warn': '#b91c1c',
      '--start': '#10b981',
      '--panel-3': '#f6efe2',
      '--stage-bg': '#fdfaf4',
      '--badge-bg': '#d9770626',
      '--badge-fg': '#92400e',
      '--ghost': '#efe6d6'
    },
    canvas: {
      spectrum: [
        [250, 246, 238],
        [234, 216, 188],
        [216, 158, 110],
        [188, 96, 72],
        [140, 40, 60],
        [60, 6, 24]
      ],
      energyRamp: [
        [242, 230, 210],
        [214, 150, 96],
        [140, 52, 44]
      ],
      ink: inkLight('#fbf7f0', '#2a2018', '#7a6a58')
    }
  }
]

const STORAGE_KEY = 'beatlooker.theme.v2'

/**
 * 默认配色：**浅色（纸白）**。
 *
 * 用户要求默认浅色 ✓ —— 谱面本来就是白纸黑字的东西 ✓
 * 而且这个应用大量时间是在看谱子和检测图，浅色在明亮环境下更耐看 ✓
 * 用户选过别的颜色会记在 localStorage 里，那个优先级更高 ✓
 */
export const DEFAULT_THEME_ID = 'paper'

let currentId = DEFAULT_THEME_ID

export function themeById(id: string): Theme {
  return (
    THEMES.find((t) => t.id === id) ??
    THEMES.find((t) => t.id === DEFAULT_THEME_ID) ??
    THEMES[0]
  )
}

/** 当前主题 */
export function theme(): Theme {
  return themeById(currentId)
}

/** 取上次选的主题（存的字符串可能来自旧版本，找不到就退回默认） */
export function loadThemeId(storage?: { getItem(k: string): string | null }): string {
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    const v = s?.getItem(STORAGE_KEY)
    if (v && THEMES.some((t) => t.id === v)) {
      currentId = v
      return v
    }
  } catch {
    // 存储不可用就用默认的，不值得为此报错
  }
  return currentId
}

/**
 * 切主题。
 *
 * 做两件事：把 CSS 变量写到 <html> 上（界面跟着变），
 * 以及记住 currentId（画布绘制代码读它）。
 * 画布的重画由调用方负责 —— 这里不碰 DOM 之外的东西。
 */
export function setTheme(id: string, storage?: { setItem(k: string, v: string): void }): Theme {
  const t = themeById(id)
  currentId = t.id
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    for (const [k, v] of Object.entries(t.css)) root.style.setProperty(k, v)
    root.style.colorScheme = t.dark ? 'dark' : 'light'
  }
  try {
    const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    s?.setItem(STORAGE_KEY, t.id)
  } catch {
    // 记不住就算了，不影响使用
  }
  return t
}

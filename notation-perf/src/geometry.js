/* =============================================================================
 * geometry.js —— 记谱几何核心（五线谱音符 / 休止符 + 简谱记号）
 * -----------------------------------------------------------------------------
 * 坐标约定
 *   单位 unit = 五线谱一条线间距(staff space)；
 *   x 向右为正，y 向下为正（与 SVG / Canvas 一致）；
 *   每个 glyph 的原点 (0,0) = 符头中心，对应五线谱中央那条线。
 *
 * 设计要点
 *   同一份路径数据既喂给 SVG(<path d>)，也喂给 Canvas(new Path2D(d))，
 *   这样"矢量 SVG / 位图精灵 / 图片拼接"三种画法的几何完全一致，
 *   性能对比才是公平的（否则差异可能来自图形本身不同）。
 *
 * 路径命令统一用可序列化数组：[['M',x,y],['C',x1,y1,x2,y2,x,y],['Z']]
 * ========================================================================== */
(function (global) {
  'use strict';

  var K = 0.5522847498307936; // 三次贝塞尔逼近 1/4 椭圆的 kappa

  /* ---------- 基础图元 ---------- */

  function ell(cx, cy, rx, ry, rot) {
    var cmds = [
      ['M', cx + rx, cy],
      ['C', cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry],
      ['C', cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy],
      ['C', cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry],
      ['C', cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy],
      ['Z']
    ];
    return rot ? rotate(cmds, cx, cy, rot) : cmds;
  }

  function rect(x, y, w, h) {
    return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  }

  // 绕 (cx,cy) 旋转 deg 度（屏幕上正角度为顺时针，符头需要 -20° 的倾角）
  function rotate(cmds, cx, cy, deg) {
    var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return cmds.map(function (cmd) {
      var out = [cmd[0]];
      for (var i = 1; i < cmd.length; i += 2) {
        var dx = cmd[i] - cx, dy = cmd[i + 1] - cy;
        out.push(cx + dx * c - dy * s, cy + dx * s + dy * c);
      }
      return out;
    });
  }

  /* ---------- 序列化 / 包围盒 ---------- */

  var r3 = function (v) { return Math.round(v * 1000) / 1000; };

  function toD(cmds) {                       // -> SVG path 数据串
    return cmds.map(function (cmd) {
      var parts = [cmd[0]];
      for (var i = 1; i < cmd.length; i++) parts.push(r3(cmd[i]));
      return parts.join(' ');
    }).join(' ');
  }

  function bbox(shapes) {                    // 用控制点估算，够用于精灵图分格
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    shapes.forEach(function (sh) {
      sh.cmds.forEach(function (cmd) {
        for (var i = 1; i < cmd.length; i += 2) {
          if (cmd[i] < x0) x0 = cmd[i];
          if (cmd[i] > x1) x1 = cmd[i];
          if (cmd[i + 1] < y0) y0 = cmd[i + 1];
          if (cmd[i + 1] > y1) y1 = cmd[i + 1];
        }
      });
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ---------- 五线谱记号部件（单位：staff space） ---------- */

  var HEAD_RX = 0.62, HEAD_RY = 0.46, HEAD_TILT = -20;
  var STEM_X = 0.58, STEM_W = 0.125, STEM_H = 3.5;

  function stem() {
    return { cmds: rect(STEM_X, -STEM_H, STEM_W, STEM_H), mode: 'fill' };
  }

  // 符尾：从符干顶端向右下弯出，dy 用于叠加第 2、3 条符尾
  function flag(dy) {
    var y = -STEM_H + (dy || 0);
    return {
      cmds: [
        ['M', STEM_X + STEM_W, y],
        ['C', 1.50, y + 0.55, 1.62, y + 1.25, 1.02, y + 1.90],
        ['C', 1.42, y + 1.15, 1.00, y + 0.60, STEM_X + STEM_W, y + 0.45],
        ['Z']
      ],
      mode: 'fill'
    };
  }

  function head(filled) {
    return filled
      ? { cmds: ell(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT), mode: 'fill' }
      // 空心符头：用描边模拟刻版的粗细对比（真刻版会更讲究，这里够用）
      : { cmds: ell(0, 0, HEAD_RX, HEAD_RY, HEAD_TILT), mode: 'stroke', width: 0.22 };
  }

  // 四分休止符（手写体折线，近似形状）
  var QUARTER_REST = [
    ['M', -0.05, -1.45],
    ['C', 0.45, -1.05, 0.42, -0.70, 0.02, -0.42],
    ['C', 0.62, -0.28, 0.68, 0.35, 0.12, 0.72],
    ['C', 0.42, 0.82, 0.55, 1.02, 0.58, 1.28],
    ['L', 0.12, 1.42],
    ['C', 0.06, 1.15, -0.10, 0.98, -0.36, 0.86],
    ['C', -0.86, 0.55, -0.80, -0.05, -0.18, -0.40],
    ['C', -0.55, -0.65, -0.60, -1.05, -0.12, -1.30],
    ['Z']
  ];

  function dotShape(x, y, r) {
    return { cmds: ell(x === undefined ? 1.20 : x, y === undefined ? 0 : y, r || 0.15, r || 0.15), mode: 'fill' };
  }

  function slash() {
    return { cmds: [['M', -0.42, 0.78], ['L', 0.30, -0.88]], mode: 'stroke', width: 0.20 };
  }

  /* ---------- 全部 glyph 注册表 ---------- */
  /* 时值链路：全音符 -> 二分 -> 四分 -> 八分 -> 十六分；再加各种休止符和附点 */
  var GLYPHS = {
    whole:         { name: '全音符',        shapes: [{ cmds: ell(0, 0, 0.78, 0.52, HEAD_TILT), mode: 'stroke', width: 0.22 }] },
    half:          { name: '二分音符',      shapes: [head(false), stem()] },
    quarter:       { name: '四分音符',      shapes: [head(true), stem()] },
    eighth:        { name: '八分音符',      shapes: [head(true), stem(), flag(0)] },
    sixteenth:     { name: '十六分音符',    shapes: [head(true), stem(), flag(0), flag(0.78)] },
    thirtysecond:  { name: '三十二分音符',  shapes: [head(true), stem(), flag(0), flag(0.78), flag(1.56)] },
    dot:           { name: '附点',          shapes: [dotShape(1.20, 0, 0.15)] },
    restWhole:     { name: '全休止符',      shapes: [{ cmds: rect(-0.62, -0.48, 1.24, 0.30), mode: 'fill' }] },
    restHalf:      { name: '二分休止符',    shapes: [{ cmds: rect(-0.62, 0.18, 1.24, 0.30), mode: 'fill' }] },
    restQuarter:   { name: '四分休止符',    shapes: [{ cmds: QUARTER_REST, mode: 'fill' }] },
    restEighth:    { name: '八分休止符',    shapes: [dotShape(-0.05, -0.50, 0.15), slash()] },
    restSixteenth: { name: '十六分休止符',  shapes: [dotShape(-0.05, -0.78, 0.15), dotShape(-0.05, -0.22, 0.15), slash()] }
  };

  /* ---------- 简谱（Numbered Notation）记号 ---------- */
  /* 简谱不用图形，用：数字 1-7、0、"-"、下划线（时值）、上下点（八度）、附点。
   * 这里给出"记号 -> HTML/CSS 结构"和"记号 -> SVG 属性"的映射表，
   * 渲染器（HTML 版 / SVG 版）共用同一份数据。 */
  var JIANPU = {
    // 时值 -> 下划线数量 / 破折号数量
    duration: {
      whole:   { dash: 3, lines: 0, label: '全音符 1 - - -' },
      half:    { dash: 1, lines: 0, label: '二分音符 1 -' },
      quarter: { dash: 0, lines: 0, label: '四分音符 1' },
      eighth:  { dash: 0, lines: 1, label: '八分音符 1（下加一横）' },
      sixteenth:{ dash: 0, lines: 2, label: '十六分音符 1（下加两横）' },
      rest:    { dash: 0, lines: 0, label: '休止符 0' }
    },
    // 八度 -> 点的位置与数量
    octave: { up2: { side: 'above', dots: 2 }, up1: { side: 'above', dots: 1 },
              plain: { side: 'none', dots: 0 },
              down1: { side: 'below', dots: 1 }, down2: { side: 'below', dots: 2 } },
    digits: ['1', '2', '3', '4', '5', '6', '7']
  };

  /* ---------- 布局helper：把 glyph 排成网格（基准测试与示例共用） ---------- */
  function gridLayout(glyphKeys, count, opts) {
    opts = opts || {};
    var size = opts.size || 12;                 // 每个 staff space 的像素数
    var pitch = (opts.pitch || 4.5) * size;     // 音符水平间距（含符尾余量）
    var rowH = (opts.rowH || 6.5) * size;
    var perRow = opts.perRow || Math.max(1, Math.floor((opts.width || 1200) / pitch));
    var notes = [];
    for (var i = 0; i < count; i++) {
      notes.push({
        glyph: glyphKeys[i % glyphKeys.length],
        x: (i % perRow) * pitch + pitch * 0.5,
        y: Math.floor(i / perRow) * rowH + rowH * 0.62
      });
    }
    return {
      notes: notes,
      size: size,
      width: opts.width || perRow * pitch,
      height: Math.max(rowH, Math.ceil(count / perRow) * rowH),
      rows: Math.ceil(count / perRow),
      perRow: perRow
    };
  }

  global.Notation = {
    K: K, ell: ell, rect: rect, rotate: rotate, toD: toD, bbox: bbox,
    GLYPHS: GLYPHS, JIANPU: JIANPU, gridLayout: gridLayout,
    HEAD_RX: HEAD_RX, HEAD_RY: HEAD_RY, HEAD_TILT: HEAD_TILT,
    STEM_X: STEM_X, STEM_W: STEM_W, STEM_H: STEM_H
  };
})(typeof window !== 'undefined' ? window : this);

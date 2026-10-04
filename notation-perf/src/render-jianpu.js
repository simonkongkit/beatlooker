/* =============================================================================
 * render-jianpu.js —— 简谱（数字谱）记号渲染，两种画法同源
 *   F1. jianpuHTML : 普通文本 + CSS（下划线=时值，上下点=八度，"-"=延长，0=休止）
 *   F2. jianpuSVG  : SVG <text>/<rect>/<circle>，便于与五线谱共用一套排版坐标
 * 记号规则见 geometry.js 里的 Notation.JIANPU。
 * ========================================================================== */
(function (global) {
  'use strict';
  var N = global.Notation, NS = 'http://www.w3.org/2000/svg';

  // 五线谱 glyph key -> 简谱时值
  var DUR = {
    whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', sixteenth: 'sixteenth',
    thirtysecond: 'sixteenth',
    restWhole: 'rest', restHalf: 'rest', restQuarter: 'rest', restEighth: 'rest', restSixteenth: 'rest',
    dot: 'quarter'
  };

  function model(layout) {
    return layout.notes.map(function (n, i) {
      var dur = DUR[n.glyph] || 'quarter';
      var isRest = dur === 'rest';
      return {
        x: n.x, y: n.y, dur: dur,
        digit: isRest ? '0' : N.JIANPU.digits[i % 7],
        octave: (i % 7 === 6) ? 'up1' : (i % 5 === 4 ? 'down1' : 'plain'),
        dotted: (i % 4 === 3)
      };
    });
  }

  /* ---------- F1. HTML + CSS ---------- */
  function renderHTML(host, layout) {
    var size = layout.size, fs = size * 1.9;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:' + layout.width + 'px;height:' + layout.height +
                         'px;font:' + fs + 'px/1 "Segoe UI",system-ui,sans-serif;color:#111';
    var frag = document.createDocumentFragment();
    model(layout).forEach(function (m) {
      var d = N.JIANPU.duration[m.dur];
      var slot = document.createElement('span');
      slot.style.cssText = 'position:absolute;left:' + m.x + 'px;top:' + (m.y - fs / 2) +
                           'px;display:inline-block;text-align:center;min-width:' + (fs * 0.7) + 'px';
      var txt = document.createElement('span');
      txt.textContent = m.digit + (m.dotted ? '.' : '') + (d.dash ? ' ' + new Array(d.dash + 1).join('- ') : '');
      slot.appendChild(txt);
      for (var i = 0; i < d.lines; i++) {           // 时值下划线：八分一横、十六分两横
        var line = document.createElement('i');
        line.style.cssText = 'position:absolute;left:0;right:0;height:1.5px;background:currentColor;' +
                             'top:' + (fs + 1 + i * 4) + 'px';
        slot.appendChild(line);
      }
      var oct = N.JIANPU.octave[m.octave];          // 八度点
      if (oct.dots) {
        var dot = document.createElement('span');
        var above = oct.side === 'above';
        dot.style.cssText = 'position:absolute;left:50%;width:3px;height:3px;border-radius:50%;' +
          'background:currentColor;margin-left:-1.5px;' + (above ? 'top:-7px' : 'bottom:-7px');
        slot.appendChild(dot);
      }
      frag.appendChild(slot);
    });
    wrap.appendChild(frag);
    host.appendChild(wrap);
    return wrap;
  }

  /* ---------- F2. SVG ---------- */
  function renderSVG(host, layout) {
    var size = layout.size, fs = size * 1.9;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    svg.setAttribute('color', '#111');
    var frag = document.createDocumentFragment();
    model(layout).forEach(function (m) {
      var d = N.JIANPU.duration[m.dur];
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', m.x);
      t.setAttribute('y', m.y + fs * 0.35);
      t.setAttribute('font-size', fs);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', 'currentColor');
      t.textContent = m.digit + (m.dotted ? '.' : '') + (d.dash ? ' ' + new Array(d.dash + 1).join('- ') : '');
      frag.appendChild(t);
      for (var i = 0; i < d.lines; i++) {
        var r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', m.x - fs * 0.35);
        r.setAttribute('y', m.y + fs * 0.35 + 2 + i * 4);
        r.setAttribute('width', fs * 0.7);
        r.setAttribute('height', 1.5);
        r.setAttribute('fill', 'currentColor');
        frag.appendChild(r);
      }
      var oct = N.JIANPU.octave[m.octave];
      if (oct.dots) {
        var c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', m.x);
        c.setAttribute('cy', m.y + fs * 0.35 + (oct.side === 'above' ? -fs - 4 : 8));
        c.setAttribute('r', 1.6);
        c.setAttribute('fill', 'currentColor');
        frag.appendChild(c);
      }
    });
    svg.appendChild(frag);
    host.appendChild(svg);
    return svg;
  }

  global.Renderers = global.Renderers || {};
  global.Renderers.jianpuHTML = { id: 'jianpuHTML', label: '简谱：文本 + CSS', kind: 'dom', render: renderHTML };
  global.Renderers.jianpuSVG = { id: 'jianpuSVG', label: '简谱：SVG text/rect/circle', kind: 'dom', render: renderSVG };
})(window);

/* =============================================================================
 * render-svg.js —— 画法 A：SVG 矢量（DOM 节点）
 * 每个 glyph 的每个子形状 = 一个 <path>，位置用 transform 摆放。
 * 这是最"原生"的乐谱画法（VexFlow 走的也是这条路），可无损缩放、可命中测试。
 * ========================================================================== */
(function (global) {
  'use strict';
  var N = global.Notation, NS = 'http://www.w3.org/2000/svg';

  function render(host, layout) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    svg.setAttribute('color', '#111');

    var frag = document.createDocumentFragment();
    for (var i = 0; i < layout.notes.length; i++) {
      var n = layout.notes[i], g = N.GLYPHS[n.glyph];
      for (var s = 0; s < g.shapes.length; s++) {
        var sh = g.shapes[s];
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', N.toD(sh.cmds));
        p.setAttribute('transform',
          'translate(' + n.x + ' ' + n.y + ') scale(' + layout.size + ') rotate(' + (sh.rotate || 0) + ')');
        if (sh.mode === 'fill') { p.setAttribute('fill', 'currentColor'); }
        else { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', sh.width); }
        frag.appendChild(p);
      }
    }
    svg.appendChild(frag);
    host.appendChild(svg);
    return svg;
  }

  global.Renderers = global.Renderers || {};
  global.Renderers.svg = { id: 'svg', label: 'SVG 矢量（每形状一个 <path>）', kind: 'dom', render: render };
})(window);

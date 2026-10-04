/* =============================================================================
 * render-canvas.js —— 画法 B / C：Canvas 2D
 *   B. canvasVector : 每个音符填充/描边矢量路径（Path2D 复用，几何与 SVG 完全同源）
 *   C. canvasSprite : 先把每个 glyph 预先光栅化进一张图集(atlas)，之后每个音符
 *                     只做一次 drawImage —— 即"用位图拼接"，但拼在 canvas 上。
 * 两者都需在测量时手动 flush（getImageData）才能把光栅化成本算进来。
 * ========================================================================== */
(function (global) {
  'use strict';
  var N = global.Notation;
  var pathCache = {};

  function pathsFor(key) {
    if (!pathCache[key]) {
      pathCache[key] = N.GLYPHS[key].shapes.map(function (sh) {
        return { path: new Path2D(N.toD(sh.cmds)), shape: sh };
      });
    }
    return pathCache[key];
  }

  function makeCanvas(layout, dpr) {
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(layout.width * dpr));
    cv.height = Math.max(1, Math.round(layout.height * dpr));
    cv.style.width = layout.width + 'px';
    cv.style.height = layout.height + 'px';
    cv.style.display = 'block';
    return cv;
  }

  function paint(ctx, key) {
    var shapes = pathsFor(key);
    for (var i = 0; i < shapes.length; i++) {
      var sh = shapes[i].shape;
      if (sh.mode === 'fill') ctx.fill(shapes[i].path);
      else { ctx.lineWidth = sh.width; ctx.stroke(shapes[i].path); }
    }
  }

  /* ---------- B. 矢量路径直画 ---------- */
  function renderVector(host, layout) {
    var dpr = window.devicePixelRatio || 1;
    var cv = makeCanvas(layout, dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#111';
    for (var i = 0; i < layout.notes.length; i++) {
      var n = layout.notes[i];
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.scale(layout.size, layout.size);
      paint(ctx, n.glyph);
      ctx.restore();
    }
    host.appendChild(cv);
    return cv;
  }

  /* ---------- C. 精灵图集 + drawImage ---------- */
  /* 图集（atlas）：每个 glyph 一格，按包围盒紧贴裁切，不浪费像素。
   * 格子按 unit = size*dpr 光栅化，绘制时目标尺寸恰好等于格子的设备像素，
   * 因此 drawImage 是 1:1 拷贝、不触发重采样 —— 这是位图方案的"最优形态"。
   * cells[key] = { x: 图集内左边界, w/h: 格子像素, ox/oy: 原点(符头中心)在格内的位置 } */
  function buildAtlas(size, dpr) {
    var keys = Object.keys(N.GLYPHS);
    var unit = size * dpr;                       // 1 staff space 的设备像素数
    var padU = 0.3;                              // 每侧留白（staff space）
    var cells = {}, total = 0, maxH = 0;
    keys.forEach(function (k) {
      var bb = N.bbox(N.GLYPHS[k].shapes);       // 用控制点估算的包围盒
      var w = Math.ceil((bb.w + padU * 2) * unit);
      var h = Math.ceil((bb.h + padU * 2) * unit);
      cells[k] = {
        x: total, w: w, h: h,
        ox: Math.round((-bb.x + padU) * unit),
        oy: Math.round((-bb.y + padU) * unit)
      };
      total += w;
      if (h > maxH) maxH = h;
    });
    var cv = document.createElement('canvas');
    cv.width = total; cv.height = maxH;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#111';
    keys.forEach(function (k) {
      var c = cells[k];
      ctx.save();
      ctx.translate(c.x + c.ox, c.oy);
      ctx.scale(unit, unit);
      paint(ctx, k);
      ctx.restore();
    });
    return { canvas: cv, unit: unit, size: size, dpr: dpr, cells: cells, keys: keys };
  }

  function renderSprite(host, layout, atlas) {
    atlas = atlas || buildAtlas(layout.size, window.devicePixelRatio || 1);
    var dpr = window.devicePixelRatio || 1;
    var k = layout.size / atlas.unit;            // 图集像素 -> CSS 像素
    var cv = makeCanvas(layout, dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var i = 0; i < layout.notes.length; i++) {
      var n = layout.notes[i], c = atlas.cells[n.glyph];
      ctx.drawImage(atlas.canvas, c.x, 0, c.w, c.h,
                    n.x - c.ox * k, n.y - c.oy * k, c.w * k, c.h * k);
    }
    host.appendChild(cv);
    return cv;
  }

  function flush(root) {                        // 强制把绘制指令光栅化
    if (root && root.getContext) root.getContext('2d').getImageData(0, 0, 1, 1);
  }

  /* DPR 变化监听。
   * 浏览器缩放、或把窗口拖到另一块不同 DPI 的显示器时 devicePixelRatio 会变，
   * 而 window.resize 不一定触发。位图方案（图集）和已建好的 canvas 都带着
   * 创建时的 dpr，不重建就会一直用旧分辨率的图 —— 越缩放越模糊。
   * 用法：Renderers.watchDpr(function () { 重新 render(); });
   * 内部每次变化后都会重新注册查询（因为分母变了）。 */
  function watchDpr(cb) {
    if (!global.matchMedia) return;
    var off = null;
    function arm() {
      var mq = global.matchMedia('(resolution: ' + (global.devicePixelRatio || 1) + 'dppx)');
      var on = function () {
        if (off) off();
        arm();                                  // 先按新 dpr 重新注册，再回调
        cb(global.devicePixelRatio || 1);
      };
      if (mq.addEventListener) mq.addEventListener('change', on);
      else if (mq.addListener) mq.addListener(on);
      off = function () {
        if (mq.removeEventListener) mq.removeEventListener('change', on);
        else if (mq.removeListener) mq.removeListener(on);
      };
    }
    arm();
  }

  global.Renderers = global.Renderers || {};
  global.Renderers.canvasVector = { id: 'canvasVector', label: 'Canvas 2D 矢量路径', kind: 'canvas', render: renderVector, flush: flush };
  global.Renderers.canvasSprite = { id: 'canvasSprite', label: 'Canvas 2D 精灵位图(drawImage)', kind: 'canvas', render: renderSprite, flush: flush };
  global.Renderers._buildAtlas = buildAtlas;
  global.Renderers.watchDpr = watchDpr;
})(window);

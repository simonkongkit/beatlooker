/* =============================================================================
 * render-img-sprite.js —— 画法 D / E：图片拼接
 *   D. imgPerGlyph  : 每个 glyph 一张小 PNG（data URL），一个音符一个 <img>
 *                     —— 等价于"每个记号一个图片文件"的传统做法
 *   E. cssAtlas     : 一张包含全部 glyph 的图集 PNG，一个音符一个 <div>，
 *                     用 background-position 取图 —— 等价于 CSS sprite
 * 位图来自 render-canvas.js 的同一份矢量图集（按包围盒紧贴裁切、1:1 像素映射），
 * 因此三种位图用法之间、以及与矢量画法之间都是同源几何、同源尺寸。
 * ========================================================================== */
(function (global) {
  'use strict';
  var N = global.Notation;

  // 把图集按 glyph 裁成独立小 PNG。
  // 结果按图集缓存：图集不变就不该重复编码 —— 否则滑杆每动一格就要 toDataURL N 次。
  var sliceCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function sliceAtlas(atlas) {
    if (sliceCache && sliceCache.has(atlas)) return sliceCache.get(atlas);
    var out = {};
    atlas.keys.forEach(function (k) {
      var c = atlas.cells[k];
      var cv = document.createElement('canvas');
      cv.width = c.w; cv.height = c.h;
      cv.getContext('2d').drawImage(atlas.canvas, c.x, 0, c.w, c.h, 0, 0, c.w, c.h);
      out[k] = cv.toDataURL('image/png');
    });
    if (sliceCache) sliceCache.set(atlas, out);
    return out;
  }

  function scale(atlas, layout) { return layout.size / atlas.unit; } // 图集像素 -> CSS 像素

  function hostBox(layout) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:' + layout.width + 'px;height:' + layout.height + 'px';
    return wrap;
  }

  /* ---------- D. 每记号一张图片 ---------- */
  function renderImgPerGlyph(host, layout, atlas) {
    atlas = atlas || global.Renderers._buildAtlas(layout.size, window.devicePixelRatio || 1);
    var urls = sliceAtlas(atlas);
    var k = scale(atlas, layout);
    var wrap = hostBox(layout);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < layout.notes.length; i++) {
      var n = layout.notes[i], c = atlas.cells[n.glyph];
      var im = document.createElement('img');
      im.src = urls[n.glyph];
      im.width = Math.round(c.w * k);
      im.height = Math.round(c.h * k);
      im.style.cssText = 'position:absolute;left:' + (n.x - c.ox * k) + 'px;top:' + (n.y - c.oy * k) + 'px';
      frag.appendChild(im);
    }
    wrap.appendChild(frag);
    host.appendChild(wrap);
    return wrap;
  }

  /* ---------- E. 一张图集 + CSS sprite ---------- */
  // background-image 只写一次（CSS 类），每个元素只内联 left/top/background-position，
  // 这才是真实工程写法；把巨大 data URL 内联进每个元素会得到虚假的慢。
  var styleCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  // 背景图默认按「1 图像像素 = 1 CSS 像素」显示，而图集是按设备像素光栅化的
  // （unit = size*dpr）。所以必须显式 background-size 把图集缩到 1/dpr，
  // 否则 background-position 按 1/dpr 偏移、图像却按 1:1 显示 —— 取错区域。
  // dpr=1 时两个量恰好抵消，所以这个 bug 只在 HiDPI 上暴露。
  function atlasClass(atlas, url, k) {
    var key = k.toFixed(6);
    var hit = styleCache && styleCache.get(atlas);
    if (hit && hit.key === key) return hit.name;

    var name = 'nota-atlas-' + Math.random().toString(36).slice(2, 8);
    var st = document.createElement('style');
    st.textContent = '.' + name + '{background-image:url(' + url + ');background-repeat:no-repeat;' +
      'background-size:' + (atlas.canvas.width * k) + 'px ' + (atlas.canvas.height * k) + 'px}';
    document.head.appendChild(st);
    if (styleCache) styleCache.set(atlas, { key: key, name: name });
    return name;
  }

  function renderCssAtlas(host, layout, atlas) {
    atlas = atlas || global.Renderers._buildAtlas(layout.size, window.devicePixelRatio || 1);
    var k = scale(atlas, layout);
    var cls = atlasClass(atlas, atlas.canvas.toDataURL('image/png'), k);
    var wrap = hostBox(layout);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < layout.notes.length; i++) {
      var n = layout.notes[i], c = atlas.cells[n.glyph];
      var d = document.createElement('div');
      d.className = cls;
      d.style.cssText = 'position:absolute;width:' + (c.w * k) + 'px;height:' + (c.h * k) + 'px;' +
        'left:' + (n.x - c.ox * k) + 'px;top:' + (n.y - c.oy * k) + 'px;' +
        'background-position:' + (-c.x * k) + 'px 0';
      frag.appendChild(d);
    }
    wrap.appendChild(frag);
    host.appendChild(wrap);
    return wrap;
  }

  global.Renderers = global.Renderers || {};
  global.Renderers.imgPerGlyph = { id: 'imgPerGlyph', label: '图片：每记号一张 PNG + <img>', kind: 'dom', render: renderImgPerGlyph };
  global.Renderers.cssAtlas = { id: 'cssAtlas', label: '图片：CSS 雪碧图 + <div> 背景', kind: 'dom', render: renderCssAtlas };
  global.Renderers._sliceAtlas = sliceAtlas;
})(window);

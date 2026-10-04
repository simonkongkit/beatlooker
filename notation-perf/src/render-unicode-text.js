/* =============================================================================
 * render-unicode-text.js —— 画法 F：系统字体里的 Unicode 音符字符（纯文本流）
 *   全音符 U+1D15D / 二分 U+1D15E / 四分 U+1D15F / 八分 U+1D160 / 十六分 U+1D161
 *   全休止 U+1D13B / 二分休止 U+1D13C / 四分休止 U+1D13D / 八分休止 U+1D13E / 十六分休止 U+1D13F
 *   BMP 里的简易字形：♩U+2669 ♪U+266A ♫U+266B ♬U+266C ♭U+266D
 *
 * 注意：这条路的"性能"取决于字体回退与 shaping，而且手机端经常没有字形。
 * 这里同时提供 coverage() 用来现场检测当前浏览器能不能画出这些码位。
 * ========================================================================== */
(function (global) {
  'use strict';

  var SMP = {
    whole: '\uD834\uDD5D', half: '\uD834\uDD5E', quarter: '\uD834\uDD5F',
    eighth: '\uD834\uDD60', sixteenth: '\uD834\uDD61',
    restWhole: '\uD834\uDD3B', restHalf: '\uD834\uDD3C', restQuarter: '\uD834\uDD3D',
    restEighth: '\uD834\uDD3E', restSixteenth: '\uD834\uDD3F'
  };
  var BMP = {
    whole: '\u2669', half: '\u266A', quarter: '\u2669', eighth: '\u266A',
    sixteenth: '\u266B', restWhole: '\u2669', restHalf: '\u2669',
    restQuarter: '\u2669', restEighth: '\u266A', restSixteenth: '\u266B'
  };

  function render(host, layout, table) {
    table = table || SMP;
    var fs = layout.size * 4;                    // 音乐字体 1em ≈ 4 staff space
    var wrap = document.createElement('div');
    wrap.style.cssText = 'font-size:' + fs + 'px;line-height:' + (layout.size * 6) + 'px;color:#111;' +
                         'word-spacing:' + (layout.size * 1.4) + 'px';
    var parts = new Array(layout.notes.length);
    for (var i = 0; i < layout.notes.length; i++) parts[i] = table[layout.notes[i].glyph] || '?';
    wrap.textContent = parts.join(' ');
    host.appendChild(wrap);
    return wrap;
  }

  // 现场检测：能否真正拿到字形（宽度为 0 或等于 .notdef 宽度即视为缺字形）
  function coverage() {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:80px';
    document.body.appendChild(probe);
    function width(s) { probe.textContent = s; return probe.getBoundingClientRect().width; }
    var tofu = width('\uFFFF');                  // 无字符码位的对照宽度
    var res = {};
    ['SMP 全音符 U+1D15D', 'SMP 四分休止 U+1D13D', 'BMP 四分 ♩ U+2669'].forEach(function () {});
    res['U+1D15D 全音符'] = { w: +width(SMP.whole).toFixed(1), ok: Math.abs(width(SMP.whole) - tofu) > 0.5 };
    res['U+1D15F 四分音符'] = { w: +width(SMP.quarter).toFixed(1), ok: Math.abs(width(SMP.quarter) - tofu) > 0.5 };
    res['U+1D13D 四分休止符'] = { w: +width(SMP.restQuarter).toFixed(1), ok: Math.abs(width(SMP.restQuarter) - tofu) > 0.5 };
    res['U+2669 ♩ (BMP)'] = { w: +width(BMP.quarter).toFixed(1), ok: Math.abs(width(BMP.quarter) - tofu) > 0.5 };
    res['notdef 参照 U+FFFF'] = { w: +tofu.toFixed(1) };
    res.fontUsed = getComputedStyle(probe).fontFamily;
    probe.remove();
    return res;
  }

  global.Renderers = global.Renderers || {};
  global.Renderers.textSMP = { id: 'textSMP', label: 'Unicode 文本：音乐符号区(U+1D100)', kind: 'dom', render: function (h, l) { return render(h, l, SMP); } };
  global.Renderers.textBMP = { id: 'textBMP', label: 'Unicode 文本：BMP ♩♪♫♬', kind: 'dom', render: function (h, l) { return render(h, l, BMP); } };
  global.Renderers._unicodeCoverage = coverage;
  global.Renderers.SMP = SMP;
  global.Renderers.BMP = BMP;
})(window);

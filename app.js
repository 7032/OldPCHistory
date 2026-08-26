/*!
 * 国産パソコン年表ビューア
 * 単一データソース: ./timeline.md
 * 外部ライブラリ・外部CDNは一切使用しない自己完結実装。
 */
'use strict';

/* =========================================================================
 * 1. 定数・ユーティリティ
 * ========================================================================= */

var SVG_NS = 'http://www.w3.org/2000/svg';

/** 年表の表示範囲（両端を含む） */
var RANGE = { startYear: 1978, startMonth: 9, endYear: 1989, endMonth: 11 };

/** 3か月以内のモデルチェンジを「短期」とみなすしきい値 */
var QUICK_MONTHS = 3;

/** 平成の始まり（1989-01-08） */
var HEISEI = { year: 1989, month: 1, day: 8 };

/** 描画寸法（SVGユーザー単位） */
var GEO = {
  axisW: 96,      // 左の年月軸の幅
  headerH: 54,    // 上のメーカー見出しの高さ
  topPad: 16,     // 見出しと最初の月の間
  bottomPad: 64,
  monthH: 30,     // 1か月の高さ（完全に等間隔）
  laneW: 98,      // 系列1レーンの幅
  boxH: 24,
  rightPad: 28
};

/**
 * 月インデックス。1978-01 を 0 とする通し番号。
 * @param {number} y 西暦年
 * @param {number} m 月 (1-12)
 * @returns {number}
 */
function monthIndex(y, m) {
  return (y - RANGE.startYear) * 12 + (m - 1);
}

/**
 * 2つの年月の差（月数）。負にもなり得る。
 */
function monthDiff(y1, m1, y2, m2) {
  return (y2 - y1) * 12 + (m2 - m1);
}

var MI_MIN = monthIndex(RANGE.startYear, RANGE.startMonth);   // 1978-09
var MI_MAX = monthIndex(RANGE.endYear, RANGE.endMonth);       // 1989-11
var MONTH_COUNT = MI_MAX - MI_MIN + 1;                        // 135

/** 月インデックスを "YYYY-MM" に戻す */
function miToLabel(mi) {
  var y = RANGE.startYear + Math.floor(mi / 12);
  var m = (mi % 12) + 1;
  return y + '-' + (m < 10 ? '0' + m : String(m));
}

/** 経過月数を日本語表記にする */
function gapText(n) {
  if (n === 0) return '同月';
  return n + 'か月';
}

/* =========================================================================
 * 2. timeline.md パーサー
 * ========================================================================= */

/**
 * timeline.md を解析する。
 *
 * 書式:
 *   ## メーカー名            メーカーセクション開始
 *   color: #RRGGBB           直前のメーカーの色
 *   lanes: 系列名, 系列名     レーンの並び順（任意）
 *   branch: 子系列名 < 親機種名  系列の派生元（任意・複数可）
 *   YYYY-MM | 機種名 | 系列  1機種
 *
 * 空行・見出し・コメント・不正行は読み飛ばし、警告として記録する。
 *
 * @param {string} text
 * @returns {{makers: Array, models: Array, warnings: Array<string>, branches: Array}}
 */
function parseTimeline(text) {
  var makers = [];
  var models = [];
  var warnings = [];
  var branchDecls = [];
  if (typeof text !== 'string') {
    return { makers: makers, models: models, warnings: ['入力が文字列ではありません'], branches: [] };
  }

  var lines = text.replace(/\r\n?/g, '\n').split('\n');
  var current = null;
  var inFence = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    var lineNo = i + 1;

    if (line === '') continue;

    // コードフェンスは中身ごと読み飛ばす
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // HTMLコメント（単一行）
    if (line.indexOf('<!--') === 0) continue;

    // メーカー見出し
    var mh = /^##\s+(.+?)\s*$/.exec(line);
    if (mh) {
      var name = mh[1];
      var dup = null;
      for (var d = 0; d < makers.length; d++) {
        if (makers[d].name === name) { dup = makers[d]; break; }
      }
      if (dup) {
        warnings.push(lineNo + '行目: メーカー "' + name + '" が重複しています。既存セクションに統合しました。');
        current = dup;
      } else {
        current = { name: name, color: null, order: makers.length, series: [], laneDecl: null };
        makers.push(current);
      }
      continue;
    }

    // その他の見出し（# タイトル / ### 小見出し など）は無視
    if (/^#{1,6}\s/.test(line)) continue;

    // color: #RRGGBB
    var ch = /^color\s*:\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(line);
    if (ch) {
      if (current) {
        current.color = ch[1];
      } else {
        warnings.push(lineNo + '行目: メーカー見出しの前に color 指定があります。無視しました。');
      }
      continue;
    }

    // レーン順宣言: lanes: <系列名>, <系列名>, ...
    // 系列名にスラッシュを含み得るため、区切りはカンマのみとする。
    var lh = /^lanes\s*:\s*(.*)$/.exec(line);
    if (lh) {
      if (!current) {
        warnings.push(lineNo + '行目: メーカー見出しの前に lanes 指定があります。無視しました。');
        continue;
      }
      if (current.laneDecl) {
        warnings.push(lineNo + '行目: メーカー "' + current.name +
                      '" に lanes 指定が複数あります。最後のものを採用しました。');
      }
      var laneNames = [];
      var rawNames = lh[1].split(',');
      for (var ln = 0; ln < rawNames.length; ln++) {
        var nm2 = rawNames[ln].trim();
        if (nm2 !== '') laneNames.push(nm2);
      }
      current.laneDecl = { names: laneNames, line: lineNo };
      continue;
    }

    // 分岐宣言: branch: <子系列名> < <親機種名>
    // 区切りは "<" のみ。親機種名にスラッシュを含む場合があるため "/" では分割しない。
    var bh = /^branch\s*:\s*(.+?)\s*<\s*(.+?)\s*$/.exec(line);
    if (bh) {
      if (!current) {
        warnings.push(lineNo + '行目: メーカー見出しの前に branch 指定があります。無視しました。');
        continue;
      }
      branchDecls.push({
        maker: current.name,
        makerRef: current,
        childSeries: bh[1],
        parentName: bh[2],
        line: lineNo
      });
      continue;
    }

    // 機種行: YYYY-MM | 機種名 | 系列
    if (line.indexOf('|') !== -1) {
      // Markdownテーブルの区切り行は無視
      if (/^\|?\s*:?-{2,}/.test(line)) continue;

      var body = line.replace(/^\|/, '').replace(/\|$/, '');
      var cols = body.split('|');
      for (var c = 0; c < cols.length; c++) cols[c] = cols[c].trim();

      var dm = /^(\d{4})-(\d{1,2})$/.exec(cols[0]);
      if (!dm || cols.length < 2 || cols[1] === '') {
        warnings.push(lineNo + '行目: 機種行として解釈できません: "' + line + '"');
        continue;
      }
      if (!current) {
        warnings.push(lineNo + '行目: メーカー見出しの前に機種行があります。無視しました。');
        continue;
      }

      var yy = parseInt(dm[1], 10);
      var mm = parseInt(dm[2], 10);
      if (mm < 1 || mm > 12) {
        warnings.push(lineNo + '行目: 月が範囲外です: "' + cols[0] + '"');
        continue;
      }

      var seriesName = (cols.length >= 3 && cols[2] !== '') ? cols[2] : cols[1];
      if (cols.length < 3 || cols[2] === '') {
        warnings.push(lineNo + '行目: 系列が空のため機種名を系列として扱いました: "' + cols[1] + '"');
      }

      var mi = monthIndex(yy, mm);
      if (mi < MI_MIN || mi > MI_MAX) {
        warnings.push(lineNo + '行目: 表示範囲(' + miToLabel(MI_MIN) + ' - ' + miToLabel(MI_MAX) +
                      ')外の年月です: "' + cols[0] + '"');
      }

      var model = {
        id: 'm' + models.length,
        maker: current.name,
        makerRef: current,
        year: yy,
        month: mm,
        mi: mi,
        ym: miToLabel(mi),
        name: cols[1],
        series: seriesName,
        order: models.length,
        prev: null,
        next: null,
        gapPrev: null,
        gapNext: null,
        branchParent: null,
        branchChildren: null
      };
      models.push(model);
      if (current.series.indexOf(seriesName) === -1) current.series.push(seriesName);
      continue;
    }

    warnings.push(lineNo + '行目: 解釈できない行を読み飛ばしました: "' + line + '"');
  }

  for (var k = 0; k < makers.length; k++) {
    if (!makers[k].color) {
      makers[k].color = '#888888';
      warnings.push('メーカー "' + makers[k].name + '" に color 指定がないため既定色を使いました。');
    }
    applyLaneOrder(makers[k], warnings);
  }

  var branches = resolveBranches(branchDecls, models, warnings);

  return { makers: makers, models: models, warnings: warnings, branches: branches };
}

/**
 * lanes: 宣言に従ってメーカーのレーン順を確定する。
 * 宣言が無い場合は timeline.md の出現順のままとする（後方互換）。
 * 実在しない系列名は無視し、書き漏らされた実在系列は右側へ出現順で補う。
 *
 * @param {Object} maker メーカー（series が出現順で入っている）
 * @param {Array<string>} warnings 警告の追加先
 */
function applyLaneOrder(maker, warnings) {
  var decl = maker.laneDecl;
  if (!decl) return;

  var actual = maker.series;          // 出現順の実在系列
  var ordered = [];
  var used = Object.create(null);
  var missing = [];

  for (var i = 0; i < decl.names.length; i++) {
    var nm = decl.names[i];
    if (actual.indexOf(nm) === -1) {
      warnings.push(decl.line + '行目: メーカー "' + maker.name + '" の lanes に実在しない系列 "' +
                    nm + '" があります。無視しました。');
      continue;
    }
    if (used[nm]) {
      warnings.push(decl.line + '行目: メーカー "' + maker.name + '" の lanes に系列 "' +
                    nm + '" が重複しています。最初のものだけ使いました。');
      continue;
    }
    used[nm] = true;
    ordered.push(nm);
  }

  for (var j = 0; j < actual.length; j++) {
    if (!used[actual[j]]) {
      missing.push(actual[j]);
      ordered.push(actual[j]);
    }
  }
  if (missing.length) {
    warnings.push(decl.line + '行目: メーカー "' + maker.name + '" の lanes に系列 ' +
                  missing.join(' / ') + ' が書かれていません。右側へ出現順で追加しました。');
  }

  maker.series = ordered;
}

/**
 * 分岐宣言を実機種へ解決する。全機種を読み終えた後に呼ぶこと。
 * 同一メーカー内で親機種名の完全一致を探し、子系列の最も古い機種を起点とする。
 *
 * @param {Array} decls branch 行の解析結果
 * @param {Array} models 全機種
 * @param {Array<string>} warnings 警告の追加先
 * @returns {Array} 解決済み分岐 { maker, makerRef, from, to, childSeries, line }
 */
function resolveBranches(decls, models, warnings) {
  var out = [];
  if (!decls || !decls.length) return out;

  function byAge(a, b) {
    if (a.mi !== b.mi) return a.mi - b.mi;
    return a.order - b.order;
  }

  for (var i = 0; i < decls.length; i++) {
    var decl = decls[i];
    var parents = [];
    var childItems = [];

    for (var j = 0; j < models.length; j++) {
      var mo = models[j];
      if (mo.maker !== decl.maker) continue;
      if (mo.name === decl.parentName) parents.push(mo);
      if (mo.series === decl.childSeries) childItems.push(mo);
    }

    if (!parents.length) {
      warnings.push(decl.line + '行目: 分岐の親機種 "' + decl.parentName + '" が見つかりません');
      continue;
    }
    parents.sort(byAge);
    if (parents.length > 1) {
      warnings.push(decl.line + '行目: 分岐の親機種 "' + decl.parentName +
                    '" が' + parents.length + '件見つかりました。最も古いもの（' +
                    parents[0].ym + '）を採用しました。');
    }

    if (!childItems.length) {
      warnings.push(decl.line + '行目: 分岐の子系列 "' + decl.childSeries + '" の機種が見つかりません');
      continue;
    }
    childItems.sort(byAge);

    var parent = parents[0];
    var child = childItems[0];

    if (parent === child) {
      warnings.push(decl.line + '行目: 分岐の親機種と子系列の起点が同一機種です: "' + parent.name + '"');
      continue;
    }
    if (child.mi < parent.mi) {
      warnings.push(decl.line + '行目: 分岐の子系列 "' + decl.childSeries + '" の起点（' + child.ym +
                    '）が親機種 "' + parent.name + '"（' + parent.ym + '）より古いため無効にしました');
      continue;
    }

    var br = {
      maker: decl.maker,
      makerRef: decl.makerRef,
      from: parent,
      to: child,
      childSeries: decl.childSeries,
      line: decl.line
    };
    if (!parent.branchChildren) parent.branchChildren = [];
    parent.branchChildren.push(br);
    child.branchParent = br;
    out.push(br);
  }

  return out;
}

/**
 * 系列ごとに発売年月順へ並べ、前後機種と経過月数を計算する。
 * 前後関係は「同一メーカー・同一系列」内で判定する。
 * @param {Array} models parseTimeline の models
 * @returns {Array} 系列オブジェクトの配列
 */
function buildSeries(models) {
  var map = Object.create(null);
  var list = [];

  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var key = m.maker + ' ' + m.series;
    var s = map[key];
    if (!s) {
      s = { key: key, maker: m.maker, makerRef: m.makerRef, name: m.series, items: [], order: list.length };
      map[key] = s;
      list.push(s);
    }
    s.items.push(m);
  }

  for (var j = 0; j < list.length; j++) {
    var items = list[j].items;
    items.sort(function (a, b) {
      if (a.mi !== b.mi) return a.mi - b.mi;
      return a.order - b.order;
    });
    for (var k = 0; k < items.length; k++) {
      var cur = items[k];
      cur.prev = k > 0 ? items[k - 1] : null;
      cur.next = k < items.length - 1 ? items[k + 1] : null;
      cur.gapPrev = cur.prev ? monthDiff(cur.prev.year, cur.prev.month, cur.year, cur.month) : null;
      cur.gapNext = cur.next ? monthDiff(cur.year, cur.month, cur.next.year, cur.next.month) : null;
    }
  }

  return list;
}

/**
 * 3か月以内のモデルチェンジ（同一系列内）を列挙する。
 */
function findQuickChanges(seriesList) {
  var out = [];
  for (var i = 0; i < seriesList.length; i++) {
    var items = seriesList[i].items;
    for (var j = 1; j < items.length; j++) {
      var gap = items[j].gapPrev;
      if (gap !== null && gap <= QUICK_MONTHS) {
        out.push({
          maker: items[j].maker,
          series: seriesList[i].name,
          from: items[j - 1],
          to: items[j],
          gap: gap
        });
      }
    }
  }
  out.sort(function (a, b) { return (a.gap - b.gap) || (a.to.mi - b.to.mi); });
  return out;
}

/**
 * 年表データの自己点検。同一メーカー・同一年月に複数の機種が並ぶ箇所と、
 * 機種名に系列名を含まない機種を洗い出す。呼び出し側の任意利用で、描画には影響しない。
 */
function auditData(models, seriesList) {
  var sameMonth = [];
  var byKey = Object.create(null);
  var keys = [];
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var key = m.maker + ' ' + m.ym;
    if (!byKey[key]) { byKey[key] = []; keys.push(key); }
    byKey[key].push(m);
  }
  for (var q = 0; q < keys.length; q++) {
    if (byKey[keys[q]].length > 1) sameMonth.push(byKey[keys[q]]);
  }

  var seriesNameMismatch = [];
  for (var s = 0; s < seriesList.length; s++) {
    var items = seriesList[s].items;
    for (var j = 0; j < items.length; j++) {
      if (items[j].name.indexOf(seriesList[s].name) === -1) {
        seriesNameMismatch.push(items[j]);
      }
    }
  }

  return { sameMonth: sameMonth, seriesNameMismatch: seriesNameMismatch };
}

/* Node.js からパーサーを単体検証できるようにエクスポートする（ブラウザでは無視される）。 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTimeline: parseTimeline,
    applyLaneOrder: applyLaneOrder,
    resolveBranches: resolveBranches,
    buildSeries: buildSeries,
    findQuickChanges: findQuickChanges,
    auditData: auditData,
    monthIndex: monthIndex,
    monthDiff: monthDiff,
    miToLabel: miToLabel,
    gapText: gapText,
    RANGE: RANGE,
    MI_MIN: MI_MIN,
    MI_MAX: MI_MAX,
    MONTH_COUNT: MONTH_COUNT,
    QUICK_MONTHS: QUICK_MONTHS
  };
}

/* =========================================================================
 * 3. 以降はブラウザ専用
 * ========================================================================= */

if (typeof document !== 'undefined') {
  (function () {

    /* ---- 小さなDOMヘルパー ---- */

    function svgEl(tag, attrs) {
      var n = document.createElementNS(SVG_NS, tag);
      if (attrs) {
        for (var k in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
            n.setAttribute(k, String(attrs[k]));
          }
        }
      }
      return n;
    }

    function svgTitle(parent, text) {
      var t = document.createElementNS(SVG_NS, 'title');
      t.textContent = text;
      parent.appendChild(t);
      return t;
    }

    function htmlEl(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = text;
      return n;
    }

    /* ---- テキスト幅計測（canvasが使えない環境でも概算で動く） ---- */

    var measureCtx = (function () {
      try {
        var c = document.createElement('canvas');
        return c.getContext ? c.getContext('2d') : null;
      } catch (e) {
        return null;
      }
    })();

    var BOX_FONT = '600 9.5px system-ui, -apple-system, "Segoe UI", sans-serif';

    function textWidth(str, font) {
      if (measureCtx) {
        measureCtx.font = font;
        return measureCtx.measureText(str).width;
      }
      var mm = /(\d+(?:\.\d+)?)px/.exec(font);
      var size = mm ? parseFloat(mm[1]) : 12;
      var w = 0;
      for (var i = 0; i < str.length; i++) {
        w += (str.charCodeAt(i) < 0x100 ? 0.55 : 1.0) * size;
      }
      return w;
    }

    function fitText(str, maxW, font) {
      if (textWidth(str, font) <= maxW) return str;
      var lo = 0, hi = str.length;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (textWidth(str.slice(0, mid) + '…', font) <= maxW) lo = mid; else hi = mid - 1;
      }
      return (lo > 0 ? str.slice(0, lo) : '') + '…';
    }

    /**
     * 機種名を最大2行に収める。1行で入るならそのまま、入らず空白があれば
     * 左右の幅が最も揃う位置で2分割する。それでも溢れる行は fitText で省略する。
     * 全文はボックスのツールチップと詳細モーダルで読める。
     */
    function fitLines(str, maxW, font) {
      if (textWidth(str, font) <= maxW) return [str];

      var parts = str.split(' ');
      if (parts.length >= 2) {
        var best = null;
        for (var k = 1; k < parts.length; k++) {
          var a = parts.slice(0, k).join(' ');
          var b = parts.slice(k).join(' ');
          var m = Math.max(textWidth(a, font), textWidth(b, font));
          if (best === null || m < best.m) best = { a: a, b: b, m: m };
        }
        if (best) return [fitText(best.a, maxW, font), fitText(best.b, maxW, font)];
      }
      return [fitText(str, maxW, font)];
    }

    /* ---- 状態 ---- */

    var state = {
      makers: [],
      models: [],
      series: [],
      branches: [],
      warnings: [],
      hiddenMakers: Object.create(null),
      query: '',
      hits: [],
      zoom: 1,
      baseW: 1,
      baseH: 1,
      boxIds: [],
      boxNodes: Object.create(null),
      connNodes: [],
      branchNodes: [],
      layout: null
    };

    var ZOOM_MIN = 0.45, ZOOM_MAX = 3, ZOOM_STEP = 1.25;

    /* ---- 要素参照 ---- */

    var elScroller   = document.getElementById('scroller');
    var elChart      = document.getElementById('chart');
    var elStatus     = document.getElementById('status');
    var elToggles    = document.getElementById('makerToggles');
    var elLegend     = document.getElementById('legend');
    var elSearch     = document.getElementById('searchInput');
    var elSearchCnt  = document.getElementById('searchCount');
    var elSearchClr  = document.getElementById('searchClear');
    var elYearJump   = document.getElementById('yearJump');
    var elZoomIn     = document.getElementById('zoomIn');
    var elZoomOut    = document.getElementById('zoomOut');
    var elZoomReset  = document.getElementById('zoomReset');
    var elZoomLabel  = document.getElementById('zoomLabel');
    var elModal      = document.getElementById('modal');
    var elModalPanel = elModal.querySelector('.modal-panel');
    var elModalClose = document.getElementById('modalClose');
    var elModalMaker = document.getElementById('modalMaker');
    var elModalTitle = document.getElementById('modalTitle');
    var elModalBody  = document.getElementById('modalBody');

    var stickyAxis = null;   // 横スクロールに追従する軸グループ
    var stickyHead = null;   // 縦スクロールに追従するメーカー見出しグループ

    /* ---- 座標計算 ---- */

    function rowTop(mi) {
      return GEO.headerH + GEO.topPad + (mi - MI_MIN) * GEO.monthH;
    }
    function rowCenter(mi) {
      return rowTop(mi) + GEO.monthH / 2;
    }

    /** 表示中メーカーから列とレーンのレイアウトを組み立てる */
    function computeLayout() {
      var cols = [];
      var x = GEO.axisW;
      for (var i = 0; i < state.makers.length; i++) {
        var mk = state.makers[i];
        if (state.hiddenMakers[mk.name]) continue;

        var lanes = mk.series.slice();          // lanes: 宣言があればその順、無ければ機種行の出現順
        var laneIndex = Object.create(null);
        for (var l = 0; l < lanes.length; l++) laneIndex[lanes[l]] = l;

        var w = Math.max(1, lanes.length) * GEO.laneW;
        cols.push({ maker: mk, x: x, w: w, lanes: lanes, laneIndex: laneIndex });
        x += w;
      }
      var totalW = Math.max(x + GEO.rightPad, GEO.axisW + GEO.laneW);
      var totalH = GEO.headerH + GEO.topPad + MONTH_COUNT * GEO.monthH + GEO.bottomPad;
      return { cols: cols, totalW: totalW, totalH: totalH };
    }

    function colOf(layout, makerName) {
      for (var c = 0; c < layout.cols.length; c++) {
        if (layout.cols[c].maker.name === makerName) return layout.cols[c];
      }
      return null;
    }

    function laneCenterX(col, seriesName) {
      var idx = col.laneIndex[seriesName];
      if (idx === undefined) idx = 0;
      return col.x + idx * GEO.laneW + GEO.laneW / 2;
    }

    /* ---- 描画 ---- */

    function render() {
      var layout = computeLayout();
      state.layout = layout;
      state.baseW = layout.totalW;
      state.baseH = layout.totalH;
      state.boxIds = [];
      state.boxNodes = Object.create(null);
      state.connNodes = [];
      state.branchNodes = [];

      while (elChart.firstChild) elChart.removeChild(elChart.firstChild);
      elChart.setAttribute('viewBox', '0 0 ' + layout.totalW + ' ' + layout.totalH);
      applyZoom();

      var defs = svgEl('defs');
      addBranchMarkers(defs);
      elChart.appendChild(defs);

      elChart.appendChild(svgEl('rect', {
        x: 0, y: 0, width: layout.totalW, height: layout.totalH, fill: '#0f1115'
      }));

      drawGrid(layout);
      drawEraBoundary(layout);
      drawConnections(layout);
      drawBranches(layout);
      drawBoxes(layout);
      stickyAxis = drawAxis(layout);
      stickyHead = drawMakerHeader(layout);

      syncSticky();
      applyFilter();
    }

    function drawGrid(layout) {
      var g = svgEl('g', { 'class': 'grid' });
      var left = GEO.axisW;
      var right = layout.totalW - GEO.rightPad;
      var bandW = right - left;

      for (var mi = MI_MIN; mi <= MI_MAX; mi++) {
        var y = rowTop(mi);
        var m = (mi % 12) + 1;
        var yr = RANGE.startYear + Math.floor(mi / 12);

        if (yr % 2 === 0) {
          g.appendChild(svgEl('rect', { x: left, y: y, width: bandW, height: GEO.monthH, fill: '#141821' }));
        }
        g.appendChild(svgEl('line', {
          x1: left, y1: y, x2: right, y2: y,
          stroke: (m === 1 ? '#39425a' : '#20252f'),
          'stroke-width': (m === 1 ? 1.4 : 0.8)
        }));
      }

      g.appendChild(svgEl('line', {
        x1: left, y1: rowTop(MI_MAX + 1), x2: right, y2: rowTop(MI_MAX + 1),
        stroke: '#39425a', 'stroke-width': 1.4
      }));

      for (var c = 0; c < layout.cols.length; c++) {
        var col = layout.cols[c];
        g.appendChild(svgEl('line', {
          x1: col.x, y1: GEO.headerH, x2: col.x, y2: rowTop(MI_MAX + 1),
          stroke: '#39425a', 'stroke-width': 1.2
        }));
        for (var l = 1; l < col.lanes.length; l++) {
          g.appendChild(svgEl('line', {
            x1: col.x + l * GEO.laneW, y1: GEO.headerH,
            x2: col.x + l * GEO.laneW, y2: rowTop(MI_MAX + 1),
            stroke: '#232a37', 'stroke-width': 0.8, 'stroke-dasharray': '3 5'
          }));
        }
      }
      if (layout.cols.length) {
        var last = layout.cols[layout.cols.length - 1];
        g.appendChild(svgEl('line', {
          x1: last.x + last.w, y1: GEO.headerH, x2: last.x + last.w, y2: rowTop(MI_MAX + 1),
          stroke: '#39425a', 'stroke-width': 1.2
        }));
      }

      elChart.appendChild(g);
    }

    /** 1989-01-08 の平成開始境界 */
    function drawEraBoundary(layout) {
      var mi = monthIndex(HEISEI.year, HEISEI.month);
      var y = rowTop(mi) + GEO.monthH * (HEISEI.day / 31);
      var g = svgEl('g', { 'class': 'era' });

      g.appendChild(svgEl('line', {
        x1: GEO.axisW, y1: y, x2: layout.totalW - GEO.rightPad, y2: y,
        stroke: '#ff922b', 'stroke-width': 2.6, 'stroke-dasharray': '10 6'
      }));

      var labelW = 186, labelH = 22;
      var lx = layout.totalW - GEO.rightPad - labelW - 8;
      if (lx < GEO.axisW + 8) lx = GEO.axisW + 8;
      g.appendChild(svgEl('rect', {
        x: lx, y: y - labelH - 4, width: labelW, height: labelH, rx: 6,
        fill: '#3b2408', stroke: '#ff922b', 'stroke-width': 1.2
      }));
      var t = svgEl('text', {
        x: lx + labelW / 2, y: y - labelH / 2 - 4,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: '#ffd8a8', 'font-size': 12, 'font-weight': 700
      });
      t.textContent = '平成元年 1989-01-08';
      g.appendChild(t);

      elChart.appendChild(g);
    }

    function drawConnections(layout) {
      var g = svgEl('g', { 'class': 'conns' });

      for (var s = 0; s < state.series.length; s++) {
        var ser = state.series[s];
        if (state.hiddenMakers[ser.maker]) continue;

        var col = colOf(layout, ser.maker);
        if (!col) continue;

        var x = laneCenterX(col, ser.name);
        var items = ser.items;

        for (var i = 1; i < items.length; i++) {
          var a = items[i - 1], b = items[i];
          var y1 = rowCenter(a.mi) + GEO.boxH / 2;
          var y2 = rowCenter(b.mi) - GEO.boxH / 2;
          if (y2 < y1) { var tmp = y1; y1 = y2; y2 = tmp; }

          var gap = b.gapPrev;

          // 接続線は経過月数によらず一律の見た目とする。
          var line = svgEl('line', {
            x1: x, y1: y1, x2: x, y2: y2,
            stroke: ser.makerRef.color,
            'stroke-width': 2,
            'stroke-opacity': 0.85,
            'class': 'conn'
          });
          svgTitle(line, a.name + ' → ' + b.name + '（' + gapText(gap) + '）');
          state.connNodes.push({ node: line, from: a, to: b, gap: gap });
          g.appendChild(line);
        }
      }
      elChart.appendChild(g);
    }

    /** 分岐線の終端に付ける矢印マーカーをメーカーごとに用意する */
    function branchMarkerId(maker) {
      return 'branchArrow-' + maker.order;
    }

    function addBranchMarkers(defs) {
      for (var i = 0; i < state.makers.length; i++) {
        var mk = state.makers[i];
        var mk2 = svgEl('marker', {
          id: branchMarkerId(mk),
          viewBox: '0 0 8 8',
          refX: 7,
          refY: 4,
          markerWidth: 8,
          markerHeight: 8,
          markerUnits: 'userSpaceOnUse',
          orient: 'auto'
        });
        mk2.appendChild(svgEl('path', {
          d: 'M0,0.8 L7.2,4 L0,7.2 Z',
          fill: mk.color,
          'fill-opacity': 0.85
        }));
        defs.appendChild(mk2);
      }
    }

    /** 系列をまたぐ分岐線。本線の直後・機種ボックスの前に描く */
    function drawBranches(layout) {
      var g = svgEl('g', { 'class': 'branches' });
      var boxW = GEO.laneW - 20;

      for (var i = 0; i < state.branches.length; i++) {
        var br = state.branches[i];
        if (state.hiddenMakers[br.maker]) continue;

        var col = colOf(layout, br.maker);
        if (!col) continue;

        var from = br.from, to = br.to;
        if (from.mi < MI_MIN || from.mi > MI_MAX) continue;
        if (to.mi < MI_MIN || to.mi > MI_MAX) continue;

        var x1 = laneCenterX(col, from.series);
        var x2 = laneCenterX(col, to.series);
        var y2 = rowCenter(to.mi) - GEO.boxH / 2;
        var y1, d;

        if (from.mi === to.mi) {
          // 同じ年月では下辺から出すと線が潰れるため、子レーン側の側面から出す
          var side = (x2 >= x1) ? 1 : -1;
          y1 = rowCenter(from.mi);
          x1 = x1 + side * (boxW / 2);
          var dx = (x2 - x1) / 2;
          d = 'M' + x1 + ',' + y1 +
              ' C' + (x1 + dx) + ',' + y1 +
              ' ' + x2 + ',' + (y1 - GEO.monthH * 0.9) +
              ' ' + x2 + ',' + y2;
        } else {
          y1 = rowCenter(from.mi) + GEO.boxH / 2;
          var cd = Math.max(GEO.monthH, Math.min((y2 - y1) * 0.45, GEO.monthH * 4));
          d = 'M' + x1 + ',' + y1 +
              ' C' + x1 + ',' + (y1 + cd) +
              ' ' + x2 + ',' + (y2 - cd) +
              ' ' + x2 + ',' + y2;
        }

        var path = svgEl('path', {
          d: d,
          'class': 'branch',
          fill: 'none',
          stroke: br.makerRef.color,
          'stroke-width': 1.6,
          'stroke-opacity': 0.75,
          'stroke-dasharray': '7 5',
          'marker-end': 'url(#' + branchMarkerId(br.makerRef) + ')'
        });
        svgTitle(path, from.name + ' から ' + br.childSeries + ' 系列が分岐');
        state.branchNodes.push({ node: path, branch: br });
        g.appendChild(path);
      }

      elChart.appendChild(g);
    }

    function drawBoxes(layout) {
      var g = svgEl('g', { 'class': 'boxes' });

      for (var i = 0; i < state.models.length; i++) {
        var m = state.models[i];
        if (state.hiddenMakers[m.maker]) continue;
        if (m.mi < MI_MIN || m.mi > MI_MAX) continue;

        var col = colOf(layout, m.maker);
        if (!col) continue;

        var cx = laneCenterX(col, m.series);
        var boxW = GEO.laneW - 6;
        var x = cx - boxW / 2;
        var cy = rowCenter(m.mi);
        var y = cy - GEO.boxH / 2;

        var grp = svgEl('g', {
          'class': 'model-box',
          role: 'button',
          tabindex: '0',
          'data-id': m.id,
          'aria-label': m.maker + ' ' + m.name + ' ' + m.ym
        });

        grp.appendChild(svgEl('rect', {
          x: x, y: y, width: boxW, height: GEO.boxH, rx: 6,
          fill: m.makerRef.color, 'fill-opacity': 0.20,
          stroke: m.makerRef.color,
          'class': 'box-rect'
        }));

        var lines = fitLines(m.name, boxW - 6, BOX_FONT);
        for (var li = 0; li < lines.length; li++) {
          var ly = (lines.length === 1) ? cy : (cy + (li === 0 ? -5.5 : 5.5));
          var label = svgEl('text', {
            x: cx, y: ly,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            fill: '#e8ecf2', 'font-size': 9.5, 'font-weight': 600
          });
          label.textContent = lines[li];
          grp.appendChild(label);
        }

        svgTitle(grp, m.ym + ' ' + m.name + '（' + m.maker + ' / ' + m.series + '）');

        state.boxNodes[m.id] = { node: grp, model: m, cx: cx, cy: cy, x: x, y: y, w: boxW };
        state.boxIds.push(m.id);
        g.appendChild(grp);
      }

      elChart.appendChild(g);
    }

    /** 左の年月軸（横スクロールに追従） */
    function drawAxis(layout) {
      var g = svgEl('g', { 'class': 'axis' });

      g.appendChild(svgEl('rect', { x: 0, y: 0, width: GEO.axisW, height: layout.totalH, fill: '#141821' }));
      g.appendChild(svgEl('line', {
        x1: GEO.axisW, y1: 0, x2: GEO.axisW, y2: layout.totalH,
        stroke: '#39425a', 'stroke-width': 1.2
      }));

      var hy = rowTop(monthIndex(HEISEI.year, HEISEI.month)) + GEO.monthH * (HEISEI.day / 31);
      var bandX = GEO.axisW - 9;
      g.appendChild(svgEl('rect', {
        x: bandX, y: rowTop(MI_MIN), width: 7, height: hy - rowTop(MI_MIN), fill: '#4c5670'
      }));
      g.appendChild(svgEl('rect', {
        x: bandX, y: hy, width: 7, height: rowTop(MI_MAX + 1) - hy, fill: '#ff922b'
      }));

      function eraLabel(txt, yc, fill) {
        var t = svgEl('text', {
          x: bandX + 3.5, y: yc, fill: fill, 'font-size': 11, 'font-weight': 700,
          'text-anchor': 'middle',
          transform: 'rotate(-90 ' + (bandX + 3.5) + ' ' + yc + ')'
        });
        t.textContent = txt;
        return t;
      }
      g.appendChild(eraLabel('昭和', (rowTop(MI_MIN) + hy) / 2, '#0f1115'));
      g.appendChild(eraLabel('平成', (hy + rowTop(MI_MAX + 1)) / 2, '#3b2408'));

      for (var mi = MI_MIN; mi <= MI_MAX; mi++) {
        var y = rowCenter(mi);
        var m = (mi % 12) + 1;
        var yr = RANGE.startYear + Math.floor(mi / 12);

        if (m === 1 || mi === MI_MIN) {
          var yt = svgEl('text', {
            x: 10, y: y, 'dominant-baseline': 'central',
            fill: '#e8ecf2', 'font-size': 14, 'font-weight': 700
          });
          yt.textContent = String(yr);
          g.appendChild(yt);
        }
        var mt = svgEl('text', {
          x: GEO.axisW - 14, y: y, 'text-anchor': 'end', 'dominant-baseline': 'central',
          fill: (m === 1 ? '#c8d1de' : '#78839a'), 'font-size': 10
        });
        mt.textContent = m + '月';
        g.appendChild(mt);
      }

      elChart.appendChild(g);
      return g;
    }

    /** 上のメーカー見出し（縦スクロールに追従） */
    function drawMakerHeader(layout) {
      var g = svgEl('g', { 'class': 'makerhead' });

      g.appendChild(svgEl('rect', { x: 0, y: 0, width: layout.totalW, height: GEO.headerH, fill: '#171a21' }));
      g.appendChild(svgEl('line', {
        x1: 0, y1: GEO.headerH, x2: layout.totalW, y2: GEO.headerH,
        stroke: '#39425a', 'stroke-width': 1.2
      }));

      var axisTitle = svgEl('text', {
        x: 10, y: GEO.headerH / 2, 'dominant-baseline': 'central',
        fill: '#98a2b3', 'font-size': 11, 'font-weight': 700
      });
      axisTitle.textContent = '年 / 月';
      g.appendChild(axisTitle);

      for (var c = 0; c < layout.cols.length; c++) {
        var col = layout.cols[c];
        g.appendChild(svgEl('rect', {
          x: col.x + 2, y: 6, width: col.w - 4, height: GEO.headerH - 14, rx: 8,
          fill: col.maker.color, 'fill-opacity': 0.18,
          stroke: col.maker.color, 'stroke-width': 1.2
        }));
        var nm = svgEl('text', {
          x: col.x + col.w / 2, y: 21,
          'text-anchor': 'middle', 'dominant-baseline': 'central',
          fill: '#e8ecf2', 'font-size': 14, 'font-weight': 700, 'letter-spacing': '0.06em'
        });
        nm.textContent = col.maker.name;
        g.appendChild(nm);

        for (var l = 0; l < col.lanes.length; l++) {
          var lt = svgEl('text', {
            x: col.x + l * GEO.laneW + GEO.laneW / 2, y: 39,
            'text-anchor': 'middle', 'dominant-baseline': 'central',
            fill: '#aab4c4', 'font-size': 11
          });
          lt.textContent = fitText(col.lanes[l], GEO.laneW - 12, '400 11px system-ui, sans-serif');
          g.appendChild(lt);
        }
      }

      elChart.appendChild(g);
      return g;
    }

    /* ---- スクロール追従 ---- */

    function syncSticky() {
      var z = state.zoom || 1;
      if (stickyAxis) {
        stickyAxis.setAttribute('transform', 'translate(' + (elScroller.scrollLeft / z) + ',0)');
      }
      if (stickyHead) {
        stickyHead.setAttribute('transform', 'translate(0,' + (elScroller.scrollTop / z) + ')');
      }
    }

    /* ---- ズーム ---- */

    function applyZoom() {
      elChart.setAttribute('width', Math.round(state.baseW * state.zoom));
      elChart.setAttribute('height', Math.round(state.baseH * state.zoom));
      elZoomLabel.textContent = Math.round(state.zoom * 100) + '%';
      syncSticky();
    }

    function setZoom(next) {
      var z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      if (z === state.zoom) return;
      var ratio = z / state.zoom;
      var cx = elScroller.scrollLeft + elScroller.clientWidth / 2;
      var cy = elScroller.scrollTop + elScroller.clientHeight / 2;
      state.zoom = z;
      applyZoom();
      elScroller.scrollLeft = Math.max(0, cx * ratio - elScroller.clientWidth / 2);
      elScroller.scrollTop = Math.max(0, cy * ratio - elScroller.clientHeight / 2);
      syncSticky();
    }

    /* ---- 検索・フィルタ ---- */

    function applyFilter() {
      var q = state.query.trim().toLowerCase();
      var hits = [];

      for (var i = 0; i < state.boxIds.length; i++) {
        var rec = state.boxNodes[state.boxIds[i]];
        var hit = (q !== '' && rec.model.name.toLowerCase().indexOf(q) !== -1);
        var cls = 'model-box';
        if (q !== '') cls += hit ? ' hit' : ' dim';
        rec.node.setAttribute('class', cls);
        if (hit) hits.push(rec);
      }

      for (var j = 0; j < state.connNodes.length; j++) {
        var cn = state.connNodes[j];
        cn.node.setAttribute('class', 'conn' + (q !== '' ? ' dim' : ''));
      }

      for (var b = 0; b < state.branchNodes.length; b++) {
        state.branchNodes[b].node.setAttribute('class', 'branch' + (q !== '' ? ' dim' : ''));
      }

      hits.sort(function (a, b) { return a.model.mi - b.model.mi; });
      state.hits = hits;
      elSearchCnt.textContent = (q === '') ? '' : (hits.length + '件');
    }

    function scrollToModel(rec, focusIt) {
      if (!rec) return;
      var z = state.zoom;
      elScroller.scrollTop = Math.max(0, rec.cy * z - elScroller.clientHeight / 2);
      elScroller.scrollLeft = Math.max(0, rec.cx * z - elScroller.clientWidth / 2);
      syncSticky();
      if (focusIt) {
        try { rec.node.focus({ preventScroll: true }); } catch (e) { /* 非対応環境は無視 */ }
      }
    }

    function scrollToYear(year) {
      var mi = Math.max(MI_MIN, monthIndex(year, 1));
      elScroller.scrollTop = Math.max(0, (rowTop(mi) - GEO.headerH - 4) * state.zoom);
      syncSticky();
    }

    /* ---- モーダル ---- */

    var lastFocused = null;

    function addRow(dt, ddText, cls) {
      elModalBody.appendChild(htmlEl('dt', null, dt));
      var d2 = htmlEl('dd', cls || null, ddText);
      elModalBody.appendChild(d2);
      return d2;
    }

    function openModal(model) {
      lastFocused = document.activeElement;

      elModalMaker.textContent = model.maker;
      elModalMaker.style.color = model.makerRef.color;
      elModalTitle.textContent = model.name;

      while (elModalBody.firstChild) elModalBody.removeChild(elModalBody.firstChild);

      addRow('メーカー', model.maker);
      addRow('機種名', model.name);
      addRow('発売年月', model.year + '年' + model.month + '月（' + model.ym + '）');
      addRow('系列', model.series);

      if (model.branchParent) {
        addRow('系列の分岐', model.branchParent.from.name + '（' + model.branchParent.from.ym +
               '）から分岐した系列の最初の機種');
      }
      if (model.branchChildren && model.branchChildren.length) {
        var names = [];
        for (var bi = 0; bi < model.branchChildren.length; bi++) {
          names.push(model.branchChildren[bi].childSeries);
        }
        addRow('派生した系列', 'この機種から ' + names.join(' / ') + ' 系列が分岐');
      }

      if (model.prev) {
        addRow('前機種', model.prev.name + '（' + model.prev.ym + '）');
        var dd1 = addRow('前機種からの経過月数', gapText(model.gapPrev));
        if (model.gapPrev <= QUICK_MONTHS) {
          dd1.appendChild(htmlEl('span', 'gap-badge quick', '3か月以内のモデルチェンジ'));
        }
      } else {
        addRow('前機種', '—（なし / この系列の最初の機種）', 'none');
        addRow('前機種からの経過月数', '—（なし）', 'none');
      }

      if (model.next) {
        addRow('次機種', model.next.name + '（' + model.next.ym + '）');
        var dd2 = addRow('次機種までの経過月数', gapText(model.gapNext));
        if (model.gapNext <= QUICK_MONTHS) {
          dd2.appendChild(htmlEl('span', 'gap-badge quick', '3か月以内のモデルチェンジ'));
        }
      } else {
        addRow('次機種', '—（なし / この系列の最後の機種）', 'none');
        addRow('次機種までの経過月数', '—（なし）', 'none');
      }

      elModal.hidden = false;
      elModalClose.focus();
      document.addEventListener('keydown', onModalKeydown, true);
    }

    function closeModal() {
      if (elModal.hidden) return;
      elModal.hidden = true;
      document.removeEventListener('keydown', onModalKeydown, true);
      if (lastFocused && typeof lastFocused.focus === 'function') {
        try { lastFocused.focus({ preventScroll: true }); } catch (e) { /* 無視 */ }
      }
      lastFocused = null;
    }

    function onModalKeydown(ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        closeModal();
        return;
      }
      if (ev.key !== 'Tab') return;
      var focusables = elModalPanel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    }

    /* ---- コントロール構築 ---- */

    function buildMakerToggles() {
      while (elToggles.firstChild) elToggles.removeChild(elToggles.firstChild);
      state.makers.forEach(function (mk) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'maker-toggle';
        b.style.color = mk.color;
        b.setAttribute('aria-pressed', state.hiddenMakers[mk.name] ? 'false' : 'true');
        b.appendChild(htmlEl('span', 'swatch'));
        var lab = htmlEl('span', null, mk.name);
        lab.style.color = 'var(--ink)';
        b.appendChild(lab);
        b.addEventListener('click', function () {
          if (state.hiddenMakers[mk.name]) delete state.hiddenMakers[mk.name];
          else state.hiddenMakers[mk.name] = true;
          b.setAttribute('aria-pressed', state.hiddenMakers[mk.name] ? 'false' : 'true');
          render();
        });
        elToggles.appendChild(b);
      });
    }

    function buildLegend() {
      while (elLegend.firstChild) elLegend.removeChild(elLegend.firstChild);

      state.makers.forEach(function (mk) {
        var w = htmlEl('span', 'lg');
        var line = htmlEl('span', 'lg-line');
        line.style.borderTopColor = mk.color;
        w.appendChild(line);
        w.appendChild(htmlEl('span', null, mk.name));
        elLegend.appendChild(w);
      });

      var br = htmlEl('span', 'lg');
      br.appendChild(htmlEl('span', 'lg-line branch'));
      br.appendChild(htmlEl('span', null, '系列の分岐（破線の矢印）'));
      elLegend.appendChild(br);

      var h = htmlEl('span', 'lg');
      h.appendChild(htmlEl('span', 'lg-line heisei'));
      h.appendChild(htmlEl('span', null, '平成開始 1989-01-08'));
      elLegend.appendChild(h);
    }

    function buildYearJump() {
      while (elYearJump.firstChild) elYearJump.removeChild(elYearJump.firstChild);
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '選択';
      elYearJump.appendChild(opt0);
      for (var y = RANGE.startYear; y <= RANGE.endYear; y++) {
        var o = document.createElement('option');
        o.value = String(y);
        o.textContent = y + '年';
        elYearJump.appendChild(o);
      }
    }

    /* ---- イベント ---- */

    function closestBox(node) {
      while (node && node !== elChart) {
        if (node.getAttribute && node.getAttribute('data-id') &&
            String(node.getAttribute('class') || '').indexOf('model-box') !== -1) {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    }

    function bindEvents() {
      elScroller.addEventListener('scroll', syncSticky, { passive: true });
      window.addEventListener('resize', syncSticky);

      elChart.addEventListener('click', function (ev) {
        var g = closestBox(ev.target);
        if (!g) return;
        var rec = state.boxNodes[g.getAttribute('data-id')];
        if (rec) openModal(rec.model);
      });

      elChart.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        var g = closestBox(ev.target);
        if (!g) return;
        ev.preventDefault();
        var rec = state.boxNodes[g.getAttribute('data-id')];
        if (rec) openModal(rec.model);
      });

      elModal.addEventListener('click', function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close') === '1') closeModal();
      });
      elModalClose.addEventListener('click', closeModal);

      elSearch.addEventListener('input', function () {
        state.query = elSearch.value;
        applyFilter();
      });
      elSearch.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (state.hits.length) scrollToModel(state.hits[0], true);
        }
      });
      elSearchClr.addEventListener('click', function () {
        elSearch.value = '';
        state.query = '';
        applyFilter();
        elSearch.focus();
      });

      elYearJump.addEventListener('change', function () {
        var v = parseInt(elYearJump.value, 10);
        if (!isNaN(v)) scrollToYear(v);
      });

      elZoomIn.addEventListener('click', function () { setZoom(state.zoom * ZOOM_STEP); });
      elZoomOut.addEventListener('click', function () { setZoom(state.zoom / ZOOM_STEP); });
      elZoomReset.addEventListener('click', function () { setZoom(1); });

      elScroller.addEventListener('wheel', function (ev) {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        setZoom(state.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));
      }, { passive: false });

      document.addEventListener('keydown', function (ev) {
        if (!elModal.hidden) return;
        var tag = document.activeElement ? document.activeElement.tagName : '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); setZoom(state.zoom * ZOOM_STEP); }
        else if (ev.key === '-') { ev.preventDefault(); setZoom(state.zoom / ZOOM_STEP); }
        else if (ev.key === '0') { ev.preventDefault(); setZoom(1); }
        else if (ev.key === '/') { ev.preventDefault(); elSearch.focus(); }
      });
    }

    /* ---- Service Worker ---- */

    function registerServiceWorker() {
      if (!('serviceWorker' in navigator)) return;
      if (location.protocol === 'file:') return;   // file:// では動作しない
      window.addEventListener('load', function () {
        // 相対パス指定。scope は service-worker.js の置き場所（配信サブパス）に従う。
        navigator.serviceWorker.register('./service-worker.js').then(function () {
          /* 登録成功 */
        }, function (err) {
          console.warn('Service Worker の登録に失敗しました:', (err && err.message) ? err.message : err);
        });
      });
    }

    /* ---- 起動 ---- */

    function boot() {
      buildYearJump();
      bindEvents();
      registerServiceWorker();

      fetch('./timeline.md', { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('timeline.md の取得に失敗しました (HTTP ' + res.status + ')');
        return res.text();
      }).then(function (text) {
        var parsed = parseTimeline(text);
        state.makers = parsed.makers;
        state.models = parsed.models;
        state.warnings = parsed.warnings;
        state.branches = parsed.branches || [];
        state.series = buildSeries(parsed.models);

        buildMakerToggles();
        buildLegend();
        render();

        var msg = state.makers.length + 'メーカー / ' + state.models.length + '機種 / ' +
                  state.series.length + '系列 を読み込みました。表示範囲 ' +
                  miToLabel(MI_MIN) + ' - ' + miToLabel(MI_MAX) +
                  '（' + MONTH_COUNT + 'か月・等間隔）。';
        if (state.warnings.length) {
          msg += ' 読み込み時の注意 ' + state.warnings.length + '件（詳細はコンソール）。';
          console.warn('timeline.md の解析メッセージ:\n' + state.warnings.join('\n'));
        }
        elStatus.textContent = msg;
        elStatus.className = 'status';
      })['catch'](function (err) {
        elStatus.className = 'status error';
        elStatus.textContent = 'データを読み込めませんでした: ' +
          ((err && err.message) ? err.message : String(err)) +
          '  （file:// では fetch が使えません。README のとおりローカルHTTPサーバから開いてください。）';
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }

  })();
}

/* ============================================================
   Report Artisan — runtime
   Banners, charts, blocks, editor wiring, export.
   Everything here is inlined into the built report, so the
   file is self-contained and works offline.
   ============================================================ */
(function (global) {
  "use strict";

  var RA = {};
  global.RA = RA;

  /* ---------------------------------------------------------
     0. Small helpers
     --------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  RA.esc = esc;

  function attr(s) { return esc(s); }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // deterministic pseudo-random from a string seed — banners must look
  // the same every time the report is opened
  function rng(seed) {
    var h = 2166136261 >>> 0;
    var str = String(seed || "seed");
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0;
    }
    return function () {
      h ^= h << 13; h >>>= 0;
      h ^= h >> 17;
      h ^= h << 5; h >>>= 0;
      return h / 4294967295;
    };
  }

  /* --- colour utilities (JS-side, so SVG can use plain hex) --- */
  function hex2rgb(h) {
    h = String(h).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgb2hex(r) {
    return "#" + r.map(function (v) {
      var s = Math.round(clamp(v, 0, 255)).toString(16);
      return s.length === 1 ? "0" + s : s;
    }).join("");
  }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function shiftHue(h, deg) {
    var c = hex2rgb(h).map(function (v) { return v / 255; });
    var max = Math.max.apply(null, c), min = Math.min.apply(null, c), d = max - min;
    var hh = 0, s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
      if (max === c[0]) hh = ((c[1] - c[2]) / d) % 6;
      else if (max === c[1]) hh = (c[2] - c[0]) / d + 2;
      else hh = (c[0] - c[1]) / d + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    hh = (hh + deg + 360) % 360;
    var C = v * s, X = C * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - C, r;
    if (hh < 60) r = [C, X, 0]; else if (hh < 120) r = [X, C, 0];
    else if (hh < 180) r = [0, C, X]; else if (hh < 240) r = [0, X, C];
    else if (hh < 300) r = [X, 0, C]; else r = [C, 0, X];
    return rgb2hex([(r[0] + m) * 255, (r[1] + m) * 255, (r[2] + m) * 255]);
  }
  RA.color = { mix: mix, shiftHue: shiftHue };

  /* --- accent presets, mirrored from report.css so SVG art can use hex --- */
  var ACCENTS = {
    blue:   { light: "#2a78d6", dark: "#5d9ceb" },
    indigo: { light: "#4a3aa7", dark: "#9085e9" },
    teal:   { light: "#0f8f79", dark: "#3fbfa6" },
    green:  { light: "#1baf7a", dark: "#3fc793" },
    amber:  { light: "#b8730a", dark: "#e0a33c" },
    rose:   { light: "#c9385c", dark: "#ec6f8f" },
    plum:   { light: "#8a3fa0", dark: "#c07ad4" },
    slate:  { light: "#3f4a5a", dark: "#8fa0b8" }
  };
  RA.ACCENTS = ACCENTS;

  function accentHex() {
    var root = document.documentElement;
    var name = root.getAttribute("data-accent") || "blue";
    var mode = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    return (ACCENTS[name] || ACCENTS.blue)[mode];
  }
  RA.accentHex = accentHex;

  function isDark() { return document.documentElement.getAttribute("data-theme") === "dark"; }

  /* --- number formatting ------------------------------------ */
  var LOCALE = "fr-FR";
  RA.setLocale = function (l) { if (l) LOCALE = l; };

  function fmt(v, f) {
    f = f || {};
    if (v == null || isNaN(v)) return "—";
    var n = Number(v), out;
    if (f.compact) {
      var abs = Math.abs(n), unit = "", div = 1;
      if (abs >= 1e9) { unit = " Md"; div = 1e9; }
      else if (abs >= 1e6) { unit = " M"; div = 1e6; }
      else if (abs >= 1e3) { unit = " k"; div = 1e3; }
      var d = f.decimals != null ? f.decimals : (div > 1 ? 1 : 0);
      out = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })
        .format(n / div) + unit;
    } else {
      var dd = f.decimals != null ? f.decimals : (Math.abs(n) < 10 && n % 1 !== 0 ? 1 : 0);
      out = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: dd, maximumFractionDigits: dd }).format(n);
    }
    return (f.prefix || "") + out + (f.suffix || "");
  }
  RA.fmt = fmt;

  /* ---------------------------------------------------------
     1. Icons — a small, consistent set (1.75 stroke, 24 grid)
     --------------------------------------------------------- */
  var ICONS = {
    info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.6"/>',
    check:     '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-4.9"/>',
    alert:     '<path d="M10.6 3.9L2.5 18a1.6 1.6 0 001.4 2.4h16.2A1.6 1.6 0 0021.5 18L13.4 3.9a1.6 1.6 0 00-2.8 0z"/><path d="M12 9.5v4"/><path d="M12 17.1v.4"/>',
    stop:      '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    bulb:      '<path d="M9 18h6"/><path d="M10 21.5h4"/><path d="M12 2.5a6 6 0 00-3.5 10.9c.6.5.9 1.2.9 1.9V18h5.2v-2.7c0-.7.3-1.4.9-1.9A6 6 0 0012 2.5z"/>',
    target:    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>',
    trendUp:   '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    trendDown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
    arrowUp:   '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    arrowDown: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    minus:     '<path d="M5 12h14"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.2 2"/>',
    users:     '<circle cx="9" cy="8" r="3.4"/><path d="M2.6 20a6.6 6.6 0 0112.8 0"/><path d="M16.5 5.2a3.4 3.4 0 010 5.6"/><path d="M18 14.4a6.6 6.6 0 013.4 5.6"/>',
    euro:      '<path d="M17.5 6.2A7 7 0 006.6 9M6.6 15a7 7 0 0010.9 2.8"/><path d="M4 10.5h8M4 13.9h7"/>',
    chart:     '<path d="M4 20V9"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    doc:       '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    flag:      '<path d="M5 21V4"/><path d="M5 5h11l-1.6 3.5L16 12H5z"/>',
    lock:      '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.4a4 4 0 018 0v3.1"/>',
    globe:     '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3a14 14 0 000 18 14 14 0 000-18z"/>',
    spark:     '<path d="M12 3l1.9 5.4L19.5 10l-5.3 2 -1.8 5.6-2-5.5L5 10l5.6-1.7z"/>',
    layers:    '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    calendar:  '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/>',
    search:    '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    building:  '<path d="M4 21V5.5A1.5 1.5 0 015.5 4h7A1.5 1.5 0 0114 5.5V21"/><path d="M14 10h4.5A1.5 1.5 0 0120 11.5V21"/><path d="M2.5 21h19"/><path d="M7.3 8h3.4M7.3 12h3.4M7.3 16h3.4"/>'
  };

  RA.icon = function (name, size) {
    var p = ICONS[name] || ICONS.info;
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + p + "</svg>";
  };
  RA.iconNames = Object.keys(ICONS);

  /* ---------------------------------------------------------
     2. Banner gallery
     Every banner is a procedural SVG built from the accent
     colour, so the whole gallery restyles when the accent or
     the theme changes. viewBox 1200x400, sliced to fill.
     --------------------------------------------------------- */
  var BANNERS = {};

  function svgWrap(inner, defs) {
    return '<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMid slice" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      (defs ? "<defs>" + defs + "</defs>" : "") + inner + "</svg>";
  }

  function baseStops(a, dark, id, angleDeg) {
    var c1 = dark ? mix(a, "#000000", 0.55) : mix(a, "#000000", 0.30);
    var c2 = dark ? mix(shiftHue(a, -28), "#000000", 0.72) : mix(shiftHue(a, -28), "#000000", 0.05);
    var rad = ((angleDeg == null ? 32 : angleDeg) * Math.PI) / 180;
    var x2 = (Math.cos(rad) * 100).toFixed(1), y2 = (Math.sin(rad) * 100).toFixed(1);
    return '<linearGradient id="' + id + '" x1="0%" y1="0%" x2="' + x2 + '%" y2="' + y2 + '%">' +
      '<stop offset="0%" stop-color="' + c1 + '"/>' +
      '<stop offset="100%" stop-color="' + c2 + '"/></linearGradient>';
  }

  /* --- aurora: soft drifting blobs ------------------------------------ */
  BANNERS.aurora = function (a, dark, seed) {
    var r = rng(seed + "aurora"), blobs = "", i;
    var cols = [shiftHue(a, -30), a, shiftHue(a, 34), mix(a, "#ffffff", 0.4)];
    for (i = 0; i < 5; i++) {
      var cx = 120 + r() * 1000, cy = 40 + r() * 320, rx = 180 + r() * 260, ry = 120 + r() * 170;
      blobs += '<ellipse cx="' + cx.toFixed(0) + '" cy="' + cy.toFixed(0) + '" rx="' + rx.toFixed(0) +
        '" ry="' + ry.toFixed(0) + '" fill="' + cols[i % cols.length] + '" opacity="' +
        (dark ? 0.42 : 0.55) + '"/>';
    }
    return svgWrap(
      '<rect width="1200" height="400" fill="url(#g)"/>' +
      '<g filter="url(#blur)">' + blobs + "</g>",
      baseStops(a, dark, "g") +
      '<filter id="blur" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feGaussianBlur stdDeviation="70"/></filter>'
    );
  };

  /* --- waves: layered sine bands -------------------------------------- */
  BANNERS.waves = function (a, dark, seed) {
    var r = rng(seed + "waves"), out = "", L = 5, i, x;
    for (i = 0; i < L; i++) {
      var amp = 26 + r() * 30, off = 150 + i * 46 + r() * 18, ph = r() * 6.28, d = "M0," + off.toFixed(1);
      for (x = 0; x <= 1200; x += 30) {
        d += " L" + x + "," + (off + Math.sin(x / 190 + ph) * amp + Math.sin(x / 71 + ph * 2) * (amp / 3.2)).toFixed(1);
      }
      d += " L1200,400 L0,400 Z";
      var c = mix(a, dark ? "#000000" : "#ffffff", 0.10 + i * 0.13);
      out += '<path d="' + d + '" style="fill:' + c + ';stroke:none" opacity="' + (0.85 - i * 0.09).toFixed(2) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out,
      baseStops(a, dark, "g", 65));
  };

  /* --- grid: perspective wireframe ------------------------------------ */
  BANNERS.grid = function (a, dark, seed) {
    var lines = "", i, stroke = mix(a, dark ? "#ffffff" : "#ffffff", dark ? 0.35 : 0.55);
    for (i = 0; i <= 24; i++) {
      var x = i * 50;
      lines += '<line x1="' + x + '" y1="0" x2="' + (600 + (x - 600) * 2.6).toFixed(0) +
        '" y2="400" stroke="' + stroke + '" stroke-width="1" opacity="0.20"/>';
    }
    for (i = 1; i <= 9; i++) {
      var t = Math.pow(i / 9, 1.9), y = 400 * t;
      lines += '<line x1="0" y1="' + y.toFixed(1) + '" x2="1200" y2="' + y.toFixed(1) +
        '" stroke="' + stroke + '" stroke-width="1" opacity="' + (0.10 + t * 0.18).toFixed(2) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + lines +
      '<ellipse cx="600" cy="70" rx="520" ry="180" fill="' + mix(a, "#ffffff", 0.55) +
      '" opacity="' + (dark ? 0.16 : 0.24) + '" filter="url(#b)"/>',
      baseStops(a, dark, "g", 90) +
      '<filter id="b" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="60"/></filter>');
  };

  /* --- topo: contour lines -------------------------------------------- */
  BANNERS.topo = function (a, dark, seed) {
    var r = rng(seed + "topo"), out = "", i, k;
    var cx = 300 + r() * 600, cy = 120 + r() * 160;
    var stroke = mix(a, "#ffffff", dark ? 0.42 : 0.62);
    for (i = 1; i <= 14; i++) {
      var pts = [], N = 72, rad0 = i * 34;
      for (k = 0; k <= N; k++) {
        var th = (k / N) * Math.PI * 2;
        var wob = Math.sin(th * 3 + i * 0.5) * 22 + Math.sin(th * 5 - i * 0.8) * 12;
        pts.push((cx + Math.cos(th) * (rad0 + wob) * 1.7).toFixed(1) + "," + (cy + Math.sin(th) * (rad0 + wob) * 0.78).toFixed(1));
      }
      out += '<polygon points="' + pts.join(" ") + '" fill="none" stroke="' + stroke +
        '" stroke-width="1.1" opacity="' + (0.42 - i * 0.022).toFixed(3) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 20));
  };

  /* --- dots: halftone field ------------------------------------------- */
  BANNERS.dots = function (a, dark, seed) {
    var out = "", x, y;
    var c = mix(a, "#ffffff", dark ? 0.38 : 0.7);
    for (y = 0; y <= 400; y += 26) {
      for (x = 0; x <= 1200; x += 26) {
        var t = 1 - clamp((x / 1200) * 0.75 + (y / 400) * 0.4, 0, 1);
        var rr = 1 + t * 4.6;
        if (rr < 1.15) continue;
        out += '<circle cx="' + x + '" cy="' + y + '" r="' + rr.toFixed(2) + '" fill="' + c +
          '" opacity="' + (0.14 + t * 0.45).toFixed(2) + '"/>';
      }
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 8));
  };

  /* --- prism: overlapping translucent shards -------------------------- */
  BANNERS.prism = function (a, dark, seed) {
    var r = rng(seed + "prism"), out = "", i;
    var cols = [mix(a, "#ffffff", 0.30), shiftHue(a, 26), shiftHue(a, -34), mix(a, "#ffffff", 0.6)];
    for (i = 0; i < 7; i++) {
      var x0 = r() * 1200, y0 = r() * 400, s = 160 + r() * 300, rot = r() * 360;
      var pts = [[0, -s], [s * 0.87, s * 0.5], [-s * 0.87, s * 0.5]].map(function (p) {
        var ra = (rot * Math.PI) / 180;
        return ((x0 + p[0] * Math.cos(ra) - p[1] * Math.sin(ra)).toFixed(1)) + "," +
          ((y0 + p[0] * Math.sin(ra) + p[1] * Math.cos(ra)) * 0.7).toFixed(1);
      }).join(" ");
      out += '<polygon points="' + pts + '" fill="' + cols[i % cols.length] +
        '" opacity="' + (dark ? 0.16 : 0.22) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 130));
  };

  /* --- ribbon: flowing bezier bands ----------------------------------- */
  BANNERS.ribbon = function (a, dark, seed) {
    var r = rng(seed + "ribbon"), out = "", i;
    for (i = 0; i < 6; i++) {
      var y0 = 60 + r() * 280, y1 = 60 + r() * 280, w = 22 + r() * 60;
      var d = "M-50," + y0.toFixed(0) + " C300," + (y0 - 140 + r() * 90).toFixed(0) +
        " 800," + (y1 + 140 - r() * 90).toFixed(0) + " 1250," + y1.toFixed(0);
      out += '<path d="' + d + '" style="fill:none;stroke:' + mix(a, "#ffffff", 0.25 + r() * 0.5) +
        '" stroke-width="' + w.toFixed(1) + '" opacity="' + (dark ? 0.13 : 0.2) +
        '" stroke-linecap="round"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 48));
  };

  /* --- strata: stacked bands ------------------------------------------ */
  BANNERS.strata = function (a, dark, seed) {
    var out = "", i, n = 9;
    for (i = 0; i < n; i++) {
      var h = 400 / n, y = i * h;
      out += '<rect x="0" y="' + y.toFixed(1) + '" width="1200" height="' + (h + 0.6).toFixed(1) +
        '" fill="' + mix(a, dark ? "#000000" : "#ffffff", i / (n + 2)) + '" opacity="0.9"/>';
    }
    out += '<g opacity="' + (dark ? 0.28 : 0.4) + '">';
    for (i = 0; i < 26; i++) {
      out += '<rect x="' + (i * 46 + 10) + '" y="0" width="2" height="400" fill="' +
        mix(a, "#ffffff", 0.7) + '" opacity="0.10"/>';
    }
    out += "</g>";
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 90));
  };

  /* --- arcs: concentric rings ----------------------------------------- */
  BANNERS.arcs = function (a, dark, seed) {
    var out = "", i;
    var stroke = mix(a, "#ffffff", dark ? 0.4 : 0.66);
    for (i = 0; i < 11; i++) {
      out += '<circle cx="980" cy="330" r="' + (70 + i * 62) + '" fill="none" stroke="' + stroke +
        '" stroke-width="' + (i % 3 === 0 ? 2.4 : 1) + '" opacity="' + (0.34 - i * 0.024).toFixed(3) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 155));
  };

  /* --- blueprint: light technical grid (light-text banner) ------------ */
  BANNERS.blueprint = function (a, dark, seed) {
    var out = "", i;
    var bg = dark ? "#141414" : "#f6f5f2";
    var fine = dark ? mix(a, "#000000", 0.55) : mix(a, "#ffffff", 0.86);
    var bold = dark ? mix(a, "#000000", 0.3) : mix(a, "#ffffff", 0.7);
    out += '<rect width="1200" height="400" fill="' + bg + '"/>';
    for (i = 0; i <= 60; i++) out += '<line x1="' + i * 20 + '" y1="0" x2="' + i * 20 + '" y2="400" stroke="' + (i % 5 === 0 ? bold : fine) + '" stroke-width="1"/>';
    for (i = 0; i <= 20; i++) out += '<line x1="0" y1="' + i * 20 + '" x2="1200" y2="' + i * 20 + '" stroke="' + (i % 5 === 0 ? bold : fine) + '" stroke-width="1"/>';
    out += '<circle cx="1010" cy="140" r="96" fill="none" stroke="' + a + '" stroke-width="2" opacity="0.5"/>' +
      '<circle cx="1010" cy="140" r="52" fill="' + a + '" opacity="0.14"/>' +
      '<line x1="820" y1="140" x2="1200" y2="140" stroke="' + a + '" stroke-width="1.5" opacity="0.35"/>';
    return svgWrap(out);
  };

  /* --- glow: single soft spotlight, very clean ------------------------ */
  BANNERS.glow = function (a, dark, seed) {
    return svgWrap(
      '<rect width="1200" height="400" fill="url(#g)"/>' +
      '<ellipse cx="880" cy="120" rx="420" ry="300" fill="' + mix(a, "#ffffff", 0.5) +
      '" opacity="' + (dark ? 0.22 : 0.34) + '" filter="url(#b)"/>' +
      '<ellipse cx="230" cy="380" rx="360" ry="230" fill="' + shiftHue(a, -40) +
      '" opacity="' + (dark ? 0.3 : 0.32) + '" filter="url(#b)"/>',
      baseStops(a, dark, "g", 40) +
      '<filter id="b" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="80"/></filter>'
    );
  };

  /* --- bars: abstract data silhouette --------------------------------- */
  BANNERS.bars = function (a, dark, seed) {
    var r = rng(seed + "bars"), out = "", i, n = 34;
    for (i = 0; i < n; i++) {
      var h = 40 + Math.pow(r(), 1.5) * 250, w = 1200 / n;
      out += '<rect x="' + (i * w + 3).toFixed(1) + '" y="' + (400 - h).toFixed(1) + '" width="' +
        (w - 6).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="4" fill="' +
        mix(a, "#ffffff", 0.15 + (i / n) * 0.55) + '" opacity="' + (dark ? 0.28 : 0.36) + '"/>';
    }
    return svgWrap('<rect width="1200" height="400" fill="url(#g)"/>' + out, baseStops(a, dark, "g", 70));
  };

  RA.bannerStyles = Object.keys(BANNERS);

  RA.bannerArt = function (style, seed) {
    var fn = BANNERS[style] || BANNERS.aurora;
    return fn(accentHex(), isDark(), seed || style);
  };

  /* ---------------------------------------------------------
     3. Charts
     Rendered as inline SVG at a fixed viewBox width so the
     exported file needs no JS to look right; a hover layer is
     hydrated on top when scripting is available.
     --------------------------------------------------------- */
  // viewBox width: charts sit either in the 760px reading column or in the
  // wider 900px bleed. Matching the viewBox to the real width keeps label
  // type at its intended size instead of scaling it up or down.
  var W = 856;
  var SERIES_VARS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

  function seriesColor(i) { return "var(" + SERIES_VARS[i % 8] + ")"; }

  // With a single series there is no identity to encode, so the mark wears the
  // report's accent and the chart reads as part of the document rather than as
  // a stray "series 1".
  function paint(series, i) {
    var s = series[i] || {};
    if (s.color) return s.color;
    return series.length === 1 ? "var(--accent)" : seriesColor(i);
  }

  // A reporting chart usually exists to answer "are we above the line?".
  // `target` accepts a bare number or {value, label}.
  function targetOf(c) {
    var t = c.target;
    if (t == null) return null;
    if (typeof t === "number") return { value: t, label: null };
    if (typeof t === "object" && t.value != null) return { value: Number(t.value), label: t.label || null };
    return null;
  }

  function targetLine(t, c, x1, y1, x2, y2, anchorX, anchorY, anchor) {
    var label = t.label != null ? t.label : "cible " + fmt(t.value, c.valueFormat);
    return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) +
      '" y2="' + y2.toFixed(1) + '" style="stroke:var(--ink-3);fill:none" stroke-width="1.5" ' +
      'stroke-dasharray="5 4"/>' +
      '<text x="' + anchorX.toFixed(1) + '" y="' + anchorY.toFixed(1) +
      '" text-anchor="' + (anchor || "end") + '" font-size="11.5" font-weight="620" ' +
      'fill="var(--ink-2)">' + esc(label) + "</text>";
  }

  // The target label needs a lane of its own to the right of the plot;
  // dropping it on top of the marks is how these charts get unreadable.
  var TARGET_LANE = 78;

  function niceTicks(min, max, count) {
    count = count || 5;
    if (min === max) { max = min + 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log(span / count) / Math.LN10));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    var out = [], v;
    for (v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }

  function axisText(x, y, s, anchor, cls) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + (anchor || "middle") +
      '" font-size="11.5" fill="var(--ink-3)"' + (cls ? ' class="' + cls + '"' : "") + ">" + esc(s) + "</text>";
  }

  function hoverRect(x, y, w, h, payload) {
    return '<rect class="ra-hit" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' +
      Math.max(0, w).toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) +
      '" fill="transparent" data-tip="' + attr(JSON.stringify(payload)) + '"/>';
  }

  /* --- vertical / grouped bars ---------------------------------------- */
  function barChart(c) {
    var H = c.height || 300, pad = { t: 14, r: c.target != null ? TARGET_LANE : 12, b: 40, l: 52 };
    var cats = c.categories || [], series = c.series || [];
    var all = [], tgt = targetOf(c);
    series.forEach(function (s) { (s.data || []).forEach(function (v) { all.push(Number(v) || 0); }); });
    if (tgt) all.push(tgt.value);
    var max = c.max != null ? c.max : Math.max.apply(null, all.concat([0]));
    var min = Math.min(0, Math.min.apply(null, all.concat([0])));
    var ticks = niceTicks(min, max, 5);
    var lo = ticks[0], hi = ticks[ticks.length - 1];
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var y = function (v) { return pad.t + plotH - ((v - lo) / (hi - lo)) * plotH; };
    var out = "";

    ticks.forEach(function (t) {
      out += '<line x1="' + pad.l + '" y1="' + y(t).toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y(t).toFixed(1) +
        '" stroke="var(--grid)" stroke-width="1"/>';
      out += axisText(pad.l - 10, y(t) + 4, fmt(t, c.valueFormat), "end");
    });

    if (tgt) out += targetLine(tgt, c, pad.l, y(tgt.value), W - pad.r, y(tgt.value),
      W - pad.r + 8, y(tgt.value) + 4, "start");

    var band = plotW / Math.max(1, cats.length);
    var gi = series.length, inner = Math.min(band * 0.72, 64);
    var bw = Math.max(3, (inner - (gi - 1) * 2) / gi);

    cats.forEach(function (cat, ci) {
      var x0 = pad.l + band * ci + (band - inner) / 2;
      series.forEach(function (s, si) {
        var v = Number((s.data || [])[ci]) || 0;
        var bx = x0 + si * (bw + 2);
        var by = Math.min(y(v), y(0)), bh = Math.abs(y(v) - y(0));
        out += '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(1, bh).toFixed(1) + '" rx="' + Math.min(4, bw / 2).toFixed(1) +
          '" fill="' + paint(series, si) + '"><title>' + esc(cat + " · " + (s.name || "") + " : " + fmt(v, c.valueFormat)) + "</title></rect>";
        // Two labels inside one category band run into each other; the
        // tooltip already carries the exact number, so drop them instead.
        if (c.showValues && (series.length === 1 || bw >= 30)) {
          out += '<text x="' + (bx + bw / 2).toFixed(1) + '" y="' + (by - 7).toFixed(1) +
            '" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink-2)">' +
            esc(fmt(v, c.valueFormat)) + "</text>";
        }
      });
      out += axisText(pad.l + band * ci + band / 2, H - pad.b + 20, cat);
      out += hoverRect(pad.l + band * ci, pad.t, band, plotH, {
        k: cat,
        rows: series.map(function (s, si) {
          return { n: s.name || "", v: fmt((s.data || [])[ci], c.valueFormat), c: paint(series, si) };
        })
      });
    });

    out += '<line x1="' + pad.l + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y(0).toFixed(1) +
      '" stroke="var(--axis)" stroke-width="1.2"/>';
    return out;
  }

  /* --- stacked bars ---------------------------------------------------- */
  function stackedChart(c) {
    var H = c.height || 300, pad = { t: 14, r: c.target != null ? TARGET_LANE : 12, b: 40, l: 56 };
    var cats = c.categories || [], series = c.series || [];
    var totals = cats.map(function (_, ci) {
      return series.reduce(function (a, s) { return a + (Number((s.data || [])[ci]) || 0); }, 0);
    });
    var pct = !!c.percent;
    var max = pct ? 100 : (c.max != null ? c.max : Math.max.apply(null, totals.concat([0])));
    var ticks = niceTicks(0, max, 5), hi = ticks[ticks.length - 1];
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var y = function (v) { return pad.t + plotH - (v / hi) * plotH; };
    var out = "";
    ticks.forEach(function (t) {
      out += '<line x1="' + pad.l + '" y1="' + y(t).toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y(t).toFixed(1) +
        '" stroke="var(--grid)" stroke-width="1"/>' +
        axisText(pad.l - 10, y(t) + 4, pct ? t + " %" : fmt(t, c.valueFormat), "end");
    });
    var tgt = targetOf(c);
    if (tgt) out += targetLine(tgt, c, pad.l, y(tgt.value), W - pad.r, y(tgt.value),
      W - pad.r + 8, y(tgt.value) + 4, "start");
    var band = plotW / Math.max(1, cats.length), bw = Math.min(band * 0.62, 76);
    cats.forEach(function (cat, ci) {
      var acc = 0, x = pad.l + band * ci + (band - bw) / 2;
      series.forEach(function (s, si) {
        var raw = Number((s.data || [])[ci]) || 0;
        var v = pct ? (totals[ci] ? (raw / totals[ci]) * 100 : 0) : raw;
        var y1 = y(acc + v), y0 = y(acc), h = Math.max(0, y0 - y1 - 2);
        out += '<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="2" fill="' + (s.color || seriesColor(si)) + '"><title>' +
          esc(cat + " · " + (s.name || "") + " : " + (pct ? v.toFixed(1) + " %" : fmt(raw, c.valueFormat))) + "</title></rect>";
        acc += v;
      });
      out += axisText(pad.l + band * ci + band / 2, H - pad.b + 20, cat);
      out += hoverRect(pad.l + band * ci, pad.t, band, plotH, {
        k: cat,
        rows: series.map(function (s, si) {
          var raw = Number((s.data || [])[ci]) || 0;
          return {
            n: s.name || "",
            v: pct ? ((totals[ci] ? (raw / totals[ci]) * 100 : 0)).toFixed(1) + " %" : fmt(raw, c.valueFormat),
            c: s.color || seriesColor(si)
          };
        })
      });
    });
    return out;
  }

  /* --- horizontal bars ------------------------------------------------- */
  function hbarChart(c) {
    var cats = c.categories || [], series = c.series || [];
    var s0 = series[0] || { data: [] };
    var rowH = c.rowHeight || 38;
    var H = cats.length * rowH + 26;
    // Size the label gutter to the longest label instead of clipping it —
    // hbar exists precisely because the labels are long.
    var longest = cats.reduce(function (a, t) { return Math.max(a, String(t).length); }, 0);
    var LABEL_CAP = 34;
    var labelW = c.labelWidth || Math.round(clamp(Math.min(longest, LABEL_CAP) * 6.6 + 22, 110, W * 0.42));
    var pad = { t: 8, r: 58, l: labelW };
    var vals = (s0.data || []).map(Number);
    var tgt = targetOf(c);
    var max = c.max != null ? c.max : Math.max.apply(null, vals.concat(tgt ? [tgt.value, 0] : [0]));
    var plotW = W - pad.l - pad.r;
    var out = "";
    if (tgt) {
      var tx = pad.l + (max ? (tgt.value / max) * plotW : 0);
      out += targetLine(tgt, c, tx, pad.t, tx, pad.t + cats.length * rowH, Math.min(tx + 4, W), pad.t - 2);
    }
    cats.forEach(function (cat, i) {
      var v = Number(vals[i]) || 0, w = max ? (v / max) * plotW : 0;
      var y = pad.t + i * rowH;
      out += '<rect x="' + pad.l + '" y="' + (y + 6).toFixed(1) + '" width="' + plotW +
        '" height="18" rx="5" fill="var(--hairline-2)"/>';
      out += '<rect x="' + pad.l + '" y="' + (y + 6).toFixed(1) + '" width="' + Math.max(2, w).toFixed(1) +
        '" height="18" rx="5" fill="' + (c.colorByCategory ? seriesColor(i) : "var(--accent)") +
        '"><title>' + esc(cat + " : " + fmt(v, c.valueFormat)) + "</title></rect>";
      var shown = String(cat).length > LABEL_CAP ? String(cat).slice(0, LABEL_CAP - 1) + "…" : String(cat);
      out += '<text x="' + (labelW - 12) + '" y="' + (y + 19.5).toFixed(1) +
        '" text-anchor="end" font-size="12.5" fill="var(--ink-2)">' + esc(shown) +
        "<title>" + esc(cat) + "</title></text>";
      out += '<text x="' + (W - 50) + '" y="' + (y + 19.5).toFixed(1) +
        '" text-anchor="start" font-size="12.5" font-weight="600" fill="var(--ink)">' +
        esc(fmt(v, c.valueFormat)) + "</text>";
    });
    return { body: out, height: H };
  }

  /* --- line / area ------------------------------------------------------ */
  function lineChart(c, area) {
    var H = c.height || 300, pad = { t: 16, r: c.target != null ? TARGET_LANE : 16, b: 40, l: 54 };
    var cats = c.categories || [], series = c.series || [];
    var all = [], tgt = targetOf(c);
    series.forEach(function (s) { (s.data || []).forEach(function (v) { if (v != null) all.push(Number(v)); }); });
    if (tgt) all.push(tgt.value);
    var lo0 = Math.min.apply(null, all), hi0 = Math.max.apply(null, all);
    if (c.zero !== false && lo0 > 0) lo0 = 0;
    var ticks = niceTicks(lo0, hi0, 5), lo = ticks[0], hi = ticks[ticks.length - 1];
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    var x = function (i) { return pad.l + (cats.length > 1 ? (i / (cats.length - 1)) * plotW : plotW / 2); };
    var y = function (v) { return pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH; };
    var out = "", defs = "";

    ticks.forEach(function (t) {
      out += '<line x1="' + pad.l + '" y1="' + y(t).toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y(t).toFixed(1) +
        '" stroke="var(--grid)" stroke-width="1"/>' + axisText(pad.l - 10, y(t) + 4, fmt(t, c.valueFormat), "end");
    });

    if (tgt) out += targetLine(tgt, c, pad.l, y(tgt.value), W - pad.r, y(tgt.value),
      W - pad.r + 8, y(tgt.value) + 4, "start");

    series.forEach(function (s, si) {
      var col = paint(series, si), d = "", i, started = false;
      for (i = 0; i < cats.length; i++) {
        var v = (s.data || [])[i];
        if (v == null) { started = false; continue; }
        d += (started ? " L" : " M") + x(i).toFixed(1) + "," + y(Number(v)).toFixed(1);
        started = true;
      }
      if (area) {
        var gid = "ar" + si + Math.floor(Math.random() * 1e6);
        defs += '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + col + '" stop-opacity="0.26"/>' +
          '<stop offset="100%" stop-color="' + col + '" stop-opacity="0.02"/></linearGradient>';
        out += '<path d="' + d + " L" + x(cats.length - 1).toFixed(1) + "," + y(lo).toFixed(1) +
          " L" + x(0).toFixed(1) + "," + y(lo).toFixed(1) + ' Z" style="fill:url(#' + gid + ');stroke:none"/>';
      }
      out += '<path d="' + d + '" style="fill:none;stroke:' + col +
        '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
      for (i = 0; i < cats.length; i++) {
        var vv = (s.data || [])[i];
        if (vv == null) continue;
        var last = i === cats.length - 1;
        if (last || cats.length <= 14) {
          out += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(Number(vv)).toFixed(1) + '" r="' +
            (last ? 4.2 : 3.2) + '" fill="' + col + '" stroke="var(--surface)" stroke-width="2"/>';
        }
      }
      if (c.labelLast !== false && cats.length) {
        var lv = (s.data || [])[cats.length - 1];
        // End-of-line labels collide as soon as two series finish close
        // together; below ~7% of the scale apart, the legend does the job.
        var crowded = series.some(function (o, oi) {
          if (oi >= si) return false;
          var ov = (o.data || [])[cats.length - 1];
          return ov != null && lv != null && Math.abs(Number(ov) - Number(lv)) / (hi - lo || 1) < 0.07;
        });
        if (lv != null && series.length <= 4 && !crowded) {
          out += '<text x="' + (x(cats.length - 1) + 8).toFixed(1) + '" y="' + (y(Number(lv)) - 9).toFixed(1) +
            '" text-anchor="end" font-size="11.5" font-weight="620" fill="' + col + '">' +
            esc(fmt(lv, c.valueFormat)) + "</text>";
        }
      }
    });

    var step = Math.ceil(cats.length / 9);
    cats.forEach(function (cat, i) {
      if (i % step === 0 || i === cats.length - 1) out += axisText(x(i), H - pad.b + 22, cat);
      var bw = plotW / Math.max(1, cats.length - 1);
      out += hoverRect(x(i) - bw / 2, pad.t, bw, plotH, {
        k: cat,
        rows: series.map(function (s, si) {
          return { n: s.name || "", v: fmt((s.data || [])[i], c.valueFormat), c: paint(series, si) };
        })
      });
    });
    out += '<line x1="' + pad.l + '" y1="' + (pad.t + plotH) + '" x2="' + (W - pad.r) + '" y2="' + (pad.t + plotH) +
      '" stroke="var(--axis)" stroke-width="1.2"/>';
    return (defs ? "<defs>" + defs + "</defs>" : "") + out;
  }

  /* --- donut ------------------------------------------------------------ */
  function donutChart(c) {
    var H = c.height || 280;
    var items = c.items || (c.categories || []).map(function (cat, i) {
      return { name: cat, value: ((c.series || [{}])[0].data || [])[i] };
    });
    var total = items.reduce(function (a, it) { return a + (Number(it.value) || 0); }, 0);
    var cx = 150, cy = H / 2, R = Math.min(H / 2 - 12, 104), r0 = R * 0.62;
    var ang = -Math.PI / 2, out = "", gap = 0.014;
    items.forEach(function (it, i) {
      var frac = total ? (Number(it.value) || 0) / total : 0;
      var a0 = ang + gap / 2, a1 = ang + frac * Math.PI * 2 - gap / 2;
      if (a1 > a0) {
        var large = a1 - a0 > Math.PI ? 1 : 0;
        var p = [
          "M", (cx + Math.cos(a0) * R).toFixed(2), (cy + Math.sin(a0) * R).toFixed(2),
          "A", R, R, 0, large, 1, (cx + Math.cos(a1) * R).toFixed(2), (cy + Math.sin(a1) * R).toFixed(2),
          "L", (cx + Math.cos(a1) * r0).toFixed(2), (cy + Math.sin(a1) * r0).toFixed(2),
          "A", r0, r0, 0, large, 0, (cx + Math.cos(a0) * r0).toFixed(2), (cy + Math.sin(a0) * r0).toFixed(2), "Z"
        ].join(" ");
        out += '<path d="' + p + '" style="fill:' + (it.color || seriesColor(i)) + ';stroke:none"><title>' +
          esc(it.name + " : " + fmt(it.value, c.valueFormat) + " (" + (frac * 100).toFixed(1) + " %)") + "</title></path>";
      }
      ang += frac * Math.PI * 2;
    });
    if (c.centerValue || c.centerLabel) {
      out += '<text x="' + cx + '" y="' + (cy + 2) + '" text-anchor="middle" font-size="26" font-weight="650" fill="var(--ink)">' +
        esc(c.centerValue || "") + "</text>";
      out += '<text x="' + cx + '" y="' + (cy + 22) + '" text-anchor="middle" font-size="11.5" fill="var(--ink-3)">' +
        esc(c.centerLabel || "") + "</text>";
    }
    // right-hand value list — identity never rests on colour alone
    // If the values are already percentages, printing the computed share next
    // to them reads as "35 % · 35 %". Say it once.
    var vfSuffix = ((c.valueFormat || {}).suffix || "").trim();
    var showShare = c.showShare != null ? c.showShare : (vfSuffix !== "%" && Math.abs(total - 100) > 0.5);
    var ly = cy - (items.length * 25) / 2 + 10;
    items.forEach(function (it, i) {
      var frac = total ? (Number(it.value) || 0) / total : 0;
      out += '<rect x="300" y="' + (ly - 9).toFixed(1) + '" width="10" height="10" rx="3" fill="' +
        (it.color || seriesColor(i)) + '"/>' +
        '<text x="320" y="' + ly.toFixed(1) + '" font-size="13" fill="var(--ink-2)">' + esc(it.name) + "</text>" +
        '<text x="' + (W - 8) + '" y="' + ly.toFixed(1) + '" text-anchor="end" font-size="13" font-weight="620" fill="var(--ink)">' +
        esc(fmt(it.value, c.valueFormat)) + (showShare ? "  ·  " + (frac * 100).toFixed(0) + " %" : "") + "</text>";
      ly += 25;
    });
    return out;
  }

  /* --- sparkline (used inside KPI tiles) -------------------------------- */
  RA.sparkline = function (data, color) {
    var d = (data || []).map(Number).filter(function (v) { return !isNaN(v); });
    if (d.length < 2) return "";
    var w = 160, h = 34, lo = Math.min.apply(null, d), hi = Math.max.apply(null, d);
    var x = function (i) { return (i / (d.length - 1)) * w; };
    var y = function (v) { return h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6); };
    var p = d.map(function (v, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    var col = color || "var(--accent)";
    return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + p + " L" + w + "," + h + " L0," + h + ' Z" style="fill:' + col + ';stroke:none" opacity="0.10"/>' +
      '<path d="' + p + '" style="fill:none;stroke:' + col + '" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
  };

  /* --- public chart entry point ---------------------------------------- */
  RA.chartSVG = function (c) {
    c = c || {};
    W = c.wide === false ? 716 : 856;
    var type = c.type || "bar", body, H = c.height || 300;
    if (type === "hbar") { var r = hbarChart(c); body = r.body; H = r.height; }
    else if (type === "line") body = lineChart(c, false);
    else if (type === "area") body = lineChart(c, true);
    else if (type === "stackedBar" || type === "stacked") body = stackedChart(c);
    else if (type === "donut" || type === "pie") { body = donutChart(c); H = c.height || 280; }
    else body = barChart(c);
    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' +
      attr(c.title || "graphique") + '">' + body + "</svg>";
  };

  RA.legendHTML = function (c) {
    var series = c.series || [];
    if (c.type === "donut" || c.type === "pie" || c.type === "hbar") return "";
    if (series.length < 2) return "";
    return '<div class="ra-legend">' + series.map(function (s, i) {
      return '<span class="ra-legend__item"><span class="ra-legend__swatch" style="background:' +
        paint(series, i) + '"></span>' + esc(s.name || "Série " + (i + 1)) + "</span>";
    }).join("") + "</div>";
  };

  /* ---------------------------------------------------------
     4. Static block renderers
     Used for the initial paint, for the exported HTML, and by
     the editor tools — one implementation, three consumers.
     --------------------------------------------------------- */
  var R = {};

  R.banner = function (d) {
    var cls = "ra-banner ra-bleed" + (d.hero ? " ra-banner--hero" : "") + (d.light ? " ra-banner--light" : "");
    var scrim = d.light ? "" :
      '<div class="ra-banner__scrim" style="background:linear-gradient(180deg,rgba(0,0,0,.10) 0%,rgba(0,0,0,.05) 40%,rgba(0,0,0,.55) 100%)"></div>';
    var art = d.image
      ? '<img src="' + attr(d.image) + '" alt="" onerror="this.style.display=\'none\'">'
      : RA.bannerArt(d.style || "aurora", d.seed || d.title || d.style);
    return '<div class="' + cls + '" style="min-height:' + (d.height || (d.hero ? 320 : 230)) + 'px">' +
      '<div class="ra-banner__art">' + art + "</div>" + scrim +
      '<div class="ra-banner__inner">' +
      (d.eyebrow ? '<div class="ra-banner__eyebrow">' + esc(d.eyebrow) + "</div>" : "") +
      (d.title ? '<h2 class="ra-banner__title">' + esc(d.title) + "</h2>" : "") +
      (d.subtitle ? '<p class="ra-banner__sub">' + esc(d.subtitle) + "</p>" : "") +
      "</div></div>";
  };

  R.kpis = function (d) {
    var items = d.items || [];
    return '<div class="ra-kpis">' + items.map(function (k) {
      var dir = k.direction || (k.delta > 0 ? "up" : k.delta < 0 ? "down" : "flat");
      var good = k.good == null ? (dir === "up") : !!k.good;
      var deltaCls = dir === "flat" ? "" : (good ? " ra-kpi__delta--up" : " ra-kpi__delta--down");
      var ic = dir === "up" ? "arrowUp" : dir === "down" ? "arrowDown" : "minus";
      var deltaTxt = k.deltaLabel != null ? k.deltaLabel
        : (k.delta != null
          ? (k.delta > 0 ? "+" : "") + fmt(k.delta, { decimals: Math.abs(k.delta) % 1 === 0 ? 0 : 1, suffix: " %" })
          : null);
      return '<div class="ra-kpi">' +
        '<div class="ra-kpi__label">' + esc(k.label || "") + "</div>" +
        '<div class="ra-kpi__value">' + esc(k.value != null ? k.value : "—") +
        (k.unit ? '<span class="ra-kpi__unit">' + esc(k.unit) + "</span>" : "") + "</div>" +
        (deltaTxt ? '<div class="ra-kpi__delta' + deltaCls + '">' + RA.icon(ic, 13) +
          "<b>" + esc(deltaTxt) + "</b>" + (k.deltaNote ? " <em>" + esc(k.deltaNote) + "</em>" : "") + "</div>" : "") +
        (k.note ? '<div class="ra-kpi__note">' + esc(k.note) + "</div>" : "") +
        (k.spark && k.spark.length > 1 ? '<div class="ra-kpi__spark">' + RA.sparkline(k.spark) + "</div>" : "") +
        "</div>";
    }).join("") + "</div>";
  };

  R.chart = function (d) {
    var wide = d.wide !== false;
    return '<figure class="ra-figure' + (wide ? " ra-bleed" : "") + '">' +
      '<div class="ra-figure__frame">' +
      (d.title || d.subtitle ? '<div class="ra-figure__head">' +
        (d.title ? '<p class="ra-figure__title">' + esc(d.title) + "</p>" : "") +
        (d.subtitle ? '<p class="ra-figure__sub">' + esc(d.subtitle) + "</p>" : "") + "</div>" : "") +
      RA.legendHTML(d) +
      '<div class="ra-chart">' + RA.chartSVG(d) + "</div>" +
      "</div>" +
      (d.caption ? '<figcaption class="ra-figure__cap">' + d.caption + "</figcaption>" : "") +
      "</figure>";
  };

  R.callout = function (d) {
    var tone = d.tone || "info";
    var icon = d.icon || ({ info: "info", good: "check", warn: "alert", critical: "stop", idea: "bulb" }[tone] || "info");
    return '<aside class="ra-callout ra-callout--' + esc(tone) + '">' +
      '<span class="ra-callout__icon">' + RA.icon(icon, 19) + "</span>" +
      '<div class="ra-callout__body">' +
      (d.title ? '<div class="ra-callout__title">' + esc(d.title) + "</div>" : "") +
      '<div class="ra-callout__text">' + (d.text || "") + "</div></div></aside>";
  };

  R.figure = function (d) {
    var wide = !!d.wide;
    var img = d.src
      ? '<img class="ra-figure__img" src="' + attr(d.src) + '" alt="' + attr(d.alt || "") +
        '" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;ra-imgfallback&quot;>' +
        attr(d.alt || "Illustration") + '</div>\'">'
      : '<div class="ra-imgfallback">' + esc(d.alt || "Illustration") + "</div>";
    return '<figure class="ra-figure' + (wide ? " ra-bleed ra-figure--full" : "") + '">' + img +
      (d.caption ? '<figcaption class="ra-figure__cap">' + d.caption + "</figcaption>" : "") + "</figure>";
  };

  R.table = function (d) {
    var content = d.content || [];
    if (!content.length) return "";
    var head = d.withHeadings !== false ? content[0] : null;
    var rows = d.withHeadings !== false ? content.slice(1) : content;
    var numCol = function (cells, i) { return /^[\s+\-–—]*[\d.,%€$\s]+$/.test(String(cells[i] || "")); };
    return '<div class="ra-table-wrap"><table class="ra-table">' +
      (head ? "<thead><tr>" + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>" : "") +
      "<tbody>" + rows.map(function (r) {
        return "<tr>" + r.map(function (c, i) {
          return '<td class="' + (i > 0 && numCol(r, i) ? "num" : "") + '">' + c + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  };

  R.quote = function (d) {
    return '<blockquote class="ra-quote"><p class="ra-quote__text">' + (d.text || "") + "</p>" +
      (d.caption ? '<div class="ra-quote__by">' + d.caption + "</div>" : "") + "</blockquote>";
  };

  R.header = function (d) {
    var lv = clamp(d.level || 2, 1, 4);
    return "<h" + lv + ">" + (d.text || "") + "</h" + lv + ">";
  };
  R.paragraph = function (d) {
    return "<p" + (d.lead ? ' class="ra-lead"' : "") + ">" + (d.text || "") + "</p>";
  };
  R.lead = function (d) { return '<p class="ra-lead">' + (d.text || "") + "</p>"; };
  R.list = function (d) {
    var ordered = d.style === "ordered";
    var walk = function (items) {
      return (ordered ? "<ol>" : "<ul>") + (items || []).map(function (it) {
        var content = typeof it === "string" ? it : (it.content || "");
        var kids = (typeof it === "object" && it.items && it.items.length) ? walk(it.items) : "";
        return "<li>" + content + kids + "</li>";
      }).join("") + (ordered ? "</ol>" : "</ul>");
    };
    return walk(d.items);
  };
  R.checklist = function (d) {
    return '<ul class="ra-check">' + (d.items || []).map(function (it) {
      return '<li>' + (it.checked ? "✓ " : "☐ ") + (it.text || "") + "</li>";
    }).join("") + "</ul>";
  };
  R.delimiter = function () { return '<hr class="ra-rule ra-rule--dots">'; };


  /* ---------------------------------------------------------
     Sources — stacked favicons that unfold into named links
     ---------------------------------------------------------
     Cited sources live once at the document root (doc.sources);
     a block cites them BY NAME. That way a source's URL and icon
     are written once and every citation of it stays in step. */
  RA.__sources = [];

  RA.sourceRef = function (ref) {
    if (ref && typeof ref === "object") return ref;
    var name = String(ref == null ? "" : ref).trim();
    var key = name.toLowerCase();
    var hit = null;
    (RA.__sources || []).forEach(function (s) {
      if (hit) return;
      var n = String(s.name || "").toLowerCase();
      var h = String(s.host || "").toLowerCase();
      if (n === key || (h && h === key) || (n && key && n.indexOf(key) === 0)) hit = s;
    });
    return hit || { name: name };
  };

  function sourceChip(src) {
    var name = String(src.name || src.url || "source");
    var url = src.url || "";
    var ico = src.icon
      ? '<img class="ra-src__ico" src="' + attr(src.icon) + '" alt="" loading="lazy">'
      : '<span class="ra-src__ico ra-src__ico--mono" style="--mono-h:' + (hashHue(name)) + 'deg">' +
        esc(name.slice(0, 1).toUpperCase()) + "</span>";
    var inner = ico + '<span class="ra-src__name">' + esc(name) + "</span>";
    return url
      ? '<a class="ra-src" href="' + attr(url) + '" target="_blank" rel="noreferrer noopener" title="' + attr(name) + '">' + inner + "</a>"
      : '<span class="ra-src" title="' + attr(name) + '">' + inner + "</span>";
  }

  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  /** The pill itself — used inline under a passage AND in the masthead. */
  RA.sourcesHTML = function (refs, extraClass) {
    var list = (refs || []).map(RA.sourceRef).filter(function (s) { return s && (s.name || s.url); });
    if (!list.length) return "";
    return '<span class="ra-sources' + (extraClass ? " " + extraClass : "") + '" data-count="' + list.length + '">' +
      list.map(sourceChip).join("") + "</span>";
  };

  R.sources = function (d) {
    var refs = d.items || d.sources || [];
    var pill = RA.sourcesHTML(refs);
    if (!pill) return "";
    return '<p class="ra-cite">' + (d.label ? '<span class="ra-cite__label">' + esc(d.label) + "</span>" : "") + pill + "</p>";
  };

  RA.renderBlock = function (b) {
    var fn = R[b.type];
    return fn ? fn(b.data || {}) : "";
  };

  RA.renderBlocks = function (blocks) {
    return (blocks || []).map(function (b) {
      var html = RA.renderBlock(b);
      var bleed = /ra-bleed/.test(html);
      return html ? '<div class="ra-static-block' + (bleed ? " is-bleed" : "") + '">' + html + "</div>" : "";
    }).join("\n");
  };

  RA.mastheadHTML = function (doc) {
    var m = doc.meta || {};
    var hasSources = (doc.sources || []).length > 0;
    var items = Object.keys(m).map(function (k) {
      // A declared source list replaces a hand-typed "Sources: a, b, c" cell —
      // otherwise the same names appear twice, once linked and once not.
      if (hasSources && /^sources?$/i.test(k)) return "";
      return '<div class="ra-meta__item"><span class="ra-meta__k">' + esc(k) +
        '</span><span class="ra-meta__v">' + esc(m[k]) + "</span></div>";
    }).join("");
    if (hasSources) {
      items += '<div class="ra-meta__item ra-meta__item--sources"><span class="ra-meta__k">Sources</span>' +
        '<span class="ra-meta__v">' + RA.sourcesHTML(doc.sources, "ra-sources--meta") + "</span></div>";
    }
    return '<header class="ra-masthead">' +
      (doc.eyebrow ? '<div class="ra-eyebrow">' + esc(doc.eyebrow) + "</div>" : "") +
      '<h1 class="ra-title">' + esc(doc.title || "Rapport") + "</h1>" +
      (doc.subtitle ? '<p class="ra-subtitle">' + esc(doc.subtitle) + "</p>" : "") +
      (items ? '<div class="ra-meta">' + items + "</div>" : "") +
      "</header>";
  };

  /* ---------------------------------------------------------
     5. Tooltip hydration
     --------------------------------------------------------- */
  RA.hydrateCharts = function (root) {
    (root || document).querySelectorAll(".ra-chart").forEach(function (host) {
      if (host.__raTip) return;
      host.__raTip = true;
      var tip = document.createElement("div");
      tip.className = "ra-tip";
      host.appendChild(tip);
      host.addEventListener("pointermove", function (e) {
        var hit = e.target.closest ? e.target.closest(".ra-hit") : null;
        if (!hit) { tip.dataset.show = "0"; return; }
        var p;
        try { p = JSON.parse(hit.getAttribute("data-tip")); } catch (_) { return; }
        tip.innerHTML = '<span class="ra-tip__k">' + esc(p.k) + "</span>" +
          (p.rows || []).map(function (r) {
            return '<span class="ra-tip__row"><span class="ra-tip__sw" style="background:' + r.c +
              '"></span>' + esc(r.n) + '<span class="ra-tip__v">' + esc(r.v) + "</span></span>";
          }).join("");
        var rect = host.getBoundingClientRect();
        tip.style.left = clamp(e.clientX - rect.left, 60, rect.width - 60) + "px";
        tip.style.top = (e.clientY - rect.top - 6) + "px";
        tip.dataset.show = "1";
      });
      host.addEventListener("pointerleave", function () { tip.dataset.show = "0"; });
    });
  };

  /* ---------------------------------------------------------
     6. Editor.js custom block tools
     --------------------------------------------------------- */
  function baseTool(name, title, iconName, defaults, renderFn, controlsFn) {
    var T = function (cfg) {
      this.data = Object.assign({}, defaults, cfg.data || {});
      this.readOnly = cfg.readOnly;
      this.wrapper = document.createElement("div");
    };
    T.toolbox = { title: title, icon: RA.icon(iconName, 16) };
    T.isReadOnlySupported = true;
    T.prototype.repaint = function () {
      var self = this;
      this.wrapper.innerHTML = "";
      if (!this.readOnly && controlsFn) {
        var bar = document.createElement("div");
        bar.className = "ra-tool-bar";
        controlsFn(bar, this.data, function () { self.repaint(); });
        this.wrapper.appendChild(bar);
      }
      var host = document.createElement("div");
      host.innerHTML = renderFn(this.data);
      while (host.firstChild) this.wrapper.appendChild(host.firstChild);
      RA.hydrateCharts(this.wrapper);
    };
    T.prototype.render = function () {
      this.wrapper.className = "ra-tool ra-tool--" + name;
      this.repaint();
      return this.wrapper;
    };
    T.prototype.save = function () { return this.data; };
    return T;
  }

  function chip(bar, label, active, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ra-chip";
    b.textContent = label;
    b.setAttribute("aria-pressed", active ? "true" : "false");
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  }
  function textField(bar, placeholder, value, onInput, wide) {
    var i = document.createElement("input");
    i.className = "ra-input" + (wide ? " ra-input--wide" : "");
    i.placeholder = placeholder;
    i.value = value || "";
    i.addEventListener("input", function () { onInput(i.value); });
    bar.appendChild(i);
    return i;
  }

  RA.tools = function () {
    var BannerTool = baseTool("banner", "Bannière", "layers",
      { style: "aurora", title: "", eyebrow: "", subtitle: "", hero: false, height: 240 },
      R.banner,
      function (bar, data, refresh) {
        RA.bannerStyles.forEach(function (s) {
          chip(bar, s, data.style === s, function () { data.style = s; refresh(); });
        });
        chip(bar, "hero", data.hero, function () { data.hero = !data.hero; refresh(); });
        textField(bar, "Titre", data.title, function (v) {
          data.title = v;
          var t = bar.parentNode.querySelector(".ra-banner__title");
          if (t) t.textContent = v; else refresh();
        });
        textField(bar, "Surtitre", data.eyebrow, function (v) { data.eyebrow = v; });
      });

    var ChartTool = baseTool("chart", "Graphique", "chart",
      {
        type: "bar", title: "", subtitle: "", caption: "",
        categories: ["A", "B", "C", "D"],
        series: [{ name: "Série 1", data: [12, 19, 9, 22] }],
        valueFormat: {}
      },
      R.chart,
      function (bar, data, refresh) {
        ["bar", "hbar", "line", "area", "stackedBar", "donut"].forEach(function (t) {
          chip(bar, t, data.type === t, function () { data.type = t; refresh(); });
        });
        textField(bar, "Titre du graphique", data.title, function (v) { data.title = v; });
        var note = document.createElement("span");
        note.className = "ra-editnote";
        note.textContent = "Données modifiables via « Exporter JSON ».";
        bar.appendChild(note);
      });

    var KpiTool = baseTool("kpis", "Indicateurs (KPI)", "target",
      { items: [{ label: "Indicateur", value: "0", delta: 0 }] },
      R.kpis,
      function (bar, data, refresh) {
        data.items.forEach(function (k, i) {
          textField(bar, "Libellé " + (i + 1), k.label, function (v) { k.label = v; });
          textField(bar, "Valeur " + (i + 1), k.value, function (v) { k.value = v; });
        });
        chip(bar, "+ ajouter", false, function () {
          data.items.push({ label: "Nouvel indicateur", value: "0" }); refresh();
        });
        if (data.items.length > 1) {
          chip(bar, "− retirer", false, function () { data.items.pop(); refresh(); });
        }
      });

    var CalloutTool = baseTool("callout", "Encadré", "info",
      { tone: "info", title: "", text: "" },
      R.callout,
      function (bar, data, refresh) {
        ["info", "good", "warn", "critical", "idea"].forEach(function (t) {
          chip(bar, t, data.tone === t, function () { data.tone = t; refresh(); });
        });
        textField(bar, "Titre", data.title, function (v) {
          data.title = v;
          var t = bar.parentNode.querySelector(".ra-callout__title");
          if (t) t.textContent = v; else refresh();
        });
      });
    // The body text stays editable in place, so the encadré behaves like the
    // surrounding prose rather than like a form to fill in.
    CalloutTool.prototype.render = (function (orig) {
      return function () {
        var node = orig.call(this);
        var self = this;
        var text = node.querySelector(".ra-callout__text");
        if (text && !this.readOnly) {
          text.contentEditable = "true";
          text.setAttribute("data-placeholder", "Texte de l'encadré…");
          text.addEventListener("input", function () { self.data.text = text.innerHTML; });
        }
        return node;
      };
    })(CalloutTool.prototype.render);

    var FigureTool = baseTool("figure", "Image / illustration", "doc",
      { src: "", alt: "", caption: "", wide: false },
      R.figure,
      function (bar, data, refresh) {
        textField(bar, "URL de l'image", data.src, function (v) { data.src = v; }, true);
        chip(bar, "pleine largeur", data.wide, function () { data.wide = !data.wide; refresh(); });
        chip(bar, "recharger", false, function () { refresh(); });
      });

    // The chapô is its own block so the opening paragraph keeps its voice
    // when the document is re-ordered.
    function LeadTool(cfg) { this.data = cfg.data || {}; this.readOnly = cfg.readOnly; }
    LeadTool.toolbox = { title: "Chapô", icon: RA.icon("spark", 16) };
    LeadTool.isReadOnlySupported = true;
    LeadTool.prototype.render = function () {
      var p = document.createElement("p");
      p.className = "ra-lead";
      p.innerHTML = this.data.text || "";
      if (!this.readOnly) {
        p.contentEditable = "true";
        p.setAttribute("data-placeholder", "Chapô — la réponse, en trois phrases.");
      }
      return p;
    };
    LeadTool.prototype.save = function (node) { return { text: node.innerHTML }; };

    var SourcesTool = baseTool("sources", "Sources", "globe",
      { items: [], label: "" },
      R.sources);

    return {
      lead: { class: LeadTool, inlineToolbar: true },
      sources: { class: SourcesTool },
      banner: { class: BannerTool },
      chart: { class: ChartTool },
      kpis: { class: KpiTool },
      callout: { class: CalloutTool },
      figure: { class: FigureTool }
    };
  };

  /* ---------------------------------------------------------
     7. Export
     --------------------------------------------------------- */
  RA.exportHTML = function (doc, blocks) {
    var root = document.documentElement;
    var css = document.getElementById("ra-css");
    var runtime = document.getElementById("ra-runtime");
    var body =
      '<div class="ra-shell"><div class="ra-paper">' +
      (doc.heroBanner ? R.banner(Object.assign({ hero: true }, doc.heroBanner)) : "") +
      '<div class="ra-body">' +
      '<div class="ra-static-block">' + RA.mastheadHTML(doc) + "</div>" +
      RA.renderBlocks(blocks) +
      (doc.footer ? '<footer class="ra-footer"><span>' + esc(doc.footer) + "</span><span>" +
        esc((doc.meta && (doc.meta.Date || doc.meta.date)) || "") + "</span></footer>" : "") +
      "</div></div></div>";
    return '<!doctype html>\n<html lang="' + (doc.lang || "fr") + '" data-theme="' +
      root.getAttribute("data-theme") + '" data-accent="' + root.getAttribute("data-accent") +
      '" data-type="' + root.getAttribute("data-type") + '">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' +
      esc(doc.title || "Rapport") + "</title>\n" + (RA.__fontLink || "") +
      "<style>" + (css ? css.textContent : "") + "</style>\n</head>\n<body>" +
      body + "\n<script>" + (runtime ? runtime.textContent : "") + "\nRA.setLocale(" +
      JSON.stringify(LOCALE) + ");RA.hydrateCharts(document);<\/script>\n</body>\n</html>";
  };

  RA.download = function (filename, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  };

  /* ---------------------------------------------------------
     8. Boot
     --------------------------------------------------------- */
  RA.boot = function (doc) {
    RA.setLocale(doc.locale || "fr-FR");
    var root = document.documentElement;
    root.setAttribute("data-theme", doc.theme === "dark" ? "dark" : "light");
    root.setAttribute("data-accent", doc.accent || "blue");
    root.setAttribute("data-type", doc.typeface || "editorial");
    document.title = doc.title || "Rapport";

    RA.__sources = (doc.sources || []).map(function (s) {
      var host = "";
      try { host = s.url ? new URL(s.url).hostname.replace(/^www./, "") : ""; } catch (_) { host = ""; }
      return { name: s.name || host || s.url || "", url: s.url || "", icon: s.icon || "", host: host };
    });

    var STORE = "ra:" + (doc.id || doc.title || "report");
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (_) { saved = null; }
    var blocks = (saved && saved.blocks) || doc.blocks || [];

    var shell = document.getElementById("ra-shell");
    shell.innerHTML =
      '<div class="ra-paper">' +
      (doc.heroBanner ? R.banner(Object.assign({ hero: true }, doc.heroBanner)) : "") +
      '<div class="ra-body"><div class="ra-static-block" id="ra-masthead"></div>' +
      '<div id="ra-editor"></div>' +
      (doc.footer ? '<footer class="ra-footer"><span>' + esc(doc.footer) + "</span></footer>" : "") +
      "</div></div>";
    document.getElementById("ra-masthead").innerHTML = RA.mastheadHTML(doc);

    var status = document.getElementById("ra-status");
    function setStatus(t) { if (status) status.textContent = t; }

    var editor = null;
    if (global.EditorJS) {
      var custom = RA.tools();
      editor = new EditorJS({
        holder: "ra-editor",
        autofocus: false,
        placeholder: "Rédigez ici — « / » ou « + » pour insérer un bloc.",
        data: { blocks: blocks },
        tools: Object.assign({
          header: { class: global.Header, inlineToolbar: true, config: { levels: [2, 3, 4], defaultLevel: 2 } },
          list: { class: global.EditorjsList, inlineToolbar: true, config: { defaultStyle: "unordered" } },
          checklist: { class: global.Checklist, inlineToolbar: true },
          table: { class: global.Table, inlineToolbar: true },
          quote: { class: global.Quote, inlineToolbar: true },
          delimiter: { class: global.Delimiter },
          marker: { class: global.Marker },
          underline: { class: global.Underline }
        }, custom),
        onReady: function () {
          RA.hydrateCharts(document);
          setStatus("prêt");
        },
        onChange: function () {
          setStatus("modifié…");
          clearTimeout(RA.__t);
          RA.__t = setTimeout(function () {
            editor.save().then(function (out) {
              try { localStorage.setItem(STORE, JSON.stringify({ blocks: out.blocks })); setStatus("enregistré localement"); }
              catch (_) { setStatus("modifié (sauvegarde locale indisponible — exportez)"); }
            });
          }, 700);
        }
      });
    } else {
      document.getElementById("ra-editor").innerHTML = RA.renderBlocks(blocks);
      RA.hydrateCharts(document);
      setStatus("lecture seule");
    }

    function currentBlocks() {
      return editor ? editor.save().then(function (o) { return o.blocks; }) : Promise.resolve(blocks);
    }

    var slug = (doc.title || "rapport").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rapport";

    var on = function (id, fn) { var e = document.getElementById(id); if (e) e.addEventListener("click", fn); };

    on("ra-theme", function () {
      var d = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", d ? "light" : "dark");
      // banners are painted from the accent hex — repaint them for the new mode
      currentBlocks().then(function (bs) {
        if (!editor) return;
        editor.render({ blocks: bs }).then(function () { RA.hydrateCharts(document); });
      });
      if (doc.heroBanner) {
        var hero = document.querySelector(".ra-banner--hero .ra-banner__art");
        if (hero) hero.innerHTML = RA.bannerArt(doc.heroBanner.style, doc.heroBanner.seed || doc.heroBanner.title);
      }
    });

    on("ra-export-html", function () {
      currentBlocks().then(function (bs) {
        RA.download(slug + ".html", RA.exportHTML(doc, bs), "text/html");
        setStatus("HTML exporté");
      });
    });

    on("ra-export-json", function () {
      currentBlocks().then(function (bs) {
        var payload = Object.assign({}, doc, { blocks: bs });
        RA.download(slug + ".json", JSON.stringify(payload, null, 2), "application/json");
        setStatus("JSON exporté");
      });
    });

    on("ra-print", function () { window.print(); });

    on("ra-reset", function () {
      if (!confirm("Rétablir la version d'origine du rapport ? Vos modifications locales seront perdues.")) return;
      try { localStorage.removeItem(STORE); } catch (_) { }
      if (editor) editor.render({ blocks: doc.blocks || [] }).then(function () { RA.hydrateCharts(document); });
      setStatus("réinitialisé");
    });
  };

})(typeof window !== "undefined" ? window : this);

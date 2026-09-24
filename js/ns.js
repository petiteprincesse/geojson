/* js/ns.js — единственное глобальное имя приложения и форматирование чисел.
   Все прочие файлы дописывают свои разделы в GP. */

var GP = window.GP || {};
window.GP = GP;

GP.NBSP = ' ';

/* Маленькая шина событий: карта сообщает, панели слушают. */
GP.bus = (function () {
  var map = {};
  return {
    on: function (name, fn) {
      (map[name] || (map[name] = [])).push(fn);
      return fn;
    },
    off: function (name, fn) {
      var list = map[name];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (name, payload) {
      var list = map[name];
      if (!list) return;
      for (var i = 0; i < list.length; i++) list[i](payload);
    }
  };
})();

/* Форматирование по правилам русского интерфейса:
   десятичная запятая, неразрывный пробел в разрядах (включая четырёхзначные),
   неразрывный пробел между числом и единицей. */
GP.fmt = (function () {
  var NBSP = GP.NBSP;
  var DASH = '—';

  function group(intDigits) {
    var out = '';
    var n = intDigits.length;
    for (var i = 0; i < n; i++) {
      if (i > 0 && (n - i) % 3 === 0) out += NBSP;
      out += intDigits.charAt(i);
    }
    return out;
  }

  /* num(1234.5, 1) -> «1 234,5» */
  function num(v, digits) {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return DASH;
    var d = (digits === undefined || digits === null) ? 0 : digits;
    var s = Math.abs(v).toFixed(d);
    var parts = s.split('.');
    var body = group(parts[0]) + (parts[1] ? ',' + parts[1] : '');
    var negative = v < 0 && parseFloat(s) !== 0;
    return (negative ? '−' : '') + body;
  }

  /* len(342.5) -> «342,5 м». Точность подбирается по величине. */
  function len(m, digits) {
    if (typeof m !== 'number' || !isFinite(m)) return DASH;
    var d = digits;
    if (d === undefined || d === null) {
      var a = Math.abs(m);
      d = a < 10 ? 2 : (a < 1000 ? 1 : 0);
    }
    return num(m, d) + NBSP + 'м';
  }

  /* deg(42.5) -> «42,5°» — знак градуса примыкает к числу. */
  function deg(v, digits) {
    if (typeof v !== 'number' || !isFinite(v)) return DASH;
    return num(v, (digits === undefined || digits === null) ? 1 : digits) + '°';
  }

  /* latlon(55.751244, 37.618423) -> «55,751244° с. ш., 37,618423° в. д.» */
  function latlon(lat, lon, digits) {
    if (typeof lat !== 'number' || typeof lon !== 'number' ||
        !isFinite(lat) || !isFinite(lon)) return DASH;
    var d = (digits === undefined || digits === null) ? 6 : digits;
    var ns = lat < 0 ? 'ю.' + NBSP + 'ш.' : 'с.' + NBSP + 'ш.';
    var ew = lon < 0 ? 'з.' + NBSP + 'д.' : 'в.' + NBSP + 'д.';
    return num(Math.abs(lat), d) + '°' + NBSP + ns + ', ' +
           num(Math.abs(lon), d) + '°' + NBSP + ew;
  }

  /* scale(5000) -> «1:5 000» */
  function scale(denominator) {
    if (typeof denominator !== 'number' || !isFinite(denominator) || denominator <= 0) {
      return DASH;
    }
    return '1:' + num(Math.round(denominator), 0);
  }

  /* mpp(0.298) -> «0,30 м/пикс» */
  function mpp(metersPerPixel) {
    if (typeof metersPerPixel !== 'number' || !isFinite(metersPerPixel)) return DASH;
    var a = Math.abs(metersPerPixel);
    var d = a < 1 ? 2 : (a < 100 ? 1 : 0);
    return num(metersPerPixel, d) + NBSP + 'м/пикс';
  }

  return {
    DASH: DASH,
    num: num,
    len: len,
    deg: deg,
    latlon: latlon,
    scale: scale,
    mpp: mpp
  };
})();

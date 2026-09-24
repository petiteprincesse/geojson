/* js/export.js — выгрузка результата привязки.

   Файл отдаётся через Blob и ссылку с download: по file:// это
   единственный работающий способ сохранить результат.

   Округление осознанное: широта и долгота до 9 знаков — это около
   0,1 мм на местности, метры до 4 знаков. Пятнадцать знаков от
   double в файле не нужны никому и мешают читать. */

GP.export = (function () {
  var LL_DIGITS = 9;       /* градусы: 1e−9° ≈ 0,1 мм */
  var M_DIGITS = 4;        /* метры: 0,1 мм */

  /* Готовые единицы: подпись, множитель «метров в единице файла». */
  var UNITS = [
    { id: 'm', title: 'метры', scale: 1 },
    { id: 'cm', title: 'сантиметры', scale: 0.01 },
    { id: 'mm', title: 'миллиметры', scale: 0.001 },
    { id: 'ft', title: 'футы', scale: 0.3048 },
    { id: 'in', title: 'дюймы', scale: 0.0254 },
    { id: 'other', title: 'другое', scale: null }
  ];

  function round(v, digits) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    var f = Math.pow(10, digits);
    var r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;   /* без минус-нуля */
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* Местное время с указанием сдвига: выгрузку потом сверяют с журналом. */
  function stamp(date) {
    var d = date || new Date();
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '−';
    return {
      iso: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
           ' UTC' + sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60),
      file: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            '_' + pad(d.getHours()) + pad(d.getMinutes())
    };
  }

  function baseName(name) {
    return String(name || 'контур').replace(/\.[^.]+$/, '').replace(/\s+/g, '-');
  }

  function fileName(state, suffix, ext, date) {
    return baseName(state.source.name) + '_привязка_' + stamp(date).file + suffix + '.' + ext;
  }

  /* ---------- сбор результата ---------- */

  function build(state, date) {
    var s = state || GP.store.state;
    if (!s || !s.source || !s.anchor) return null;

    var frame = GP.transform.frameOf(s);
    var size = GP.transform.sizeOnMap(s);

    var catalog = s.source.vertices.map(function (v, i) {
      var ll = GP.transform.vertexLatLng(v.x, v.y, s, frame);
      var m = GP.geo.toMercator(ll[0], ll[1]);
      return {
        'номер': i + 1,
        'x': round(v.x, M_DIGITS),
        'y': round(v.y, M_DIGITS),
        'широта': round(ll[0], LL_DIGITS),
        'долгота': round(ll[1], LL_DIGITS),
        'x_3857': round(m.x, M_DIGITS),
        'y_3857': round(m.y, M_DIGITS),
        'полигон': v.polygon + 1,
        'кольцо': v.ring + 1,
        'вершина': v.index + 1
      };
    });

    var gcpStats = GP.gcp.stats(s);

    var b = s.source.bbox;
    var corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
    var gcp = corners.map(function (c) {
      var ll = GP.transform.vertexLatLng(c[0], c[1], s, frame);
      return '-gcp ' + round(c[0], M_DIGITS) + ' ' + round(c[1], M_DIGITS) + ' ' +
             round(ll[1], LL_DIGITS) + ' ' + round(ll[0], LL_DIGITS);
    }).join(' ');

    return {
      'файл': s.source.name,
      'создано': stamp(date).iso,
      'параметры_трансформирования': {
        'модель': 'подобие, 4 параметра',
        'опорная_точка_wgs84': {
          'широта': round(s.anchor.lat, LL_DIGITS),
          'долгота': round(s.anchor.lon, LL_DIGITS)
        },
        'опорная_точка_в_координатах_файла': {
          'x': round(s.source.center.x, M_DIGITS),
          'y': round(s.source.center.y, M_DIGITS)
        },
        'поворот_против_часовой_градусы': round(s.rotation, 6),
        'азимут_оси_y_градусы': round(GP.transform.azimuthY(s), 6),
        'масштаб_метров_в_единице_файла': s.scale,
        'эллипсоид': {
          'имя': 'WGS 84',
          'большая_полуось_м': GP.geo.A,
          'обратное_уплощение': 298.257223563
        },
        'как_применять': 'вычесть из координат вершины опорную точку в координатах ' +
          'файла, умножить на масштаб, повернуть против часовой на угол поворота, ' +
          'отложить полученные метры как восток и север в плоскости ENU ' +
          'от опорной точки WGS 84'
      },
      'каталог_координат': catalog,
      'опорные_точки': gcpStats.rows.map(function (r) {
        return {
          'номер': r.pair.n,
          'x': round(r.pair.x, M_DIGITS),
          'y': round(r.pair.y, M_DIGITS),
          'широта': round(r.pair.lat, LL_DIGITS),
          'долгота': round(r.pair.lon, LL_DIGITS),
          'учитывается': !!r.used,
          'контрольная': !!r.pair.control,
          'dN': round(r.dN, M_DIGITS),
          'dE': round(r.dE, M_DIGITS),
          'dS': round(r.dS, M_DIGITS)
        };
      }),
      'оценка_точности': {
        'rms_м': round(gcpStats.rms, M_DIGITS),
        'наибольшая_невязка_м': round(gcpStats.max, M_DIGITS),
        'rms_по_контрольным_м': round(gcpStats.rmsControl, M_DIGITS),
        'масштаб_работ': '1:' + (s.workScale || 500),
        'допуск_м': round(gcpStats.tolerance, M_DIGITS),
        'вердикт': gcpStats.usedCount >= 2
          ? GP.gcp.VERDICT_TEXT[gcpStats.verdict] : 'опорные точки не заданы',
        'учтённых_точек': gcpStats.usedCount,
        'контрольных_точек': gcpStats.controlCount,
        'примечание': gcpStats.exact
          ? 'учтённых точек ровно столько, сколько нужно для решения: ' +
            'невязки тождественно нулевые и точность не характеризуют'
          : 'невязки посчитаны по учтённым точкам; контрольные в подгонке ' +
            'не участвовали'
      },
      'оценка_модели': {
        'радиус_площадки_м': round(size.radius, M_DIGITS),
        'ожидаемая_погрешность_касательной_плоскости_м':
          round(GP.transform.expectedError(size.radius), 9),
        'примечание': 'это только погрешность модели плоскости; ошибка ручного ' +
          'совмещения по подложке на порядки больше'
      },
      'gcp_gdal_translate': '-a_srs EPSG:4326 ' + gcp
    };
  }

  /* ---------- форматы ---------- */

  function toJson(state, date) {
    var data = build(state, date);
    return data ? JSON.stringify(data, null, 2) : '';
  }

  var CSV_COLUMNS = [
    ['номер', '№', 0],
    ['x', 'X файла', M_DIGITS],
    ['y', 'Y файла', M_DIGITS],
    ['широта', 'Широта', LL_DIGITS],
    ['долгота', 'Долгота', LL_DIGITS],
    ['x_3857', 'X EPSG:3857', M_DIGITS],
    ['y_3857', 'Y EPSG:3857', M_DIGITS],
    ['полигон', 'Полигон', 0],
    ['кольцо', 'Кольцо', 0],
    ['вершина', 'Вершина', 0]
  ];

  /* Разделитель и десятичный знак выбирает пользователь: Excel в русской
     локали ждёт точку с запятой и запятую, в английской — наоборот. */
  function toCsv(state, options, date) {
    var data = build(state, date);
    if (!data) return '';
    var opts = options || {};
    var decimal = opts.decimal === '.' ? '.' : ',';
    /* Запятая не может быть одновременно разделителем столбцов
       и десятичным знаком. */
    var sep = opts.delimiter === ',' && decimal !== ',' ? ',' : ';';

    function cell(v, digits) {
      if (v === null || v === undefined) return '';
      var s = digits ? v.toFixed(digits) : String(v);
      return decimal === ',' ? s.replace('.', ',') : s;
    }

    var lines = [CSV_COLUMNS.map(function (c) { return c[1]; }).join(sep)];
    data['каталог_координат'].forEach(function (r) {
      lines.push(CSV_COLUMNS.map(function (c) { return cell(r[c[0]], c[2]); }).join(sep));
    });
    /* BOM обязателен: без него Excel показывает кириллицу мусором. */
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* Контур в WGS 84 обычным geojson — открыть в QGIS и посмотреть глазами. */
  function toGeoJson(state, date) {
    var s = state || GP.store.state;
    if (!s || !s.source || !s.anchor) return '';
    var frame = GP.transform.frameOf(s);

    var coordinates = s.source.polygons.map(function (rings) {
      return rings.map(function (ring) {
        var out = ring.map(function (p) {
          var ll = GP.transform.vertexLatLng(p[0], p[1], s, frame);
          return [round(ll[1], LL_DIGITS), round(ll[0], LL_DIGITS)];
        });
        out.push(out[0].slice());   /* geojson требует замкнутое кольцо */
        return out;
      });
    });

    return JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          'файл': s.source.name,
          'создано': stamp(date).iso,
          'поворот_градусы': round(s.rotation, 6),
          'масштаб_метров_в_единице_файла': s.scale,
          'опорная_точка': [round(s.anchor.lon, LL_DIGITS), round(s.anchor.lat, LL_DIGITS)]
        },
        geometry: { type: 'MultiPolygon', coordinates: coordinates }
      }]
    }, null, 2);
  }

  /* ---------- сохранение ---------- */

  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return name;
  }

  /* Что показать в панели после выгрузки. */
  function summary(state) {
    var s = state || GP.store.state;
    if (!s || !s.source) return null;
    var size = GP.transform.sizeOnMap(s);
    var known = null;
    UNITS.forEach(function (u) {
      if (u.scale !== null && Math.abs(s.scale - u.scale) < u.scale * 1e-6) known = u;
    });
    return {
      points: s.source.counts.vertices,
      scale: s.scale,
      width: size.width,
      height: size.height,
      unit: known,
      suspicious: Math.abs(Math.log10(s.scale)) > 0.02
    };
  }

  return {
    UNITS: UNITS,
    LL_DIGITS: LL_DIGITS,
    M_DIGITS: M_DIGITS,
    CSV_COLUMNS: CSV_COLUMNS,
    round: round,
    build: build,
    toJson: toJson,
    toCsv: toCsv,
    toGeoJson: toGeoJson,
    fileName: fileName,
    download: download,
    summary: summary
  };
})();

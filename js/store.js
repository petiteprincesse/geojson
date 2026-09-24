/* js/store.js — состояние проекта, разбор geojson и история отмены.
   Один источник истины: всё, что рисуется на карте и показывается
   в панелях, выводится отсюда. Изменения идут через GP.store,
   поэтому отмена работает предсказуемо. */

GP.store = (function () {
  var LIMIT = 100;              /* глубина истории */

  var state = {
    source: null,               /* разобранный контур */
    anchor: null,               /* {lat, lon} — куда попадает центр габарита */
    rotation: 0,                /* градусы против часовой */
    scale: 1,                   /* множитель: метров в единице файла */
    visible: true,
    fillOpacity: 0.15,
    references: [],             /* эталонные слои: ранее привязанные контуры */
    gcp: [],                    /* опорные точки: пары «точка файла ↔ точка карты» */
    handoff: null,              /* ручное положение, отброшенное опорными точками */
    unitsConfirmed: false,      /* пользователь сам выбирал единицы файла */
    workScale: 500,             /* знаменатель масштаба работ для допуска */
    vectorScale: 50             /* увеличение векторов невязок на карте */
  };

  var undoStack = [];
  var redoStack = [];
  var referenceSeq = 0;
  var gcpSeq = 0;

  /* ---------- разбор geojson ---------- */

  function err(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /* Собираем кольца из любой обёртки: FeatureCollection, Feature,
     GeometryCollection или голая геометрия. */
  function collect(node, out, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 12) return;
    var t = node.type;
    if (t === 'FeatureCollection' && Array.isArray(node.features)) {
      node.features.forEach(function (f) { collect(f, out, (depth || 0) + 1); });
    } else if (t === 'Feature') {
      collect(node.geometry, out, (depth || 0) + 1);
    } else if (t === 'GeometryCollection' && Array.isArray(node.geometries)) {
      node.geometries.forEach(function (gm) { collect(gm, out, (depth || 0) + 1); });
    } else if (t === 'Polygon' && Array.isArray(node.coordinates)) {
      out.push(node.coordinates);
    } else if (t === 'MultiPolygon' && Array.isArray(node.coordinates)) {
      node.coordinates.forEach(function (poly) {
        if (Array.isArray(poly)) out.push(poly);
      });
    }
  }

  function build(obj, name) {
    var raw = [];
    collect(obj, raw, 0);
    if (!raw.length) {
      throw err('no-polygons',
        'В файле нет полигонов. Нужны Polygon или MultiPolygon — ' +
        'точки и линии для границы проектирования не подойдут.');
    }

    var numeric = 0;
    var polygons = [];

    raw.forEach(function (rawRings) {
      var rings = [];
      rawRings.forEach(function (rawRing) {
        if (!Array.isArray(rawRing)) return;
        var ring = [];
        rawRing.forEach(function (c) {
          /* Координаты бывают [x, y] и [x, y, z] — берём первые две. */
          if (!Array.isArray(c)) return;
          var x = c[0], y = c[1];
          if (typeof x !== 'number' || typeof y !== 'number' ||
              !isFinite(x) || !isFinite(y)) return;
          numeric++;
          ring.push([x, y]);
        });
        /* Замыкающая вершина совпадает с первой — держать её незачем. */
        if (ring.length > 1 &&
            ring[0][0] === ring[ring.length - 1][0] &&
            ring[0][1] === ring[ring.length - 1][1]) {
          ring.pop();
        }
        if (ring.length >= 3) rings.push(ring);
      });
      if (rings.length) polygons.push(rings);
    });

    if (!numeric) {
      throw err('no-numbers',
        'Координаты вершин не числовые. Ожидаются пары чисел, ' +
        'например [2180000, 476000].');
    }
    if (!polygons.length) {
      throw err('no-rings',
        'В файле нет замкнутых колец: в кольце должно быть не меньше ' +
        'трёх вершин с числовыми координатами.');
    }

    var vertices = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var ringCount = 0;

    polygons.forEach(function (rings, pi) {
      rings.forEach(function (ring, ri) {
        ringCount++;
        ring.forEach(function (p, vi) {
          vertices.push({ x: p[0], y: p[1], polygon: pi, ring: ri, index: vi });
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[1] > maxY) maxY = p[1];
        });
      });
    });

    var center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    var radius = 0;
    vertices.forEach(function (v) {
      var d = Math.sqrt((v.x - center.x) * (v.x - center.x) +
                        (v.y - center.y) * (v.y - center.y));
      if (d > radius) radius = d;
    });

    return {
      name: name || 'Контур',
      polygons: polygons,
      vertices: vertices,
      bbox: {
        minX: minX, minY: minY, maxX: maxX, maxY: maxY,
        width: maxX - minX, height: maxY - minY
      },
      center: center,
      radius: radius,
      counts: {
        polygons: polygons.length,
        rings: ringCount,
        vertices: vertices.length
      }
    };
  }

  /* ---------- распознавание собственной выгрузки ----------
     Выгрузка приложения — географические координаты в градусах. Если
     читать её как исходный контур, получится участок в полсантиметра,
     поэтому такие файлы распознаются до разбора. */

  function detectResult(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (obj['параметры_трансформирования'] && obj['каталог_координат']) {
      return { kind: 'json', created: obj['создано'] || null, name: obj['файл'] || null };
    }

    var feature = null;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) feature = obj.features[0];
    else if (obj.type === 'Feature') feature = obj;

    var p = feature && feature.properties;
    if (p && p['поворот_градусы'] !== undefined &&
        p['масштаб_метров_в_единице_файла'] !== undefined &&
        p['опорная_точка'] !== undefined) {
      return { kind: 'geojson', created: p['создано'] || null, name: p['файл'] || null };
    }
    return null;
  }

  /* Эталонный слой: контур в его настоящем географическом положении.
     Собирается и из geojson, и из каталога координат в JSON. */
  function buildReference(obj, fileName) {
    var found = detectResult(obj);
    if (!found) {
      throw err('not-result', 'Это не результат привязки из этого приложения.');
    }

    var polygons = [];
    var anchor, rotation, scale;

    if (found.kind === 'geojson') {
      var feature = obj.type === 'Feature' ? obj : obj.features[0];
      var p = feature.properties;
      anchor = { lat: p['опорная_точка'][1], lon: p['опорная_точка'][0] };
      rotation = p['поворот_градусы'];
      scale = p['масштаб_метров_в_единице_файла'];

      var geometry = feature.geometry || {};
      var raw = geometry.type === 'Polygon' ? [geometry.coordinates]
              : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
      raw.forEach(function (rings) {
        var out = [];
        rings.forEach(function (ring) {
          var line = ring.map(function (c) { return [c[1], c[0]]; });  /* [lon,lat] → [lat,lon] */
          if (line.length > 1 &&
              line[0][0] === line[line.length - 1][0] &&
              line[0][1] === line[line.length - 1][1]) line.pop();
          if (line.length >= 3) out.push(line);
        });
        if (out.length) polygons.push(out);
      });
    } else {
      var params = obj['параметры_трансформирования'];
      anchor = {
        lat: params['опорная_точка_wgs84']['широта'],
        lon: params['опорная_точка_wgs84']['долгота']
      };
      rotation = params['поворот_против_часовой_градусы'];
      scale = params['масштаб_метров_в_единице_файла'];

      var buckets = {};
      obj['каталог_координат'].forEach(function (r) {
        var key = r['полигон'] + '/' + r['кольцо'];
        (buckets[key] || (buckets[key] = [])).push(r);
      });
      Object.keys(buckets).sort().forEach(function (key) {
        var rows = buckets[key].sort(function (a, b) { return a['вершина'] - b['вершина']; });
        var line = rows.map(function (r) { return [r['широта'], r['долгота']]; });
        if (line.length < 3) return;
        var poly = key.split('/')[0] - 1;
        (polygons[poly] || (polygons[poly] = [])).push(line);
      });
      polygons = polygons.filter(function (x) { return x && x.length; });
    }

    if (!polygons.length) {
      throw err('no-rings', 'В результате привязки нет колец с координатами.');
    }

    var rings = 0, vertices = 0;
    polygons.forEach(function (poly) {
      poly.forEach(function (ring) { rings++; vertices += ring.length; });
    });

    return {
      id: 'ref-' + (++referenceSeq),
      name: fileName || found.name || 'Эталон',
      origin: found.name || null,
      created: found.created || null,
      kind: found.kind,
      anchor: anchor,
      rotation: rotation,
      scale: scale,
      polygons: polygons,
      visible: true,
      counts: { polygons: polygons.length, rings: rings, vertices: vertices }
    };
  }

  /* Прочитать файл и сказать, что это: исходный контур или собственная
     выгрузка. Разбор в контур делает уже вызывающая сторона. */
  function read(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw err('not-json',
        'Файл не разбирается как JSON. Проверьте, что это geojson, ' +
        'а не архив, таблица или shapefile.');
    }
    return { obj: obj, result: detectResult(obj) };
  }

  function parse(text, name) {
    return build(read(text).obj, name);
  }

  /* ---------- диагностика единиц ---------- */

  /* Главная проверка после загрузки — габарит в метрах: по нему сразу
     видно, метры в файле или миллиметры. */
  function diagnose(source) {
    var w = source.bbox.width, h = source.bbox.height;
    var warnings = [];

    var looksLikeDegrees = w < 1 && h < 1 &&
      Math.abs(source.bbox.minX) <= 180 && Math.abs(source.bbox.maxX) <= 180 &&
      Math.abs(source.bbox.minY) <= 90 && Math.abs(source.bbox.maxY) <= 90;

    if (looksLikeDegrees) {
      warnings.push({
        level: 'danger',
        text: 'Координаты похожи на градусы, а не на метры: габарит меньше ' +
              'единицы, значения укладываются в ±180 и ±90. Инструмент ждёт ' +
              'файл в метрах местной системы координат. Если это результат ' +
              'привязки из этого приложения — загрузите его как эталонный слой.'
      });
    }
    if (w > 500000 || h > 500000) {
      warnings.push({
        level: 'warning',
        text: 'Габарит больше 500 км. Похоже, в файле не площадка, ' +
              'а несколько разнесённых объектов или другие единицы.'
      });
    }
    if (w < 1e-9 || h < 1e-9) {
      warnings.push({
        level: 'warning',
        text: 'Габарит вырожден по одной из осей: все вершины лежат ' +
              'на прямой. Повернуть и вписать такой контур не выйдет.'
      });
    }
    return warnings;
  }

  /* Подсказка про миллиметры — вопрос, а не диагноз. Габарит 50 000
     единиц — это и область в 50 км в метрах, и участок в 50 м
     в миллиметрах; по одному числу их не различить. Подсказка нужна
     там, где миллиметры правдоподобны: большая сторона от 10 000
     до 5 000 000 единиц и после деления на 1000 похожа на участок
     (от 10 м до 5 км). От 500 000 единиц одновременно срабатывает
     предупреждение про габарит больше 500 км — подсказка дополняет его
     конкретным вариантом. */
  var MM_MIN_UNITS = 10000;
  var MM_MAX_UNITS = 5000000;
  var MM_MIN_SITE = 10;
  var MM_MAX_SITE = 5000;

  function millimetreHint(source) {
    if (!source) return null;
    var w = source.bbox.width, h = source.bbox.height;
    var side = Math.max(w, h);
    if (side < MM_MIN_UNITS || side > MM_MAX_UNITS) return null;
    if (side / 1000 < MM_MIN_SITE || side / 1000 > MM_MAX_SITE) return null;
    return { side: side, width: w, height: h, mmWidth: w / 1000, mmHeight: h / 1000 };
  }

  /* ---------- история ---------- */

  function snapshotOf(s) {
    return {
      source: s.source,
      anchor: s.anchor ? { lat: s.anchor.lat, lon: s.anchor.lon } : null,
      rotation: s.rotation,
      scale: s.scale,
      visible: s.visible,
      fillOpacity: s.fillOpacity,
      /* Массив копируется, элементы неизменяемы: правка точки создаёт
         новый объект, поэтому снимок не «уезжает» вместе с состоянием. */
      gcp: s.gcp.slice(),
      /* Передача управления точкам откатывается вместе с ними:
         Ctrl+Z после второй пары возвращает ручное совмещение целиком. */
      handoff: s.handoff,
      unitsConfirmed: s.unitsConfirmed
    };
  }

  function restore(snap) {
    state.source = snap.source;
    state.anchor = snap.anchor ? { lat: snap.anchor.lat, lon: snap.anchor.lon } : null;
    state.rotation = snap.rotation;
    state.scale = snap.scale;
    state.visible = snap.visible;
    state.fillOpacity = snap.fillOpacity;
    state.gcp = snap.gcp ? snap.gcp.slice() : [];
    state.handoff = snap.handoff || null;
    state.unitsConfirmed = !!snap.unitsConfirmed;
  }

  function emit(reason) {
    GP.bus.emit('store:change', { state: state, reason: reason });
  }

  /* Снимок берётся ПЕРЕД дискретным действием: началом перетаскивания,
     началом вращения, правкой поля, шагом стрелкой. */
  function snapshot() {
    undoStack.push(snapshotOf(state));
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
    emit('history');
  }

  function set(patch, reason) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    emit(reason || 'set');
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(snapshotOf(state));
    restore(undoStack.pop());
    emit('undo');
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(snapshotOf(state));
    restore(redoStack.pop());
    emit('redo');
    return true;
  }

  /* ---------- загрузка ---------- */

  function load(source, anchor) {
    snapshot();
    state.source = source;
    state.anchor = { lat: anchor.lat, lon: anchor.lon };
    state.rotation = 0;
    state.scale = 1;
    state.visible = true;
    /* Опорные точки заданы в координатах прежнего файла — к новому
       контуру они не относятся. */
    state.gcp = [];
    state.handoff = null;
    state.unitsConfirmed = false;
    emit('load');
  }

  /* ---------- опорные точки ---------- */

  function addGcp(pair) {
    var item = {
      id: 'gcp-' + (++gcpSeq),
      n: state.gcp.reduce(function (m, p) { return Math.max(m, p.n); }, 0) + 1,
      x: pair.x, y: pair.y,
      lat: pair.lat, lon: pair.lon,
      kind: pair.kind || 'vertex',
      enabled: true,
      control: false
    };
    state.gcp = state.gcp.concat([item]);
    emit('gcp');
    return item;
  }

  /* Правка точки заменяет её копией: иначе снимок истории менялся бы
     вместе с состоянием и отмена ничего не возвращала бы. */
  function updateGcp(id, patch) {
    state.gcp = state.gcp.map(function (p) {
      if (p.id !== id) return p;
      var copy = {};
      Object.keys(p).forEach(function (k) { copy[k] = p[k]; });
      Object.keys(patch).forEach(function (k) { copy[k] = patch[k]; });
      return copy;
    });
    emit('gcp');
  }

  function removeGcp(id) {
    state.gcp = state.gcp.filter(function (p) { return p.id !== id; });
    emit('gcp');
  }

  function clearGcp() {
    state.gcp = [];
    emit('gcp');
  }

  /* Совпадает ли эталон с уже загруженным: опорная точка, поворот
     и масштаб. Выгрузка одной привязки даёт JSON и geojson, которые
     в списке выглядят одинаково — дубль ловится по числам. */
  function findSameReference(ref) {
    var found = null;
    state.references.forEach(function (r) {
      if (found) return;
      var inv = GP.geo.vincentyInverse(r.anchor.lat, r.anchor.lon, ref.anchor.lat, ref.anchor.lon);
      var sameScale = r.scale && ref.scale
        ? Math.abs(ref.scale / r.scale - 1) < 1e-9
        : r.scale === ref.scale;
      if (inv.distance < 1e-3 && Math.abs(r.rotation - ref.rotation) < 1e-6 && sameScale) {
        found = r;
      }
    });
    return found;
  }

  /* Эталоны живут вне истории отмены: это не привязка, а отпечатки
     для сравнения, и откатывать их вместе со сдвигом было бы неожиданно. */
  function addReference(ref) {
    state.references = state.references.concat([ref]);
    emit('reference');
    return ref;
  }

  function removeReference(id) {
    state.references = state.references.filter(function (r) { return r.id !== id; });
    emit('reference');
  }

  function clearReferences() {
    state.references = [];
    emit('reference');
  }

  function setReferenceVisible(id, visible) {
    state.references.forEach(function (r) { if (r.id === id) r.visible = !!visible; });
    emit('reference');
  }

  function clear() {
    snapshot();
    state.source = null;
    state.anchor = null;
    state.rotation = 0;
    state.scale = 1;
    emit('clear');
  }

  return {
    state: state,
    read: read,
    parse: parse,
    build: build,
    detectResult: detectResult,
    buildReference: buildReference,
    addReference: addReference,
    findSameReference: findSameReference,
    addGcp: addGcp,
    updateGcp: updateGcp,
    removeGcp: removeGcp,
    clearGcp: clearGcp,
    removeReference: removeReference,
    clearReferences: clearReferences,
    setReferenceVisible: setReferenceVisible,
    diagnose: diagnose,
    millimetreHint: millimetreHint,
    load: load,
    clear: clear,
    set: set,
    snapshot: snapshot,
    undo: undo,
    redo: redo,
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    depth: function () { return { undo: undoStack.length, redo: redoStack.length }; }
  };
})();

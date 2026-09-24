/* js/transform.js — перемещение, вращение и масштабирование контура.

   Вершина живёт в двух системах: в местных метрах файла и на эллипсоиде.
   Путь туда один и тот же для отрисовки, для экспорта и для измерений:
   вычесть центр габарита, умножить на масштаб, повернуть против часовой,
   получить ENU и перевести в географические координаты относительно
   опорной точки. Никакого CSS-трансформа: он развалился бы при зуме. */

GP.transform = (function () {
  var R_MEAN = 6371008.8;       /* средний радиус Земли для оценки погрешности */
  var DEG = Math.PI / 180;

  function params(s) {
    return {
      originX: s.source.center.x,
      originY: s.source.center.y,
      rotationDeg: s.rotation,
      scale: s.scale
    };
  }

  /* Местные метры файла → ENU относительно опорной точки. */
  function localToEnu(x, y, s) {
    return GP.geo.similarity(x, y, params(s));
  }

  /* Обратный ход: ENU → местные метры файла. */
  function enuToLocal(e, n, s) {
    var th = -s.rotation * DEG;
    var c = Math.cos(th), si = Math.sin(th);
    var x = (e * c - n * si) / s.scale;
    var y = (e * si + n * c) / s.scale;
    return { x: x + s.source.center.x, y: y + s.source.center.y };
  }

  /* Рамку опорной точки считаем один раз на перерисовку. */
  function frameOf(s) { return GP.geo.frame(s.anchor); }

  function vertexLatLng(x, y, s, frame) {
    var enu = localToEnu(x, y, s);
    var g = (frame || frameOf(s)).toGeodetic(enu.e, enu.n, 0);
    return [g.lat, g.lon];
  }

  /* Вложенные массивы для L.polygon: полигоны, в каждом внешнее кольцо
     и дырки. */
  function polygonsLatLngs(s) {
    if (!s.source || !s.anchor) return [];
    var frame = frameOf(s);
    return s.source.polygons.map(function (rings) {
      return rings.map(function (ring) {
        return ring.map(function (p) { return vertexLatLng(p[0], p[1], s, frame); });
      });
    });
  }

  function verticesLatLngs(s) {
    if (!s.source || !s.anchor) return [];
    var frame = frameOf(s);
    return s.source.vertices.map(function (v) {
      return vertexLatLng(v.x, v.y, s, frame);
    });
  }

  /* ---------- размеры на карте ---------- */

  function sizeOnMap(s) {
    if (!s.source) return { width: 0, height: 0, radius: 0 };
    return {
      width: s.source.bbox.width * s.scale,
      height: s.source.bbox.height * s.scale,
      radius: s.source.radius * s.scale
    };
  }

  /* Ручка вращения: 1,06 радиуса габарита, но не ближе 15 м. */
  function handleDistance(s) {
    return Math.max(sizeOnMap(s).radius * 1.06, 15);
  }

  /* Направление ручки при повороте r: rotation = −atan2(e, n),
     значит e = −d·sin r, n = d·cos r. При нулевом повороте ручка
     смотрит строго на север. */
  function handleEnu(s, distance) {
    var d = (distance === undefined) ? handleDistance(s) : distance;
    var r = s.rotation * DEG;
    return { e: -d * Math.sin(r), n: d * Math.cos(r) };
  }

  function handleLatLng(s, frame) {
    var enu = handleEnu(s);
    var g = (frame || frameOf(s)).toGeodetic(enu.e, enu.n, 0);
    return [g.lat, g.lon];
  }

  /* Угол по положению ручки: E — вправо, N — вверх, поэтому поворот
     против часовой даёт отрицательный азимут. */
  function rotationFromEnu(e, n) {
    return normalizeAngle(-Math.atan2(e, n) / DEG);
  }

  function normalizeAngle(deg) {
    var d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  /* Азимут локальной оси +Y — то, что оператор сверяет с чертежом. */
  function azimuthY(s) {
    var a = -s.rotation % 360;
    if (a < 0) a += 360;
    return a;
  }

  /* Ожидаемая погрешность модели на площадке радиуса r: касательная
     плоскость отходит от эллипсоида примерно на r³/(3·R²). */
  function expectedError(radius) {
    return radius * radius * radius / (3 * R_MEAN * R_MEAN);
  }

  /* ---------- сравнение с эталонами ---------- */

  /* Расхождение текущей привязки с эталоном. Сдвиг опорной точки меряется
     по геодезической линии, а не по касательной плоскости. */
  function compare(s, ref) {
    if (!s || !s.anchor || !ref) return null;
    var inv = GP.geo.vincentyInverse(ref.anchor.lat, ref.anchor.lon, s.anchor.lat, s.anchor.lon);
    return {
      shift: inv.distance,
      azimuth: inv.azimuth,
      /* Все величины — текущая привязка относительно эталонной:
         поворот как разность со знаком по кратчайшей дуге, масштаб
         как относительная разница. Сдвиг знака не имеет, это расстояние. */
      rotation: normalizeAngle(s.rotation - ref.rotation),
      scaleRel: ref.scale ? s.scale / ref.scale - 1 : NaN
    };
  }

  /* Разброс по всем привязкам сразу, включая текущую: максимальное
     попарное расхождение по положению и по повороту. */
  function spread(bindings) {
    var maxShift = 0, maxRotation = 0;
    for (var i = 0; i < bindings.length; i++) {
      for (var j = i + 1; j < bindings.length; j++) {
        var a = bindings[i], b = bindings[j];
        var inv = GP.geo.vincentyInverse(a.anchor.lat, a.anchor.lon, b.anchor.lat, b.anchor.lon);
        maxShift = Math.max(maxShift, inv.distance);
        maxRotation = Math.max(maxRotation, Math.abs(normalizeAngle(a.rotation - b.rotation)));
      }
    }
    return { shift: maxShift, rotation: maxRotation, count: bindings.length };
  }

  /* ---------- дискретные действия ---------- */
  /* Снимок в историю берёт вызывающая сторона: она знает, где начинается
     действие, а где идёт непрерывное движение мыши. */

  function moveBy(dEast, dNorth) {
    var s = GP.store.state;
    if (!s.anchor) return;
    var g = GP.geo.enuToGeodetic(dEast, dNorth, s.anchor, 0);
    GP.store.set({ anchor: { lat: g.lat, lon: g.lon } }, 'move');
  }

  function setAnchor(lat, lon, reason) {
    GP.store.set({ anchor: { lat: lat, lon: lon } }, reason || 'move');
  }

  function rotateBy(deg) {
    GP.store.set({ rotation: normalizeAngle(GP.store.state.rotation + deg) }, 'rotate');
  }

  function setRotation(deg) {
    GP.store.set({ rotation: normalizeAngle(deg) }, 'rotate');
  }

  /* Поле в панели — «метров в единице файла»: ровно тот множитель,
     который возвращает подгонка подобия и который показан в диагностике.
     Никакого 1/x: иначе пользователь видел бы 0,001, а вводил 1000. */
  function setScale(metersPerUnit) {
    if (!isFinite(metersPerUnit) || metersPerUnit <= 0) return false;
    GP.store.set({ scale: metersPerUnit }, 'scale');
    return true;
  }

  return {
    R_MEAN: R_MEAN,
    localToEnu: localToEnu,
    enuToLocal: enuToLocal,
    frameOf: frameOf,
    vertexLatLng: vertexLatLng,
    polygonsLatLngs: polygonsLatLngs,
    verticesLatLngs: verticesLatLngs,
    sizeOnMap: sizeOnMap,
    handleDistance: handleDistance,
    handleEnu: handleEnu,
    handleLatLng: handleLatLng,
    rotationFromEnu: rotationFromEnu,
    normalizeAngle: normalizeAngle,
    azimuthY: azimuthY,
    expectedError: expectedError,
    compare: compare,
    spread: spread,
    moveBy: moveBy,
    setAnchor: setAnchor,
    rotateBy: rotateBy,
    setRotation: setRotation,
    setScale: setScale
  };
})();

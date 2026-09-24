/* js/gcp.js — опорные точки: пары «точка контура ↔ точка на карте».

   Две пары задают подобие точно, поэтому с двух пар положение контура
   считается подгонкой, а не руками. Невязки меряются в метрах на
   местности: пиксели ничего не говорят о качестве привязки.

   Контрольные точки в подгонке не участвуют. При малом числе точек это
   единственный честный способ увидеть настоящую ошибку: на учтённых
   точках невязка занижена по построению. */

GP.gcp = (function () {
  var active = false;          /* режим расстановки включён */
  var pending = null;          /* первая точка пары уже поставлена */

  /* Допуск: 0,3 мм в масштабе работ. Для 1:500 это 0,15 м. */
  var WORK_SCALES = [500, 1000, 2000, 5000];
  var TOLERANCE_MM = 0.3;

  function tolerance(denominator) {
    return TOLERANCE_MM / 1000 * denominator;
  }

  /* ---------- режим ---------- */

  function isActive() { return active; }

  function setActive(on) {
    active = !!on;
    if (!active) pending = null;
    GP.bus.emit('gcp:mode', { active: active, pending: pending });
  }

  function getPending() { return pending; }

  function setPending(p) {
    pending = p;
    GP.bus.emit('gcp:mode', { active: active, pending: pending });
  }

  /* Escape: сначала отменяет незавершённую пару, потом выходит из режима. */
  function cancel() {
    if (pending) { setPending(null); return 'pending'; }
    if (active) { setActive(false); return 'mode'; }
    return null;
  }

  /* ---------- выборки ---------- */

  function used(list) {
    return list.filter(function (p) { return p.enabled && !p.control; });
  }

  function controls(list) {
    return list.filter(function (p) { return p.enabled && p.control; });
  }

  /* С двух учтённых пар положение задаётся точками, а не руками. */
  function isLocked(s) {
    var st = s || GP.store.state;
    return used(st.gcp || []).length >= 2;
  }

  /* ---------- притяжение к контуру ---------- */

  var SNAP_PX = 12;

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* project(x, y) отдаёт экранную точку вершины; сравнение идёт
     в пикселях, потому что притяжение — про то, что видит глаз. */
  function snapToContour(s, project, point) {
    if (!s.source) return null;
    var bestVertex = null, bestEdge = null;

    s.source.polygons.forEach(function (rings, pi) {
      rings.forEach(function (ring, ri) {
        for (var i = 0; i < ring.length; i++) {
          var a = ring[i], b = ring[(i + 1) % ring.length];
          var pa = project(a[0], a[1]), pb = project(b[0], b[1]);

          var dv = Math.hypot(pa.x - point.x, pa.y - point.y);
          if (!bestVertex || dv < bestVertex.distance) {
            bestVertex = {
              x: a[0], y: a[1], kind: 'vertex', distance: dv,
              polygon: pi, ring: ri, index: i
            };
          }

          var vx = pb.x - pa.x, vy = pb.y - pa.y;
          var len2 = vx * vx + vy * vy;
          var t = len2 ? ((point.x - pa.x) * vx + (point.y - pa.y) * vy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          var ex = pa.x + vx * t, ey = pa.y + vy * t;
          var de = Math.hypot(ex - point.x, ey - point.y);
          if (!bestEdge || de < bestEdge.distance) {
            bestEdge = {
              x: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t),
              kind: 'edge', distance: de, polygon: pi, ring: ri, index: i
            };
          }
        }
      });
    });

    if (!bestVertex) return null;
    return (bestVertex.distance <= SNAP_PX) ? bestVertex : bestEdge;
  }

  /* ---------- подгонка ---------- */

  function centroidLatLon(list) {
    var lat = 0, lon = 0;
    list.forEach(function (p) { lat += p.lat; lon += p.lon; });
    return { lat: lat / list.length, lon: lon / list.length };
  }

  /* Параметры привязки по учтённым парам.

     Подгонка идёт в локальной плоскости ENU, и плоскость эта обязана
     совпасть с той, в которой потом строится контур, — то есть иметь
     начало в опорной точке. Начало неизвестно до решения, поэтому
     первый проход считается от центра тяжести целевых точек, а
     следующие — от найденной опорной точки. Без этих итераций две пары
     дают невязку около двух сантиметров вместо нуля: ровно на столько
     расходятся две касательные плоскости на площадке в километр. */
  function solve(s) {
    var st = s || GP.store.state;
    if (!st.source) return null;
    var list = used(st.gcp || []);
    if (list.length < 2) return null;

    var c = st.source.center;
    var src = list.map(function (p) { return [p.x, p.y]; });
    var origin = centroidLatLon(list);
    var frame, fit, g = null;

    for (var pass = 0; pass < 3; pass++) {
      frame = GP.geo.frame(origin);
      var dst = list.map(function (p) {
        var e = frame.toEnu(p.lat, p.lon, 0);
        return [e.e, e.n];
      });
      fit = GP.geo.fitSimilarity(src, dst);
      if (!fit) return null;

      /* Опорная точка контура — центр габарита, прогнанный через
         найденное подобие. */
      var e = fit.a * c.x - fit.b * c.y + fit.tx;
      var n = fit.b * c.x + fit.a * c.y + fit.ty;
      g = frame.toGeodetic(e, n, 0);
      origin = { lat: g.lat, lon: g.lon };
    }

    return {
      anchor: { lat: g.lat, lon: g.lon },
      rotation: GP.transform.normalizeAngle(fit.rotationDeg),
      scale: fit.scale,
      fit: fit,
      origin: origin,
      count: list.length
    };
  }

  /* Пересчитать контур по точкам. Вызывается после каждой правки набора.

     Решение по двум парам проходит ровно через два клика и полностью
     отбрасывает ручное совмещение — это верно, но выглядит как поломка.
     Поэтому в момент, когда точки забирают управление, ручное положение
     запоминается: панель объясняет скачок и умеет вернуть как было. */
  function apply() {
    var st = GP.store.state;
    var solution = solve();

    if (!solution) {
      if (st.handoff) GP.store.set({ handoff: null }, 'gcp-solve');
      return null;
    }

    var patch = {
      anchor: solution.anchor,
      rotation: solution.rotation,
      scale: solution.scale
    };

    if (!st.handoff && st.anchor) {
      var shift = GP.geo.vincentyInverse(st.anchor.lat, st.anchor.lon,
                                         solution.anchor.lat, solution.anchor.lon).distance;
      var size = GP.transform.sizeOnMap(st);
      patch.handoff = {
        anchor: { lat: st.anchor.lat, lon: st.anchor.lon },
        rotation: st.rotation,
        scale: st.scale,
        count: solution.count,
        shift: shift,
        rotationChange: GP.transform.normalizeAngle(solution.rotation - st.rotation),
        /* Смещение больше габарита — скорее всего точки пары не
           соответствуют друг другу. */
        big: shift > Math.max(size.width, size.height)
      };
    }

    GP.store.set(patch, 'gcp-solve');
    return solution;
  }

  /* Вернуть ручное совмещение: прежнее положение и выключенные точки.
     Точки не удаляются — их невязки показывают, насколько ручное
     положение расходится с ними, и их можно включить обратно. */
  function restoreManual() {
    var st = GP.store.state;
    var h = st.handoff;
    if (!h) return false;
    GP.store.snapshot();
    GP.store.set({
      gcp: st.gcp.map(function (p) {
        if (!p.enabled || p.control) return p;
        var copy = {};
        Object.keys(p).forEach(function (k) { copy[k] = p[k]; });
        copy.enabled = false;
        return copy;
      }),
      anchor: { lat: h.anchor.lat, lon: h.anchor.lon },
      rotation: h.rotation,
      scale: h.scale,
      handoff: null
    }, 'gcp-manual');
    return true;
  }

  /* ---------- невязки ---------- */

  /* Вектор от фактического положения точки (куда её поставил оператор)
     к расчётному (куда её кладёт модель). Считается для всех пар,
     включая выключенные и контрольные. */
  function residuals(s) {
    var st = s || GP.store.state;
    if (!st.source || !st.anchor) return [];
    return (st.gcp || []).map(function (p) {
      var ll = GP.transform.vertexLatLng(p.x, p.y, st);
      var frame = GP.geo.frame({ lat: p.lat, lon: p.lon });
      var d = frame.toEnu(ll[0], ll[1], 0);
      return {
        pair: p,
        computed: { lat: ll[0], lon: ll[1] },
        dE: d.e,
        dN: d.n,
        dS: Math.hypot(d.e, d.n),
        used: p.enabled && !p.control,
        control: p.enabled && p.control
      };
    });
  }

  function median(values) {
    if (!values.length) return NaN;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function rmsOf(list) {
    if (!list.length) return NaN;
    var sum = 0;
    list.forEach(function (r) { sum += r.dS * r.dS; });
    return Math.sqrt(sum / list.length);
  }

  function stats(s) {
    var st = s || GP.store.state;
    var rows = residuals(st);
    var usedRows = rows.filter(function (r) { return r.used; });
    var controlRows = rows.filter(function (r) { return r.control; });

    var rms = rmsOf(usedRows);
    var max = 0;
    usedRows.forEach(function (r) { max = Math.max(max, r.dS); });

    /* Стандартное отклонение имеет смысл, когда точек хватает:
       на двух парах невязки тождественно нулевые.

       Считается оно устойчиво, через медиану абсолютных отклонений:
       обычная сигма раздувается той самой грубой ошибкой, которую
       ищем, и выброс маскирует сам себя. Множитель 1,4826 приводит
       медианную оценку к обычному стандартному отклонению. */
    var sigma = NaN;
    if (usedRows.length >= 4) {
      var values = usedRows.map(function (r) { return r.dS; });
      var med = median(values);
      sigma = 1.4826 * median(values.map(function (v) { return Math.abs(v - med); }));
      if (!(sigma > 0)) {
        var mean = values.reduce(function (a, v) { return a + v; }, 0) / values.length;
        var acc = 0;
        values.forEach(function (v) { acc += (v - mean) * (v - mean); });
        sigma = Math.sqrt(acc / (values.length - 1));
      }
    }

    var tol = tolerance(st.workScale || 500);
    return {
      rows: rows,
      rms: rms,
      max: max,
      sigma: sigma,
      medianResidual: usedRows.length ? median(usedRows.map(function (r) { return r.dS; })) : NaN,
      rmsControl: rmsOf(controlRows),
      usedCount: usedRows.length,
      controlCount: controlRows.length,
      disabledCount: rows.length - usedRows.length - controlRows.length,
      total: rows.length,
      tolerance: tol,
      verdict: verdict(rms, tol),
      /* Ровно две учтённые пары дают тождественно нулевую невязку:
         решение проходит через точки точно, и низкий RMS ничего не значит. */
      exact: usedRows.length > 0 && usedRows.length <= 2
    };
  }

  /* Светофор: зелёный — с запасом, жёлтый — впритык, красный — вне допуска. */
  function verdict(rms, tol) {
    if (!isFinite(rms) || !isFinite(tol) || tol <= 0) return 'none';
    if (rms <= tol * 0.75) return 'ok';
    if (rms <= tol) return 'warn';
    return 'bad';
  }

  var VERDICT_TEXT = {
    ok: 'в допуске',
    warn: 'на границе допуска',
    bad: 'вне допуска',
    none: 'нет данных'
  };

  /* Строка с выбросом: невязка больше трёх стандартных отклонений.

     К этому правилу добавлены два порога, иначе оно бесполезно на малом
     числе точек: на чистых данных сигма падает до микрометров и красной
     становится половина таблицы, а одна грубая ошибка перекашивает
     невязки всех точек сразу и красит таблицу целиком. Поэтому выброс
     обязан вдвое превышать медианную невязку и быть не меньше пятой
     части допуска — тогда подсвечивается именно виновник. */
  function isOutlier(row, st) {
    if (!row.used || !isFinite(st.sigma) || st.sigma <= 0) return false;
    if (row.dS <= 3 * st.sigma) return false;
    if (isFinite(st.medianResidual) && row.dS < 2 * st.medianResidual) return false;
    return row.dS >= st.tolerance * 0.2;
  }

  return {
    WORK_SCALES: WORK_SCALES,
    TOLERANCE_MM: TOLERANCE_MM,
    SNAP_PX: SNAP_PX,
    VERDICT_TEXT: VERDICT_TEXT,
    isActive: isActive,
    setActive: setActive,
    toggle: function () { setActive(!active); },
    getPending: getPending,
    setPending: setPending,
    cancel: cancel,
    isLocked: isLocked,
    used: used,
    controls: controls,
    snapToContour: snapToContour,
    solve: solve,
    apply: apply,
    restoreManual: restoreManual,
    residuals: residuals,
    stats: stats,
    tolerance: tolerance,
    verdict: verdict,
    isOutlier: isOutlier
  };
})();

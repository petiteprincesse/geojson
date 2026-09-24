/* js/layers.js — слой контура на карте и манипуляторы.

   Геометрия задаётся географическими координатами вершин: при зуме
   контур остаётся на том же месте местности, потому что пересчитывается,
   а не растягивается CSS-трансформом.

   Перетаскивание сделано на pointer capture, а не на map.on('mousemove'):
   при быстром движении курсор соскакивает с полигона, и перетаскивание
   на карте рвётся, а захват указателя держит его до отпускания. */

GP.layers = (function () {
  var map = null;
  var group = null;

  var poly = null;
  var vertexGroup = null;
  var vertexMarkers = [];
  var anchorMarker = null;
  var lever = null;
  var handle = null;
  var sector = null;
  var readout = null;

  /* Эталонные слои: ранее привязанные контуры в их настоящем
     географическом положении. Их не двигают и не вращают. */
  var refGroup = null;
  var refLayers = {};

  /* Опорные точки: марки, номера, векторы невязок и резинка
     во время расстановки. */
  var gcpGroup = null;
  var gcpLayers = {};
  var vectorGroup = null;
  var snapMarker = null;
  var rubber = null;
  var hovered = null;

  var VERTEX_LIMIT = 1000;

  /* Флаг «ручку сейчас тянут»: пока он поднят, перерисовка не трогает
     ручку — иначе на каждое движение мыши появлялась бы новая. */
  var rotating = false;
  var dragging = false;
  var dragOffset = null;
  var rotateStart = 0;
  var pendingFrame = false;

  var colors = {};

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    colors = {
      contour: cs.getPropertyValue('--geom-contour').trim(),
      vertex: cs.getPropertyValue('--geom-vertex').trim(),
      control: cs.getPropertyValue('--geom-control').trim(),
      text3: cs.getPropertyValue('--text-3').trim()
    };
  }

  /* ---------- создание слоёв ---------- */

  function ensureLayers() {
    if (poly) return;

    poly = L.polygon([], {
      color: colors.contour,
      weight: 2,
      fillColor: colors.contour,
      fillOpacity: GP.store.state.fillOpacity,
      className: 'gp-contour',
      interactive: true
    }).addTo(group);

    vertexGroup = L.layerGroup().addTo(group);

    lever = L.polyline([], {
      color: colors.control,
      weight: 1,
      dashArray: '4 3',
      interactive: false,
      className: 'gp-lever'
    }).addTo(group);

    anchorMarker = L.circleMarker([0, 0], {
      radius: 4,
      color: colors.control,
      weight: 2,
      fillColor: colors.vertex,
      fillOpacity: 1,
      interactive: false,
      className: 'gp-anchor'
    }).addTo(group);

    handle = L.circleMarker([0, 0], {
      radius: 6,
      color: colors.control,
      weight: 2,
      fillColor: colors.control,
      fillOpacity: 1,
      className: 'gp-handle',
      interactive: true
    }).addTo(group);

  }

  function restyle() {
    if (!poly) return;
    poly.setStyle({ color: colors.contour, fillColor: colors.contour });
    lever.setStyle({ color: colors.control });
    anchorMarker.setStyle({ color: colors.control, fillColor: colors.vertex });
    handle.setStyle({ color: colors.control, fillColor: colors.control });
    vertexMarkers.forEach(function (m) {
      m.setStyle({ color: colors.contour, fillColor: colors.vertex });
    });
    Object.keys(refLayers).forEach(function (id) {
      refLayers[id].setStyle({ color: colors.control });
    });
  }

  /* ---------- отрисовка ---------- */

  function clearVertices() {
    vertexGroup.clearLayers();
    vertexMarkers = [];
  }

  function renderVertices(s, frame) {
    if (s.source.counts.vertices > VERTEX_LIMIT) {
      if (vertexMarkers.length) clearVertices();
      return;
    }
    var pts = s.source.vertices.map(function (v) {
      return GP.transform.vertexLatLng(v.x, v.y, s, frame);
    });
    if (vertexMarkers.length !== pts.length) {
      clearVertices();
      pts.forEach(function (p) {
        var m = L.circleMarker(p, {
          radius: 2.5,
          weight: 1,
          color: colors.contour,
          fillColor: colors.vertex,
          fillOpacity: 1,
          interactive: false,
          className: 'gp-vertex'
        });
        m.addTo(vertexGroup);
        vertexMarkers.push(m);
      });
    } else {
      for (var i = 0; i < pts.length; i++) vertexMarkers[i].setLatLng(pts[i]);
    }
  }

  function setShown(shown) {
    if (!group) return;
    var el = group;
    if (shown && !map.hasLayer(el)) el.addTo(map);
    if (!shown && map.hasLayer(el)) map.removeLayer(el);
  }

  /* ---------- эталонные слои ---------- */

  function referenceStyle() {
    return {
      color: colors.control,
      weight: 2,
      dashArray: '6 4',
      fill: false,
      interactive: false,
      className: 'gp-reference'
    };
  }

  function renderReferences(s) {
    var seen = {};
    s.references.forEach(function (ref) {
      seen[ref.id] = true;
      var layer = refLayers[ref.id];
      if (!layer) {
        layer = L.polygon(ref.polygons, referenceStyle());
        refLayers[ref.id] = layer;
      }
      var on = refGroup.hasLayer(layer);
      if (ref.visible && !on) layer.addTo(refGroup);
      if (!ref.visible && on) refGroup.removeLayer(layer);
    });
    Object.keys(refLayers).forEach(function (id) {
      if (seen[id]) return;
      refGroup.removeLayer(refLayers[id]);
      delete refLayers[id];
    });
  }

  /* ---------- опорные точки ---------- */

  function gcpNumberIcon(pair, isHot) {
    return L.divIcon({
      className: 'gp-gcp-label' + (isHot ? ' is-hot' : '') +
        (pair.control ? ' is-control' : '') + (pair.enabled ? '' : ' is-off'),
      html: String(pair.n),
      iconSize: null
    });
  }

  function renderGcp(s) {
    var seen = {};
    s.gcp.forEach(function (pair) {
      seen[pair.id] = true;
      var item = gcpLayers[pair.id];
      var hot = hovered === pair.id;
      if (!item) {
        item = {
          dot: L.circleMarker([pair.lat, pair.lon], {
            radius: 4, weight: 2, color: colors.control,
            fillColor: colors.vertex, fillOpacity: 1,
            className: 'gp-gcp-dot', interactive: true
          }),
          label: L.marker([pair.lat, pair.lon], {
            icon: gcpNumberIcon(pair, hot), interactive: false, keyboard: false
          })
        };
        item.dot.on('mouseover', function () { GP.bus.emit('gcp:hover', pair.id); });
        item.dot.on('mouseout', function () { GP.bus.emit('gcp:hover', null); });
        item.dot.addTo(gcpGroup);
        item.label.addTo(gcpGroup);
        gcpLayers[pair.id] = item;
      }
      item.dot.setLatLng([pair.lat, pair.lon]);
      item.dot.setStyle({
        radius: hot ? 6 : 4,
        color: pair.enabled ? colors.control : colors.text3,
        fillColor: pair.control ? colors.control : colors.vertex,
        dashArray: pair.control ? '2 2' : null
      });
      item.label.setLatLng([pair.lat, pair.lon]);
      item.label.setIcon(gcpNumberIcon(pair, hot));
    });

    Object.keys(gcpLayers).forEach(function (id) {
      if (seen[id]) return;
      gcpGroup.removeLayer(gcpLayers[id].dot);
      gcpGroup.removeLayer(gcpLayers[id].label);
      delete gcpLayers[id];
    });
  }

  /* Векторы невязок: стрелка от фактического положения точки
     к расчётному, увеличенная в выбранное число раз. */
  function renderVectors(s) {
    vectorGroup.clearLayers();
    var k = s.vectorScale;
    if (!k || !s.source || !s.anchor || !s.gcp.length) return;

    GP.gcp.residuals(s).forEach(function (r) {
      if (!r.pair.enabled) return;
      var frame = GP.geo.frame({ lat: r.pair.lat, lon: r.pair.lon });
      var len = Math.hypot(r.dE, r.dN) * k;
      if (len < 0.05) return;
      var tip = frame.toGeodetic(r.dE * k, r.dN * k, 0);
      var head = Math.min(len * 0.28, 14);
      var angle = Math.atan2(r.dE, r.dN);
      var wings = [0.4, -0.4].map(function (turn) {
        var a = angle + Math.PI + turn;
        return frame.toGeodetic(r.dE * k + Math.sin(a) * head,
                                r.dN * k + Math.cos(a) * head, 0);
      });
      var style = {
        color: colors.control, weight: 1.5, interactive: false,
        className: 'gp-vector' + (r.control ? ' is-control' : '')
      };
      L.polyline([[r.pair.lat, r.pair.lon], [tip.lat, tip.lon]], style).addTo(vectorGroup);
      L.polyline([[wings[0].lat, wings[0].lon], [tip.lat, tip.lon],
                  [wings[1].lat, wings[1].lon]], style).addTo(vectorGroup);
    });
  }

  function render() {
    var s = GP.store.state;
    if (!map) return;

    renderReferences(s);
    renderGcp(s);
    renderVectors(s);

    if (!s.source || !s.anchor) { setShown(false); return; }

    ensureLayers();
    setShown(s.visible);
    if (!s.visible) return;

    /* Обработчики вешаются здесь, а не при создании слоя: SVG-элемент
       появляется только после того, как слой добавлен на карту.
       Повторный вызов безопасен — метка стоит на самом элементе. */
    attachDrag(poly.getElement(), onPolyDown);
    attachDrag(handle.getElement(), onHandleDown);

    var frame = GP.transform.frameOf(s);

    poly.setLatLngs(GP.transform.polygonsLatLngs(s));
    poly.setStyle({ fillOpacity: s.fillOpacity });
    renderVertices(s, frame);

    var a = [s.anchor.lat, s.anchor.lon];
    anchorMarker.setLatLng(a);

    /* Положение задано опорными точками — ручку вращения убираем,
       чтобы она не обманывала: тянуть её больше нечем. */
    var locked = GP.gcp.isLocked(s);
    if (locked && group.hasLayer(handle)) { group.removeLayer(handle); group.removeLayer(lever); }
    if (!locked && !group.hasLayer(handle)) { handle.addTo(group); lever.addTo(group); }
    if (locked) return;

    /* Пока ручку тянут, её положение задаёт мышь, а не перерисовка. */
    var h = GP.transform.handleLatLng(s, frame);
    if (!rotating) handle.setLatLng(h);
    lever.setLatLngs([a, rotating ? handle.getLatLng() : h]);

    if (rotating) renderSector(s, frame);
  }

  function scheduleRender() {
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(function () { pendingFrame = false; render(); });
  }

  /* ---------- сектор поворота и отсчёт у курсора ---------- */

  function renderSector(s, frame) {
    var d = GP.transform.handleDistance(s) * 0.55;
    var from = rotateStart, to = s.rotation;
    /* Идём коротким путём, чтобы сектор не оборачивался вокруг. */
    var delta = GP.transform.normalizeAngle(to - from);
    var steps = Math.max(2, Math.ceil(Math.abs(delta) / 3));
    var pts = [[s.anchor.lat, s.anchor.lon]];
    for (var i = 0; i <= steps; i++) {
      var r = (from + delta * (i / steps)) * Math.PI / 180;
      var g = frame.toGeodetic(-d * Math.sin(r), d * Math.cos(r), 0);
      pts.push([g.lat, g.lon]);
    }
    if (!sector) {
      sector = L.polygon(pts, {
        color: colors.control,
        weight: 1,
        fillColor: colors.control,
        fillOpacity: 0.12,
        interactive: false,
        className: 'gp-sector'
      }).addTo(group);
    } else {
      sector.setLatLngs(pts);
      if (!group.hasLayer(sector)) sector.addTo(group);
    }
  }

  function hideSector() {
    if (sector && group.hasLayer(sector)) group.removeLayer(sector);
  }

  function showReadout(containerPoint, text, hint) {
    if (!readout) {
      readout = document.createElement('div');
      readout.className = 'gp-readout mono';
      map.getContainer().appendChild(readout);
    }
    readout.textContent = text;
    if (hint) {
      var el = document.createElement('span');
      el.className = 'gp-readout__hint';
      el.textContent = hint;
      readout.appendChild(el);
    }
    readout.style.transform = 'translate(' + (containerPoint.x + 14) + 'px,' +
                              (containerPoint.y + 14) + 'px)';
    readout.hidden = false;
  }

  function hideReadout() { if (readout) readout.hidden = true; }

  /* ---------- перетаскивание ---------- */

  function attachDrag(el, onDown) {
    if (!el || el.__gpBound) return;
    el.__gpBound = true;
    /* Без touch-action перетаскивание конфликтует с прокруткой
       на тачпадах и планшетах. */
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', onDown);
  }

  function beginCapture(el, ev, onMove, onEnd) {
    el.setPointerCapture(ev.pointerId);
    map.dragging.disable();

    function move(e) { onMove(e); }
    function end(e) {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      try { el.releasePointerCapture(ev.pointerId); } catch (err) { /* уже отпущен */ }
      map.dragging.enable();
      onEnd(e);
    }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function onPolyDown(ev) {
    var s = GP.store.state;
    if (ev.button !== 0 || !s.source || !s.anchor) return;
    /* В режиме расстановки и при заданном точками положении
       контур не таскается. */
    if (GP.gcp.isActive() || GP.gcp.isLocked(s)) return;
    L.DomEvent.stop(ev);
    GP.store.snapshot();

    var start = map.mouseEventToLatLng(ev);
    /* Смещение опорной точки от курсора в ENU держим постоянным:
       контур едет ровно за курсором и ошибка не накапливается. */
    var off = GP.geo.geodeticToEnu(s.anchor.lat, s.anchor.lon,
                                   { lat: start.lat, lon: start.lng }, 0);
    dragOffset = { e: off.e, n: off.n };
    dragging = true;
    document.body.classList.add('is-dragging-geom');

    beginCapture(ev.target, ev, function (e) {
      var ll = map.mouseEventToLatLng(e);
      var g = GP.geo.enuToGeodetic(dragOffset.e, dragOffset.n,
                                   { lat: ll.lat, lon: ll.lng }, 0);
      GP.transform.setAnchor(g.lat, g.lon, 'drag');
      e.preventDefault();
    }, function () {
      dragging = false;
      dragOffset = null;
      document.body.classList.remove('is-dragging-geom');
    });
  }

  function onHandleDown(ev) {
    var s = GP.store.state;
    if (ev.button !== 0 || !s.source || !s.anchor) return;
    if (GP.gcp.isActive() || GP.gcp.isLocked(s)) return;
    L.DomEvent.stop(ev);
    GP.store.snapshot();

    rotating = true;
    rotateStart = s.rotation;
    document.body.classList.add('is-rotating-geom');

    beginCapture(ev.target, ev, function (e) {
      var ll = map.mouseEventToLatLng(e);
      var p = GP.geo.geodeticToEnu(ll.lat, ll.lng, GP.store.state.anchor, 0);
      var deg = GP.transform.rotationFromEnu(p.e, p.n);
      /* По умолчанию вращение свободное, Shift прилипает к кратным 15°.
         Так принято в чертёжных инструментах, и только так можно мерить
         угловую точность: округление до ±7,5° на контуре радиусом 200 м
         уводит дальнюю вершину на 26 м — грубее самой измеряемой величины. */
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      handle.setLatLng(ll);
      GP.transform.setRotation(deg);
      showReadout(map.mouseEventToContainerPoint(e),
                  GP.fmt.deg(GP.store.state.rotation, 2),
                  e.shiftKey ? 'шаг 15°' : 'Shift \u2014 шаг 15°');
      e.preventDefault();
    }, function () {
      rotating = false;
      document.body.classList.remove('is-rotating-geom');
      hideSector();
      hideReadout();
      render();
    });
  }

  /* ---------- режим расстановки опорных точек ---------- */

  function projectLocal(s) {
    var frame = GP.transform.frameOf(s);
    return function (x, y) {
      var ll = GP.transform.vertexLatLng(x, y, s, frame);
      return map.latLngToContainerPoint(L.latLng(ll[0], ll[1]));
    };
  }

  function snapAt(containerPoint) {
    var s = GP.store.state;
    if (!s.source || !s.anchor) return null;
    return GP.gcp.snapToContour(s, projectLocal(s), containerPoint);
  }

  function showSnap(snap) {
    if (!snap) { hideSnap(); return; }
    var s = GP.store.state;
    var ll = GP.transform.vertexLatLng(snap.x, snap.y, s);
    if (!snapMarker) {
      snapMarker = L.circleMarker(ll, {
        radius: 6, weight: 2, color: colors.control, fill: false,
        interactive: false, className: 'gp-snap'
      }).addTo(gcpGroup);
    } else {
      snapMarker.setLatLng(ll);
      if (!gcpGroup.hasLayer(snapMarker)) snapMarker.addTo(gcpGroup);
    }
  }

  function hideSnap() {
    if (snapMarker && gcpGroup.hasLayer(snapMarker)) gcpGroup.removeLayer(snapMarker);
  }

  function showRubber(from, to) {
    if (!rubber) {
      rubber = L.polyline([from, to], {
        color: colors.control, weight: 1.5, dashArray: '4 3',
        interactive: false, className: 'gp-rubber'
      }).addTo(gcpGroup);
    } else {
      rubber.setLatLngs([from, to]);
      if (!gcpGroup.hasLayer(rubber)) rubber.addTo(gcpGroup);
    }
  }

  function hideRubber() {
    if (rubber && gcpGroup.hasLayer(rubber)) gcpGroup.removeLayer(rubber);
  }

  function onMapMove(e) {
    if (!GP.gcp.isActive()) return;
    var s = GP.store.state;
    var pending = GP.gcp.getPending();
    if (!pending) {
      var snap = snapAt(e.containerPoint);
      showSnap(snap);
      /* Индикатор притяжения у курсора: видно, к вершине притянулось
         или к ребру. */
      if (snap) showReadout(e.containerPoint, snap.kind === 'vertex' ? 'вершина' : 'ребро');
      else hideReadout();
      return;
    }
    hideReadout();
    var from = GP.transform.vertexLatLng(pending.x, pending.y, s);
    showRubber(from, [e.latlng.lat, e.latlng.lng]);
  }

  function onMapClick(e) {
    if (!GP.gcp.isActive()) return;
    var native = e.originalEvent;
    if (native && native.__gcpHandled) return;
    if (native) native.__gcpHandled = true;

    var s = GP.store.state;
    if (!s.source || !s.anchor) return;

    var pending = GP.gcp.getPending();
    if (!pending) {
      var snap = snapAt(e.containerPoint);
      if (snap) GP.gcp.setPending(snap);
      return;
    }

    GP.store.snapshot();
    GP.store.addGcp({
      x: pending.x, y: pending.y, kind: pending.kind,
      lat: e.latlng.lat, lon: e.latlng.lng
    });
    GP.gcp.setPending(null);
    hideRubber();
    /* Контур пересчитывается сразу после каждой добавленной пары. */
    GP.gcp.apply();
  }

  /* ---------- вписать в вид ---------- */

  /* Рамка симметрична относительно опорной точки и включает ручку:
     иначе после возврата центра в опорную точку край уезжает за кадр. */
  /* Вписать эталон отдельно: у него нет ни ручки, ни опорной точки,
     поэтому рамка обычная. */
  function fitReference(id, always) {
    var layer = refLayers[id];
    if (!layer || !map) return;
    var bounds = layer.getBounds();
    /* Вид не дёргаем, если эталон и так виден целиком. */
    if (!always && map.getBounds().contains(bounds)) return;
    GP.map.fit(bounds);
  }

  function fitToView() {
    var s = GP.store.state;
    if (!s.source || !s.anchor) return;
    var frame = GP.transform.frameOf(s);
    var pts = s.source.vertices.map(function (v) {
      return GP.transform.vertexLatLng(v.x, v.y, s, frame);
    });
    pts.push(GP.transform.handleLatLng(s, frame));

    var dLat = 0, dLon = 0;
    pts.forEach(function (p) {
      dLat = Math.max(dLat, Math.abs(p[0] - s.anchor.lat));
      dLon = Math.max(dLon, Math.abs(p[1] - s.anchor.lon));
    });
    dLat = dLat || 1e-4;
    dLon = dLon || 1e-4;

    GP.map.fit(L.latLngBounds(
      [s.anchor.lat - dLat, s.anchor.lon - dLon],
      [s.anchor.lat + dLat, s.anchor.lon + dLon]
    ));
  }

  /* ---------- запуск ---------- */

  function init(mapInstance) {
    map = mapInstance;
    group = L.layerGroup();
    refGroup = L.layerGroup().addTo(map);
    gcpGroup = L.layerGroup().addTo(map);
    vectorGroup = L.layerGroup().addTo(map);
    readColors();

    map.on('click', onMapClick);
    map.on('mousemove', onMapMove);

    GP.bus.on('store:change', scheduleRender);
    GP.bus.on('ui:theme', function () { readColors(); restyle(); });
    GP.bus.on('gcp:hover', function (id) {
      if (hovered === id) return;
      hovered = id;
      scheduleRender();
    });
    GP.bus.on('gcp:mode', function (mode) {
      if (!mode.active || !mode.pending) hideRubber();
      if (!mode.active) { hideSnap(); hideReadout(); }
      map.getContainer().classList.toggle('is-gcp-mode', mode.active);
      scheduleRender();
    });
    render();
  }

  return {
    init: init,
    render: render,
    fitToView: fitToView,
    fitReference: fitReference,
    snapAt: snapAt,
    vertexLimit: VERTEX_LIMIT,
    isBusy: function () { return dragging || rotating; },
    /* Доступ к созданным слоям: им пользуются автопроверки, чтобы мерить
       то, что действительно нарисовано, а не пересчитывать состояние. */
    parts: function () {
      return { poly: poly, handle: handle, anchor: anchorMarker, lever: lever, sector: sector };
    },
    handleElementCount: function () {
      return map ? map.getContainer().querySelectorAll('.gp-handle').length : 0;
    }
  };
})();

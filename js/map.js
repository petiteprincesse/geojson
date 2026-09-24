/* js/map.js — карта Leaflet и подложки.
   Источники подложек описаны одним массивом-конфигом: добавить новую —
   значит дописать сюда запись. */

GP.map = (function () {
  /* Ключ Яндекс Tiles API. Свой ключ: https://yandex.ru/maps-api/console,
     продукт «Tiles API». Пустая строка — «Схема Яндекс» видна в списке
     подложек, но неактивна; остальные подложки ключа не требуют.
     Константа внутри модуля, а не глобальная: кроме GP глобальных имён
     у приложения нет. */
  var YANDEX_API_KEY = '3e9ade44-1e19-47a3-8733-874bf3c9e0df';

  /* projection=web_mercator обязателен. По умолчанию Яндекс отдаёт тайлы
     в эллиптическом Меркаторе (EPSG:3395), а Leaflet раскладывает их как
     сферические (EPSG:3857). На широте Москвы это сдвиг около 20 км
     к северу — карта ляжет на чужое место.
     scale=2 на плотных экранах: иначе подписи на ретине расплываются. */
  function yandexUrl(key, pixelRatio) {
    return 'https://tiles.api-maps.yandex.ru/v1/tiles/?apikey=' + encodeURIComponent(key) +
      '&lang=ru_RU&x={x}&y={y}&z={z}&l=map&projection=web_mercator' +
      (pixelRatio > 1 ? '&scale=2' : '');
  }

  var ESRI_ATTR = 'Esri, Maxar, Earthstar Geographics';
  var ESRI_STREET_ATTR = 'Esri, HERE, Garmin, © OpenStreetMap';

  /* Порядок в массиве — порядок в переключателе. */
  var BASEMAPS = [
    {
      id: 'imagery-labels',
      title: 'Снимок с подписями',
      /* по умолчанию: совмещать контур со схемой бесполезно,
         оператору нужны здания и заборы */
      isDefault: true,
      tiles: [
        {
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          options: { maxNativeZoom: 19, maxZoom: 21, attribution: ESRI_ATTR }
        },
        {
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          options: { maxNativeZoom: 19, maxZoom: 21, attribution: '' }
        }
      ]
    },
    {
      id: 'imagery',
      title: 'Космоснимок',
      tiles: [
        {
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          options: { maxNativeZoom: 19, maxZoom: 21, attribution: ESRI_ATTR }
        }
      ]
    },
    {
      id: 'yandex',
      title: 'Схема Яндекс',
      source: 'Яндекс Tiles API',
      needsKey: true,
      keyMissingHint: 'Нужен ключ Tiles API, впишите его в начале js/map.js',
      /* Условия Яндекса: ссылка на Яндекс Карты в углу карты, пока
         подложка активна. Картинку логотипа с их сервера не тянем. */
      logo: { text: 'Яндекс Карты', href: 'https://yandex.ru/maps' },
      /* Отказ Яндекса приходит без картинки, его ловят события тайлов.
         Прямой запрос не нужен: ответ с ошибкой не разрешает чтение
         со страницы и лишь добавил бы ошибку в консоль. */
      probe: false,
      tiles: [
        {
          url: yandexUrl(YANDEX_API_KEY, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
          options: { tileSize: 256, maxNativeZoom: 20, maxZoom: 21, attribution: '© Яндекс' }
        }
      ]
    },
    {
      id: 'street',
      title: 'Схема Esri',
      source: 'Esri World Street Map',
      tiles: [
        {
          /* Тот же хост, что у снимка. Прежний источник OpenStreetMap
             требует заголовок Referer, а по file:// браузер его не шлёт:
             работает только при отдаче страницы по http.
             url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' */
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
          options: { maxNativeZoom: 19, maxZoom: 21, attribution: ESRI_STREET_ATTR }
        }
      ]
    }
    /* CARTO Positron сюда не подходит: без заголовка Referer, то есть
       по file://, сервер отвечает кодом 200, но кладёт на каждый тайл
       водяной знак «API KEY REQUIRED». Такой отказ не видят ни события
       тайлов, ни проверка кода ответа — только глаз.
       url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' */
  ];

  /* Источник для сообщений: у снимков он общий. */
  BASEMAPS.forEach(function (b) { if (!b.source) b.source = 'Esri World Imagery'; });

  /* Подложка с ключом без ключа неактивна, но видна в списке. */
  function isAvailable(cfg, key) {
    if (!cfg || !cfg.needsKey) return true;
    var k = key === undefined ? YANDEX_API_KEY : key;
    return !!(k && String(k).trim());
  }

  /* Ссылка-логотип поставщика в левом нижнем углу канваса. */
  var logoControl = null;

  function setLogo(cfg) {
    if (logoControl) { instance.removeControl(logoControl); logoControl = null; }
    if (!cfg || !cfg.logo || !basemapVisible) return;
    var Logo = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var a = L.DomUtil.create('a', 'map-logo');
        a.href = cfg.logo.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = cfg.logo.text;
        L.DomEvent.disableClickPropagation(a);
        return a;
      }
    });
    logoControl = new Logo();
    logoControl.addTo(instance);
  }

  /* ---------- доступность подложки ----------

     Отказ сервера бывает трёх видов, и ловятся только два. Тайл с кодом ошибки и без картинки
     браузер считает неудачей — это ловят события Leaflet. Но отказ часто
     приходит картинкой с текстом «доступ запрещён», и тогда <img>
     вызывает onload: для Leaflet такой тайл загрузился успешно, а на
     экране чужие картинки с ошибкой. Поэтому при переключении один тайл
     дополнительно запрашивается напрямую — так виден настоящий код ответа.
     Это запрос к удалённому серверу, а не к локальному файлу, и по file://
     он работает: тайловые серверы разрешают чтение с любого адреса.
     Третий вид — код 200 и водяной знак поверх карты — не отличим
     от нормального тайла ничем, кроме взгляда; такие источники
     в конфиг не попадают (см. CARTO выше). */

  var STATUS_DELAY = 3000;
  var watch = null;

  /* Чистая функция, её проверяют автотесты.
     Ориентир — «ни одного успешного тайла», а не «есть хоть одна ошибка»:
     тайлы за краем покрытия и выше родного масштаба не грузятся штатно. */
  function basemapStatus(w, elapsed) {
    if (!w) return 'idle';
    if (w.denied) return 'unavailable';
    if (w.loaded > 0) return 'ok';
    if (elapsed >= STATUS_DELAY && (w.requested > 0 || w.failed > 0)) return 'unavailable';
    return 'pending';
  }

  function report() {
    if (!watch) {
      GP.bus.emit('map:basemap-status', { status: 'idle' });
      return;
    }
    var cfg = findConfig(watch.id);
    GP.bus.emit('map:basemap-status', {
      id: watch.id,
      title: cfg ? cfg.title : '',
      source: cfg ? cfg.source : '',
      status: basemapStatus(watch, Date.now() - watch.started),
      httpStatus: watch.httpStatus
    });
  }

  function stopWatch() {
    if (watch && watch.timer) clearTimeout(watch.timer);
    watch = null;
    report();
  }

  function probe(cfg, w) {
    if (typeof fetch !== 'function' || !instance || cfg.probe === false) return;
    var tile = cfg.tiles[0];
    var z = Math.max(0, Math.min(Math.round(instance.getZoom()), tile.options.maxNativeZoom || 19));
    var p = instance.project(instance.getCenter(), z);
    var subs = tile.options.subdomains || 'abc';
    var url = L.Util.template(tile.url, {
      s: typeof subs === 'string' ? subs.charAt(0) : subs[0],
      x: Math.floor(p.x / 256), y: Math.floor(p.y / 256), z: z, r: ''
    });
    fetch(url, { mode: 'cors' }).then(function (res) {
      if (watch !== w || res.ok) return;
      w.denied = true;
      w.httpStatus = res.status;
      report();
    }).catch(function () {
      /* Сеть недоступна или сервер не разрешает чтение: судить
         по статусу нельзя, остаются события самих тайлов. */
    });
  }

  function startWatch(cfg) {
    if (watch && watch.timer) clearTimeout(watch.timer);
    var w = {
      id: cfg.id, loaded: 0, failed: 0, requested: 0,
      denied: false, httpStatus: null, started: Date.now(), timer: null
    };
    watch = w;
    w.timer = setTimeout(function () { if (watch === w) report(); }, STATUS_DELAY);
    probe(cfg, w);
    report();
  }

  function trackLayer(layer, id) {
    layer.on('tileloadstart', function () {
      if (watch && watch.id === id) watch.requested++;
    });
    layer.on('tileload', function () {
      /* Отказ, нарисованный картинкой, успехом не считается. */
      if (!watch || watch.id !== id || watch.denied) return;
      watch.loaded++;
      if (watch.loaded === 1) report();
    });
    layer.on('tileerror', function () {
      if (watch && watch.id === id) watch.failed++;
    });
  }

  var instance = null;
  var activeId = null;
  var activeLayers = [];
  var basemapVisible = true;

  /* Отступы канваса из CSS-переменных: панели и служебные наложения.
     Их учитывают центрирование и вписывание, иначе объекты уезжают
     под панели. */
  function insets() {
    var cs = getComputedStyle(document.documentElement);
    function px(name) {
      var v = parseFloat(cs.getPropertyValue(name));
      return isFinite(v) ? v : 0;
    }
    return {
      left: px('--canvas-inset-left'),
      right: px('--canvas-inset-right'),
      top: px('--canvas-inset-top'),
      bottom: px('--canvas-inset-bottom')
    };
  }

  function findConfig(id) {
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].id === id) return BASEMAPS[i];
    }
    return null;
  }

  function setBasemap(id) {
    var cfg = findConfig(id);
    if (!cfg || !instance || id === activeId || !isAvailable(cfg)) return;

    for (var j = 0; j < activeLayers.length; j++) instance.removeLayer(activeLayers[j]);
    activeLayers = [];

    for (var k = 0; k < cfg.tiles.length; k++) {
      var t = cfg.tiles[k];
      var layer = L.tileLayer(t.url, t.options);
      trackLayer(layer, id);
      if (basemapVisible) layer.addTo(instance);
      activeLayers.push(layer);
    }
    activeId = id;
    setLogo(cfg);
    GP.bus.emit('map:basemap', id);
    if (basemapVisible) startWatch(cfg); else stopWatch();
  }

  /* Метры на пиксель в центре вида — измеряются по самой карте,
     поэтому верны на любой широте. */
  function metersPerPixel() {
    if (!instance) return NaN;
    var p = instance.latLngToContainerPoint(instance.getCenter());
    var a = instance.containerPointToLatLng(p);
    var b = instance.containerPointToLatLng(L.point(p.x + 1, p.y));
    return a.distanceTo(b);
  }

  /* Знаменатель именованного масштаба при пикселе 0,28 мм (OGC). */
  function scaleDenominator() {
    var m = metersPerPixel();
    return isFinite(m) ? m / 0.00028 : NaN;
  }

  /* Вписать границы с учётом отступов канваса. */
  function fit(bounds, options) {
    if (!instance || !bounds) return;
    var ins = insets();
    var pad = 16;
    instance.fitBounds(bounds, Object.assign({
      paddingTopLeft: L.point(ins.left + pad, ins.top + pad),
      paddingBottomRight: L.point(ins.right + pad, ins.bottom + pad)
    }, options || {}));
  }

  /* Поставить точку в центр свободной части канваса. */
  function center(latlng, zoom) {
    if (!instance) return;
    var ins = insets();
    var z = (zoom === undefined) ? instance.getZoom() : zoom;
    var p = instance.project(latlng, z);
    p.x += (ins.right - ins.left) / 2;
    p.y += (ins.bottom - ins.top) / 2;
    instance.setView(instance.unproject(p, z), z);
  }

  function setVisible(v) {
    basemapVisible = !!v;
    if (!instance) return;
    activeLayers.forEach(function (layer) {
      if (basemapVisible) layer.addTo(instance);
      else instance.removeLayer(layer);
    });
    /* Скрытая подложка ничего не грузит — тревожиться не о чем. */
    var cfg = findConfig(activeId);
    setLogo(cfg);
    if (basemapVisible && cfg) startWatch(cfg); else stopWatch();
  }

  function title(id) {
    var cfg = findConfig(id);
    return cfg ? cfg.title : '';
  }

  function init(elementId) {
    instance = L.map(elementId, {
      center: [55.751244, 37.618423],
      zoom: 13,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true
    });

    var def = BASEMAPS[0];
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].isDefault) def = BASEMAPS[i];
    }
    setBasemap(def.id);

    instance.on('mousemove', function (e) {
      GP.bus.emit('map:cursor', e.latlng);
    });
    instance.on('mouseout', function () {
      GP.bus.emit('map:cursor', null);
    });
    instance.on('move zoom moveend zoomend', function () {
      GP.bus.emit('map:view', {
        metersPerPixel: metersPerPixel(),
        scaleDenominator: scaleDenominator(),
        zoom: instance.getZoom()
      });
    });

    GP.bus.emit('map:view', {
      metersPerPixel: metersPerPixel(),
      scaleDenominator: scaleDenominator(),
      zoom: instance.getZoom()
    });

    return instance;
  }

  return {
    BASEMAPS: BASEMAPS,
    init: init,
    setBasemap: setBasemap,
    setVisible: setVisible,
    basemapStatus: basemapStatus,
    STATUS_DELAY: STATUS_DELAY,
    isAvailable: isAvailable,
    yandexUrl: yandexUrl,
    title: title,
    getBasemap: function () { return activeId; },
    getInstance: function () { return instance; },
    insets: insets,
    metersPerPixel: metersPerPixel,
    scaleDenominator: scaleDenominator,
    fit: fit,
    center: center,
    invalidateSize: function () { if (instance) instance.invalidateSize({ animate: false }); }
  };
})();

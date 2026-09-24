/* js/ui.js — панели, список слоёв, сводка привязки, статусбар, клавиатура.
   Никаких эмодзи: иконки — встроенный SVG, цвет наследуется от кнопки. */

GP.ui = (function () {
  var THEME_KEY = 'gp.theme';

  var ICONS = {
    chevronLeft: '<path d="M10 3 5 8l5 5"/>',
    sun: '<circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15' +
         'M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13"/>',
    moon: '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z"/>',
    undo: '<path d="M3.5 7.5h6.2a3.3 3.3 0 0 1 0 6.6H6.2"/><path d="M6 4.5 3 7.5l3 3"/>',
    redo: '<path d="M12.5 7.5H6.3a3.3 3.3 0 0 0 0 6.6h3.5"/><path d="M10 4.5l3 3-3 3"/>',
    fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>' +
         '<rect x="5.5" y="5.5" width="5" height="5"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.2h5.6l.7-8.2"/>' +
           '<path d="M6.8 7v3.4M9.2 7v3.4"/>'
  };

  function icon(name, extraClass) {
    return '<svg class="icon' + (extraClass ? ' ' + extraClass : '') + '" viewBox="0 0 16 16" ' +
           'fill="none" stroke="currentColor" stroke-width="1.3" ' +
           'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
           ICONS[name] + '</svg>';
  }

  function $(id) { return document.getElementById(id); }

  /* ---------- тема ---------- */

  function readStoredTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function storeTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* file:// без хранилища */ }
  }

  function applyTheme(theme) {
    var dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var btn = $('theme-toggle');
    if (btn) {
      btn.innerHTML = icon(dark ? 'sun' : 'moon');
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
      btn.classList.toggle('is-on', dark);
    }
    GP.bus.emit('ui:theme', dark ? 'dark' : 'light');
  }

  function initTheme() {
    applyTheme(readStoredTheme() === 'dark' ? 'dark' : 'light');
    $('theme-toggle').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      storeTheme(next);
    });
  }

  /* ---------- подложки ---------- */

  function initBasemaps() {
    var box = $('basemap-switch');
    GP.map.BASEMAPS.forEach(function (cfg) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg__item';
      b.textContent = cfg.title;
      b.dataset.basemap = cfg.id;
      b.setAttribute('aria-pressed', 'false');

      /* Подложка без ключа видна, но неактивна. Не disabled, а
         aria-disabled: кнопка остаётся в порядке обхода с клавиатуры,
         подсказка при наведении работает, а нажатие объясняет причину. */
      if (!GP.map.isAvailable(cfg)) {
        b.setAttribute('aria-disabled', 'true');
        b.title = cfg.keyMissingHint;
      }

      b.addEventListener('click', function () {
        if (!GP.map.isAvailable(cfg)) {
          var note = $('basemap-status');
          note.textContent = 'Подложка «' + cfg.title + '» неактивна. ' + cfg.keyMissingHint + '.';
          note.hidden = false;
          return;
        }
        GP.map.setBasemap(cfg.id);
      });
      box.appendChild(b);
    });

    GP.bus.on('map:basemap', function (id) {
      Array.prototype.forEach.call(box.children, function (b) {
        b.setAttribute('aria-pressed', b.dataset.basemap === id ? 'true' : 'false');
      });
      $('basemap-name').textContent = GP.map.title(id);
      /* Логотип поставщика появился или пропал — нижний отступ канваса
         меняется вместе с ним. */
      updateInsets();
    });

    $('basemap-visible').addEventListener('change', function (e) {
      GP.map.setVisible(e.target.checked);
    });

    /* Подложка недоступна — говорим об этом словами, иначе пользователь
       видит пустую карту или чужие картинки с текстом ошибки и не
       понимает, что сломалось. Строка исчезает, как только тайлы пошли. */
    GP.bus.on('map:basemap-status', function (st) {
      var box = $('basemap-status');
      if (st.status !== 'unavailable') { box.hidden = true; return; }
      box.textContent = 'Подложка недоступна: «' + st.title + '», источник ' + st.source + '. ' +
        (st.httpStatus
          ? 'Сервер отказал в доступе, код ответа ' + st.httpStatus + '.'
          : 'За ' + GP.fmt.num(GP.map.STATUS_DELAY / 1000, 0) +
            '\u00A0секунды не загрузился ни один тайл.') +
        ' Попробуйте другую подложку.';
      box.hidden = false;
    });
  }

  /* ---------- отступы канваса ----------
     Панели фиксированные, но канвас перекрывают ещё и элементы управления
     картой. Считаем перекрытие по фактическим прямоугольникам: центрирование
     и вписывание должны учитывать всё, что лежит поверх карты. */

  function overlap(el, box, side) {
    if (!el) return 0;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    if (r.right <= box.left || r.left >= box.right) return 0;
    if (r.bottom <= box.top || r.top >= box.bottom) return 0;
    if (side === 'left') return Math.max(0, Math.min(r.right, box.right) - box.left);
    if (side === 'right') return Math.max(0, box.right - Math.max(r.left, box.left));
    if (side === 'top') return Math.max(0, Math.min(r.bottom, box.bottom) - box.top);
    return Math.max(0, box.bottom - Math.max(r.top, box.top));
  }

  function updateInsets() {
    var canvas = $('canvas');
    if (!canvas) return;
    var box = canvas.getBoundingClientRect();
    var root = document.documentElement;

    var zoomCtl = document.querySelector('.leaflet-control-zoom');
    var attr = document.querySelector('.leaflet-control-attribution');

    var left = Math.max(
      overlap($('panel-left'), box, 'left'),
      overlap(zoomCtl, box, 'left')
    );
    /* Атрибуция занимает только нижнюю полосу, поэтому идёт в bottom,
       а не в right: иначе правый отступ съел бы четверть канваса. */
    var right = overlap($('panel-right'), box, 'right');
    /* Сверху канвас ничем не перекрыт: панель инструментов лежит вне его. */
    var top = 0;
    var logo = document.querySelector('.map-logo');
    var bottom = Math.max(overlap(attr, box, 'bottom'), overlap(logo, box, 'bottom'));

    root.style.setProperty('--canvas-inset-left', Math.round(left) + 'px');
    root.style.setProperty('--canvas-inset-right', Math.round(right) + 'px');
    root.style.setProperty('--canvas-inset-top', Math.round(top) + 'px');
    root.style.setProperty('--canvas-inset-bottom', Math.round(bottom) + 'px');
  }

  /* ---------- панели ---------- */

  function setCollapsed(panel, btn, collapsed, title) {
    panel.classList.toggle('is-collapsed', collapsed);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', (collapsed ? 'Развернуть панель «' : 'Свернуть панель «') + title + '»');
    afterLayoutChange();
  }

  function afterLayoutChange() {
    /* Сначала карта узнаёт новый размер контейнера, затем пересчитываются
       отступы канваса. */
    GP.map.invalidateSize();
    updateInsets();
  }

  function initPanels() {
    var pairs = [
      { panel: $('panel-left'), btn: $('collapse-left'), title: 'Проект' },
      { panel: $('panel-right'), btn: $('collapse-right'), title: 'Привязка' }
    ];

    pairs.forEach(function (p) {
      p.btn.innerHTML = icon('chevronLeft', 'icon--chevron');
      p.btn.addEventListener('click', function () {
        setCollapsed(p.panel, p.btn, !p.panel.classList.contains('is-collapsed'), p.title);
      });
    });

    var hideBtn = $('toggle-panels');
    hideBtn.addEventListener('click', function () {
      var hidden = !$('app').classList.contains('is-panels-hidden');
      $('app').classList.toggle('is-panels-hidden', hidden);
      hideBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      hideBtn.textContent = hidden ? 'Показать панели' : 'Скрыть панели';
      afterLayoutChange();
    });

    window.addEventListener('resize', updateInsets);
  }

  /* ---------- статусбар ---------- */

  function initStatusbar() {
    var cursor = $('st-cursor');
    var scale = $('st-scale');
    var mpp = $('st-mpp');

    GP.bus.on('map:cursor', function (latlng) {
      if (!latlng) {
        cursor.textContent = GP.fmt.DASH;
        cursor.classList.add('is-empty');
        return;
      }
      cursor.textContent = GP.fmt.latlon(latlng.lat, latlng.lng, 6);
      cursor.classList.remove('is-empty');
    });

    GP.bus.on('map:view', function (view) {
      scale.textContent = GP.fmt.scale(view.scaleDenominator);
      mpp.textContent = GP.fmt.mpp(view.metersPerPixel);
    });
  }

  /* ---------- диалог ---------- */

  var dialogAction = null;
  var dialogCancel = null;

  function isDialogOpen() { return !$('dialog').hidden; }

  function openDialog(opts) {
    $('dialog-title').textContent = opts.title;
    $('dialog-text').textContent = opts.text;
    $('dialog-confirm').textContent = opts.confirm;
    dialogAction = opts.onConfirm || null;
    dialogCancel = opts.onCancel || null;
    $('dialog').hidden = false;
    $('dialog-confirm').focus();
  }

  function closeDialog() {
    $('dialog').hidden = true;
    dialogAction = null;
    dialogCancel = null;
  }

  function cancelDialog() {
    var run = dialogCancel;
    closeDialog();
    if (run) run();
  }

  function initDialog() {
    $('dialog-confirm').addEventListener('click', function () {
      var run = dialogAction;
      closeDialog();
      if (run) run();
    });
    $('dialog-cancel').addEventListener('click', cancelDialog);
    $('dialog').addEventListener('mousedown', function (e) {
      if (e.target === $('dialog')) cancelDialog();
    });
    /* Пока диалог открыт, фокус ходит только по его кнопкам. */
    $('dialog').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { cancelDialog(); e.preventDefault(); return; }
      if (e.key !== 'Tab') return;
      var first = $('dialog-cancel'), last = $('dialog-confirm');
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });
  }

  /* «2026-09-23T23:35:37 UTC+03:00» → «23.09.2026 в 23:35» */
  /* Секунды обязательны: JSON и geojson одной привязки различаются
     только ими, а по минутам выглядят одинаково. */
  function formatCreated(created) {
    if (!created) return 'неизвестной даты';
    var m = String(created).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return String(created);
    return m[3] + '.' + m[2] + '.' + m[1] + ' в ' + m[4] + ':' + m[5] + ':' + m[6];
  }

  /* Многоточие ставится посередине: у выгрузок одной привязки
     различаются начало и конец имени, а середина одинаковая. */
  function shortName(name, max) {
    var limit = max || 30;
    var text = String(name);
    if (text.length <= limit) return text;
    var head = Math.ceil((limit - 1) / 2);
    var tail = limit - 1 - head;
    return text.slice(0, head) + '\u2026' + text.slice(text.length - tail);
  }

  /* ---------- загрузка файла ---------- */

  function showMessage(text, level) {
    var box = $('load-error');
    box.textContent = text;
    box.className = 'msg msg--' + (level || 'danger');
    box.hidden = !text;
  }

  function showError(text) { showMessage(text, 'danger'); }

  function loadSource(source) {
    var c = GP.map.getInstance().getCenter();
    GP.store.load(source, { lat: c.lat, lon: c.lng });
    GP.layers.fitToView();
  }

  /* ---------- пачка файлов ----------
     Для замера это основной сценарий: человек тащит две-три выгрузки
     разом. Каждый файл классифицируется отдельно, диалог — один на всю
     пачку, итог — одной строкой: что загружено, что пропущено и почему. */

  var SHORT_REASON = {
    'not-json': 'не разбирается как JSON',
    'no-polygons': 'в файле нет полигонов',
    'no-numbers': 'координаты вершин не числовые',
    'no-rings': 'нет замкнутых колец',
    'read': 'файл не удалось прочитать'
  };

  /* Пользовательские файлы читаются только через FileReader:
     по file:// сетевые запросы к локальным файлам не работают. */
  function readText(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ name: file.name, text: String(reader.result) }); };
      reader.onerror = function () { resolve({ name: file.name, error: 'read' }); };
      reader.readAsText(file);
    });
  }

  function classify(item) {
    if (item.error) {
      return { name: item.name, kind: 'error', code: item.error,
               message: 'Файл не удалось прочитать. Попробуйте открыть его заново.' };
    }
    var read;
    try {
      read = GP.store.read(item.text);
    } catch (e) {
      return { name: item.name, kind: 'error', code: e.code, message: e.message };
    }
    /* Собственная выгрузка — это градусы, а не метры местной системы.
       Читать её как исходный контур бессмысленно: получится участок
       в полсантиметра. */
    if (read.result) {
      return { name: item.name, kind: 'result', obj: read.obj, found: read.result };
    }
    try {
      return { name: item.name, kind: 'source', source: GP.store.build(read.obj, item.name) };
    } catch (e) {
      return { name: item.name, kind: 'error', code: e.code, message: e.message };
    }
  }

  function quote(name) { return '«' + shortName(name, 34) + '»'; }

  function reportBatch(report) {
    var parts = [];
    if (report.loaded.length) parts.push('Загружено: ' + report.loaded.join(', ') + '.');
    if (report.skipped.length) parts.push('Пропущено: ' + report.skipped.join('; ') + '.');
    if (!parts.length) return;
    showMessage(parts.join(' '), report.skipped.length ? 'warning' : 'info');
  }

  function addReferences(results, report) {
    var added = null;
    results.forEach(function (r) {
      var ref;
      try {
        ref = GP.store.buildReference(r.obj, r.name);
      } catch (e) {
        report.skipped.push(quote(r.name) + ' \u2014 ' + e.message.replace(/\.$/, '').toLowerCase());
        return;
      }
      /* Одна и та же привязка выгружается в JSON и geojson: в списке
         они выглядят одинаково, поэтому дубль не добавляется. */
      var same = GP.store.findSameReference(ref);
      if (same) {
        report.skipped.push(quote(r.name) + ' \u2014 эта привязка уже загружена как эталон ' +
                            quote(same.name));
        return;
      }
      GP.store.addReference(ref);
      report.loaded.push('эталон ' + quote(r.name));
      added = added || ref;
    });
    if (added) GP.layers.fitReference(added.id);
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    showMessage('');

    Promise.all(files.map(readText)).then(function (items) {
      var parsed = items.map(classify);

      /* Один файл с ошибкой — полное объяснение, как и раньше. */
      if (parsed.length === 1 && parsed[0].kind === 'error') {
        showError(parsed[0].message);
        return;
      }

      var sources = parsed.filter(function (p) { return p.kind === 'source'; });
      var results = parsed.filter(function (p) { return p.kind === 'result'; });
      var errors = parsed.filter(function (p) { return p.kind === 'error'; });
      var report = { loaded: [], skipped: [] };

      if (sources.length) {
        loadSource(sources[0].source);
        report.loaded.push('контур ' + quote(sources[0].name));
        sources.slice(1).forEach(function (p) {
          report.skipped.push(quote(p.name) + ' \u2014 в пачке несколько исходных контуров, взят первый, ' +
                              quote(sources[0].name));
        });
      }
      errors.forEach(function (p) {
        report.skipped.push(quote(p.name) + ' \u2014 ' + (SHORT_REASON[p.code] || p.message));
      });

      /* Один файл и ничего не пропущено — отчёт не нужен. */
      var quiet = files.length === 1;

      if (!results.length) {
        if (!quiet) reportBatch(report);
        return;
      }

      var text;
      if (files.length === 1) {
        text = 'Это результат привязки от ' + formatCreated(results[0].found.created) +
               ', а не исходный контур. Открыть его как эталонный слой?';
      } else {
        text = 'Файлов: ' + files.length + '. Результатов привязки: ' + results.length +
               ', контуров: ' + sources.length +
               (errors.length ? ', не распознано: ' + errors.length : '') + '. ' +
               (results.length > 1
                 ? 'Открыть результаты привязки как эталонные слои?'
                 : 'Открыть результат привязки как эталонный слой?');
      }

      openDialog({
        title: results.length > 1 ? 'Результаты привязки' : 'Это результат привязки',
        text: text,
        confirm: 'Открыть как эталон',
        onConfirm: function () {
          addReferences(results, report);
          if (!quiet || report.skipped.length) reportBatch(report);
        },
        onCancel: function () {
          results.forEach(function (r) {
            report.skipped.push(quote(r.name) + ' \u2014 открытие эталоном отменено');
          });
          if (!quiet) reportBatch(report);
        }
      });
    });
  }

  function initLoading() {
    var input = $('file-input');
    $('pick-file').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      handleFiles(input.files);
      input.value = '';
    });

    $('load-sample').addEventListener('click', function () {
      showMessage('');
      loadSource(GP.store.build(GP.sample.geojson, GP.sample.name));
    });

    var zone = $('dropzone');
    var depth = 0;

    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      depth++;
      zone.hidden = false;
      e.preventDefault();
    });
    window.addEventListener('dragover', function (e) {
      if (!zone.hidden) e.preventDefault();
    });
    window.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      depth = 0;
      zone.hidden = true;
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      /* Все файлы пачки, а не только первый. */
      handleFiles(e.dataTransfer.files);
    });
  }

  /* ---------- список слоёв и диагностика ---------- */

  function row(term, value, title) {
    return '<div class="readout__row"><dt' +
           (title ? ' title="' + title + '"' : '') + '>' + term + '</dt>' +
           '<dd class="mono">' + value + '</dd></div>';
  }

  function renderDiagnostics(source) {
    var box = $('diag');
    if (!source) { box.hidden = true; return; }
    box.hidden = false;

    var b = source.bbox;
    $('diag-stats').innerHTML =
      row('Полигонов', GP.fmt.num(source.counts.polygons, 0)) +
      row('Колец', GP.fmt.num(source.counts.rings, 0)) +
      row('Вершин', GP.fmt.num(source.counts.vertices, 0)) +
      row('Габарит', 'Ширина ' + GP.fmt.len(b.width, 1) +
                     ', высота ' + GP.fmt.len(b.height, 1));

    var warnings = GP.store.diagnose(source);
    $('diag-warnings').innerHTML = warnings.map(function (w) {
      return '<p class="msg msg--' + w.level + '">' + w.text + '</p>';
    }).join('');
  }

  /* Подсказка про миллиметры: показывается, пока пользователь сам
     не выбирал единицы. Тон — вопрос: по габариту единицы не определить. */
  function renderUnitsHint(s) {
    var box = $('units-hint');
    var hint = s.source && !s.unitsConfirmed && s.scale === 1 && !GP.gcp.isLocked(s)
      ? GP.store.millimetreHint(s.source) : null;
    box.hidden = !hint;
    if (!hint) return;
    $('units-hint-text').textContent = 'Габарит ' + GP.fmt.len(hint.side, 1) +
      '. Если файл в миллиметрах, реальный размер ' + GP.fmt.num(hint.mmWidth, 1) +
      ' \u00D7 ' + GP.fmt.len(hint.mmHeight, 1) + '.';
  }

  function renderLayerRow(s) {
    var rowEl = $('row-layer');
    rowEl.hidden = !s.source;
    $('left-empty').hidden = !!(s.source || s.references.length);
    renderReferenceRows(s);
    if (!s.source) return;

    $('layer-name').textContent = s.source.name;
    $('layer-name').title = s.source.name;
    $('layer-count').textContent = GP.fmt.num(s.source.counts.vertices, 0) + ' верш.';
    if ($('layer-visible').checked !== s.visible) $('layer-visible').checked = s.visible;

    var percent = Math.round(s.fillOpacity * 100);
    if (document.activeElement !== $('layer-opacity')) $('layer-opacity').value = percent;
    $('layer-opacity-value').textContent = GP.fmt.num(percent, 0) + ' %';
  }

  var referenceSignature = '';

  function renderReferenceRows(s) {
    /* Перерисовка идёт на каждое движение мыши при перетаскивании,
       поэтому строки пересобираются только когда набор эталонов
       действительно изменился. */
    var sig = s.references.map(function (r) {
      return r.id + ':' + (r.visible ? 1 : 0) + ':' + r.name;
    }).join('|');
    if (sig === referenceSignature) return;
    referenceSignature = sig;

    var list = $('layers');
    Array.prototype.slice.call(list.querySelectorAll('.layer--reference, .layer--group'))
      .forEach(function (el) { el.remove(); });

    /* Заголовок группы: перед чтением второй серии замера эталоны
       первой убираются одним нажатием. Без подтверждения — эталон
       всегда можно загрузить заново из файла. */
    if (s.references.length) {
      var head = document.createElement('li');
      head.className = 'layer layer--group';
      head.innerHTML =
        '<div class="layer__line">' +
          '<span class="layer__group-title">Эталоны</span>' +
          '<span class="layer__meta num">' + GP.fmt.num(s.references.length, 0) + '</span>' +
          (s.references.length > 1
            ? '<button type="button" class="btn btn--compact" data-act="remove-all">' +
              'Удалить все эталоны</button>'
            : '') +
        '</div>';
      var all = head.querySelector('[data-act="remove-all"]');
      if (all) all.addEventListener('click', function () { GP.store.clearReferences(); });
      list.appendChild(head);
    }

    s.references.forEach(function (ref) {
      var li = document.createElement('li');
      li.className = 'layer layer--reference';
      li.dataset.ref = ref.id;
      li.innerHTML =
        '<div class="layer__line">' +
          '<input type="checkbox" class="check"' + (ref.visible ? ' checked' : '') +
            ' aria-label="Показывать эталон «' + ref.name + '»">' +
          '<span class="layer__name" title="' + ref.name + '">' + shortName(ref.name, 26) + '</span>' +
          '<span class="layer__badge">эталон</span>' +
          '<button type="button" class="btn btn--icon" data-act="fit" ' +
            'aria-label="Вписать эталон «' + ref.name + '» в вид">' + icon('fit') + '</button>' +
          '<button type="button" class="btn btn--icon" data-act="remove" ' +
            'aria-label="Удалить эталон «' + ref.name + '»" title="Удалить эталон">' +
            icon('trash') + '</button>' +
        '</div>' +
        '<div class="layer__line layer__line--sub">' +
          '<span class="layer__sub">Привязан ' + formatCreated(ref.created) + '</span>' +
        '</div>';

      li.querySelector('.check').addEventListener('change', function (e) {
        GP.store.setReferenceVisible(ref.id, e.target.checked);
      });
      li.querySelector('[data-act="fit"]').addEventListener('click', function () {
        GP.layers.fitReference(ref.id, true);
      });
      li.querySelector('[data-act="remove"]').addEventListener('click', function () {
        GP.store.removeReference(ref.id);
      });
      list.appendChild(li);
    });
  }

  /* ---------- сравнение с эталонами ---------- */

  /* Относительная разница масштаба: мелкие значения геодезисты читают
     в миллионных долях, крупные — в процентах. */
  function formatRelative(rel) {
    if (!isFinite(rel)) return GP.fmt.DASH;
    if (rel === 0) return '0';
    var sign = rel > 0 ? '+' : '';
    if (Math.abs(rel) < 1e-3) {
      var ppm = rel * 1e6;
      return sign + GP.fmt.num(ppm, Math.abs(ppm) < 10 ? 2 : 0) + '\u00A0млн\u207B\u00B9';
    }
    return sign + GP.fmt.num(rel * 100, 2) + '\u00A0%';
  }

  function renderCompare(s) {
    var box = $('compare');
    box.hidden = !s.references.length;
    if (!s.references.length) return;

    var html = '';
    var bound = !!(s.source && s.anchor);

    if (!bound) {
      html += '<p class="hint">Текущая привязка не задана: загрузите контур, ' +
        'чтобы увидеть расхождение с эталонами.</p>';
    }

    s.references.forEach(function (ref, i) {
      html += '<div class="compare__item">' +
        '<p class="compare__name" title="' + ref.name + '">' +
        'Эталон ' + (i + 1) + ' \u00B7 ' + shortName(ref.name, 26) + '</p>' +
        '<p class="compare__date">Привязан ' + formatCreated(ref.created) + '</p>';
      if (bound) {
        var c = GP.transform.compare(s, ref);
        html += '<dl class="readout">' +
          row('Сдвиг опорной точки', GP.fmt.len(c.shift),
              'расстояние между опорными точками по геодезической линии') +
          /* Три знака: на площадке 300 м сотые доли градуса — это уже
             десятки сантиметров на краю контура. */
          row('Разница поворота', GP.fmt.deg(c.rotation, 3),
              'текущая привязка относительно эталонной, по кратчайшей дуге') +
          row('Разница масштаба', formatRelative(c.scaleRel),
              'текущая привязка относительно эталонной') +
          '</dl>';
      }
      html += '</div>';
    });

    if (s.references.length > 1) {
      var bindings = s.references.map(function (r) {
        return { anchor: r.anchor, rotation: r.rotation };
      });
      if (bound) bindings.push({ anchor: s.anchor, rotation: s.rotation });
      var sp = GP.transform.spread(bindings);
      html += '<div class="compare__spread"><dl class="readout">' +
        row('Разброс по положению', GP.fmt.len(sp.shift),
            'наибольшее расстояние между опорными точками привязок') +
        row('Разброс по повороту', GP.fmt.deg(sp.rotation, 3),
            'наибольшая попарная разница поворотов, по кратчайшей дуге') +
        '</dl><p class="field__hint">Максимальное попарное расхождение ' +
        'между ' + GP.fmt.num(sp.count, 0) + ' привязками' +
        (bound ? ', включая текущую' : '') + '.</p></div>';
    }

    $('compare-body').innerHTML = html;
  }

  /* ---------- опорные точки ---------- */

  var hotGcp = null;
  var gcpPanelShown = false;

  function light(verdict) {
    return '<span class="light light--' + verdict + '" aria-hidden="true"></span>';
  }

  function renderGcpMode(mode) {
    var btn = $('gcp-mode');
    btn.setAttribute('aria-pressed', mode.active ? 'true' : 'false');
    btn.classList.toggle('btn--primary', mode.active);
    btn.textContent = mode.active ? 'Выйти из режима' : 'Опорные точки';

    var hint = $('gcp-hint');
    hint.hidden = !mode.active;
    if (mode.active) {
      hint.textContent = mode.pending
        ? 'Теперь укажите на карте, куда эта точка должна попасть. ' +
          'Escape отменяет незавершённую пару.'
        : 'Кликните по контуру: точка притянется к вершине, если она ближе ' +
          GP.fmt.num(GP.gcp.SNAP_PX, 0) + ' пикселей, иначе встанет на ребро. ' +
          'Escape выходит из режима.';
    }
    renderGcpPanelVisibility(GP.store.state);
  }

  function renderGcpPanelVisibility(s) {
    var show = !!(s.gcp.length || GP.gcp.isActive());
    if (show === gcpPanelShown) return;
    gcpPanelShown = show;
    $('gcp-panel').hidden = !show;
    afterLayoutChange();
  }

  function gcpRowHtml(r, st) {
    var p = r.pair;
    var cls = [];
    if (!p.enabled) cls.push('is-off');
    if (p.control) cls.push('is-control');
    if (GP.gcp.isOutlier(r, st)) cls.push('is-outlier');
    if (hotGcp === p.id) cls.push('is-hot');

    return '<tr data-id="' + p.id + '" class="' + cls.join(' ') + '">' +
      '<td><input type="checkbox" class="check" data-act="enabled"' +
        (p.enabled ? ' checked' : '') +
        ' aria-label="Учитывать точку ' + p.n + '"></td>' +
      '<td class="num">' + p.n + '</td>' +
      '<td class="num">' + GP.fmt.num(p.x, 2) + '</td>' +
      '<td class="num">' + GP.fmt.num(p.y, 2) + '</td>' +
      '<td class="num">' + GP.fmt.num(p.lon, 6) + '</td>' +
      '<td class="num">' + GP.fmt.num(p.lat, 6) + '</td>' +
      '<td class="num">' + GP.fmt.num(r.dN, 3) + '</td>' +
      '<td class="num">' + GP.fmt.num(r.dE, 3) + '</td>' +
      '<td class="num grid__ds">' + GP.fmt.num(r.dS, 3) + '</td>' +
      '<td><input type="checkbox" class="check" data-act="control"' +
        (p.control ? ' checked' : '') +
        ' aria-label="Контрольная точка ' + p.n + '"></td>' +
      '<td><button type="button" class="btn btn--icon" data-act="remove" ' +
        'aria-label="Удалить опорную точку ' + p.n + '">' + icon('trash') + '</button></td>' +
      '</tr>';
  }

  function renderHandoff(s) {
    var h = s.handoff;
    $('gcp-handoff').hidden = !h;
    if (!h) return;
    $('gcp-handoff-text').textContent = 'Положение пересчитано по ' + GP.fmt.num(h.count, 0) +
      ' опорным точкам, ручное совмещение отброшено: опорная точка сдвинулась на ' +
      GP.fmt.len(h.shift) + ', поворот изменился на ' + GP.fmt.deg(h.rotationChange, 2) + '.';
    var big = $('gcp-handoff-big');
    big.hidden = !h.big;
    if (h.big) {
      big.textContent = 'Большое смещение — проверьте, что точки пары соответствуют ' +
        'друг другу: сдвиг ' + GP.fmt.len(h.shift) + ' больше габарита контура.';
    }
  }

  function renderGcp(s) {
    renderGcpPanelVisibility(s);
    renderHandoff(s);
    $('gcp-lock').hidden = !GP.gcp.isLocked(s);

    if (!s.source) {
      $('gcp-stats').innerHTML = '';
      $('gcp-rows').innerHTML = '';
      return;
    }

    var st = GP.gcp.stats(s);

    /* Сортировка по модулю невязки: сомнительные точки наверху. */
    var rows = st.rows.slice().sort(function (a, b) { return b.dS - a.dS; });
    $('gcp-rows').innerHTML = rows.map(function (r) { return gcpRowHtml(r, st); }).join('');
    $('gcp-empty').hidden = rows.length > 0;

    var counts = GP.fmt.num(st.usedCount, 0) + ' учтено';
    if (st.controlCount) counts += ' \u00B7 ' + GP.fmt.num(st.controlCount, 0) + ' контрольных';
    if (st.disabledCount) counts += ' \u00B7 ' + GP.fmt.num(st.disabledCount, 0) + ' выключено';

    var html = row('Точек', counts);
    if (st.usedCount >= 2) {
      html += row('Невязка RMS', light(st.verdict) + GP.fmt.len(st.rms, 3) +
                  ' \u00B7 ' + GP.gcp.VERDICT_TEXT[st.verdict]);
      html += row('Наибольшая', GP.fmt.len(st.max, 3));
      if (st.controlCount) {
        html += row('RMS по контрольным', GP.fmt.len(st.rmsControl, 3));
      }
    }
    html += row('Допуск', GP.fmt.len(st.tolerance, 2) + ' \u2014 это ' +
                GP.fmt.num(GP.gcp.TOLERANCE_MM, 1) + '\u00A0мм в масштабе 1:' +
                GP.fmt.num(s.workScale, 0));
    $('gcp-stats').innerHTML = html;

    var exact = $('gcp-exact');
    exact.hidden = !st.exact;
    if (st.exact) {
      exact.textContent = 'Две пары задают подобие точно: невязки тождественно ' +
        'нулевые, и низкий RMS ничего не доказывает. Добавьте третью пару ' +
        'или отметьте одну из точек контрольной.';
    }

    $('gcp-meta').textContent = st.total
      ? GP.fmt.num(st.total, 0) + ' точек' +
        (st.usedCount >= 2 ? ' \u00B7 RMS ' + GP.fmt.len(st.rms, 3) : '')
      : '';
  }

  function syncHotRow() {
    Array.prototype.forEach.call($('gcp-rows').children, function (tr) {
      tr.classList.toggle('is-hot', tr.dataset.id === hotGcp);
    });
  }

  function initGcp() {
    $('gcp-mode').addEventListener('click', function () { GP.gcp.toggle(); });
    $('gcp-restore').addEventListener('click', function () { GP.gcp.restoreManual(); });

    var work = $('work-scale');
    GP.gcp.WORK_SCALES.forEach(function (d) {
      var o = document.createElement('option');
      o.value = String(d);
      o.textContent = '1:' + GP.fmt.num(d, 0);
      work.appendChild(o);
    });
    work.value = String(GP.store.state.workScale);
    work.addEventListener('change', function () {
      GP.store.set({ workScale: Number(work.value) }, 'work-scale');
    });

    var vectors = $('vector-scale');
    vectors.value = String(GP.store.state.vectorScale);
    vectors.addEventListener('change', function () {
      GP.store.set({ vectorScale: Number(vectors.value) }, 'vectors');
    });

    var tbody = $('gcp-rows');

    tbody.addEventListener('change', function (e) {
      var tr = e.target.closest('tr');
      if (!tr || !e.target.dataset.act) return;
      GP.store.snapshot();
      var patch = {};
      patch[e.target.dataset.act] = e.target.checked;
      GP.store.updateGcp(tr.dataset.id, patch);
      GP.gcp.apply();
    });

    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="remove"]');
      if (!btn) return;
      GP.store.snapshot();
      GP.store.removeGcp(btn.closest('tr').dataset.id);
      GP.gcp.apply();
    });

    tbody.addEventListener('mouseover', function (e) {
      var tr = e.target.closest('tr');
      if (tr) GP.bus.emit('gcp:hover', tr.dataset.id);
    });
    tbody.addEventListener('mouseleave', function () {
      GP.bus.emit('gcp:hover', null);
    });

    GP.bus.on('gcp:hover', function (id) {
      if (hotGcp === id) return;
      hotGcp = id;
      syncHotRow();
    });
    GP.bus.on('gcp:mode', renderGcpMode);

    var collapse = $('gcp-collapse');
    collapse.innerHTML = icon('chevronLeft', 'icon--chevron');
    collapse.addEventListener('click', function () {
      var panel = $('gcp-panel');
      var collapsed = !panel.classList.contains('is-collapsed');
      panel.classList.toggle('is-collapsed', collapsed);
      collapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      collapse.setAttribute('aria-label',
        collapsed ? 'Развернуть таблицу опорных точек' : 'Свернуть таблицу опорных точек');
      afterLayoutChange();
    });

    renderGcpMode({ active: false, pending: null });
  }

  function initLayerList() {
    $('layer-visible').addEventListener('change', function (e) {
      GP.store.set({ visible: e.target.checked }, 'visible');
    });
    $('layer-opacity').addEventListener('input', function (e) {
      GP.store.set({ fillOpacity: Number(e.target.value) / 100 }, 'opacity');
    });
    var fit = $('layer-fit');
    fit.innerHTML = icon('fit');
    fit.addEventListener('click', function () { GP.layers.fitToView(); });
  }

  /* ---------- сводка привязки ---------- */

  function formatError(meters) {
    if (meters < 1) {
      var mm = meters * 1000;
      if (mm < 0.01) return 'менее 0,01 мм';
      return GP.fmt.num(mm, mm < 10 ? 2 : 1) + ' мм';
    }
    return GP.fmt.len(meters);
  }

  /* Поле, которое само вызвало изменение состояния. Пока флаг поднят,
     перерисовка его не трогает — иначе значение прыгало бы под курсором.
     Любое изменение извне (отмена, опорные точки, загрузка) поле
     обновляет даже с фокусом: иначе в нём остаётся старое число,
     которое при потере фокуса запишется обратно и отменит отмену. */
  var editingField = null;

  function renderBinding(s) {
    $('binding').hidden = !s.source;
    $('export-block').hidden = !s.source;
    $('right-empty').hidden = !!(s.source || s.references.length);
    renderCompare(s);
    if (!s.source) return;

    var size = GP.transform.sizeOnMap(s);

    $('ro-anchor').textContent = GP.fmt.latlon(s.anchor.lat, s.anchor.lon, 6);
    $('ro-anchor-local').textContent =
      GP.fmt.num(s.source.center.x, 1) + '; ' + GP.fmt.num(s.source.center.y, 1);
    /* Два знака, чтобы панель показывала ровно то, что уйдёт в файл:
       свободный поворот с Shift даёт дробные градусы. */
    $('ro-azimuth').textContent = GP.fmt.deg(GP.transform.azimuthY(s), 2);

    /* Поле поворота — оно же показывает текущее значение, в том числе
       когда положение посчитано по опорным точкам. */
    if (editingField !== 'rotation-input' || document.activeElement !== $('rotation-input')) {
      $('rotation-input').value = formatAngle(s.rotation);
    }

    /* Положение задано точками — поля параметров не трогаем. */
    var locked = GP.gcp.isLocked(s);
    $('rotation-input').disabled = locked;
    $('scale-input').disabled = locked;
    $('units-select').disabled = locked;
    $('ro-scale').textContent = formatScale(s.scale) + ' м в единице файла';
    $('ro-size').textContent = GP.fmt.len(size.width, 1) + ' × ' + GP.fmt.len(size.height, 1);
    $('ro-vertices').textContent = GP.fmt.num(s.source.counts.vertices, 0);

    var err = GP.transform.expectedError(size.radius);
    var errEl = $('ro-error');
    errEl.textContent = formatError(err);
    errEl.classList.toggle('is-warning', err > 0.5);

    var note = $('vertex-note');
    var many = s.source.counts.vertices > GP.layers.vertexLimit;
    note.hidden = !many;
    if (many) {
      note.textContent = 'Вершин больше ' + GP.fmt.num(GP.layers.vertexLimit, 0) +
        ', поэтому точки вершин не рисуются: перерисовка на каждое движение ' +
        'мыши стала бы заметно медленнее. На привязку и выгрузку это не влияет.';
    }

    if (editingField !== 'scale-input' || document.activeElement !== $('scale-input')) {
      $('scale-input').value = formatScale(s.scale);
      syncUnitSelect(s.scale);
    }
  }

  /* Угол в поле — с обычным дефисом, чтобы значение можно было править
     с клавиатуры; типографский минус остаётся в сводках. */
  function formatAngle(v) {
    var t = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return t.replace('.', ',');
  }

  /* Масштаб печатается без хвостовых нулей: 1, 0,001, 0,3048. */
  function formatScale(v) {
    var t = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return t.replace('.', ',');
  }

  function unitFor(scale) {
    var found = null;
    GP.export.UNITS.forEach(function (u) {
      if (u.scale !== null && Math.abs(scale - u.scale) <= u.scale * 1e-9) found = u;
    });
    return found;
  }

  function syncUnitSelect(scale) {
    var u = unitFor(scale);
    $('units-select').value = u ? u.id : 'other';
  }

  function initRotationField() {
    var input = $('rotation-input');
    var error = $('rotation-error');

    function commit() {
      var raw = input.value.replace(/\s|\u00A0/g, '')
        .replace(',', '.').replace(/\u2212/g, '-');
      var value = Number(raw);
      if (!raw || !isFinite(value)) {
        input.classList.add('is-invalid');
        error.hidden = false;
        error.textContent = 'Введите число градусов, например 30 или \u221245. ' +
          'Значения больше 180° приводятся к кратчайшей дуге.';
        return;
      }
      input.classList.remove('is-invalid');
      error.hidden = true;
      var normalized = GP.transform.normalizeAngle(value);
      if (Math.abs(normalized - GP.store.state.rotation) > 1e-12) {
        GP.store.snapshot();
        editingField = 'rotation-input';
        GP.transform.setRotation(value);
        editingField = null;
      }
      input.value = formatAngle(GP.store.state.rotation);
    }

    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commit(); e.preventDefault(); }
    });
  }

  function initScaleField() {
    var input = $('scale-input');
    var error = $('scale-error');
    var select = $('units-select');

    GP.export.UNITS.forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.scale === null ? u.title
        : u.title + ' (' + formatScale(u.scale) + ')';
      select.appendChild(opt);
    });

    function apply(value) {
      input.classList.remove('is-invalid');
      error.hidden = true;
      if (Math.abs(value - GP.store.state.scale) < 1e-15) return;
      GP.store.snapshot();
      editingField = 'scale-input';
      GP.transform.setScale(value);
      GP.store.set({ unitsConfirmed: true }, 'scale');
      editingField = null;
    }

    function commit() {
      var raw = input.value.replace(/ |\s/g, '').replace(',', '.');
      var value = Number(raw);
      if (!raw || !isFinite(value) || value <= 0) {
        input.classList.add('is-invalid');
        error.hidden = false;
        error.textContent = 'Введите положительное число: 1 для метров, ' +
          '0,001 для миллиметров.';
        return;
      }
      apply(value);
      input.value = formatScale(GP.store.state.scale);
      syncUnitSelect(GP.store.state.scale);
    }

    /* Выбор в списке подставляет число, ручной ввод нестандартного
       значения переводит список в «другое». */
    select.addEventListener('change', function () {
      var u = null;
      GP.export.UNITS.forEach(function (x) { if (x.id === select.value) u = x; });
      if (!u || u.scale === null) return;
      input.value = formatScale(u.scale);
      apply(u.scale);
    });

    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commit(); e.preventDefault(); }
    });

    /* Кнопка в подсказке делает то же, что выбор «миллиметры» в списке. */
    $('units-hint-apply').addEventListener('click', function () {
      select.value = 'mm';
      input.value = formatScale(0.001);
      apply(0.001);
    });
  }

  /* ---------- выгрузка ---------- */

  function exportSummary(name) {
    var sum = GP.export.summary();
    if (!sum) return;
    var box = $('export-summary');
    var dot = '\u2002\u00B7\u2002';
    var html = '<p class="summary-line">Сохранено: <b>' + name + '</b><br>' +
      'В файле: точек <b>' + GP.fmt.num(sum.points, 0) + '</b>' + dot +
      'масштаб <b>' + formatScale(sum.scale) + '</b>' + dot +
      'габарит на местности <b>' + GP.fmt.len(sum.width, 1) + ' \u00D7 ' +
      GP.fmt.len(sum.height, 1) + '</b></p>';

    if (sum.suspicious) {
      var tail = sum.unit
        ? 'это ' + sum.unit.title + ' в файле'
        : 'около 0,001 означает миллиметры в файле, 0,3048 — футы';
      html += '<p class="msg msg--warning">Масштаб ' + formatScale(sum.scale) +
        ' далёк от единицы: ' + tail +
        '. Сверьте габарит на местности с ожидаемым размером участка.</p>';
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  function initExport() {
    var delimiter = $('csv-delimiter');
    var decimal = $('csv-decimal');

    /* Запятая не может быть сразу и разделителем столбцов,
       и десятичным знаком. */
    function syncCsvOptions() {
      var commaDecimal = decimal.value === ',';
      delimiter.options[1].disabled = commaDecimal;
      if (commaDecimal && delimiter.value === ',') delimiter.value = ';';
    }
    decimal.addEventListener('change', syncCsvOptions);
    syncCsvOptions();

    function save(suffix, ext, text, mime) {
      var s = GP.store.state;
      if (!s.source) return;
      var name = GP.export.fileName(s, suffix, ext);
      GP.export.download(name, text(s), mime);
      exportSummary(name);
    }

    $('export-json').addEventListener('click', function () {
      save('', 'json', function (s) { return GP.export.toJson(s); }, 'application/json');
    });
    $('export-csv').addEventListener('click', function () {
      save('_каталог', 'csv', function (s) {
        return GP.export.toCsv(s, { delimiter: delimiter.value, decimal: decimal.value });
      }, 'text/csv');
    });
    $('export-geojson').addEventListener('click', function () {
      save('_контур', 'geojson', function (s) { return GP.export.toGeoJson(s); },
           'application/geo+json');
    });
  }

  /* ---------- история ---------- */

  function initHistory() {
    var undo = $('undo'), redo = $('redo');
    undo.innerHTML = icon('undo');
    redo.innerHTML = icon('redo');
    undo.addEventListener('click', function () { GP.store.undo(); });
    redo.addEventListener('click', function () { GP.store.redo(); });
  }

  function renderHistory() {
    $('undo').disabled = !GP.store.canUndo();
    $('redo').disabled = !GP.store.canRedo();
  }

  /* ---------- клавиатура ---------- */

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /* Коды клавиш не зависят от раскладки: KeyQ — это и Q, и Й. */
  function initKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (isDialogOpen()) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'я') {
          if (e.shiftKey) GP.store.redo();
          else GP.store.undo();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape' && GP.gcp.cancel()) { e.preventDefault(); return; }
      if (isTyping(document.activeElement)) return;
      if (!GP.store.state.source) return;
      /* Положение задано опорными точками: стрелки и Q/E молчат,
         иначе они спорили бы с решением. */
      if (GP.gcp.isLocked()) return;

      var step = e.shiftKey ? 10 : 1;
      var turn = e.shiftKey ? 5 : 0.5;
      var code = e.code;

      if (code === 'ArrowLeft') { GP.store.snapshot(); GP.transform.moveBy(-step, 0); }
      else if (code === 'ArrowRight') { GP.store.snapshot(); GP.transform.moveBy(step, 0); }
      else if (code === 'ArrowUp') { GP.store.snapshot(); GP.transform.moveBy(0, step); }
      else if (code === 'ArrowDown') { GP.store.snapshot(); GP.transform.moveBy(0, -step); }
      else if (code === 'KeyQ') { GP.store.snapshot(); GP.transform.rotateBy(turn); }
      else if (code === 'KeyE') { GP.store.snapshot(); GP.transform.rotateBy(-turn); }
      else return;

      e.preventDefault();
    });
  }

  /* ---------- запуск ---------- */

  var started = false;

  function init() {
    if (started) return;
    started = true;

    initTheme();
    initBasemaps();
    /* Статусбар подписывается до создания карты: первое сообщение о виде
       карта присылает сразу при инициализации. */
    initStatusbar();
    var map = GP.map.init('map');
    GP.layers.init(map);

    initPanels();
    initLoading();
    initLayerList();
    initGcp();
    initDialog();
    initRotationField();
    initScaleField();
    initExport();
    initHistory();
    initKeyboard();

    GP.bus.on('store:change', function (ev) {
      var s = ev.state;
      if (ev.reason === 'load' || ev.reason === 'clear') {
        $('export-summary').hidden = true;
      }
      renderLayerRow(s);
      renderBinding(s);
      renderGcp(s);
      renderDiagnostics(s.source);
      renderUnitsHint(s);
      renderHistory();
    });

    renderLayerRow(GP.store.state);
    renderBinding(GP.store.state);
    renderGcp(GP.store.state);
    renderHistory();
    updateInsets();
  }

  return {
    init: init,
    icon: icon,
    updateInsets: updateInsets,
    applyTheme: applyTheme
  };
})();

document.addEventListener('DOMContentLoaded', GP.ui.init);
if (document.readyState !== 'loading') GP.ui.init();

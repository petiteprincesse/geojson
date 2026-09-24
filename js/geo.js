/* js/geo.js — геодезия. Чистая математика: ни одной ссылки на Leaflet
   и на DOM, ни одного обращения к состоянию приложения.

   Эллипсоид WGS 84. Локальная плоскость — топоцентрическая ENU
   (восток, север, вверх) с началом в опорной точке: только в ней
   подобие остаётся подобием. Считать привязку в Меркаторе нельзя —
   там масштаб по северу и востоку различается, проверка 9 в tests.html
   показывает цену такой ошибки. */

GP.geo = (function () {

  /* ---------- эллипсоид ---------- */

  var A = 6378137;                    /* большая полуось, м */
  var INV_F = 298.257223563;          /* обратное уплощение */
  var F = 1 / INV_F;
  var B = A * (1 - F);                /* малая полуось, м */
  var E2 = F * (2 - F);               /* первый эксцентриситет в квадрате */
  var EP2 = E2 / (1 - E2);            /* второй эксцентриситет в квадрате */

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;

  function toRad(d) { return d * DEG; }
  function toDeg(r) { return r * RAD; }

  /* ---------- геодезические ↔ ECEF ---------- */

  function geodeticToEcef(latDeg, lonDeg, h) {
    var lat = toRad(latDeg);
    var lon = toRad(lonDeg);
    var height = h || 0;
    var sinLat = Math.sin(lat);
    var cosLat = Math.cos(lat);
    var N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    return [
      (N + height) * cosLat * Math.cos(lon),
      (N + height) * cosLat * Math.sin(lon),
      (N * (1 - E2) + height) * sinLat
    ];
  }

  /* Обратное преобразование по Боурингу. Само по себе оно даёт доли
     миллиметра погрешности, поэтому следом идут две итерации уточнения
     широты и высоты — после них round-trip сходится до 1e−9 м. */
  function ecefToGeodetic(x, y, z) {
    var p = Math.sqrt(x * x + y * y);
    var lon = Math.atan2(y, x);

    /* На оси вращения долгота не определена: берём ноль. */
    if (p < 1e-9) {
      var sign = z < 0 ? -1 : 1;
      return [sign * 90, 0, Math.abs(z) - B];
    }

    var theta = Math.atan2(z * A, p * B);
    var sinT = Math.sin(theta);
    var cosT = Math.cos(theta);
    var lat = Math.atan2(z + EP2 * B * sinT * sinT * sinT,
                         p - E2 * A * cosT * cosT * cosT);

    var sinLat, N, h = 0;
    for (var i = 0; i < 2; i++) {
      sinLat = Math.sin(lat);
      N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
      h = p / Math.cos(lat) - N;
      lat = Math.atan2(z, p * (1 - E2 * N / (N + h)));
    }

    sinLat = Math.sin(lat);
    N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - N;

    return [toDeg(lat), toDeg(lon), h];
  }

  /* ---------- геодезические ↔ ENU ---------- */

  function anchorFrame(anchor) {
    var lat0 = toRad(anchor.lat);
    var lon0 = toRad(anchor.lon);
    return {
      sinLat: Math.sin(lat0), cosLat: Math.cos(lat0),
      sinLon: Math.sin(lon0), cosLon: Math.cos(lon0),
      ecef: geodeticToEcef(anchor.lat, anchor.lon, anchor.h || 0)
    };
  }

  /* Рамка опорной точки: синусы, косинусы и ECEF считаются один раз.
     Пересчёт сотен вершин на каждое движение мыши идёт через неё. */
  function frame(anchor) {
    var f = anchorFrame(anchor);
    return {
      toEnu: function (latDeg, lonDeg, h) { return enuFrom(f, latDeg, lonDeg, h); },
      toGeodetic: function (e, n, u) { return geodeticFrom(f, e, n, u); }
    };
  }

  /* Метры восток/север/вверх относительно опорной точки {lat, lon}. */
  function geodeticToEnu(latDeg, lonDeg, anchor, h) {
    return enuFrom(anchorFrame(anchor), latDeg, lonDeg, h);
  }

  function enuFrom(f, latDeg, lonDeg, h) {
    var p = geodeticToEcef(latDeg, lonDeg, h || 0);
    var dx = p[0] - f.ecef[0];
    var dy = p[1] - f.ecef[1];
    var dz = p[2] - f.ecef[2];
    return {
      e: -f.sinLon * dx + f.cosLon * dy,
      n: -f.sinLat * f.cosLon * dx - f.sinLat * f.sinLon * dy + f.cosLat * dz,
      u: f.cosLat * f.cosLon * dx + f.cosLat * f.sinLon * dy + f.sinLat * dz
    };
  }

  /* Обратно. Четвёртый аргумент u нужен редко: приложение кладёт вершины
     на касательную плоскость, то есть u = 0, и получает высоту h,
     которую потом отбрасывает. Цену этого шага меряет проверка 3. */
  function enuToGeodetic(e, n, anchor, u) {
    return geodeticFrom(anchorFrame(anchor), e, n, u);
  }

  function geodeticFrom(f, e, n, u) {
    var up = u || 0;
    var dx = -f.sinLon * e - f.sinLat * f.cosLon * n + f.cosLat * f.cosLon * up;
    var dy = f.cosLon * e - f.sinLat * f.sinLon * n + f.cosLat * f.sinLon * up;
    var dz = f.cosLat * n + f.sinLat * up;
    var g = ecefToGeodetic(f.ecef[0] + dx, f.ecef[1] + dy, f.ecef[2] + dz);
    return { lat: g[0], lon: g[1], h: g[2] };
  }

  /* ---------- подобие в локальной плоскости ---------- */

  /* Жёсткое подобие: вычесть центр, умножить на масштаб, повернуть
     против часовой стрелки. Ось e — восток, ось n — север. */
  function similarity(x, y, params) {
    var scale = (params.scale === undefined) ? 1 : params.scale;
    var th = toRad(params.rotationDeg || 0);
    var dx = (x - (params.originX || 0)) * scale;
    var dy = (y - (params.originY || 0)) * scale;
    var c = Math.cos(th);
    var s = Math.sin(th);
    return { e: dx * c - dy * s, n: dx * s + dy * c };
  }

  function px(p) { return Array.isArray(p) ? p[0] : (p.x !== undefined ? p.x : p.e); }
  function py(p) { return Array.isArray(p) ? p[1] : (p.y !== undefined ? p.y : p.n); }

  /* Подгонка подобия в замкнутой форме, без итераций:
       a = Σ(dx·dX + dy·dY) / Σ(dx² + dy²)
       b = Σ(dx·dY − dy·dX) / Σ(dx² + dy²)
       X = a·x − b·y + tx,  Y = b·x + a·y + ty
     Вырожденные входы: одна пара — чистый сдвиг; все точки совпали —
     знаменатель нулевой, возвращаем null, а не NaN. */
  function fitSimilarity(src, dst) {
    if (!src || !dst) return null;
    var n = Math.min(src.length, dst.length);
    if (n < 1) return null;

    var i, mx = 0, my = 0, mX = 0, mY = 0;
    for (i = 0; i < n; i++) {
      mx += px(src[i]); my += py(src[i]);
      mX += px(dst[i]); mY += py(dst[i]);
    }
    mx /= n; my /= n; mX /= n; mY /= n;

    var a, b;
    if (n === 1) {
      /* Одна опорная точка задаёт только сдвиг. */
      a = 1; b = 0;
    } else {
      var num1 = 0, num2 = 0, den = 0;
      for (i = 0; i < n; i++) {
        var dx = px(src[i]) - mx, dy = py(src[i]) - my;
        var dX = px(dst[i]) - mX, dY = py(dst[i]) - mY;
        num1 += dx * dX + dy * dY;
        num2 += dx * dY - dy * dX;
        den += dx * dx + dy * dy;
      }
      if (den === 0) return null;   /* все исходные точки совпали */
      a = num1 / den;
      b = num2 / den;
      if (a === 0 && b === 0) return null;
    }

    var tx = mX - (a * mx - b * my);
    var ty = mY - (b * mx + a * my);

    var sum2 = 0, maxResidual = 0;
    for (i = 0; i < n; i++) {
      var X = a * px(src[i]) - b * py(src[i]) + tx;
      var Y = b * px(src[i]) + a * py(src[i]) + ty;
      var rx = X - px(dst[i]);
      var ry = Y - py(dst[i]);
      var r2 = rx * rx + ry * ry;
      sum2 += r2;
      if (r2 > maxResidual) maxResidual = r2;
    }

    var rotation = toDeg(Math.atan2(b, a));
    return {
      a: a,
      b: b,
      tx: tx,
      ty: ty,
      scale: Math.sqrt(a * a + b * b),
      rotationDeg: rotation,
      rms: Math.sqrt(sum2 / n),
      maxResidual: Math.sqrt(maxResidual)
    };
  }

  /* ---------- Web Mercator ---------- */

  /* EPSG:3857: сфера радиуса A поверх эллипсоида WGS 84.
     Годится для подложки и только для неё. */
  function toMercator(latDeg, lonDeg) {
    var lat = toRad(latDeg);
    return {
      x: A * toRad(lonDeg),
      y: A * Math.log(Math.tan(Math.PI / 4 + lat / 2))
    };
  }

  /* ---------- прямая задача Vincenty ---------- */

  /* Независимый эталон на эллипсоиде: приложению не нужна,
     нужна автопроверкам, чтобы сверять с ней цепочку ENU. */
  function vincentyDirect(latDeg, lonDeg, azimuthDeg, s) {
    var phi1 = toRad(latDeg);
    var alpha1 = toRad(azimuthDeg);
    var sinAlpha1 = Math.sin(alpha1);
    var cosAlpha1 = Math.cos(alpha1);

    var tanU1 = (1 - F) * Math.tan(phi1);
    var cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
    var sinU1 = tanU1 * cosU1;

    var sigma1 = Math.atan2(tanU1, cosAlpha1);
    var sinAlpha = cosU1 * sinAlpha1;
    var cosSqAlpha = 1 - sinAlpha * sinAlpha;
    var uSq = cosSqAlpha * (A * A - B * B) / (B * B);
    var Acoef = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    var Bcoef = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

    var sigma = s / (B * Acoef);
    var sinSigma, cosSigma, cos2SigmaM, deltaSigma, prev;
    for (var i = 0; i < 100; i++) {
      cos2SigmaM = Math.cos(2 * sigma1 + sigma);
      sinSigma = Math.sin(sigma);
      cosSigma = Math.cos(sigma);
      deltaSigma = Bcoef * sinSigma * (cos2SigmaM + Bcoef / 4 *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
         Bcoef / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
         (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      prev = sigma;
      sigma = s / (B * Acoef) + deltaSigma;
      if (Math.abs(sigma - prev) < 1e-14) break;
    }

    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);

    var tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
    var phi2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
                          (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));
    var lambda = Math.atan2(sinSigma * sinAlpha1,
                            cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
    var C = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    var L = lambda - (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma *
      (-1 + 2 * cos2SigmaM * cos2SigmaM)));

    return { lat: toDeg(phi2), lon: lonDeg + toDeg(L) };
  }

  /* Обратная задача Vincenty: расстояние по геодезической линии и азимут.
     Нужна сравнению эталонов — сдвиг опорной точки меряется именно
     по эллипсоиду, а не по касательной плоскости. */
  function vincentyInverse(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
    var L = toRad(lon2Deg - lon1Deg);
    var U1 = Math.atan((1 - F) * Math.tan(toRad(lat1Deg)));
    var U2 = Math.atan((1 - F) * Math.tan(toRad(lat2Deg)));
    var sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    var sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    var lambda = L, prev, i = 0;
    var sinLambda, cosLambda, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM, C;

    do {
      sinLambda = Math.sin(lambda);
      cosLambda = Math.cos(lambda);
      sinSigma = Math.sqrt(
        (cosU2 * sinLambda) * (cosU2 * sinLambda) +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
      if (sinSigma === 0) return { distance: 0, azimuth: 0 };   /* точки совпали */
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
      sigma = Math.atan2(sinSigma, cosSigma);
      sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
      cosSqAlpha = 1 - sinAlpha * sinAlpha;
      cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
      C = F / 16 * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
      prev = lambda;
      lambda = L + (1 - C) * F * sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma *
        (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    } while (Math.abs(lambda - prev) > 1e-12 && ++i < 200);

    var uSq = cosSqAlpha * (A * A - B * B) / (B * B);
    var Acoef = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    var Bcoef = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    var deltaSigma = Bcoef * sinSigma * (cos2SigmaM + Bcoef / 4 *
      (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
       Bcoef / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
       (-3 + 4 * cos2SigmaM * cos2SigmaM)));

    var azimuth = toDeg(Math.atan2(cosU2 * sinLambda,
                                   cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
    if (azimuth < 0) azimuth += 360;

    return { distance: B * Acoef * (sigma - deltaSigma), azimuth: azimuth };
  }

  return {
    A: A,
    B: B,
    F: F,
    E2: E2,
    toRad: toRad,
    toDeg: toDeg,
    geodeticToEcef: geodeticToEcef,
    ecefToGeodetic: ecefToGeodetic,
    geodeticToEnu: geodeticToEnu,
    enuToGeodetic: enuToGeodetic,
    frame: frame,
    similarity: similarity,
    fitSimilarity: fitSimilarity,
    toMercator: toMercator,
    vincentyDirect: vincentyDirect,
    vincentyInverse: vincentyInverse
  };
})();

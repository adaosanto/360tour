(function () {
  var root = document.querySelector(".app-shell");
  var projectId = root.dataset.projectId;
  var panoElement = document.getElementById("pano");
  var sceneList = document.getElementById("sceneList");
  var hotspotList = document.getElementById("hotspotList");
  var saveState = document.getElementById("saveState");
  var progressBox = document.getElementById("progressBox");
  var progressText = document.getElementById("progressText");
  var progressBar = document.getElementById("progressBar");
  var viewReadout = document.getElementById("viewReadout");
  var addFilesInput = document.getElementById("addFiles");
  var autorenameDistance = document.getElementById("autorenameDistance");
  var autorenameArcgisViewUrl = document.getElementById("autorenameArcgisViewUrl");
  var autorenameArcgisCiclo = document.getElementById("autorenameArcgisCiclo");
  var autorenameArcgisProfissional = document.getElementById("autorenameArcgisProfissional");
  var autorenameArcgisFinalidade = document.getElementById("autorenameArcgisFinalidade");
  var autorenameArcgisDepartamento = document.getElementById("autorenameArcgisDepartamento");
  var autorenameArcgisSituacao = document.getElementById("autorenameArcgisSituacao");
  var previewAutorename = document.getElementById("previewAutorename");
  var applyAutorename = document.getElementById("applyAutorename");
  var previewArcgisSync = document.getElementById("previewArcgisSync");
  var commitArcgisSync = document.getElementById("commitArcgisSync");
  var autorenameStatus = document.getElementById("autorenameStatus");
  var autorenameMap = document.getElementById("autorenameMap");
  var autorenameMapTiles = document.getElementById("autorenameMapTiles");
  var autorenameMapLines = document.getElementById("autorenameMapLines");
  var autorenameMapMarkers = document.getElementById("autorenameMapMarkers");
  var autorenameMapZoomIn = document.getElementById("autorenameMapZoomIn");
  var autorenameMapZoomOut = document.getElementById("autorenameMapZoomOut");
  var autorenameMapRecenter = document.getElementById("autorenameMapRecenter");
  var autorenameMatches = document.getElementById("autorenameMatches");
  var arcgisSyncPanel = document.getElementById("arcgisSyncPanel");
  var arcgisSyncSummary = document.getElementById("arcgisSyncSummary");
  var arcgisSyncRecords = document.getElementById("arcgisSyncRecords");
  var sceneHeadingOffset = document.getElementById("sceneHeadingOffset");
  var sceneHeadingOffsetLabel = document.getElementById("sceneHeadingOffsetLabel");
  var sceneCameraYaw = document.getElementById("sceneCameraYaw");
  var sceneViewHeading = document.getElementById("sceneViewHeading");
  var sceneConeBearing = document.getElementById("sceneConeBearing");
  var sceneConeBearingLabel = document.getElementById("sceneConeBearingLabel");
  var sceneHeadingStatus = document.getElementById("sceneHeadingStatus");
  var sceneHeadingMap = document.getElementById("sceneHeadingMap");
  var sceneHeadingMapTiles = document.getElementById("sceneHeadingMapTiles");
  var sceneHeadingMapDirection = document.getElementById("sceneHeadingMapDirection");
  var sceneHeadingMapCone = document.getElementById("sceneHeadingMapCone");
  var sceneHeadingZoomOut = document.getElementById("sceneHeadingZoomOut");
  var sceneHeadingZoomIn = document.getElementById("sceneHeadingZoomIn");
  var alignConeWithView = document.getElementById("alignConeWithView");
  var resetConeAlignment = document.getElementById("resetConeAlignment");
  var setInitialViewAndCone = document.getElementById("setInitialViewAndCone");
  var viewer;
  var project;
  var scenes = [];
  var currentIndex = 0;
  var saveTimer = null;
  var savePromise = null;
  var hasPendingSave = false;
  var selectedHotspot = null;
  var placingHotspot = null;
  var autorenamePreviewPayload = null;
  var arcgisSyncPreviewPayload = null;
  var autorenameMapMatches = [];
  var autorenameMapPoints = [];
  var autorenameMapState = { latitude: 0, longitude: 0, zoom: 17 };
  var autorenameMapDrag = null;
  var uploadWorkflowActive = false;
  var autorenameTileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var headingOverlayTileUrlTemplate = "https://tiles.arcgis.com/tiles/MRbkurfLm8nmQrDq/arcgis/rest/services/RasterLrv2026_1/MapServer/tile/{level}/{row}/{col}";
  var headingMapZoom = 18;
  var headingMapMinZoom = 16;
  var headingMapMaxZoom = 19;
  var headingMapKey = "";
  var headingMapDrag = null;
  var uploadBatchMaxFiles = 5;
  var uploadBatchMaxBytes = 750 * 1024 * 1024;
  var panoramaZoomMultiplier = 3;

  function requestJSON(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.detail || "Falha na requisicao.");
        return payload;
      });
    });
  }

  function responsePayload(xhr) {
    try {
      return JSON.parse(xhr.responseText || "{}");
    } catch (error) {
      return {};
    }
  }

  function formatBytes(bytes) {
    var units = ["B", "KB", "MB", "GB", "TB"];
    var value = Number(bytes) || 0;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (unit === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)) + " " + units[unit];
  }

  function normalizeSettings(settings) {
    settings = settings || {};
    return {
      autorotate: !!settings.autorotate,
      controls: settings.controls !== false,
      fullscreen: settings.fullscreen !== false,
      sceneList: settings.sceneList !== false,
      mouseViewMode: settings.mouseViewMode === "qtvr" ? "qtvr" : "drag",
      showPhotoNames: !!settings.showPhotoNames,
      showMapViewCone: settings.showMapViewCone !== false,
      saveOriginalPhotos: settings.saveOriginalPhotos !== false
    };
  }

  function normalizeSignedDegrees(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    number = ((number + 180) % 360 + 360) % 360 - 180;
    return Math.abs(number) < 0.000001 ? 0 : number;
  }

  function normalizeHeadingDegrees(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    number = ((number % 360) + 360) % 360;
    return Math.abs(number) < 0.000001 ? 0 : number;
  }

  function formatSignedDegrees(value) {
    var number = normalizeSignedDegrees(value);
    return (number > 0 ? "+" : "") + number.toFixed(1) + " deg";
  }

  function formatHeadingDegrees(value) {
    return normalizeHeadingDegrees(value).toFixed(1) + " deg";
  }

  function readNumericMetadata(metadata, keys) {
    metadata = metadata || {};
    for (var i = 0; i < keys.length; i++) {
      var value = Number(metadata[keys[i]]);
      if (isFinite(value)) return value;
    }
    return 0;
  }

  function rawCameraHeading(sceneData) {
    var metadata = (sceneData && sceneData.metadata) || {};
    return readNumericMetadata(metadata, [
      "cameraYaw",
      "cameraYawDegree",
      "gimbalYawDegree",
      "GimbalYawDegree",
      "gimbalYaw",
      "flightYaw",
      "flightYawDegree",
      "FlightYawDegree",
      "droneYaw",
      "heading"
    ]);
  }

  function sceneHeadingCorrection(sceneData) {
    return normalizeSignedDegrees(sceneData && sceneData.headingOffset);
  }

  function cameraHeadingOffset(sceneData) {
    return rawCameraHeading(sceneData) + sceneHeadingCorrection(sceneData);
  }

  function correctedViewHeading(sceneData, params) {
    params = params || {};
    return normalizeHeadingDegrees(cameraHeadingOffset(sceneData) + ((Number(params.yaw) || 0) * 180 / Math.PI));
  }

  function currentViewParameters() {
    if (viewer && viewer.view()) return viewer.view().parameters();
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    return scene ? scene.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 } : null;
  }

  function currentViewYawDegrees(params) {
    params = params || currentViewParameters() || {};
    return (Number(params.yaw) || 0) * 180 / Math.PI;
  }

  function readSceneCoordinates(scene) {
    var coordinates = scene && scene.metadata ? scene.metadata.coordinates : null;
    var latitude = coordinates ? Number(coordinates.latitude) : NaN;
    var longitude = coordinates ? Number(coordinates.longitude) : NaN;
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    return { latitude: latitude, longitude: longitude };
  }

  function currentConeBearingForScene(scene, params) {
    return correctedViewHeading(scene, params);
  }

  function setCurrentSceneConeBearing(bearing, options) {
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    if (!scene) return;
    var params = currentViewParameters() || {};
    var normalizedBearing = normalizeHeadingDegrees(bearing);
    var correction = normalizedBearing - rawCameraHeading(scene) - currentViewYawDegrees(params);
    scene.headingOffset = normalizeSignedDegrees(correction);
    updateHeadingCalibration(params);
    if (!options || !options.skipSave) {
      markDirty(options && options.immediate ? { immediate: true } : undefined);
    }
  }

  function headingMapTileUrl(template, level, col, row) {
    return template
      .replace("{level}", level)
      .replace("{col}", col)
      .replace("{row}", row);
  }

  function clampHeadingMapZoom(value) {
    var zoom = Math.round(Number(value));
    if (!isFinite(zoom)) zoom = 18;
    return Math.max(headingMapMinZoom, Math.min(headingMapMaxZoom, zoom));
  }

  function setHeadingMapZoom(value) {
    var nextZoom = clampHeadingMapZoom(value);
    if (nextZoom === headingMapZoom) return;
    headingMapZoom = nextZoom;
    renderSceneHeadingMap(true);
  }

  function setHeadingMapStatus(message, active) {
    if (!sceneHeadingStatus) return;
    sceneHeadingStatus.textContent = message;
    sceneHeadingStatus.classList.toggle("active", !!active);
  }

  function updateSceneHeadingMapDirection(params) {
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    if (!scene || !sceneHeadingMapDirection) return;
    var bearing = currentConeBearingForScene(scene, params || currentViewParameters());
    sceneHeadingMapDirection.style.transform = "rotate(" + bearing.toFixed(2) + "deg)";
    if (sceneHeadingMapCone) {
      sceneHeadingMapCone.style.width = "76px";
      sceneHeadingMapCone.style.height = "66px";
    }
  }

  function renderSceneHeadingMap(force) {
    if (!sceneHeadingMap || !sceneHeadingMapTiles) return;
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    var coordinates = readSceneCoordinates(scene);
    if (!scene || !coordinates) {
      sceneHeadingMap.hidden = true;
      headingMapKey = "";
      if (sceneHeadingZoomOut) sceneHeadingZoomOut.disabled = true;
      if (sceneHeadingZoomIn) sceneHeadingZoomIn.disabled = true;
      setHeadingMapStatus("Sem coordenadas para calibrar pelo mapa.", false);
      return;
    }

    sceneHeadingMap.hidden = false;
    setHeadingMapStatus("Calibracao por mapa ativa. Zoom " + headingMapZoom + ".", true);
    if (sceneHeadingZoomOut) sceneHeadingZoomOut.disabled = headingMapZoom <= headingMapMinZoom;
    if (sceneHeadingZoomIn) sceneHeadingZoomIn.disabled = headingMapZoom >= headingMapMaxZoom;
    var width = sceneHeadingMap.clientWidth || 320;
    var height = sceneHeadingMap.clientHeight || 220;
    var zoom = headingMapZoom;
    var key = [
      scene.id,
      coordinates.latitude.toFixed(7),
      coordinates.longitude.toFixed(7),
      width,
      height,
      zoom
    ].join("|");
    if (force || headingMapKey !== key) {
      headingMapKey = key;
      sceneHeadingMapTiles.innerHTML = "";
      var centerX = lonToWorldX(coordinates.longitude, zoom);
      var centerY = latToWorldY(coordinates.latitude, zoom);
      var left = centerX - width / 2;
      var top = centerY - height / 2;
      var minCol = Math.floor(left / 256);
      var maxCol = Math.floor((left + width) / 256);
      var minRow = Math.floor(top / 256);
      var maxRow = Math.floor((top + height) / 256);
      var tileCount = Math.pow(2, zoom);
      for (var row = minRow; row <= maxRow; row++) {
        if (row < 0 || row >= tileCount) continue;
        for (var col = minCol; col <= maxCol; col++) {
          var wrappedCol = ((col % tileCount) + tileCount) % tileCount;
          [
            { template: autorenameTileUrlTemplate, className: "base" },
            { template: headingOverlayTileUrlTemplate, className: "overlay" }
          ].forEach(function (tile) {
            var image = document.createElement("img");
            image.alt = "";
            image.className = tile.className;
            image.src = headingMapTileUrl(tile.template, zoom, wrappedCol, row);
            image.style.left = Math.round(col * 256 - left) + "px";
            image.style.top = Math.round(row * 256 - top) + "px";
            sceneHeadingMapTiles.appendChild(image);
          });
        }
      }
    }
    updateSceneHeadingMapDirection();
  }

  function bearingFromHeadingMapEvent(event) {
    if (!sceneHeadingMap) return null;
    var rect = sceneHeadingMap.getBoundingClientRect();
    var dx = event.clientX - (rect.left + rect.width / 2);
    var dy = event.clientY - (rect.top + rect.height / 2);
    if (Math.abs(dx) + Math.abs(dy) < 3) return null;
    return normalizeHeadingDegrees(Math.atan2(dx, -dy) * 180 / Math.PI);
  }

  function normalizeProject(payload) {
    payload = payload || {};
    payload.settings = normalizeSettings(payload.settings);
    payload.scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
    payload.scenes.forEach(function (scene) {
      scene.infoHotspots = Array.isArray(scene.infoHotspots) ? scene.infoHotspots : [];
      scene.linkHotspots = Array.isArray(scene.linkHotspots) ? scene.linkHotspots : [];
      scene.headingOffset = normalizeSignedDegrees(scene.headingOffset);
    });
    return payload;
  }

  function isActiveProgressStatus(status) {
    return status === "uploading" || status === "queued" || status === "processing";
  }

  function isServerProcessingStatus(status) {
    return status === "queued" || status === "processing";
  }

  function setAutorenameStatus(message, isError) {
    if (!autorenameStatus) return;
    autorenameStatus.textContent = message;
    autorenameStatus.classList.toggle("error", !!isError);
  }

  function autorenamePayload() {
    return {
      maxDistanceMeters: Number(autorenameDistance.value || 15)
    };
  }

  function fieldValue(element) {
    return element ? element.value.trim() : "";
  }

  function autorenameArcgisPayload() {
    var payload = autorenamePayload();
    payload.viewUrl = fieldValue(autorenameArcgisViewUrl);
    payload.ciclo = fieldValue(autorenameArcgisCiclo);
    payload.profissional = fieldValue(autorenameArcgisProfissional);
    payload.finalidade = fieldValue(autorenameArcgisFinalidade);
    payload.departamentoSolicitante = fieldValue(autorenameArcgisDepartamento);
    payload.situacao = fieldValue(autorenameArcgisSituacao);
    return payload;
  }

  function validateArcgisSyncForm() {
    var fields = [
      autorenameArcgisViewUrl,
      autorenameArcgisCiclo,
      autorenameArcgisProfissional,
      autorenameArcgisFinalidade,
      autorenameArcgisDepartamento,
      autorenameArcgisSituacao
    ];
    for (var index = 0; index < fields.length; index++) {
      if (fields[index] && !fields[index].reportValidity()) return false;
    }
    return true;
  }

  function autorenameIsApplied(payload) {
    var matched = ((payload && payload.matches) || []).filter(function (match) { return match.matched; });
    return !!matched.length && matched.every(function (match) {
      return String(match.sceneId || "") === String(match.newId || "")
        && String(match.sceneName || "") === String(match.newName || "");
    });
  }

  function setAutorenameLoading(isLoading) {
    if (previewAutorename) previewAutorename.disabled = isLoading;
    if (applyAutorename) applyAutorename.disabled = isLoading || !autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount || (autorenamePreviewPayload.duplicatePointIds || []).length;
    if (previewArcgisSync) previewArcgisSync.disabled = isLoading || !autorenameIsApplied(autorenamePreviewPayload) || (autorenamePreviewPayload.duplicatePointIds || []).length;
    if (commitArcgisSync) commitArcgisSync.disabled = isLoading || !arcgisSyncPreviewPayload || !arcgisSyncPreviewPayload.createCount;
  }

  function lonToWorldX(lon, zoom) {
    return ((lon + 180) / 360) * 256 * Math.pow(2, zoom);
  }

  function latToWorldY(lat, zoom) {
    var sin = Math.sin(lat * Math.PI / 180);
    sin = Math.min(Math.max(sin, -0.9999), 0.9999);
    return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256 * Math.pow(2, zoom);
  }

  function worldXToLon(x, zoom) {
    return x / (256 * Math.pow(2, zoom)) * 360 - 180;
  }

  function worldYToLat(y, zoom) {
    var n = Math.PI - 2 * Math.PI * y / (256 * Math.pow(2, zoom));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function chooseAutorenameMapZoom(points, width, height) {
    if (points.length <= 1) return 17;
    var usableWidth = Math.max(80, width - 42);
    var usableHeight = Math.max(80, height - 42);
    for (var zoom = 18; zoom >= 2; zoom--) {
      var xs = points.map(function (point) { return lonToWorldX(point.longitude, zoom); });
      var ys = points.map(function (point) { return latToWorldY(point.latitude, zoom); });
      var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      if (spanX <= usableWidth && spanY <= usableHeight) return zoom;
    }
    return 2;
  }

  function autorenameTileUrl(level, col, row) {
    return autorenameTileUrlTemplate
      .replace("{level}", level)
      .replace("{col}", col)
      .replace("{row}", row);
  }

  function buildAutorenameMapPoints(matches) {
    var points = [];
    (matches || []).forEach(function (match) {
      if (match.photo) points.push({ type: "photo", latitude: match.photo.latitude, longitude: match.photo.longitude, match: match });
      if (match.point && match.matched) points.push({ type: "point", latitude: match.point.latitude, longitude: match.point.longitude, match: match });
    });
    return points;
  }

  function updateAutorenameMapControls() {
    var enabled = !!autorenameMapPoints.length;
    [autorenameMapZoomIn, autorenameMapZoomOut, autorenameMapRecenter].forEach(function (button) {
      if (button) button.disabled = !enabled;
    });
    if (autorenameMapZoomIn) autorenameMapZoomIn.disabled = !enabled || autorenameMapState.zoom >= 20;
    if (autorenameMapZoomOut) autorenameMapZoomOut.disabled = !enabled || autorenameMapState.zoom <= 2;
  }

  function fitAutorenameMapToPoints() {
    if (!autorenameMapPoints.length) return;
    var width = autorenameMap.clientWidth || 320;
    var height = autorenameMap.clientHeight || 260;
    autorenameMapState.zoom = chooseAutorenameMapZoom(autorenameMapPoints, width, height);
    var xs = autorenameMapPoints.map(function (point) { return lonToWorldX(point.longitude, autorenameMapState.zoom); });
    var ys = autorenameMapPoints.map(function (point) { return latToWorldY(point.latitude, autorenameMapState.zoom); });
    var centerX = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    var centerY = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
    autorenameMapState.longitude = worldXToLon(centerX, autorenameMapState.zoom);
    autorenameMapState.latitude = worldYToLat(centerY, autorenameMapState.zoom);
  }

  function renderAutorenameMap(matches, options) {
    if (!autorenameMap || !autorenameMapTiles || !autorenameMapLines || !autorenameMapMarkers) return;
    if (Array.isArray(matches)) {
      autorenameMapMatches = matches;
      autorenameMapPoints = buildAutorenameMapPoints(matches);
    }
    var shouldFit = !options || options.fit !== false;
    autorenameMap.hidden = !autorenameMapPoints.length;
    autorenameMapTiles.innerHTML = "";
    autorenameMapLines.innerHTML = "";
    autorenameMapMarkers.innerHTML = "";
    if (!autorenameMapPoints.length) {
      updateAutorenameMapControls();
      return;
    }

    var width = autorenameMap.clientWidth || 320;
    var height = autorenameMap.clientHeight || 260;
    if (shouldFit) fitAutorenameMapToPoints();
    var zoom = autorenameMapState.zoom;
    var centerX = lonToWorldX(autorenameMapState.longitude, zoom);
    var centerY = latToWorldY(autorenameMapState.latitude, zoom);
    var left = centerX - width / 2;
    var top = centerY - height / 2;
    var minCol = Math.floor(left / 256);
    var maxCol = Math.floor((left + width) / 256);
    var minRow = Math.floor(top / 256);
    var maxRow = Math.floor((top + height) / 256);
    var tileCount = Math.pow(2, zoom);

    for (var row = minRow; row <= maxRow; row++) {
      if (row < 0 || row >= tileCount) continue;
      for (var col = minCol; col <= maxCol; col++) {
        var wrappedCol = ((col % tileCount) + tileCount) % tileCount;
        var image = document.createElement("img");
        image.alt = "";
        image.src = autorenameTileUrl(zoom, wrappedCol, row);
        image.style.left = Math.round(col * 256 - left) + "px";
        image.style.top = Math.round(row * 256 - top) + "px";
        autorenameMapTiles.appendChild(image);
      }
    }

    function screenPoint(point) {
      return {
        x: lonToWorldX(point.longitude, zoom) - left,
        y: latToWorldY(point.latitude, zoom) - top
      };
    }

    function pointIsNearViewport(point) {
      var margin = 80;
      return point.x >= -margin && point.x <= width + margin && point.y >= -margin && point.y <= height + margin;
    }

    autorenameMapLines.setAttribute("viewBox", "0 0 " + width + " " + height);
    autorenameMapLines.setAttribute("width", width);
    autorenameMapLines.setAttribute("height", height);
    autorenameMapMatches.forEach(function (match) {
      if (!match.matched || !match.photo || !match.point) return;
      var photo = screenPoint(match.photo);
      var point = screenPoint(match.point);
      if (!pointIsNearViewport(photo) && !pointIsNearViewport(point)) return;
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", photo.x.toFixed(1));
      line.setAttribute("y1", photo.y.toFixed(1));
      line.setAttribute("x2", point.x.toFixed(1));
      line.setAttribute("y2", point.y.toFixed(1));
      autorenameMapLines.appendChild(line);
    });
    autorenameMapPoints.forEach(function (point) {
      var marker = document.createElement("span");
      var screen = screenPoint(point);
      if (!pointIsNearViewport(screen)) return;
      marker.className = "autorename-marker " + point.type + (point.match.matched ? "" : " unmatched");
      marker.style.left = Math.round(screen.x) + "px";
      marker.style.top = Math.round(screen.y) + "px";
      marker.title = point.type === "photo"
        ? "Foto: " + (point.match.sourceFile || point.match.sceneName || point.match.sceneId)
        : "Ponto ArcGIS: " + point.match.point.id;
      autorenameMapMarkers.appendChild(marker);
    });
    updateAutorenameMapControls();
  }

  function zoomAutorenameMap(delta, origin) {
    if (!autorenameMapPoints.length) return;
    var oldZoom = autorenameMapState.zoom;
    var nextZoom = Math.max(2, Math.min(20, oldZoom + delta));
    if (nextZoom === oldZoom) return;

    if (origin && autorenameMap.clientWidth) {
      var rect = autorenameMap.getBoundingClientRect();
      var offsetX = origin.clientX - rect.left - autorenameMap.clientWidth / 2;
      var offsetY = origin.clientY - rect.top - autorenameMap.clientHeight / 2;
      var worldX = lonToWorldX(autorenameMapState.longitude, oldZoom) + offsetX;
      var worldY = latToWorldY(autorenameMapState.latitude, oldZoom) + offsetY;
      var scale = Math.pow(2, nextZoom - oldZoom);
      autorenameMapState.longitude = worldXToLon((worldX * scale) - offsetX, nextZoom);
      autorenameMapState.latitude = worldYToLat((worldY * scale) - offsetY, nextZoom);
    }

    autorenameMapState.zoom = nextZoom;
    renderAutorenameMap(null, { fit: false });
  }

  function panAutorenameMap(start, event) {
    var centerX = start.centerX - (event.clientX - start.x);
    var centerY = start.centerY - (event.clientY - start.y);
    autorenameMapState.longitude = worldXToLon(centerX, autorenameMapState.zoom);
    autorenameMapState.latitude = worldYToLat(centerY, autorenameMapState.zoom);
    renderAutorenameMap(null, { fit: false });
  }

  function renderAutorenameMatches(payload) {
    if (!autorenameMatches) return;
    autorenameMatches.innerHTML = "";
    (payload.matches || []).forEach(function (match) {
      var item = document.createElement("div");
      item.className = "autorename-match" + (match.matched ? "" : " unmatched");
      var title = document.createElement("strong");
      var detail = document.createElement("span");
      var file = document.createElement("span");
      title.textContent = match.matched
        ? (match.sourceFile || match.sceneName || match.sceneId) + " -> " + match.newName
        : (match.sourceFile || match.sceneName || match.sceneId);
      detail.textContent = match.matched
        ? "Ponto " + match.point.id + " | " + match.distanceMeters.toFixed(2) + " m"
        : (match.reason || "Sem match");
      file.textContent = match.matched ? "Novo ID: " + match.newId : "";
      item.appendChild(title);
      item.appendChild(detail);
      if (file.textContent) item.appendChild(file);
      autorenameMatches.appendChild(item);
    });
  }

  function resetArcgisSyncPreview() {
    arcgisSyncPreviewPayload = null;
    if (commitArcgisSync) commitArcgisSync.disabled = true;
    if (arcgisSyncPanel) arcgisSyncPanel.hidden = true;
    if (arcgisSyncRecords) arcgisSyncRecords.innerHTML = "";
  }

  function renderArcgisSyncRecords(payload) {
    if (!arcgisSyncPanel || !arcgisSyncSummary || !arcgisSyncRecords) return;
    arcgisSyncPanel.hidden = false;
    arcgisSyncRecords.innerHTML = "";

    var statusLabels = {
      pending: "Sera criado",
      existing: "Ja existe",
      invalid: "Invalido",
      created: "Criado",
      failed: "Falhou"
    };
    var records = (payload.records || []).slice().sort(function (left, right) {
      var order = { pending: 0, failed: 1, invalid: 2, existing: 3, created: 4 };
      var leftOrder = Object.prototype.hasOwnProperty.call(order, left.status) ? order[left.status] : 9;
      var rightOrder = Object.prototype.hasOwnProperty.call(order, right.status) ? order[right.status] : 9;
      return leftOrder - rightOrder;
    });

    records.forEach(function (record) {
      var item = document.createElement("div");
      var header = document.createElement("div");
      var title = document.createElement("strong");
      var badge = document.createElement("span");
      var detail = document.createElement("span");
      var link = document.createElement("span");
      item.className = "arcgis-sync-record " + (record.status || "invalid");
      header.className = "arcgis-sync-record-header";
      title.textContent = record.sourceFile || record.sceneId || "Imagem";
      badge.className = "arcgis-sync-badge";
      badge.textContent = statusLabels[record.status] || record.status || "Invalido";
      detail.textContent = "Ponto " + (record.pointId || "-") + (record.reason ? " | " + record.reason : "");
      link.className = "arcgis-sync-link";
      link.textContent = record.imageLink || "Sem ImagemLink";
      header.appendChild(title);
      header.appendChild(badge);
      item.appendChild(header);
      item.appendChild(detail);
      item.appendChild(link);
      arcgisSyncRecords.appendChild(item);
    });

    if (Object.prototype.hasOwnProperty.call(payload, "submittedCount")) {
      arcgisSyncSummary.textContent = payload.createdCount + " criado(s), " + payload.alreadyExistsCount + " ja existente(s), " + payload.failedCount + " falha(s).";
    } else {
      arcgisSyncSummary.textContent = payload.createCount + " sera(ao) criado(s), " + payload.alreadyExistsCount + " ja existe(m), " + payload.invalidCount + " invalido(s).";
    }
  }

  function renderArcgisSyncPreview(payload) {
    arcgisSyncPreviewPayload = payload;
    renderArcgisSyncRecords(payload);
    if (commitArcgisSync) commitArcgisSync.disabled = !payload.createCount;
    setAutorenameStatus(
      payload.createCount
        ? payload.createCount + " registro(s) pronto(s) para envio. A tabela possui " + payload.existingFeatureCount + " registro(s)."
        : "Nenhum registro novo para enviar. " + payload.alreadyExistsCount + " foto(s) ja existe(m).",
      !!payload.invalidCount
    );
  }

  function renderArcgisSyncResult(payload) {
    arcgisSyncPreviewPayload = null;
    renderArcgisSyncRecords(payload);
    if (commitArcgisSync) commitArcgisSync.disabled = true;
    var message = payload.createdCount + " registro(s) criado(s) no ArcGIS.";
    if (payload.alreadyExistsCount) message += " " + payload.alreadyExistsCount + " duplicado(s) ignorado(s).";
    if (payload.failedCount) message += " " + payload.failedCount + " falha(s).";
    setAutorenameStatus(message, !!payload.failedCount || !!payload.invalidCount);
  }

  function renderAutorenamePreview(payload) {
    autorenamePreviewPayload = payload;
    resetArcgisSyncPreview();
    var duplicateIds = payload.duplicatePointIds || [];
    var status = payload.matchedCount + " de " + payload.sceneCount + " cenas com match em " + payload.pointCount + " pontos ArcGIS.";
    if (duplicateIds.length) {
      status += " Pontos duplicados: " + duplicateIds.join(", ") + ".";
    } else if (payload.matchedCount && !autorenameIsApplied(payload)) {
      status += " Aplique o autorename antes de verificar o envio.";
    }
    setAutorenameStatus(status, !!duplicateIds.length);
    if (applyAutorename) {
      applyAutorename.disabled = !payload.matchedCount || !!duplicateIds.length;
    }
    if (previewArcgisSync) {
      previewArcgisSync.disabled = !autorenameIsApplied(payload) || !!duplicateIds.length;
    }
    renderAutorenameMatches(payload);
    renderAutorenameMap(payload.matches || []);
  }

  function markDirty(options) {
    saveState.textContent = "Salvando";
    hasPendingSave = true;
    clearTimeout(saveTimer);
    if (options && options.immediate) {
      saveProject();
    } else {
      saveTimer = setTimeout(saveProject, 350);
    }
  }

  function saveProject(options) {
    if (!project) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = null;
    hasPendingSave = false;
    var requestOptions = {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project)
    };
    if (options && options.keepalive) {
      requestOptions.keepalive = true;
    }
    savePromise = requestJSON("/api/projects/" + projectId, requestOptions).then(function () {
      saveState.textContent = "Salvo";
      return true;
    }).catch(function (error) {
      saveState.textContent = error.message;
      hasPendingSave = true;
      throw error;
    });
    return savePromise;
  }

  function initViewer() {
    viewer = new Marzipano.Viewer(panoElement, {
      controls: { mouseViewMode: project.settings.mouseViewMode || "drag" },
      stage: { progressive: true }
    });
    var controls = viewer.controls();
    var velocity = 0.7;
    var friction = 3;
    [["viewLeft", "x", -velocity], ["viewRight", "x", velocity], ["viewUp", "y", -velocity], ["viewDown", "y", velocity], ["viewIn", "zoom", -velocity], ["viewOut", "zoom", velocity]].forEach(function (item) {
      controls.registerMethod(item[0], new Marzipano.ElementPressControlMethod(document.getElementById(item[0]), item[1], item[2], friction), true);
    });
  }

  function buildScenes() {
    scenes = project.scenes.map(function (sceneData) {
      return { data: sceneData, scene: null, view: null, hotspotHandles: [] };
    });
  }

  function ensureSceneLoaded(scene) {
    if (scene.scene && scene.view) return scene;
    var sceneData = scene.data;
    var source = Marzipano.ImageUrlSource.fromString("/project-files/" + projectId + "/" + sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg");
    var geometry = new Marzipano.CubeGeometry(sceneData.levels);
    var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize * panoramaZoomMultiplier, 100 * Math.PI / 180, 120 * Math.PI / 180);
    var initialView = sceneData.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
    var view = new Marzipano.RectilinearView(initialView, limiter);
    scene.scene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });
    scene.view = view;
    scene.hotspotHandles = [];
    return scene;
  }

  function rebuildViewer() {
    panoElement.innerHTML = "";
    initViewer();
    buildScenes();
    currentIndex = Math.min(currentIndex, Math.max(0, scenes.length - 1));
    switchScene(currentIndex);
  }

  function switchScene(index) {
    if (!scenes[index]) return;
    currentIndex = index;
    selectedHotspot = null;
    var scene = ensureSceneLoaded(scenes[index]);
    scene.view.setParameters(scene.data.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 });
    scene.scene.switchTo();
    renderSceneList();
    renderCurrentSceneForm();
    renderHotspots();
  }

  function currentScene() {
    return scenes[currentIndex];
  }

  function renderSceneList() {
    sceneList.innerHTML = "";
    project.scenes.forEach(function (scene, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = index === currentIndex ? "scene-item active" : "scene-item";
      button.textContent = scene.name || scene.id;
      button.addEventListener("click", function () { switchScene(index); });
      sceneList.appendChild(button);
    });
  }

  function renderCurrentSceneForm() {
    var scene = project.scenes[currentIndex];
    document.getElementById("sceneName").value = scene ? scene.name : "";
    document.getElementById("settingAutorotate").checked = !!project.settings.autorotate;
    document.getElementById("settingControls").checked = project.settings.controls !== false;
    document.getElementById("settingFullscreen").checked = project.settings.fullscreen !== false;
    document.getElementById("settingSceneList").checked = project.settings.sceneList !== false;
    document.getElementById("settingShowPhotoNames").checked = !!project.settings.showPhotoNames;
    document.getElementById("settingShowMapViewCone").checked = project.settings.showMapViewCone !== false;
    document.getElementById("settingSaveOriginalPhotos").checked = project.settings.saveOriginalPhotos !== false;
    document.getElementById("settingMouseMode").value = project.settings.mouseViewMode || "drag";
    document.getElementById("controls").hidden = project.settings.controls === false;
    updateHeadingCalibration();
    renderSceneHeadingMap(true);
  }

  function updateHeadingCalibration(params) {
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    var hasScene = !!scene;
    if (sceneHeadingOffset) {
      sceneHeadingOffset.disabled = !hasScene;
      sceneHeadingOffset.value = hasScene ? sceneHeadingCorrection(scene).toFixed(6) : "0";
    }
    if (sceneConeBearing) {
      sceneConeBearing.disabled = !hasScene;
    }
    [alignConeWithView, resetConeAlignment, setInitialViewAndCone].forEach(function (button) {
      if (button) button.disabled = !hasScene;
    });
    if (!hasScene) {
      if (sceneCameraYaw) sceneCameraYaw.textContent = "-";
      if (sceneConeBearingLabel) sceneConeBearingLabel.textContent = "-";
      if (sceneHeadingOffsetLabel) sceneHeadingOffsetLabel.textContent = "0 deg";
      if (sceneViewHeading) sceneViewHeading.textContent = "Sem cena";
      if (sceneConeBearing && document.activeElement !== sceneConeBearing) sceneConeBearing.value = "0.0";
      renderSceneHeadingMap();
      return;
    }
    params = params || currentViewParameters();
    var coneBearing = params ? currentConeBearingForScene(scene, params) : 0;
    if (sceneCameraYaw) sceneCameraYaw.textContent = formatHeadingDegrees(rawCameraHeading(scene));
    if (sceneConeBearingLabel) sceneConeBearingLabel.textContent = formatHeadingDegrees(coneBearing);
    if (sceneHeadingOffsetLabel) sceneHeadingOffsetLabel.textContent = formatSignedDegrees(sceneHeadingCorrection(scene));
    if (sceneConeBearing && document.activeElement !== sceneConeBearing) {
      sceneConeBearing.value = coneBearing.toFixed(1);
    }
    if (sceneViewHeading) {
      sceneViewHeading.textContent = params ? "Cone " + formatHeadingDegrees(coneBearing) : "Cone -";
    }
    updateSceneHeadingMapDirection(params);
  }

  function setCurrentSceneHeadingOffset(value, options) {
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    if (!scene) return;
    scene.headingOffset = normalizeSignedDegrees(value);
    updateHeadingCalibration();
    if (!options || !options.skipSave) {
      markDirty(options && options.immediate ? { immediate: true } : undefined);
    }
  }

  function saveCurrentViewAndCone() {
    var scene = project && project.scenes ? project.scenes[currentIndex] : null;
    if (!scene || !viewer || !viewer.view()) return;
    var params = viewer.view().parameters();
    scene.initialViewParameters = { yaw: params.yaw, pitch: params.pitch, fov: params.fov };
    updateHeadingCalibration(params);
    markDirty({ immediate: true });
  }

  function makeHotspotElement(hotspot, type) {
    var element = document.createElement("button");
    element.type = "button";
    element.className = "hotspot " + type + (selectedHotspot === hotspot ? " selected" : "");
    element.textContent = type === "link" ? "↪" : "i";
    element.title = hotspot.title || hotspot.text || "Hotspot";
    element.addEventListener("click", function (event) {
      event.stopPropagation();
      selectedHotspot = hotspot;
      renderHotspots();
    });
    return element;
  }

  function clearHotspotHandles(scene) {
    if (!scene.hotspotHandles) scene.hotspotHandles = [];
    scene.hotspotHandles.forEach(function (handle) { handle.destroy(); });
    scene.hotspotHandles = [];
  }

  function renderHotspots() {
    scenes.forEach(clearHotspotHandles);
    var scene = currentScene();
    if (!scene) return;
    ensureSceneLoaded(scene);
    scene.data.infoHotspots.forEach(function (hotspot) {
      scene.hotspotHandles.push(scene.scene.hotspotContainer().createHotspot(makeHotspotElement(hotspot, "info"), { yaw: hotspot.yaw, pitch: hotspot.pitch }));
    });
    scene.data.linkHotspots.forEach(function (hotspot) {
      scene.hotspotHandles.push(scene.scene.hotspotContainer().createHotspot(makeHotspotElement(hotspot, "link"), { yaw: hotspot.yaw, pitch: hotspot.pitch }));
    });
    renderHotspotList();
  }

  function renderHotspotList() {
    var scene = project.scenes[currentIndex];
    hotspotList.innerHTML = "";
    if (!scene) return;
    scene.infoHotspots.forEach(function (hotspot) { addHotspotForm(hotspot, "info"); });
    scene.linkHotspots.forEach(function (hotspot) { addHotspotForm(hotspot, "link"); });
  }

  function addHotspotForm(hotspot, type) {
    var item = document.createElement("div");
    item.className = "hotspot-form" + (selectedHotspot === hotspot ? " active" : "");
    item.innerHTML = type === "info"
      ? '<strong>Info</strong><input data-field="title" placeholder="Titulo"><textarea data-field="text" placeholder="Descricao"></textarea><div class="button-row"><button type="button" data-action="move">Reposicionar</button><button type="button" data-action="delete">Excluir</button></div>'
      : '<strong>Link</strong><input data-field="title" placeholder="Rotulo"><select data-field="target"></select><div class="button-row"><button type="button" data-action="move">Reposicionar</button><button type="button" data-action="delete">Excluir</button></div>';
    item.querySelectorAll("[data-field]").forEach(function (field) {
      if (field.dataset.field === "target") {
        project.scenes.forEach(function (scene) {
          if (scene.id !== project.scenes[currentIndex].id) {
            var option = document.createElement("option");
            option.value = scene.id;
            option.textContent = scene.name;
            field.appendChild(option);
          }
        });
      }
      field.value = hotspot[field.dataset.field] || "";
      function updateHotspotField() {
        hotspot[field.dataset.field] = field.value;
        markDirty();
      }
      field.addEventListener("input", updateHotspotField);
      field.addEventListener("change", updateHotspotField);
    });
    item.querySelector('[data-action="move"]').addEventListener("click", function () {
      placingHotspot = hotspot;
      selectedHotspot = hotspot;
      progressBox.hidden = false;
      progressText.textContent = "Clique no panorama para reposicionar o hotspot.";
      progressBar.value = 100;
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", function () {
      var list = type === "info" ? project.scenes[currentIndex].infoHotspots : project.scenes[currentIndex].linkHotspots;
      list.splice(list.indexOf(hotspot), 1);
      selectedHotspot = null;
      markDirty();
      renderHotspots();
    });
    item.addEventListener("click", function () {
      selectedHotspot = hotspot;
      renderHotspots();
    });
    hotspotList.appendChild(item);
  }

  function viewCoordsFromEvent(event) {
    var rect = panoElement.getBoundingClientRect();
    var coords = viewer.view().screenToCoordinates({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    return { yaw: coords.yaw, pitch: coords.pitch };
  }

  panoElement.addEventListener("click", function (event) {
    if (!placingHotspot || !currentScene()) return;
    var coords = viewCoordsFromEvent(event);
    placingHotspot.yaw = coords.yaw;
    placingHotspot.pitch = coords.pitch;
    placingHotspot = null;
    progressBox.hidden = true;
    markDirty();
    renderHotspots();
  });

  document.getElementById("sceneName").addEventListener("input", function (event) {
    if (!project.scenes[currentIndex]) return;
    project.scenes[currentIndex].name = event.target.value;
    markDirty();
    renderSceneList();
  });

  document.getElementById("moveUp").addEventListener("click", function () {
    if (currentIndex <= 0) return;
    var item = project.scenes.splice(currentIndex, 1)[0];
    project.scenes.splice(currentIndex - 1, 0, item);
    currentIndex -= 1;
    markDirty();
    rebuildViewer();
  });

  document.getElementById("moveDown").addEventListener("click", function () {
    if (currentIndex >= project.scenes.length - 1) return;
    var item = project.scenes.splice(currentIndex, 1)[0];
    project.scenes.splice(currentIndex + 1, 0, item);
    currentIndex += 1;
    markDirty();
    rebuildViewer();
  });

  document.getElementById("deleteScene").addEventListener("click", function () {
    if (!project.scenes[currentIndex] || !confirm("Excluir esta cena do projeto?")) return;
    var removed = project.scenes.splice(currentIndex, 1)[0];
    project.scenes.forEach(function (scene) {
      scene.linkHotspots = scene.linkHotspots.filter(function (hotspot) { return hotspot.target !== removed.id; });
    });
    markDirty();
    rebuildViewer();
  });

  document.getElementById("setInitialView").addEventListener("click", function () {
    var params = viewer.view().parameters();
    project.scenes[currentIndex].initialViewParameters = { yaw: params.yaw, pitch: params.pitch, fov: params.fov };
    markDirty();
  });

  if (sceneConeBearing) {
    sceneConeBearing.addEventListener("input", function (event) {
      var value = Number(event.target.value);
      if (!isFinite(value)) return;
      setCurrentSceneConeBearing(value);
    });
    sceneConeBearing.addEventListener("change", function (event) {
      var value = Number(event.target.value);
      setCurrentSceneConeBearing(isFinite(value) ? value : 0, { immediate: true });
      var scene = project && project.scenes ? project.scenes[currentIndex] : null;
      event.target.value = scene ? currentConeBearingForScene(scene, currentViewParameters()).toFixed(1) : "0.0";
    });
  }

  if (alignConeWithView) {
    alignConeWithView.addEventListener("click", function () {
      saveCurrentViewAndCone();
    });
  }

  if (resetConeAlignment) {
    resetConeAlignment.addEventListener("click", function () {
      setCurrentSceneHeadingOffset(0, { immediate: true });
    });
  }

  if (setInitialViewAndCone) {
    setInitialViewAndCone.addEventListener("click", function () {
      saveCurrentViewAndCone();
    });
  }

  if (sceneHeadingMap) {
    sceneHeadingMap.addEventListener("pointerdown", function (event) {
      if (event.target.closest(".heading-map-controls")) return;
      var scene = project && project.scenes ? project.scenes[currentIndex] : null;
      if (!scene || !readSceneCoordinates(scene)) return;
      var bearing = bearingFromHeadingMapEvent(event);
      if (bearing == null) return;
      event.preventDefault();
      headingMapDrag = event.pointerId;
      sceneHeadingMap.setPointerCapture(event.pointerId);
      setCurrentSceneConeBearing(bearing, { skipSave: true });
    });
    sceneHeadingMap.addEventListener("pointermove", function (event) {
      if (headingMapDrag !== event.pointerId) return;
      var bearing = bearingFromHeadingMapEvent(event);
      if (bearing == null) return;
      event.preventDefault();
      setCurrentSceneConeBearing(bearing, { skipSave: true });
    });
    sceneHeadingMap.addEventListener("pointerup", function (event) {
      if (headingMapDrag !== event.pointerId) return;
      headingMapDrag = null;
      try {
        sceneHeadingMap.releasePointerCapture(event.pointerId);
      } catch (error) {}
      var bearing = bearingFromHeadingMapEvent(event);
      if (bearing != null) {
        setCurrentSceneConeBearing(bearing, { immediate: true });
      } else {
        markDirty({ immediate: true });
      }
    });
    sceneHeadingMap.addEventListener("pointercancel", function (event) {
      if (headingMapDrag !== event.pointerId) return;
      headingMapDrag = null;
      try {
        sceneHeadingMap.releasePointerCapture(event.pointerId);
      } catch (error) {}
      markDirty({ immediate: true });
    });
    sceneHeadingMap.addEventListener("wheel", function (event) {
      var scene = project && project.scenes ? project.scenes[currentIndex] : null;
      if (!scene || !readSceneCoordinates(scene)) return;
      event.preventDefault();
      setHeadingMapZoom(headingMapZoom + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  if (sceneHeadingZoomOut) {
    sceneHeadingZoomOut.addEventListener("click", function (event) {
      event.stopPropagation();
      setHeadingMapZoom(headingMapZoom - 1);
    });
  }

  if (sceneHeadingZoomIn) {
    sceneHeadingZoomIn.addEventListener("click", function (event) {
      event.stopPropagation();
      setHeadingMapZoom(headingMapZoom + 1);
    });
  }

  document.getElementById("addInfo").addEventListener("click", function () {
    var params = viewer.view().parameters();
    var hotspot = { yaw: params.yaw, pitch: params.pitch, title: "Info", text: "" };
    project.scenes[currentIndex].infoHotspots.push(hotspot);
    selectedHotspot = hotspot;
    placingHotspot = hotspot;
    markDirty();
    renderHotspots();
  });

  document.getElementById("addLink").addEventListener("click", function () {
    var params = viewer.view().parameters();
    var target = project.scenes.find(function (scene, index) { return index !== currentIndex; });
    var hotspot = { yaw: params.yaw, pitch: params.pitch, title: "Link", target: target ? target.id : "" };
    project.scenes[currentIndex].linkHotspots.push(hotspot);
    selectedHotspot = hotspot;
    placingHotspot = hotspot;
    markDirty();
    renderHotspots();
  });

  ["settingAutorotate", "settingControls", "settingFullscreen", "settingSceneList", "settingShowPhotoNames", "settingShowMapViewCone", "settingSaveOriginalPhotos"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", function (event) {
      var key = id.replace("setting", "");
      key = key.charAt(0).toLowerCase() + key.slice(1);
      project.settings[key] = event.target.checked;
      renderCurrentSceneForm();
      markDirty({ immediate: true });
    });
  });

  document.getElementById("settingMouseMode").addEventListener("change", function (event) {
    project.settings.mouseViewMode = event.target.value;
    markDirty({ immediate: true });
    rebuildViewer();
  });

  if (previewAutorename) {
    previewAutorename.addEventListener("click", function () {
      setAutorenameStatus("Consultando ArcGIS no servidor e calculando proximidade...");
      setAutorenameLoading(true);
      saveProject()
        .then(function () {
          return requestJSON("/api/projects/" + projectId + "/autorename/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autorenamePayload())
          });
        })
        .then(function (payload) {
          renderAutorenamePreview(payload);
        })
        .catch(function (error) {
          autorenamePreviewPayload = null;
          resetArcgisSyncPreview();
          if (applyAutorename) applyAutorename.disabled = true;
          if (previewArcgisSync) previewArcgisSync.disabled = true;
          setAutorenameStatus(error.message, true);
        })
        .finally(function () {
          setAutorenameLoading(false);
        });
    });
  }

  if (applyAutorename) {
    applyAutorename.addEventListener("click", function () {
      if (!autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount) return;
      if (!confirm("Aplicar IDs e nomes dos pontos ArcGIS nas cenas com match?")) return;
      setAutorenameStatus("Aplicando renomeacao...");
      setAutorenameLoading(true);
      saveProject()
        .then(function () {
          return requestJSON("/api/projects/" + projectId + "/autorename/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autorenamePayload())
          });
        })
        .then(function (payload) {
          project = normalizeProject(payload.project);
          currentIndex = Math.min(currentIndex, Math.max(0, project.scenes.length - 1));
          rebuildViewer();
          renderAutorenamePreview(payload);
          saveState.textContent = "Salvo";
          setAutorenameStatus("Renomeacao aplicada em " + payload.matchedCount + " cenas.");
        })
        .catch(function (error) {
          setAutorenameStatus(error.message, true);
        })
        .finally(function () {
          setAutorenameLoading(false);
        });
    });
  }

  if (previewArcgisSync) {
    previewArcgisSync.addEventListener("click", function () {
      if (!autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount) return;
      if (!validateArcgisSyncForm()) return;
      setAutorenameStatus("Consultando todas as imagens da tabela ArcGIS...");
      setAutorenameLoading(true);
      saveProject()
        .then(function () {
          return requestJSON("/api/projects/" + projectId + "/autorename/arcgis/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autorenameArcgisPayload())
          });
        })
        .then(function (payload) {
          renderArcgisSyncPreview(payload);
        })
        .catch(function (error) {
          resetArcgisSyncPreview();
          setAutorenameStatus(error.message, true);
        })
        .finally(function () {
          setAutorenameLoading(false);
        });
    });
  }

  if (commitArcgisSync) {
    commitArcgisSync.addEventListener("click", function () {
      if (!arcgisSyncPreviewPayload || !arcgisSyncPreviewPayload.createCount) return;
      if (!validateArcgisSyncForm()) return;
      var count = arcgisSyncPreviewPayload.createCount;
      if (!confirm("Criar " + count + " registro(s) na tabela de imagens do ArcGIS?")) return;
      setAutorenameStatus("Revalidando duplicados e enviando ao ArcGIS...");
      setAutorenameLoading(true);
      saveProject()
        .then(function () {
          return requestJSON("/api/projects/" + projectId + "/autorename/arcgis/commit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autorenameArcgisPayload())
          });
        })
        .then(function (payload) {
          renderArcgisSyncResult(payload);
        })
        .catch(function (error) {
          setAutorenameStatus(error.message, true);
        })
        .finally(function () {
          setAutorenameLoading(false);
        });
    });
  }

  [
    autorenameArcgisViewUrl,
    autorenameArcgisCiclo,
    autorenameArcgisProfissional,
    autorenameArcgisFinalidade,
    autorenameArcgisDepartamento,
    autorenameArcgisSituacao
  ].forEach(function (field) {
    if (!field) return;
    field.addEventListener("change", function () {
      if (!arcgisSyncPreviewPayload) return;
      resetArcgisSyncPreview();
      setAutorenameStatus("Formulario alterado. Verifique o envio novamente.");
    });
  });

  if (autorenameMapZoomIn) {
    autorenameMapZoomIn.addEventListener("click", function (event) {
      event.stopPropagation();
      zoomAutorenameMap(1);
    });
  }

  if (autorenameMapZoomOut) {
    autorenameMapZoomOut.addEventListener("click", function (event) {
      event.stopPropagation();
      zoomAutorenameMap(-1);
    });
  }

  if (autorenameMapRecenter) {
    autorenameMapRecenter.addEventListener("click", function (event) {
      event.stopPropagation();
      fitAutorenameMapToPoints();
      renderAutorenameMap(null, { fit: false });
    });
  }

  if (autorenameMap) {
    autorenameMap.addEventListener("pointerdown", function (event) {
      if (!autorenameMapPoints.length || event.button !== 0 || event.target.closest(".autorename-map-controls")) return;
      autorenameMapDrag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        centerX: lonToWorldX(autorenameMapState.longitude, autorenameMapState.zoom),
        centerY: latToWorldY(autorenameMapState.latitude, autorenameMapState.zoom)
      };
      autorenameMap.classList.add("dragging");
      autorenameMap.setPointerCapture(event.pointerId);
    });

    autorenameMap.addEventListener("pointermove", function (event) {
      if (!autorenameMapDrag || autorenameMapDrag.id !== event.pointerId) return;
      panAutorenameMap(autorenameMapDrag, event);
    });

    function endAutorenameMapDrag(event) {
      if (!autorenameMapDrag || autorenameMapDrag.id !== event.pointerId) return;
      autorenameMapDrag = null;
      autorenameMap.classList.remove("dragging");
      if (autorenameMap.hasPointerCapture(event.pointerId)) {
        autorenameMap.releasePointerCapture(event.pointerId);
      }
    }

    autorenameMap.addEventListener("pointerup", endAutorenameMapDrag);
    autorenameMap.addEventListener("pointercancel", endAutorenameMapDrag);
    autorenameMap.addEventListener("wheel", function (event) {
      if (!autorenameMapPoints.length) return;
      event.preventDefault();
      zoomAutorenameMap(event.deltaY < 0 ? 1 : -1, event);
    }, { passive: false });
  }

  function supportedPanoramaFile(file) {
    return /\.(jpe?g|png|tiff?)$/i.test(file.name);
  }

  function isSafeUploadNameChar(character) {
    return /[0-9A-Za-z._-]/.test(character) || character.toLowerCase() !== character.toUpperCase();
  }

  function safeUploadNameKey(name) {
    var source = String(name || "panorama.jpg").split(/[\\/]/).pop();
    var safe = "";
    Array.prototype.forEach.call(source, function (character) {
      if (safe.length >= 120) return;
      safe += isSafeUploadNameChar(character) ? character : "-";
    });
    return (safe || "panorama").toLowerCase();
  }

  function uploadNameKeys(name) {
    var direct = String(name || "").trim().toLowerCase();
    var safe = safeUploadNameKey(name);
    var keys = {};
    if (direct) keys[direct] = true;
    if (safe) keys[safe] = true;
    return Object.keys(keys);
  }

  function rememberUploadName(map, name, displayName) {
    uploadNameKeys(name).forEach(function (key) {
      map[key] = displayName || name;
    });
  }

  function filterNewUploadFiles(files) {
    var selected = {};
    var existing = {};
    var skipped = [];
    var accepted = [];
    ((project && project.scenes) || []).forEach(function (scene) {
      if (scene.sourceFile) rememberUploadName(existing, scene.sourceFile, scene.sourceFile);
    });
    files.forEach(function (file) {
      var keys = uploadNameKeys(file.name);
      var repeated = keys.some(function (key) { return selected[key] || existing[key]; });
      if (repeated) {
        skipped.push(file.name);
        return;
      }
      accepted.push(file);
      keys.forEach(function (key) {
        selected[key] = file.name;
      });
    });
    return { accepted: accepted, skipped: skipped.sort(function (a, b) { return a.localeCompare(b); }) };
  }

  function skippedUploadMessage(names) {
    var visible = names.slice(0, 8).join(", ");
    var remaining = names.length - 8;
    if (remaining > 0) visible += " e mais " + remaining;
    return names.length + " foto(s) duplicada(s) ignorada(s): " + visible + ".";
  }

  function makeUploadBatches(files) {
    var batches = [];
    var current = [];
    var currentBytes = 0;
    files.forEach(function (file) {
      var wouldExceedCount = current.length >= uploadBatchMaxFiles;
      var wouldExceedBytes = current.length && currentBytes + file.size > uploadBatchMaxBytes;
      if (wouldExceedCount || wouldExceedBytes) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.size;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  function sendUploadBatch(batch, index, totalBatches, uploadedBytes, totalBytes) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var formData = new FormData();
      batch.forEach(function (file) {
        formData.append("files", file, file.name);
      });
      if (index === 0) {
        formData.append("clear_existing", "true");
      }
      xhr.open("POST", "/api/projects/" + projectId + "/panoramas/upload");
      xhr.upload.addEventListener("progress", function (event) {
        if (!event.lengthComputable) {
          progressText.textContent = "Enviando lote " + (index + 1) + " de " + totalBatches + "...";
          return;
        }
        var sent = uploadedBytes + event.loaded;
        var percent = Math.min(99, (sent / totalBytes) * 100);
        progressBar.value = percent;
        progressText.textContent = "Upload " + Math.round(percent) + "% | lote " + (index + 1) + "/" + totalBatches + " | " + formatBytes(sent) + " de " + formatBytes(totalBytes);
      });
      xhr.addEventListener("load", function () {
        var payload = responsePayload(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
          return;
        }
        reject(new Error(payload.detail || "Falha ao enviar lote " + (index + 1) + "."));
      });
      xhr.addEventListener("error", function () {
        reject(new Error("Falha de conexao durante o upload do lote " + (index + 1) + "."));
      });
      xhr.addEventListener("abort", function () {
        reject(new Error("Upload cancelado."));
      });
      xhr.send(formData);
    });
  }

  function processUploadedPanoramas() {
    var formData = new FormData();
    return requestJSON("/api/projects/" + projectId + "/panoramas/process", {
      method: "POST",
      body: formData
    });
  }

  function uploadFiles(files) {
    var invalid = files.filter(function (file) { return !supportedPanoramaFile(file); });
    if (invalid.length) {
      throw new Error("Arquivo em formato nao permitido: " + invalid[0].name);
    }
    var filtered = filterNewUploadFiles(files);
    var skipped = filtered.skipped;
    files = filtered.accepted;
    if (!files.length) {
      progressBox.hidden = false;
      progressBar.value = 0;
      progressText.textContent = "Nenhuma foto nova para enviar. " + skippedUploadMessage(skipped);
      return Promise.resolve();
    }
    var skippedMessage = skipped.length ? " " + skippedUploadMessage(skipped) : "";
    var totalBytes = files.reduce(function (sum, file) { return sum + file.size; }, 0);
    var batches = makeUploadBatches(files);
    var uploadedBytes = 0;
    uploadWorkflowActive = true;
    progressBox.hidden = false;
    progressBar.value = 0;
    progressText.textContent = "Preparando upload de " + files.length + " panorama(s), " + formatBytes(totalBytes) + "." + skippedMessage;
    if (addFilesInput) addFilesInput.disabled = true;
    progressText.textContent = "Salvando configuracoes do projeto..." + skippedMessage;
    return saveProject().then(function () {
      return batches.reduce(function (promise, batch, index) {
        return promise.then(function () {
          return sendUploadBatch(batch, index, batches.length, uploadedBytes, totalBytes).then(function () {
            uploadedBytes += batch.reduce(function (sum, file) { return sum + file.size; }, 0);
            progressBar.value = Math.min(99, (uploadedBytes / totalBytes) * 100);
            progressText.textContent = "Lote " + (index + 1) + " de " + batches.length + " enviado. " + formatBytes(uploadedBytes) + " de " + formatBytes(totalBytes) + ".";
          });
        });
      }, Promise.resolve());
    }).then(function () {
      progressBar.value = 100;
      progressText.textContent = "Upload concluido. Enfileirando processamento...";
      return processUploadedPanoramas();
    }).then(function () {
      progressText.textContent = "Processamento iniciado para " + files.length + " panorama(s)." + skippedMessage;
      pollProgress();
    }).catch(function (error) {
      uploadWorkflowActive = false;
      progressText.textContent = error.message;
      if (addFilesInput) addFilesInput.disabled = false;
    });
  }

  if (addFilesInput) {
    addFilesInput.addEventListener("change", function (event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      event.target.value = "";
      if (!files.length) return;
      try {
        uploadFiles(files);
      } catch (error) {
        progressBox.hidden = false;
        progressBar.value = 0;
        progressText.textContent = error.message;
      }
    });
  }

  function pollProgress() {
    requestJSON("/api/projects/" + projectId + "/progress").then(function (state) {
      progressBox.hidden = state.status === "done" && state.percent >= 100;
      progressText.textContent = state.message || state.status;
      progressBar.value = state.percent || 0;
      if (isActiveProgressStatus(state.status)) {
        setTimeout(pollProgress, 900);
      } else {
        uploadWorkflowActive = false;
        if (addFilesInput) addFilesInput.disabled = false;
        loadProject();
      }
    }).catch(function (error) {
      uploadWorkflowActive = false;
      progressText.textContent = error.message;
      if (addFilesInput) addFilesInput.disabled = false;
    });
  }

  document.getElementById("exportZip").addEventListener("click", function () {
    saveProject().then(function () {
      window.location.href = "/api/projects/" + projectId + "/export";
    }).catch(function () {});
  });

  var deleteProject = document.getElementById("deleteProject");
  if (deleteProject) {
    deleteProject.addEventListener("click", function () {
      if (!confirm("Excluir o projeto temporario?")) return;
      fetch("/api/projects/" + projectId, { method: "DELETE" }).then(function () { window.location.href = "/"; });
    });
  }

  function updateReadout() {
    var activeView = viewer ? viewer.view() : null;
    if (activeView) {
      var p = activeView.parameters();
      var scene = project && project.scenes ? project.scenes[currentIndex] : null;
      var headingText = scene ? " | cone " + formatHeadingDegrees(correctedViewHeading(scene, p)) : "";
      viewReadout.textContent = "yaw " + p.yaw.toFixed(3) + " | pitch " + p.pitch.toFixed(3) + " | fov " + p.fov.toFixed(3) + headingText;
      updateHeadingCalibration(p);
    }
    requestAnimationFrame(updateReadout);
  }

  function loadProject() {
    return requestJSON("/api/projects/" + projectId).then(function (payload) {
      project = normalizeProject(payload);
      saveState.textContent = "Salvo";
      if (!viewer) {
        renderCurrentSceneForm();
        renderSceneList();
        initViewer();
        updateReadout();
        buildScenes();
        if (project.scenes.length) {
          switchScene(currentIndex);
        }
      } else {
        rebuildViewer();
      }
      pollInitialProgress();
    }).catch(function (error) {
      saveState.textContent = error.message;
      progressBox.hidden = false;
      progressText.textContent = error.message;
      progressBar.value = 0;
    });
  }

  function pollInitialProgress() {
    if (uploadWorkflowActive) return;
    requestJSON("/api/projects/" + projectId + "/progress").then(function (state) {
      if (uploadWorkflowActive) return;
      if (isServerProcessingStatus(state.status)) {
        progressBox.hidden = false;
        progressText.textContent = state.message || "Processando";
        progressBar.value = state.percent || 0;
        setTimeout(function () {
          if (uploadWorkflowActive) return;
          requestJSON("/api/projects/" + projectId).then(function (payload) {
            if (uploadWorkflowActive) return;
            project = normalizeProject(payload);
            rebuildViewer();
            pollInitialProgress();
          });
        }, 1000);
      } else {
        progressBox.hidden = true;
      }
    });
  }

  window.addEventListener("beforeunload", function () {
    if (hasPendingSave) {
      saveProject({ keepalive: true }).catch(function () {});
    }
  });

  window.addEventListener("resize", function () {
    renderSceneHeadingMap(true);
  });

  loadProject();
})();

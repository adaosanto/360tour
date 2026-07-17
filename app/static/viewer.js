(function () {
  "use strict";

  var body = document.body;
  var projectId = body.dataset.projectId;
  var initialSceneId = (body.dataset.initialSceneId || "").trim();
  var showBtnList = body.dataset.showBtnList !== "false";
  var projectFileBase = body.dataset.projectFileBase || "";
  var panoElement = document.getElementById("pano");
  var emptyState = document.getElementById("emptyState");
  var emptyCover = document.getElementById("emptyCover");
  var emptyTitle = document.getElementById("emptyTitle");
  var emptyMessage = document.getElementById("emptyMessage");
  var projectName = document.getElementById("projectName");
  var sceneName = document.getElementById("sceneName");
  var sceneList = document.getElementById("sceneList");
  var sceneItems = document.getElementById("sceneItems");
  var sceneListToggle = document.getElementById("sceneListToggle");
  var metadataToggle = document.getElementById("metadataToggle");
  var metadataClose = document.getElementById("metadataClose");
  var metadataPanel = document.getElementById("metadataPanel");
  var metadataCoords = document.getElementById("metadataCoords");
  var metadataAltitude = document.getElementById("metadataAltitude");
  var metadataHeight = document.getElementById("metadataHeight");
  var metadataDate = document.getElementById("metadataDate");
  var metadataPhotoRow = document.getElementById("metadataPhotoRow");
  var metadataPhoto = document.getElementById("metadataPhoto");
  var photoMap = document.getElementById("photoMap");
  var mapTiles = document.getElementById("mapTiles");
  var mapMarkers = document.getElementById("mapMarkers");
  var mapZoomIn = document.getElementById("mapZoomIn");
  var mapZoomOut = document.getElementById("mapZoomOut");
  var mapRecenter = document.getElementById("mapRecenter");
  var printGeoButton = document.getElementById("printGeoButton");
  var printLayout = document.getElementById("printLayout");
  var autorotateToggle = document.getElementById("autorotateToggle");
  var fullscreenToggle = document.getElementById("fullscreenToggle");
  var viewer = null;
  var autorotate = null;
  var project = null;
  var scenes = [];
  var currentScene = null;
  var mapPoints = [];
  var mapState = { lat: 0, lon: 0, zoom: 16 };
  var mapDrag = null;
  var cameraDirectionFrame = null;
  var printViewer = null;
  var printScene = null;
  var printSceneId = null;
  var baseTileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var overlayTileUrlTemplate = "https://tiles.arcgis.com/tiles/MRbkurfLm8nmQrDq/arcgis/rest/services/RasterLrv2026_1/MapServer/tile/{level}/{row}/{col}";
  var initialized = false;
  var pollTimer = null;
  var embeddedProject = window.__PROJECT_DATA__ || null;

  function requestJSON(url) {
    var separator = url.indexOf("?") === -1 ? "?" : "&";
    url = url + separator + "_=" + Date.now();
    return fetch(url).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.detail || "Falha ao carregar o projeto.");
        return payload;
      });
    });
  }

  function projectFileUrl(path) {
    if (!path) return "";
    path = String(path).replace(/^\/+/, "");
    if (!projectFileBase) return "/project-files/" + projectId + "/" + path;
    if (projectFileBase.slice(-1) === "/" || /[?&][^=]*=$/.test(projectFileBase)) {
      return projectFileBase + path;
    }
    if (projectFileBase.indexOf("?") !== -1) {
      return projectFileBase + "&asset=" + path;
    }
    return projectFileBase.replace(/\/+$/, "") + "/" + path;
  }

  function imagePath(path) {
    return projectFileUrl(path);
  }

  function setupProjectChrome() {
    var name = project.name || "Tour 360";
    projectName.textContent = name;
    emptyTitle.textContent = name;
    if (project.thumbnailPath) {
      var thumbnailUrl = imagePath(project.thumbnailPath);
      emptyCover.style.backgroundImage = "url('" + thumbnailUrl.replace(/'/g, "\\'") + "')";
      emptyCover.classList.add("has-image");
    }
  }

  function showEmptyState(message) {
    emptyState.hidden = false;
    emptyMessage.textContent = message || "Nenhum panorama processado neste projeto.";
    body.classList.add("single-scene", "hide-controls", "hide-map");
  }

  function hideEmptyState() {
    emptyState.hidden = true;
    body.classList.remove("single-scene", "hide-controls", "hide-map");
  }

  function createInfoHotspot(hotspot) {
    var element = document.createElement("button");
    var header = document.createElement("span");
    var icon = document.createElement("span");
    var title = document.createElement("span");
    var text = document.createElement("span");

    element.type = "button";
    element.className = "info-hotspot";
    header.className = "info-hotspot-header";
    icon.className = "info-hotspot-icon";
    title.className = "info-hotspot-title";
    text.className = "info-hotspot-text";
    icon.textContent = "i";
    title.textContent = hotspot.title || "Info";
    text.textContent = hotspot.text || "";
    header.appendChild(icon);
    header.appendChild(title);
    element.appendChild(header);
    element.appendChild(text);
    element.addEventListener("click", function () {
      element.classList.toggle("visible");
    });
    return element;
  }

  function createLinkHotspot(hotspot) {
    var element = document.createElement("button");
    var icon = document.createElement("span");
    var label = document.createElement("span");
    element.type = "button";
    element.className = "link-hotspot";
    icon.className = "link-hotspot-icon";
    label.className = "link-hotspot-tooltip";
    icon.textContent = "↪";
    label.textContent = hotspot.title || "Abrir cena";
    element.appendChild(icon);
    element.appendChild(label);
    element.addEventListener("click", function () {
      var target = scenes.find(function (scene) { return scene.data.id === hotspot.target; });
      if (target) switchScene(target);
    });
    return element;
  }

  function buildScenes() {
    viewer = new Marzipano.Viewer(panoElement, {
      controls: { mouseViewMode: project.settings.mouseViewMode || "drag" },
      stage: { progressive: true }
    });
    autorotate = Marzipano.autorotate({ yawSpeed: 0.03, targetPitch: 0, targetFov: Math.PI / 2 });

    scenes = project.scenes.map(function (sceneData) {
      return { data: sceneData, scene: null, view: null };
    });
  }

  function ensureSceneLoaded(scene) {
    if (scene.scene && scene.view) return scene;
    var sceneData = scene.data;
    var source = Marzipano.ImageUrlSource.fromString(projectFileUrl(sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg"));
    var geometry = new Marzipano.CubeGeometry(sceneData.levels);
    var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180);
    var initialView = sceneData.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
    var view = new Marzipano.RectilinearView(initialView, limiter);
    var marzipanoScene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });

    (sceneData.infoHotspots || []).forEach(function (hotspot) {
      marzipanoScene.hotspotContainer().createHotspot(createInfoHotspot(hotspot), { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });
    (sceneData.linkHotspots || []).forEach(function (hotspot) {
      marzipanoScene.hotspotContainer().createHotspot(createLinkHotspot(hotspot), { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });

    scene.scene = marzipanoScene;
    scene.view = view;
    return scene;
  }

  function renderSceneList() {
    sceneItems.innerHTML = "";
    scenes.forEach(function (scene) {
      var link = document.createElement("a");
      var item = document.createElement("li");
      link.href = "javascript:void(0)";
      link.className = "scene";
      link.dataset.id = scene.data.id;
      item.className = "text";
      item.textContent = scene.data.name || scene.data.id;
      link.appendChild(item);
      link.addEventListener("click", function () {
        switchScene(scene);
        if (window.innerWidth <= 700) sceneList.classList.remove("enabled");
      });
      sceneItems.appendChild(link);
    });
  }

  function normalizeIdentifier(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function findInitialScene() {
    if (!initialSceneId) return scenes[0];
    var normalized = normalizeIdentifier(initialSceneId);
    return scenes.find(function (scene) {
      var data = scene.data || {};
      return data.id === initialSceneId ||
        data.sourceFile === initialSceneId ||
        data.name === initialSceneId ||
        normalizeIdentifier(data.id) === normalized ||
        normalizeIdentifier(data.sourceFile) === normalized ||
        normalizeIdentifier(data.name) === normalized;
    }) || scenes[0];
  }

  function switchScene(scene) {
    ensureSceneLoaded(scene);
    currentScene = scene;
    viewer.stopMovement();
    viewer.setIdleMovement(null);
    scene.view.setParameters(scene.data.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 });
    scene.scene.switchTo();
    sceneName.textContent = scene.data.name || scene.data.id;
    Array.prototype.forEach.call(sceneItems.children, function (item) {
      item.classList.toggle("current", item.dataset.id === scene.data.id);
    });
    updateMetadata(scene.data);
    updateMapMarkers();
    applyAutorotate(true);
  }

  function getScenePoint(scene) {
    var metadata = scene.data.metadata || {};
    var coordinates = metadata.coordinates;
    if (!coordinates) return null;
    var lat = Number(coordinates.latitude);
    var lon = Number(coordinates.longitude);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat: lat, lon: lon, altitude: metadata.altitude, height: metadata.height, takenAt: metadata.takenAt, scene: scene };
  }

  function formatCoords(coordinates) {
    if (!coordinates) return "Sem coordenadas";
    return Number(coordinates.latitude).toFixed(7) + ", " + Number(coordinates.longitude).toFixed(7);
  }

  function readCoordinates(coordinates) {
    if (!coordinates) return null;
    var latitude = Number(coordinates.latitude);
    var longitude = Number(coordinates.longitude);
    if (!isFinite(latitude) || !isFinite(longitude)) return null;
    return { latitude: latitude, longitude: longitude };
  }

  function formatDecimal(value, digits) {
    var number = Number(value);
    return isFinite(number) ? number.toFixed(digits) : "-";
  }

  function formatMeters(value) {
    var number = Number(value);
    return isFinite(number) ? number.toFixed(2) + " m" : "-";
  }

  function normalizeDegrees(value) {
    var number = Number(value);
    if (!isFinite(number)) return null;
    return ((number % 360) + 360) % 360;
  }

  function formatDegrees(value) {
    var number = normalizeDegrees(value);
    return number == null ? "-" : number.toFixed(1) + " deg";
  }

  function formatPhotoDate(value) {
    if (!value) return "Sem data";
    var match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      return match[3] + "/" + match[2] + "/" + match[1] + " " + match[4] + ":" + match[5];
    }
    var parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    }
    return String(value);
  }

  function photoLabel(sceneData) {
    return sceneData.name || sceneData.sourceFile || sceneData.id;
  }

  function readNumericMetadata(metadata, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = Number(metadata[keys[i]]);
      if (isFinite(value)) return value;
    }
    return 0;
  }

  function cameraHeadingOffset(sceneData) {
    var metadata = sceneData.metadata || {};
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

  function horizontalFovDegrees(params) {
    var verticalFov = Number(params.fov) || Math.PI / 2;
    var width = Math.max(1, panoElement.clientWidth || window.innerWidth || 1);
    var height = Math.max(1, panoElement.clientHeight || window.innerHeight || 1);
    return 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height)) * 180 / Math.PI;
  }

  function createViewDirectionElement() {
    var direction = document.createElement("span");
    var cone = document.createElement("span");
    direction.className = "map-view-direction";
    cone.className = "map-view-cone";
    direction.appendChild(cone);
    return direction;
  }

  function updateViewCone(indicator, params) {
    var cone = indicator.querySelector(".map-view-cone");
    if (!cone) return;
    var length = 62;
    var angle = Math.max(22, Math.min(110, horizontalFovDegrees(params)));
    var width = 2 * length * Math.tan((angle * Math.PI / 180) / 2);
    cone.style.width = Math.round(width) + "px";
    cone.style.height = length + "px";
  }

  function updateMetadata(sceneData) {
    var metadata = sceneData.metadata || {};
    metadataCoords.textContent = formatCoords(metadata.coordinates);
    metadataAltitude.textContent = metadata.altitude == null ? "Sem altitude" : metadata.altitude + " m";
    metadataHeight.textContent = metadata.height == null ? "Sem altura" : metadata.height + " m";
    metadataDate.textContent = formatPhotoDate(metadata.takenAt);
    metadataPhotoRow.hidden = !project.settings.showPhotoNames;
    metadataPhoto.textContent = sceneData.sourceFile || sceneData.name || sceneData.id;
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

  function chooseMapZoom(points, width, height) {
    if (points.length <= 1) return 17;
    for (var zoom = 18; zoom >= 2; zoom--) {
      var xs = points.map(function (point) { return lonToWorldX(point.lon, zoom); });
      var ys = points.map(function (point) { return latToWorldY(point.lat, zoom); });
      var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      if (spanX <= width - 70 && spanY <= height - 70) return zoom;
    }
    return 2;
  }

  function fitMapToPoints() {
    if (!mapPoints.length) return;
    var width = photoMap.clientWidth || 320;
    var height = photoMap.clientHeight || 220;
    var centerX = mapPoints.reduce(function (sum, point) { return sum + lonToWorldX(point.lon, 18); }, 0) / mapPoints.length;
    var centerY = mapPoints.reduce(function (sum, point) { return sum + latToWorldY(point.lat, 18); }, 0) / mapPoints.length;
    mapState.zoom = chooseMapZoom(mapPoints, width, height);
    mapState.lon = worldXToLon(centerX / Math.pow(2, 18 - mapState.zoom), mapState.zoom);
    mapState.lat = worldYToLat(centerY / Math.pow(2, 18 - mapState.zoom), mapState.zoom);
  }

  function tileUrl(template, level, col, row) {
    return template
      .replace("{level}", level)
      .replace("{col}", col)
      .replace("{row}", row);
  }

  function setPrintText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = value == null || value === "" ? "-" : String(value);
  }

  function renderPrintPano(sceneData, params) {
    var container = document.getElementById("printPanoLive");
    if (!container) return;
    if (printSceneId !== sceneData.id || !printViewer || !printScene) {
      container.innerHTML = "";
      printViewer = new Marzipano.Viewer(container, {
        controls: { mouseViewMode: project.settings.mouseViewMode || "drag" },
        stage: { progressive: true }
      });
      var source = Marzipano.ImageUrlSource.fromString(projectFileUrl(sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg"));
      var geometry = new Marzipano.CubeGeometry(sceneData.levels);
      var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180);
      var initialView = sceneData.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
      var view = new Marzipano.RectilinearView(initialView, limiter);
      printScene = {
        scene: printViewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true }),
        view: view
      };
      printSceneId = sceneData.id;
    }
    printScene.view.setParameters({
      yaw: params.yaw,
      pitch: params.pitch,
      fov: params.fov
    });
    if (printViewer && typeof printViewer.updateSize === "function") {
      printViewer.updateSize();
    }
    printScene.scene.switchTo();
  }

  function addPrintMapTile(container, url, col, row, left, top, className) {
    var image = document.createElement("img");
    image.alt = "";
    image.className = className;
    image.src = url;
    image.style.left = Math.round(col * 256 - left) + "px";
    image.style.top = Math.round(row * 256 - top) + "px";
    container.appendChild(image);
  }

  function renderPrintMap(sceneData, params) {
    var printMap = document.getElementById("printMap");
    var printMapTiles = document.getElementById("printMapTiles");
    var printMapView = document.getElementById("printMapView");
    var printMapCone = document.getElementById("printMapCone");
    if (!printMap || !printMapTiles || !printMapView || !printMapCone) return;

    printMapTiles.innerHTML = "";
    var metadata = sceneData.metadata || {};
    var coordinates = readCoordinates(metadata.coordinates);
    printMap.classList.toggle("missing", !coordinates);
    if (!coordinates) return;

    var width = printMap.clientWidth || 420;
    var height = printMap.clientHeight || 305;
    var zoom = Math.max(17, Math.min(20, mapState.zoom || 18));
    var size = Math.pow(2, zoom);
    var centerX = lonToWorldX(coordinates.longitude, zoom);
    var centerY = latToWorldY(coordinates.latitude, zoom);
    var left = centerX - width / 2;
    var top = centerY - height / 2;
    var minCol = Math.floor(left / 256);
    var maxCol = Math.floor((left + width) / 256);
    var minRow = Math.floor(top / 256);
    var maxRow = Math.floor((top + height) / 256);

    for (var row = minRow; row <= maxRow; row++) {
      if (row < 0 || row >= size) continue;
      for (var col = minCol; col <= maxCol; col++) {
        var wrappedCol = ((col % size) + size) % size;
        addPrintMapTile(printMapTiles, tileUrl(baseTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-base");
        addPrintMapTile(printMapTiles, tileUrl(overlayTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-overlay");
      }
    }

    var bearing = cameraHeadingOffset(sceneData) + (params.yaw * 180 / Math.PI);
    bearing = ((bearing % 360) + 360) % 360;
    var length = 62;
    var angle = Math.max(22, Math.min(110, horizontalFovDegrees(params)));
    var coneWidth = 2 * length * Math.tan((angle * Math.PI / 180) / 2);
    printMapCone.style.width = Math.round(coneWidth) + "px";
    printMapCone.style.height = length + "px";
    printMapView.style.transform = "rotate(" + bearing.toFixed(2) + "deg)";
  }

  function updatePrintLayout() {
    if (!printLayout || !currentScene || !currentScene.view) return;
    body.classList.add("print-preparing");

    var sceneData = currentScene.data;
    var metadata = sceneData.metadata || {};
    var coordinates = readCoordinates(metadata.coordinates);
    var params = currentScene.view.parameters();
    var cameraYaw = cameraHeadingOffset(sceneData);
    var viewYaw = cameraYaw + (params.yaw * 180 / Math.PI);
    var fov = horizontalFovDegrees(params);

    setPrintText("printProjectName", project.name || "Tour 360");
    setPrintText("printSceneTitle", sceneData.name || sceneData.id || "Cena");
    setPrintText("printPhotoName", sceneData.sourceFile || sceneData.name || sceneData.id || "-");
    setPrintText("printGeneratedAt", new Date().toLocaleString("pt-BR"));
    setPrintText("printArcgisPoint", metadata.arcgisPointId ? "PONTO " + metadata.arcgisPointId : "-");
    setPrintText("printCoords", coordinates ? formatCoords(metadata.coordinates) : "Sem coordenadas");
    setPrintText("printLatitude", coordinates ? formatDecimal(coordinates.latitude, 8) : "-");
    setPrintText("printLongitude", coordinates ? formatDecimal(coordinates.longitude, 8) : "-");
    setPrintText("printAltitude", formatMeters(metadata.altitude));
    setPrintText("printHeight", formatMeters(metadata.height));
    setPrintText("printPhotoDate", formatPhotoDate(metadata.takenAt));
    setPrintText("printCameraYaw", formatDegrees(cameraYaw));
    setPrintText("printViewYaw", formatDegrees(viewYaw));
    setPrintText("printFov", formatDegrees(fov));
    setPrintText("printUrl", window.location.href);

    renderPrintPano(sceneData, params);
    renderPrintMap(sceneData, params);
  }

  function waitForPrintImages(callback) {
    if (!printLayout) {
      callback();
      return;
    }
    var images = Array.prototype.slice.call(printLayout.querySelectorAll("img")).filter(function (image) {
      return image.getAttribute("src") && !image.complete;
    });
    if (!images.length) {
      window.setTimeout(callback, 650);
      return;
    }
    var remaining = images.length;
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      window.setTimeout(callback, 650);
    }
    function tick() {
      remaining -= 1;
      if (remaining <= 0) done();
    }
    window.setTimeout(done, 1400);
    images.forEach(function (image) {
      image.addEventListener("load", tick, { once: true });
      image.addEventListener("error", tick, { once: true });
    });
  }

  function printGeoreferencedLayout() {
    if (!currentScene) return;
    updatePrintLayout();
    waitForPrintImages(function () {
      window.print();
    });
  }

  function addMapTile(url, col, row, left, top, className) {
    var image = document.createElement("img");
    image.alt = "";
    image.className = className;
    image.src = url;
    image.style.left = Math.round(col * 256 - left) + "px";
    image.style.top = Math.round(row * 256 - top) + "px";
    mapTiles.appendChild(image);
  }

  function renderMap() {
    if (!mapPoints.length || !photoMap.clientWidth) return;
    mapTiles.innerHTML = "";
    var zoom = mapState.zoom;
    var size = Math.pow(2, zoom);
    var width = photoMap.clientWidth;
    var height = photoMap.clientHeight;
    var centerX = lonToWorldX(mapState.lon, zoom);
    var centerY = latToWorldY(mapState.lat, zoom);
    var left = centerX - width / 2;
    var top = centerY - height / 2;
    var minCol = Math.floor(left / 256);
    var maxCol = Math.floor((left + width) / 256);
    var minRow = Math.floor(top / 256);
    var maxRow = Math.floor((top + height) / 256);

    for (var row = minRow; row <= maxRow; row++) {
      if (row < 0 || row >= size) continue;
      for (var col = minCol; col <= maxCol; col++) {
        var wrappedCol = ((col % size) + size) % size;
        addMapTile(tileUrl(baseTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-base");
        addMapTile(tileUrl(overlayTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-overlay");
      }
    }
    updateMapMarkers();
  }

  function zoomMap(delta, origin) {
    if (!mapPoints.length) return;
    var oldZoom = mapState.zoom;
    var nextZoom = Math.max(2, Math.min(20, oldZoom + delta));
    if (nextZoom === oldZoom) return;

    if (origin && photoMap.clientWidth) {
      var rect = photoMap.getBoundingClientRect();
      var offsetX = origin.clientX - rect.left - photoMap.clientWidth / 2;
      var offsetY = origin.clientY - rect.top - photoMap.clientHeight / 2;
      var worldX = lonToWorldX(mapState.lon, oldZoom) + offsetX;
      var worldY = latToWorldY(mapState.lat, oldZoom) + offsetY;
      var scale = Math.pow(2, nextZoom - oldZoom);
      mapState.lon = worldXToLon((worldX * scale) - offsetX, nextZoom);
      mapState.lat = worldYToLat((worldY * scale) - offsetY, nextZoom);
    }

    mapState.zoom = nextZoom;
    renderMap();
  }

  function updateMapMarkers() {
    if (!mapPoints.length || !photoMap.clientWidth) return;
    mapMarkers.innerHTML = "";
    var zoom = mapState.zoom;
    var centerX = lonToWorldX(mapState.lon, zoom);
    var centerY = latToWorldY(mapState.lat, zoom);
    var left = centerX - photoMap.clientWidth / 2;
    var top = centerY - photoMap.clientHeight / 2;
    mapPoints.forEach(function (point) {
      var marker = document.createElement("button");
      var details = [];
      if (point.takenAt) details.push(formatPhotoDate(point.takenAt));
      if (point.height != null) details.push("altura " + point.height + " m");
      if (point.altitude != null) details.push("altitude " + point.altitude + " m");
      marker.type = "button";
      marker.className = "map-marker" + (currentScene && point.scene.data.id === currentScene.data.id ? " active" : "");
      marker.style.left = Math.round(lonToWorldX(point.lon, zoom) - left) + "px";
      marker.style.top = Math.round(latToWorldY(point.lat, zoom) - top) + "px";
      marker.title = details.length ? details.join(" | ") : "Abrir foto";
      if (currentScene && point.scene.data.id === currentScene.data.id) {
        marker.appendChild(createViewDirectionElement());
      }
      marker.addEventListener("click", function () { switchScene(point.scene); });
      mapMarkers.appendChild(marker);
    });
    updateCameraDirectionIndicator();
  }

  function updateCameraDirectionIndicator() {
    if (!currentScene || !mapMarkers) return;
    var indicator = mapMarkers.querySelector(".map-view-direction");
    if (!indicator) return;
    var params = currentScene.view.parameters();
    var bearing = cameraHeadingOffset(currentScene.data) + (params.yaw * 180 / Math.PI);
    bearing = ((bearing % 360) + 360) % 360;
    updateViewCone(indicator, params);
    indicator.style.transform = "rotate(" + bearing.toFixed(2) + "deg)";
  }

  function runCameraDirectionLoop() {
    updateCameraDirectionIndicator();
    cameraDirectionFrame = requestAnimationFrame(runCameraDirectionLoop);
  }

  function panMap(start, event) {
    var centerX = start.centerX - (event.clientX - start.x);
    var centerY = start.centerY - (event.clientY - start.y);
    mapState.lon = worldXToLon(centerX, mapState.zoom);
    mapState.lat = worldYToLat(centerY, mapState.zoom);
    renderMap();
  }

  function setupMap() {
    mapPoints = scenes.map(getScenePoint).filter(Boolean);
    if (!mapPoints.length) {
      body.classList.add("hide-map");
      return;
    }
    fitMapToPoints();
    metadataPanel.classList.add("enabled");
    renderMap();
    if (!cameraDirectionFrame) {
      runCameraDirectionLoop();
    }
  }

  function setupControls() {
    var controls = viewer.controls();
    var velocity = 0.7;
    var friction = 3;
    [["viewLeft", "x", -velocity], ["viewRight", "x", velocity], ["viewUp", "y", -velocity], ["viewDown", "y", velocity], ["viewIn", "zoom", -velocity], ["viewOut", "zoom", velocity]].forEach(function (item) {
      controls.registerMethod(item[0], new Marzipano.ElementPressControlMethod(document.getElementById(item[0]), item[1], item[2], friction), true);
    });
  }

  sceneListToggle.addEventListener("click", function () {
    sceneList.classList.toggle("enabled");
    sceneListToggle.classList.toggle("enabled");
  });

  metadataToggle.addEventListener("click", function () {
    metadataPanel.classList.toggle("enabled");
    metadataToggle.classList.toggle("enabled");
    metadataToggle.setAttribute("aria-expanded", metadataPanel.classList.contains("enabled") ? "true" : "false");
    renderMap();
  });

  metadataClose.addEventListener("click", function () {
    metadataPanel.classList.remove("enabled");
    metadataToggle.classList.remove("enabled");
    metadataToggle.setAttribute("aria-expanded", "false");
  });

  mapZoomIn.addEventListener("click", function () {
    zoomMap(1);
  });

  mapZoomOut.addEventListener("click", function () {
    zoomMap(-1);
  });

  mapRecenter.addEventListener("click", function () {
    fitMapToPoints();
    renderMap();
  });

  if (printGeoButton) {
    printGeoButton.addEventListener("click", function () {
      printGeoreferencedLayout();
    });
  }

  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && String(event.key || "").toLowerCase() === "p") {
      event.preventDefault();
      printGeoreferencedLayout();
    }
  });

  window.addEventListener("beforeprint", function () {
    updatePrintLayout();
  });

  window.addEventListener("afterprint", function () {
    body.classList.remove("print-preparing");
  });

  photoMap.addEventListener("pointerdown", function (event) {
    if (!mapPoints.length || event.button !== 0 || event.target.closest(".photo-map-controls, .map-marker")) return;
    mapDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      centerX: lonToWorldX(mapState.lon, mapState.zoom),
      centerY: latToWorldY(mapState.lat, mapState.zoom)
    };
    photoMap.classList.add("dragging");
    photoMap.setPointerCapture(event.pointerId);
  });

  photoMap.addEventListener("pointermove", function (event) {
    if (!mapDrag || mapDrag.id !== event.pointerId) return;
    panMap(mapDrag, event);
  });

  function endMapDrag(event) {
    if (!mapDrag || mapDrag.id !== event.pointerId) return;
    mapDrag = null;
    photoMap.classList.remove("dragging");
    if (photoMap.hasPointerCapture(event.pointerId)) {
      photoMap.releasePointerCapture(event.pointerId);
    }
  }

  photoMap.addEventListener("pointerup", endMapDrag);
  photoMap.addEventListener("pointercancel", endMapDrag);

  photoMap.addEventListener("wheel", function (event) {
    if (!mapPoints.length) return;
    event.preventDefault();
    zoomMap(event.deltaY < 0 ? 1 : -1, event);
  }, { passive: false });

  function updateAutorotateButton() {
    var enabled = !!(project && project.settings && project.settings.autorotate);
    autorotateToggle.classList.toggle("enabled", enabled);
    autorotateToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    autorotateToggle.textContent = enabled ? "❚❚" : "▶";
    autorotateToggle.title = enabled ? "Pausar autorrotacao" : "Iniciar autorrotacao";
  }

  function applyAutorotate(immediate) {
    if (!viewer) return;
    viewer.setIdleMovement(null);
    if (project.settings.autorotate) {
      if (immediate) {
        viewer.startMovement(autorotate);
      } else {
        viewer.setIdleMovement(3000, autorotate);
      }
    } else {
      viewer.stopMovement();
    }
    updateAutorotateButton();
  }

  autorotateToggle.addEventListener("click", function (event) {
    event.preventDefault();
    if (!viewer) return;
    project.settings.autorotate = !project.settings.autorotate;
    applyAutorotate(true);
  });

  fullscreenToggle.addEventListener("click", function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  window.addEventListener("resize", renderMap);

  function waitForScenes() {
    requestJSON("/api/projects/" + projectId + "/progress").then(function (state) {
      var message = state.message || "Nenhum panorama processado neste projeto.";
      if (state.status === "processing") {
        showEmptyState(message);
        pollTimer = setTimeout(loadProject, 1200);
        return;
      }
      if (state.status === "ready" || state.status === "unknown") {
        showEmptyState("Adicione panoramas no editor para liberar a visualizacao do tour.");
        return;
      }
      if (state.status === "failed") {
        showEmptyState(message);
        return;
      }
      showEmptyState("Nenhum panorama processado neste projeto.");
    }).catch(function () {
      showEmptyState("Adicione panoramas no editor para liberar a visualizacao do tour.");
    });
  }

  function initializeViewer() {
    if (initialized) return;
    initialized = true;
    hideEmptyState();
    body.classList.toggle("single-scene", project.scenes.length === 1);
    body.classList.toggle("multiple-scenes", project.scenes.length > 1);
    body.classList.toggle("hide-controls", project.settings.controls === false);
    body.classList.toggle("hide-fullscreen", project.settings.fullscreen === false);
    body.classList.toggle("hide-scenes", project.settings.sceneList === false || !showBtnList);
    buildScenes();
    renderSceneList();
    setupControls();
    setupMap();
    updateAutorotateButton();
    if (showBtnList && project.settings.sceneList !== false && project.scenes.length > 1) {
      sceneList.classList.add("enabled");
      sceneListToggle.classList.add("enabled");
    }
    switchScene(findInitialScene());
  }

  function loadProject() {
    if (embeddedProject) {
      var payload = embeddedProject;
      embeddedProject = null;
      applyProject(payload);
      return;
    }
    requestJSON("/api/projects/" + projectId).then(function (payload) {
      applyProject(payload);
    }).catch(function (error) {
      emptyState.hidden = false;
      emptyTitle.textContent = error.message;
      emptyMessage.textContent = "Verifique se o projeto ainda existe no disco temporario.";
      body.classList.add("single-scene", "hide-controls", "hide-map");
    });
  }

  function applyProject(payload) {
    project = payload;
    project.settings = project.settings || {};
    project.scenes = project.scenes || [];
    setupProjectChrome();
    if (!project.scenes.length) {
      waitForScenes();
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    initializeViewer();
  }

  loadProject();
})();

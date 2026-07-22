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
  var mapExpandToggle = document.getElementById("mapExpandToggle");
  var printGeoButton = document.getElementById("printGeoButton");
  var printLayout = document.getElementById("printLayout");
  var sketchToggle = document.getElementById("sketchToggle");
  var sketchClear = document.getElementById("sketchClear");
  var sketchUndo = document.getElementById("sketchUndo");
  var sketchFinishPolygon = document.getElementById("sketchFinishPolygon");
  var annotationOverlay = document.getElementById("annotationOverlay");
  var printAnnotationOverlay = document.getElementById("printAnnotationOverlay");
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
  var printInProgress = false;
  var printButtonLabel = printGeoButton ? printGeoButton.textContent : "Print";
  var sketchDrawing = false;
  var sketchMode = "draw";
  var sketchAnnotations = {};
  var activeStroke = null;
  var pendingPolygon = null;
  var selectedAnnotationId = null;
  var selectedVertexIndex = null;
  var editDrag = null;
  var baseTileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var overlayTileUrlTemplate = "https://tiles.arcgis.com/tiles/MRbkurfLm8nmQrDq/arcgis/rest/services/RasterLrv2026_1/MapServer/tile/{level}/{row}/{col}";
  var labelTileUrlTemplate = "https://mt1.google.com/vt/lyrs=h&hl=pt-BR&z={level}&x={col}&y={row}";
  var initialized = false;
  var pollTimer = null;
  var embeddedProject = window.__PROJECT_DATA__ || null;
  var panoramaZoomMultiplier = 3;

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

  function isMapViewConeEnabled() {
    return !(project && project.settings && project.settings.showMapViewCone === false);
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
    var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize * panoramaZoomMultiplier, 100 * Math.PI / 180, 120 * Math.PI / 180);
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

  function sceneMatchesIdentifier(scene, value) {
    if (!scene || !value) return false;
    var data = scene.data || {};
    var normalized = normalizeIdentifier(value);
    return data.id === value ||
      data.sourceFile === value ||
      data.name === value ||
      normalizeIdentifier(data.id) === normalized ||
      normalizeIdentifier(data.sourceFile) === normalized ||
      normalizeIdentifier(data.name) === normalized;
  }

  function findInitialScene() {
    if (!initialSceneId) return scenes[0];
    return scenes.find(function (scene) {
      return sceneMatchesIdentifier(scene, initialSceneId);
    }) || scenes[0];
  }

  function hasExplicitInitialScene(scene) {
    return !!initialSceneId && sceneMatchesIdentifier(scene, initialSceneId);
  }

  function switchScene(scene) {
    ensureSceneLoaded(scene);
    currentScene = scene;
    activeStroke = null;
    pendingPolygon = null;
    selectedAnnotationId = null;
    selectedVertexIndex = null;
    editDrag = null;
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
    updateSketchState();
    renderAnnotations();
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

  function normalizeSignedDegrees(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    number = ((number + 180) % 360 + 360) % 360 - 180;
    return Math.abs(number) < 0.000001 ? 0 : number;
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
    var metadataHeading = readNumericMetadata(metadata, [
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
    return metadataHeading + normalizeSignedDegrees(sceneData.headingOffset);
  }

  function horizontalFovRadians(params, width, height) {
    var verticalFov = Number(params.fov) || Math.PI / 2;
    width = Math.max(1, width || 1);
    height = Math.max(1, height || 1);
    return 2 * Math.atan(Math.tan(verticalFov / 2) * (width / height));
  }

  function horizontalFovDegrees(params) {
    var width = panoElement.clientWidth || window.innerWidth || 1;
    var height = panoElement.clientHeight || window.innerHeight || 1;
    return horizontalFovRadians(params, width, height) * 180 / Math.PI;
  }

  function printVerticalFov(params, container) {
    var sourceWidth = panoElement.clientWidth || window.innerWidth || 1;
    var sourceHeight = panoElement.clientHeight || window.innerHeight || 1;
    var targetWidth = container.clientWidth || sourceWidth;
    var targetHeight = container.clientHeight || sourceHeight;
    var horizontalFov = horizontalFovRadians(params, sourceWidth, sourceHeight);
    var targetAspect = Math.max(0.01, targetWidth / Math.max(1, targetHeight));
    return Math.max(0.001, Math.min(Math.PI - 0.001, 2 * Math.atan(Math.tan(horizontalFov / 2) / targetAspect)));
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
    var usableWidth = Math.max(80, width - 70);
    var usableHeight = Math.max(80, height - 70);
    for (var zoom = 18; zoom >= 2; zoom--) {
      var xs = points.map(function (point) { return lonToWorldX(point.lon, zoom); });
      var ys = points.map(function (point) { return latToWorldY(point.lat, zoom); });
      var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      if (spanX <= usableWidth && spanY <= usableHeight) return zoom;
    }
    return 2;
  }

  function fitMapToPoints() {
    if (!mapPoints.length) return;
    var width = photoMap.clientWidth || 320;
    var height = photoMap.clientHeight || 220;
    mapState.zoom = chooseMapZoom(mapPoints, width, height);
    var xs = mapPoints.map(function (point) { return lonToWorldX(point.lon, mapState.zoom); });
    var ys = mapPoints.map(function (point) { return latToWorldY(point.lat, mapState.zoom); });
    var centerX = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
    var centerY = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
    mapState.lon = worldXToLon(centerX, mapState.zoom);
    mapState.lat = worldYToLat(centerY, mapState.zoom);
  }

  function mapPointForScene(scene) {
    if (!scene) return null;
    return mapPoints.find(function (point) {
      return point.scene === scene || point.scene.data.id === scene.data.id;
    }) || null;
  }

  function focusMapOnScene(scene) {
    var point = mapPointForScene(scene);
    if (!point) {
      fitMapToPoints();
      return;
    }
    mapState.lat = point.lat;
    mapState.lon = point.lon;
    mapState.zoom = Math.max(17, Math.min(19, mapState.zoom || 18));
    if (mapPoints.length > 1 && mapState.zoom < 18) {
      mapState.zoom = 16;
    }
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

  function sketchStorageKey() {
    return "marzipano-sketch-" + projectId;
  }

  function loadSketchAnnotations() {
    try {
      var stored = localStorage.getItem(sketchStorageKey());
      sketchAnnotations = stored ? JSON.parse(stored) || {} : {};
    } catch (error) {
      sketchAnnotations = {};
    }
    normalizeSketchAnnotations();
    updateSketchState();
  }

  function saveSketchAnnotations() {
    try {
      localStorage.setItem(sketchStorageKey(), JSON.stringify(sketchAnnotations));
    } catch (error) { }
    updateSketchState();
  }

  function normalizeSketchAnnotations() {
    var changed = false;
    Object.keys(sketchAnnotations).forEach(function (sceneId) {
      if (!Array.isArray(sketchAnnotations[sceneId])) {
        sketchAnnotations[sceneId] = [];
        changed = true;
        return;
      }
      var filtered = sketchAnnotations[sceneId].filter(function (annotation) {
        return annotation && annotation.type !== "measure";
      });
      if (filtered.length !== sketchAnnotations[sceneId].length) {
        sketchAnnotations[sceneId] = filtered;
        changed = true;
      }
      sketchAnnotations[sceneId].forEach(function (annotation) {
        if (!annotation.id) {
          annotation.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
          changed = true;
        }
      });
    });
    if (changed) {
      try {
        localStorage.setItem(sketchStorageKey(), JSON.stringify(sketchAnnotations));
      } catch (error) { }
    }
  }

  function activeSceneId() {
    return currentScene && currentScene.data ? currentScene.data.id : "";
  }

  function sceneSketches(sceneId) {
    sceneId = sceneId || activeSceneId();
    if (!sceneId) return [];
    if (!Array.isArray(sketchAnnotations[sceneId])) {
      sketchAnnotations[sceneId] = [];
    }
    return sketchAnnotations[sceneId];
  }

  function hasAnySketch() {
    return Object.keys(sketchAnnotations).some(function (sceneId) {
      return Array.isArray(sketchAnnotations[sceneId]) && sketchAnnotations[sceneId].length > 0;
    });
  }

  function updateSketchState() {
    body.classList.toggle("sketch-has-drawing", hasAnySketch() || !!pendingPolygon || !!activeStroke);
    if (sketchFinishPolygon) {
      sketchFinishPolygon.disabled = !(pendingPolygon && pendingPolygon.points.length >= 3);
    }
  }

  function setSketchMode(mode) {
    sketchMode = mode || "draw";
    if (pendingPolygon && sketchMode !== "polygon") {
      pendingPolygon = null;
    }
    if (sketchMode !== "edit") {
      selectedAnnotationId = null;
      selectedVertexIndex = null;
      editDrag = null;
    }
    ["draw", "text", "polygon", "edit"].forEach(function (item) {
      body.classList.toggle("sketch-mode-" + item, sketchMode === item);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-sketch-mode]"), function (button) {
      button.classList.toggle("enabled", button.dataset.sketchMode === sketchMode);
    });
    updateSketchState();
    renderAnnotations();
  }

  function createSvgElement(name) {
    return document.createElementNS("http://www.w3.org/2000/svg", name);
  }

  function resizeAnnotationOverlay() {
    if (!annotationOverlay) return;
    var rect = panoElement.getBoundingClientRect();
    annotationOverlay.setAttribute("viewBox", "0 0 " + Math.max(1, Math.round(rect.width)) + " " + Math.max(1, Math.round(rect.height)));
  }

  function screenPointToView(event) {
    if (!currentScene || !currentScene.view || !annotationOverlay) return null;
    var rect = annotationOverlay.getBoundingClientRect();
    return currentScene.view.screenToCoordinates({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  }

  function projectPoint(view, point) {
    var projected = view.coordinatesToScreen({ yaw: point.yaw, pitch: point.pitch });
    if (!projected || projected.x == null || projected.y == null) return null;
    return projected;
  }

  function screenPointFromEvent(event) {
    if (!annotationOverlay) return null;
    var rect = annotationOverlay.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function distanceBetweenScreenPoints(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function distanceToSegment(point, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return distanceBetweenScreenPoints(point, a);
    var t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return distanceBetweenScreenPoints(point, {
      x: a.x + t * dx,
      y: a.y + t * dy
    });
  }

  function annotationPoints(annotation) {
    if (!annotation) return [];
    if (annotation.type === "text") return [annotation];
    return Array.isArray(annotation.points) ? annotation.points : [];
  }

  function findAnnotationById(id) {
    if (!id) return null;
    return sceneSketches().find(function (annotation) {
      return annotation.id === id;
    }) || null;
  }

  function findPolygonVertexAt(screenPoint) {
    var annotations = sceneSketches();
    var best = null;
    for (var index = annotations.length - 1; index >= 0; index--) {
      var annotation = annotations[index];
      if (!annotation || annotation.type !== "polygon" || !Array.isArray(annotation.points)) continue;
      annotation.points.forEach(function (point, vertexIndex) {
        var projected = projectPoint(currentScene.view, point);
        if (!projected) return;
        var distance = distanceBetweenScreenPoints(screenPoint, projected);
        if (distance <= 16 && (!best || distance < best.distance)) {
          best = {
            annotation: annotation,
            vertexIndex: vertexIndex,
            distance: distance
          };
        }
      });
      if (best && best.distance <= 8) break;
    }
    return best;
  }

  function annotationHitDistance(annotation, screenPoint) {
    var points = annotationPoints(annotation).map(function (point) {
      return projectPoint(currentScene.view, point);
    }).filter(Boolean);
    if (!points.length) return Infinity;
    if (annotation.type === "text") return distanceBetweenScreenPoints(screenPoint, points[0]);
    if (points.length === 1) return distanceBetweenScreenPoints(screenPoint, points[0]);
    var best = Infinity;
    points.forEach(function (point, index) {
      best = Math.min(best, distanceBetweenScreenPoints(screenPoint, point));
      if (index > 0) {
        best = Math.min(best, distanceToSegment(screenPoint, points[index - 1], point));
      }
    });
    if (annotation.type === "polygon" && points.length > 2) {
      best = Math.min(best, distanceToSegment(screenPoint, points[points.length - 1], points[0]));
    }
    return best;
  }

  function findAnnotationAt(screenPoint) {
    var annotations = sceneSketches();
    for (var index = annotations.length - 1; index >= 0; index--) {
      var annotation = annotations[index];
      var distance = annotationHitDistance(annotation, screenPoint);
      var threshold = annotation.type === "text" ? 32 : 16;
      if (distance <= threshold) return annotation;
    }
    return null;
  }

  function cloneAnnotation(annotation) {
    return JSON.parse(JSON.stringify(annotation));
  }

  function clampPitch(value) {
    var limit = Math.PI / 2 - 0.001;
    return Math.max(-limit, Math.min(limit, value));
  }

  function yawDelta(current, start) {
    var delta = current - start;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  function applyMovedPoint(target, source, deltaYaw, deltaPitch) {
    target.yaw = source.yaw + deltaYaw;
    target.pitch = clampPitch(source.pitch + deltaPitch);
  }

  function moveAnnotation(annotation, original, startPoint, currentPoint) {
    var deltaYaw = yawDelta(currentPoint.yaw, startPoint.yaw);
    var deltaPitch = currentPoint.pitch - startPoint.pitch;
    if (annotation.type === "text") {
      applyMovedPoint(annotation, original, deltaYaw, deltaPitch);
      return;
    }
    var targetPoints = annotationPoints(annotation);
    var sourcePoints = annotationPoints(original);
    targetPoints.forEach(function (point, index) {
      if (sourcePoints[index]) applyMovedPoint(point, sourcePoints[index], deltaYaw, deltaPitch);
    });
  }

  function moveAnnotationVertex(annotation, vertexIndex, point) {
    if (!annotation || !Array.isArray(annotation.points) || !annotation.points[vertexIndex]) return;
    annotation.points[vertexIndex].yaw = point.yaw;
    annotation.points[vertexIndex].pitch = clampPitch(point.pitch);
  }

  function beginEditAnnotation(event, point) {
    var screenPoint = screenPointFromEvent(event);
    var vertexHit = screenPoint ? findPolygonVertexAt(screenPoint) : null;
    if (vertexHit) {
      selectedAnnotationId = vertexHit.annotation.id;
      selectedVertexIndex = vertexHit.vertexIndex;
      event.preventDefault();
      editDrag = {
        id: vertexHit.annotation.id,
        mode: "vertex",
        vertexIndex: vertexHit.vertexIndex,
        moved: false
      };
      if (annotationOverlay && annotationOverlay.setPointerCapture) {
        annotationOverlay.setPointerCapture(event.pointerId);
      }
      renderAnnotations();
      return;
    }
    var annotation = screenPoint ? findAnnotationAt(screenPoint) : null;
    selectedAnnotationId = annotation ? annotation.id : null;
    selectedVertexIndex = null;
    if (!annotation) {
      editDrag = null;
      renderAnnotations();
      return;
    }
    event.preventDefault();
    editDrag = {
      id: annotation.id,
      mode: "annotation",
      startPoint: point,
      original: cloneAnnotation(annotation),
      moved: false
    };
    if (annotationOverlay && annotationOverlay.setPointerCapture) {
      annotationOverlay.setPointerCapture(event.pointerId);
    }
    renderAnnotations();
  }

  function drawEditAnnotation(event) {
    if (!editDrag) return false;
    var point = screenPointToView(event);
    if (!point) return true;
    var annotation = findAnnotationById(editDrag.id);
    if (!annotation) return true;
    event.preventDefault();
    if (editDrag.mode === "vertex") {
      moveAnnotationVertex(annotation, editDrag.vertexIndex, point);
      selectedVertexIndex = editDrag.vertexIndex;
    } else {
      moveAnnotation(annotation, editDrag.original, editDrag.startPoint, point);
    }
    editDrag.moved = true;
    renderAnnotations();
    return true;
  }

  function endEditAnnotation(event) {
    if (!editDrag) return false;
    if (annotationOverlay && annotationOverlay.hasPointerCapture && annotationOverlay.hasPointerCapture(event.pointerId)) {
      annotationOverlay.releasePointerCapture(event.pointerId);
    }
    if (editDrag.moved) {
      saveSketchAnnotations();
    }
    editDrag = null;
    renderAnnotations();
    return true;
  }

  function editTextAnnotation(annotation) {
    if (!annotation || annotation.type !== "text") return;
    var nextText = window.prompt("Texto da anotação:", annotation.text || "");
    if (nextText == null) return;
    nextText = nextText.trim();
    if (!nextText) return;
    annotation.text = nextText;
    selectedAnnotationId = annotation.id;
    saveSketchAnnotations();
    renderAnnotations();
  }

  function deleteSelectedAnnotation() {
    if (!selectedAnnotationId) return;
    var annotations = sceneSketches();
    var index = annotations.findIndex(function (annotation) {
      return annotation.id === selectedAnnotationId;
    });
    if (index === -1) return;
    var annotation = annotations[index];
    if (annotation.type === "polygon" && selectedVertexIndex != null && Array.isArray(annotation.points) && annotation.points.length > 3) {
      annotation.points.splice(selectedVertexIndex, 1);
      selectedVertexIndex = null;
      saveSketchAnnotations();
      renderAnnotations();
      return;
    }
    annotations.splice(index, 1);
    selectedAnnotationId = null;
    selectedVertexIndex = null;
    saveSketchAnnotations();
    renderAnnotations();
  }

  function appendPolyline(svg, view, points, className) {
    var current = [];
    points.forEach(function (point) {
      var projected = projectPoint(view, point);
      if (!projected) {
        if (current.length > 1) appendPolylineElement(svg, current, className);
        current = [];
        return;
      }
      current.push(projected);
    });
    if (current.length > 1) appendPolylineElement(svg, current, className);
  }

  function appendPolylineElement(svg, points, className) {
    var polyline = createSvgElement("polyline");
    polyline.setAttribute("class", className);
    polyline.setAttribute("points", points.map(function (point) {
      return point.x.toFixed(1) + "," + point.y.toFixed(1);
    }).join(" "));
    svg.appendChild(polyline);
  }

  function appendPolygon(svg, view, points, className) {
    var projected = points.map(function (point) { return projectPoint(view, point); }).filter(Boolean);
    if (projected.length < 2) return;
    var element = createSvgElement(projected.length >= 3 && className.indexOf("annotation-polygon") !== -1 ? "polygon" : "polyline");
    element.setAttribute("class", className);
    element.setAttribute("points", projected.map(function (point) {
      return point.x.toFixed(1) + "," + point.y.toFixed(1);
    }).join(" "));
    svg.appendChild(element);
    projected.forEach(function (point) {
      var vertex = createSvgElement("circle");
      vertex.setAttribute("class", "annotation-vertex");
      vertex.setAttribute("cx", point.x.toFixed(1));
      vertex.setAttribute("cy", point.y.toFixed(1));
      vertex.setAttribute("r", "4");
      svg.appendChild(vertex);
    });
  }

  function appendPointHandle(svg, view, point, className, radius) {
    var projected = projectPoint(view, point);
    if (!projected) return;
    var handle = createSvgElement("circle");
    handle.setAttribute("class", className);
    handle.setAttribute("cx", projected.x.toFixed(1));
    handle.setAttribute("cy", projected.y.toFixed(1));
    handle.setAttribute("r", String(radius || 5));
    svg.appendChild(handle);
  }

  function appendTextAnnotation(svg, view, annotation, selected) {
    var projected = projectPoint(view, annotation);
    if (!projected) return;
    ["annotation-text-shadow", "annotation-text"].forEach(function (className) {
      var text = createSvgElement("text");
      text.setAttribute("class", className + (selected ? " annotation-selected" : ""));
      text.setAttribute("x", projected.x.toFixed(1));
      text.setAttribute("y", projected.y.toFixed(1));
      text.textContent = annotation.text || "";
      svg.appendChild(text);
    });
  }

  function appendSelectionHandles(svg, view, annotation) {
    annotationPoints(annotation).forEach(function (point, index) {
      var className = "annotation-selection-handle";
      if (annotation.id === selectedAnnotationId && index === selectedVertexIndex) {
        className += " annotation-handle-active";
      }
      appendPointHandle(svg, view, point, className, annotation.type === "text" ? 6 : 5);
    });
  }

  function renderAnnotationLayer(svg, view, annotations, options) {
    if (!svg || !view) return;
    var width = svg.clientWidth || panoElement.clientWidth || 1;
    var height = svg.clientHeight || panoElement.clientHeight || 1;
    svg.setAttribute("viewBox", "0 0 " + Math.max(1, Math.round(width)) + " " + Math.max(1, Math.round(height)));
    svg.innerHTML = "";
    annotations.forEach(function (annotation) {
      var selected = options && options.selectedId === annotation.id;
      var selectedClass = selected ? " annotation-selected" : "";
      if (annotation.type === "stroke") appendPolyline(svg, view, annotation.points || [], "annotation-stroke" + selectedClass);
      if (annotation.type === "polygon") appendPolygon(svg, view, annotation.points || [], "annotation-polygon" + selectedClass);
      if (annotation.type === "text") appendTextAnnotation(svg, view, annotation, selected);
      if (selected && options && options.showSelection) appendSelectionHandles(svg, view, annotation);
    });
    if (options && options.pendingPolygon && options.pendingPolygon.points.length) {
      appendPolygon(svg, view, options.pendingPolygon.points, "annotation-pending");
    }
    if (options && options.activeStroke && options.activeStroke.points.length > 1) {
      appendPolyline(svg, view, options.activeStroke.points, "annotation-stroke annotation-pending");
    }
  }

  function renderAnnotations() {
    if (!currentScene || !currentScene.view) return;
    resizeAnnotationOverlay();
    renderAnnotationLayer(annotationOverlay, currentScene.view, sceneSketches(), {
      pendingPolygon: pendingPolygon,
      activeStroke: activeStroke,
      selectedId: selectedAnnotationId,
      showSelection: sketchMode === "edit",
      sceneData: currentScene.data
    });
  }

  function renderPrintAnnotations(sceneData) {
    if (!printAnnotationOverlay || !printScene || !printScene.view) return;
    renderAnnotationLayer(printAnnotationOverlay, printScene.view, sceneSketches(sceneData.id), {
      sceneData: sceneData
    });
  }

  function addSketchAnnotation(annotation) {
    annotation.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    sceneSketches().push(annotation);
    saveSketchAnnotations();
    renderAnnotations();
  }

  function clearSketch() {
    var sceneId = activeSceneId();
    if (!sceneId) return;
    sketchAnnotations[sceneId] = [];
    activeStroke = null;
    pendingPolygon = null;
    selectedAnnotationId = null;
    selectedVertexIndex = null;
    editDrag = null;
    saveSketchAnnotations();
    renderAnnotations();
  }

  function undoSketch() {
    var annotations = sceneSketches();
    if (pendingPolygon && pendingPolygon.points.length) {
      pendingPolygon.points.pop();
      if (!pendingPolygon.points.length) pendingPolygon = null;
    } else {
      var removed = annotations.pop();
      if (removed && removed.id === selectedAnnotationId) selectedAnnotationId = null;
      selectedVertexIndex = null;
      saveSketchAnnotations();
    }
    updateSketchState();
    renderAnnotations();
  }

  function finishPolygon() {
    if (!pendingPolygon || pendingPolygon.points.length < 3) return;
    addSketchAnnotation({ type: "polygon", points: pendingPolygon.points.slice() });
    pendingPolygon = null;
    updateSketchState();
    renderAnnotations();
  }

  function beginSketch(event) {
    if (!body.classList.contains("sketch-active")) return;
    if (event.button != null && event.button !== 0) return;
    var point = screenPointToView(event);
    if (!point) return;
    event.preventDefault();
    if (sketchMode === "edit") {
      beginEditAnnotation(event, point);
      return;
    }
    if (sketchMode === "text") {
      var text = window.prompt("Texto da anotação:");
      if (text && text.trim()) {
        addSketchAnnotation({ type: "text", yaw: point.yaw, pitch: point.pitch, text: text.trim() });
      }
      return;
    }
    if (sketchMode === "polygon") {
      if (!pendingPolygon) pendingPolygon = { type: "polygon", points: [] };
      pendingPolygon.points.push({ yaw: point.yaw, pitch: point.pitch });
      updateSketchState();
      renderAnnotations();
      return;
    }
    sketchDrawing = true;
    activeStroke = { type: "stroke", points: [{ yaw: point.yaw, pitch: point.pitch }] };
    if (annotationOverlay && annotationOverlay.setPointerCapture) {
      annotationOverlay.setPointerCapture(event.pointerId);
    }
  }

  function drawSketch(event) {
    if (drawEditAnnotation(event)) return;
    if (!sketchDrawing || !activeStroke) return;
    var point = screenPointToView(event);
    if (!point) return;
    event.preventDefault();
    var points = activeStroke.points;
    var last = points[points.length - 1];
    if (Math.abs(point.yaw - last.yaw) + Math.abs(point.pitch - last.pitch) < 0.002) return;
    points.push({ yaw: point.yaw, pitch: point.pitch });
    updateSketchState();
    renderAnnotations();
  }

  function endSketch(event) {
    if (endEditAnnotation(event)) return;
    if (!sketchDrawing) return;
    sketchDrawing = false;
    if (annotationOverlay && annotationOverlay.hasPointerCapture && annotationOverlay.hasPointerCapture(event.pointerId)) {
      annotationOverlay.releasePointerCapture(event.pointerId);
    }
    if (activeStroke && activeStroke.points.length > 1) {
      addSketchAnnotation({ type: "stroke", points: activeStroke.points.slice() });
    }
    activeStroke = null;
    updateSketchState();
    renderAnnotations();
  }

  function renderPrintPano(sceneData, params) {
    var container = document.getElementById("printPanoLive");
    if (!container) return;
    if (printSceneId !== sceneData.id || !printViewer || !printScene) {
      container.innerHTML = "";
      printViewer = new Marzipano.Viewer(container, {
        controls: { mouseViewMode: project.settings.mouseViewMode || "drag" },
        stage: { progressive: true, preserveDrawingBuffer: true }
      });
      var source = Marzipano.ImageUrlSource.fromString(projectFileUrl(sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg"));
      var geometry = new Marzipano.CubeGeometry(sceneData.levels);
      var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize * panoramaZoomMultiplier, 100 * Math.PI / 180, 120 * Math.PI / 180);
      var initialView = sceneData.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 };
      var view = new Marzipano.RectilinearView(initialView, limiter);
      printScene = {
        scene: printViewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true }),
        view: view
      };
      printSceneId = sceneData.id;
    }
    var fov = printVerticalFov(params, container);
    printScene.view.setParameters({
      yaw: params.yaw,
      pitch: params.pitch,
      fov: fov
    });
    if (printViewer && typeof printViewer.updateSize === "function") {
      printViewer.updateSize();
    }
    printScene.scene.switchTo();
    renderPrintAnnotations(sceneData);
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

    var showCone = isMapViewConeEnabled();
    printMapView.hidden = !showCone;
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
        addPrintMapTile(printMapTiles, tileUrl(labelTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-labels");
      }
    }

    if (!showCone) return;
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
    resizeAnnotationOverlay();
    renderAnnotations();

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
    setPrintText("printUrl", " ");

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
      window.setTimeout(callback, 900);
      return;
    }
    var remaining = images.length;
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      window.setTimeout(callback, 250);
    }
    function tick() {
      remaining -= 1;
      if (remaining <= 0) done();
    }
    window.setTimeout(done, 10000);
    images.forEach(function (image) {
      image.addEventListener("load", tick, { once: true });
      image.addEventListener("error", tick, { once: true });
    });
  }

  function setPrintBusy(isBusy) {
    printInProgress = !!isBusy;
    if (!printGeoButton) return;
    printGeoButton.disabled = !!isBusy;
    printGeoButton.classList.toggle("is-loading", !!isBusy);
    printGeoButton.setAttribute("aria-busy", isBusy ? "true" : "false");
    printGeoButton.textContent = isBusy ? "Preparando" : printButtonLabel;
  }

  function clearPrintPreparation() {
    body.classList.remove("print-preparing");
    setPrintBusy(false);
  }

  function viewerStylesheetHref() {
    var link = document.querySelector("link[href*='viewer.css']");
    return link ? link.href : "/static/viewer.css";
  }

  function writePrintPopupShell(popup) {
    var doc = popup.document;
    doc.open();
    doc.write([
      "<!doctype html>",
      "<html lang=\"pt-BR\">",
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
      "<title></title>",
      "<link rel=\"stylesheet\" href=\"" + viewerStylesheetHref().replace(/"/g, "&quot;") + "\">",
      "<style>",
      "html,body{margin:0;background:#fff;color:#17202a;}",
      "#printLayout{display:block!important;position:static!important;top:auto!important;left:auto!important;width:281mm;min-height:194mm;margin:0 auto;background:#fff;opacity:1!important;pointer-events:auto;}",
      "@media print{body>*:not(#printLayout){display:none!important;}#printLayout{display:block!important;position:static!important;width:281mm;min-height:194mm;margin:0 auto;background:#fff;opacity:1!important;}}",
      "</style>",
      "</head>",
      "<body><div style=\"padding:20px;font:14px Helvetica,Arial,sans-serif;color:#17202a;\">Preparando impressão.</div></body>",
      "</html>"
    ].join(""));
    doc.close();
  }

  function openPrintPopup() {
    var popup = window.open("about:blank", "_blank");
    if (!popup) return null;
    writePrintPopupShell(popup);
    return popup;
  }

  function currentPrintLayer() {
    if (!printScene || !printScene.scene || !printScene.scene.layer) return null;
    return printScene.scene.layer();
  }

  function waitForPrintPanoStable(callback, timeoutMs) {
    var layer = currentPrintLayer();
    var stage = printViewer && printViewer.stage ? printViewer.stage() : null;
    if (!layer || !stage) {
      callback(false);
      return;
    }

    var finished = false;
    var timeout = window.setTimeout(function () {
      finish(false);
    }, timeoutMs || 10000);

    function finish(isStable) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      layer.removeEventListener("renderComplete", onRenderComplete);
      callback(!!isStable);
    }

    function onRenderComplete(isStable) {
      if (!isStable) return;
      window.setTimeout(function () {
        finish(true);
      }, 180);
    }

    layer.addEventListener("renderComplete", onRenderComplete);
    try {
      stage.render();
    } catch (error) { }
  }

  function waitForPrintAssets(callback) {
    var panoDone = false;
    var panoStable = false;
    var imagesDone = false;

    function maybeDone() {
      if (panoDone && imagesDone) {
        callback(panoStable);
      }
    }

    waitForPrintPanoStable(function (isStable) {
      panoDone = true;
      panoStable = isStable;
      maybeDone();
    }, 10000);

    waitForPrintImages(function () {
      imagesDone = true;
      maybeDone();
    });
  }

  function capturePrintPanoSnapshot() {
    try {
      if (printViewer && printViewer.stage && printViewer.stage().takeSnapshot) {
        var stageSnapshot = printViewer.stage().takeSnapshot({ quality: 92 });
        if (stageSnapshot && stageSnapshot.length > 1000) return stageSnapshot;
      }
    } catch (error) { }
    var container = document.getElementById("printPanoLive");
    var canvas = container ? container.querySelector("canvas") : null;
    if (!canvas || !canvas.width || !canvas.height) return "";
    try {
      var directSnapshot = canvas.toDataURL("image/png");
      if (directSnapshot && directSnapshot.length > 1000) return directSnapshot;
    } catch (error) { }
    try {
      var buffer = document.createElement("canvas");
      buffer.width = canvas.width;
      buffer.height = canvas.height;
      var context = buffer.getContext("2d");
      if (!context) return "";
      context.drawImage(canvas, 0, 0);
      var copiedSnapshot = buffer.toDataURL("image/png");
      return copiedSnapshot && copiedSnapshot.length > 1000 ? copiedSnapshot : "";
    } catch (error) {
      return "";
    }
  }

  function waitForPrintPanoSnapshot(callback, attempts) {
    var snapshot = capturePrintPanoSnapshot();
    if (snapshot || attempts <= 0) {
      callback(snapshot);
      return;
    }
    window.setTimeout(function () {
      waitForPrintPanoSnapshot(callback, attempts - 1);
    }, 250);
  }

  function clonePrintLayoutForPopup(snapshotUrl) {
    if (!printLayout) return null;
    var clone = printLayout.cloneNode(true);
    clone.removeAttribute("aria-hidden");
    var livePano = clone.querySelector("#printPanoLive");
    if (livePano && snapshotUrl) {
      livePano.innerHTML = "";
      var image = document.createElement("img");
      image.className = "print-pano-snapshot";
      image.alt = "Vista atual do panorama";
      image.src = snapshotUrl;
      livePano.appendChild(image);
    }
    return clone;
  }

  function writePrintPopupLayout(popup, snapshotUrl) {
    if (!popup || popup.closed) return false;
    var clone = clonePrintLayoutForPopup(snapshotUrl);
    if (!clone) return false;
    popup.document.body.innerHTML = "";
    popup.document.body.appendChild(popup.document.importNode(clone, true));
    return true;
  }

  function waitForPopupImages(popup, callback) {
    if (!popup || popup.closed) {
      callback();
      return;
    }
    var images = Array.prototype.slice.call(popup.document.querySelectorAll("img")).filter(function (image) {
      return image.getAttribute("src") && !image.complete;
    });
    if (!images.length) {
      window.setTimeout(callback, 250);
      return;
    }
    var remaining = images.length;
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      window.setTimeout(callback, 250);
    }
    function tick() {
      remaining -= 1;
      if (remaining <= 0) done();
    }
    window.setTimeout(done, 1200);
    images.forEach(function (image) {
      image.addEventListener("load", tick, { once: true });
      image.addEventListener("error", tick, { once: true });
    });
  }

  function printPopupLayout(popup) {
    var cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearPrintPreparation();
      try {
        if (popup && !popup.closed) popup.close();
      } catch (error) { }
    }
    popup.addEventListener("afterprint", cleanup);
    popup.addEventListener("beforeunload", cleanup);
    try {
      popup.focus();
      popup.print();
    } catch (error) {
      cleanup();
    }
  }

  function printGeoreferencedLayout() {
    if (!currentScene || printInProgress) return;
    setPrintBusy(true);
    updatePrintLayout();
    waitForPrintAssets(function (panoStable) {
      if (!panoStable) {
        clearPrintPreparation();
        window.alert("A vista 360 ainda esta carregando. Tente imprimir novamente em alguns segundos.");
        return;
      }
      waitForPrintPanoSnapshot(function (snapshotUrl) {
        if (!snapshotUrl) {
          clearPrintPreparation();
          window.alert("Vista 360 nao ficou pronta para impressao. Tente imprimir novamente.");
          return;
        }
        var popup = openPrintPopup();
        if (!popup) {
          clearPrintPreparation();
          window.alert("Permita pop-ups para imprimir sem exibir a URL do projeto.");
          return;
        }
        if (!writePrintPopupLayout(popup, snapshotUrl)) {
          clearPrintPreparation();
          window.alert("Vista 360 nao ficou pronta para impressao. Tente imprimir novamente.");
          try {
            popup.close();
          } catch (error) { }
          return;
        }
        waitForPopupImages(popup, function () {
          printPopupLayout(popup);
        });
      }, 10);
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
        addMapTile(tileUrl(labelTileUrlTemplate, zoom, wrappedCol, row), col, row, left, top, "map-tile-labels");
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
    var width = photoMap.clientWidth;
    var height = photoMap.clientHeight;
    var left = centerX - width / 2;
    var top = centerY - height / 2;
    var margin = 56;
    var fragment = document.createDocumentFragment();
    mapPoints.forEach(function (point) {
      var markerX = lonToWorldX(point.lon, zoom) - left;
      var markerY = latToWorldY(point.lat, zoom) - top;
      if (markerX < -margin || markerX > width + margin || markerY < -margin || markerY > height + margin) {
        return;
      }
      var marker = document.createElement("button");
      var details = [];
      if (point.takenAt) details.push(formatPhotoDate(point.takenAt));
      if (point.height != null) details.push("altura " + point.height + " m");
      if (point.altitude != null) details.push("altitude " + point.altitude + " m");
      marker.type = "button";
      marker.className = "map-marker" + (currentScene && point.scene.data.id === currentScene.data.id ? " active" : "");
      marker.style.left = Math.round(markerX) + "px";
      marker.style.top = Math.round(markerY) + "px";
      marker.title = details.length ? details.join(" | ") : "Abrir foto";
      if (currentScene && point.scene.data.id === currentScene.data.id && isMapViewConeEnabled()) {
        marker.appendChild(createViewDirectionElement());
      }
      marker.addEventListener("click", function () { switchScene(point.scene); });
      fragment.appendChild(marker);
    });
    mapMarkers.appendChild(fragment);
    updateCameraDirectionIndicator();
  }

  function updateCameraDirectionIndicator() {
    if (!isMapViewConeEnabled()) return;
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
    renderAnnotations();
    cameraDirectionFrame = requestAnimationFrame(runCameraDirectionLoop);
  }

  function panMap(start, event) {
    var centerX = start.centerX - (event.clientX - start.x);
    var centerY = start.centerY - (event.clientY - start.y);
    mapState.lon = worldXToLon(centerX, mapState.zoom);
    mapState.lat = worldYToLat(centerY, mapState.zoom);
    renderMap();
  }

  function setMapExpanded(expanded) {
    if (!metadataPanel || !mapExpandToggle) return;
    metadataPanel.classList.toggle("map-expanded", !!expanded);
    mapExpandToggle.classList.toggle("enabled", !!expanded);
    mapExpandToggle.setAttribute("aria-pressed", expanded ? "true" : "false");
    mapExpandToggle.setAttribute("aria-label", expanded ? "Reduzir mapa" : "Ampliar mapa");
    mapExpandToggle.title = expanded ? "Reduzir mapa" : "Ampliar mapa";
    requestAnimationFrame(renderMap);
  }

  function setupMap(initialScene, shouldFocusInitialScene) {
    mapPoints = scenes.map(getScenePoint).filter(Boolean);
    if (!mapPoints.length) {
      body.classList.add("hide-map");
      return;
    }
    if (shouldFocusInitialScene) {
      focusMapOnScene(initialScene);
    } else {
      fitMapToPoints();
    }
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
    if (!metadataPanel.classList.contains("enabled")) {
      setMapExpanded(false);
    }
    renderMap();
  });

  metadataClose.addEventListener("click", function () {
    setMapExpanded(false);
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

  if (mapExpandToggle) {
    mapExpandToggle.addEventListener("click", function () {
      setMapExpanded(!metadataPanel.classList.contains("map-expanded"));
    });
  }

  if (printGeoButton) {
    printGeoButton.addEventListener("click", function () {
      printGeoreferencedLayout();
    });
  }

  if (sketchToggle && annotationOverlay) {
    sketchToggle.addEventListener("click", function () {
      body.classList.toggle("sketch-active");
      var active = body.classList.contains("sketch-active");
      sketchToggle.classList.toggle("enabled", active);
      sketchToggle.setAttribute("aria-pressed", active ? "true" : "false");
      if (active && viewer) {
        viewer.stopMovement();
        viewer.setIdleMovement(null);
      }
      renderAnnotations();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-sketch-mode]"), function (button) {
    button.addEventListener("click", function () {
      setSketchMode(button.dataset.sketchMode || "draw");
    });
  });

  if (sketchUndo) {
    sketchUndo.addEventListener("click", function () {
      undoSketch();
    });
  }

  if (sketchFinishPolygon) {
    sketchFinishPolygon.addEventListener("click", function () {
      finishPolygon();
    });
  }

  if (sketchClear) {
    sketchClear.addEventListener("click", function () {
      clearSketch();
    });
  }

  if (annotationOverlay) {
    annotationOverlay.addEventListener("pointerdown", beginSketch);
    annotationOverlay.addEventListener("pointermove", drawSketch);
    annotationOverlay.addEventListener("pointerup", endSketch);
    annotationOverlay.addEventListener("pointercancel", endSketch);
    annotationOverlay.addEventListener("dblclick", function (event) {
      if (sketchMode === "polygon") {
        event.preventDefault();
        finishPolygon();
        return;
      }
      if (sketchMode === "edit") {
        var screenPoint = screenPointFromEvent(event);
        var annotation = screenPoint ? findAnnotationAt(screenPoint) : null;
        if (annotation && annotation.type === "text") {
          event.preventDefault();
          editTextAnnotation(annotation);
        }
      }
    });
  }

  window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && String(event.key || "").toLowerCase() === "p") {
      event.preventDefault();
      printGeoreferencedLayout();
      return;
    }
    if (!body.classList.contains("sketch-active")) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) {
      event.preventDefault();
      deleteSelectedAnnotation();
      return;
    }
    if (event.key === "Escape") {
      pendingPolygon = null;
      selectedAnnotationId = null;
      selectedVertexIndex = null;
      editDrag = null;
      updateSketchState();
      renderAnnotations();
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

  window.addEventListener("resize", function () {
    renderMap();
    resizeAnnotationOverlay();
    renderAnnotations();
  });

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
    body.classList.toggle("hide-map-view-cone", !isMapViewConeEnabled());
    buildScenes();
    var initialScene = findInitialScene();
    renderSceneList();
    setupControls();
    setupMap(initialScene, hasExplicitInitialScene(initialScene));
    loadSketchAnnotations();
    setSketchMode("draw");
    resizeAnnotationOverlay();
    renderAnnotations();
    updateAutorotateButton();
    if (showBtnList && project.settings.sceneList !== false && project.scenes.length > 1) {
      sceneList.classList.add("enabled");
      sceneListToggle.classList.add("enabled");
    }
    switchScene(initialScene);
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
    project.settings.showMapViewCone = project.settings.showMapViewCone !== false;
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

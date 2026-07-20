(function () {
  var data = window.data || { scenes: [], settings: {} };
  var panoElement = document.getElementById("pano");
  var sceneName = document.getElementById("sceneName");
  var sceneList = document.getElementById("sceneList");
  var sceneListToggle = document.getElementById("sceneListToggle");
  var mapToggle = document.getElementById("mapToggle");
  var mapPanel = document.getElementById("mapPanel");
  var mapCanvas = document.getElementById("mapCanvas");
  var mapTiles = document.getElementById("mapTiles");
  var mapMarkers = document.getElementById("mapMarkers");
  var mapCaption = document.getElementById("mapCaption");
  var mapZoomIn = document.getElementById("mapZoomIn");
  var mapZoomOut = document.getElementById("mapZoomOut");
  var mapRecenter = document.getElementById("mapRecenter");
  var fullscreenToggle = document.getElementById("fullscreenToggle");
  var viewer = new Marzipano.Viewer(panoElement, {
    controls: { mouseViewMode: data.settings.mouseViewMode || "drag" },
    stage: { progressive: true }
  });
  var autorotate = Marzipano.autorotate({ yawSpeed: 0.03, targetPitch: 0, targetFov: Math.PI / 2 });
  var baseTileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var overlayTileUrlTemplate = "https://tiles.arcgis.com/tiles/MRbkurfLm8nmQrDq/arcgis/rest/services/RasterLrv2026_1/MapServer/tile/{level}/{row}/{col}";
  var mapPoints = [];
  var currentScene = null;
  var currentSceneId = null;
  var mapState = { lat: 0, lon: 0, zoom: 16 };
  var mapDrag = null;
  var cameraDirectionFrame = null;

  function isMapViewConeEnabled() {
    return data.settings.showMapViewCone !== false;
  }

  function createInfoHotspot(hotspot) {
    var element = document.createElement("button");
    element.type = "button";
    element.className = "hotspot info";
    element.textContent = "i";
    var bubble = document.createElement("span");
    bubble.className = "tooltip";
    bubble.innerHTML = "<strong></strong><small></small>";
    bubble.querySelector("strong").textContent = hotspot.title || "Info";
    bubble.querySelector("small").textContent = hotspot.text || "";
    element.appendChild(bubble);
    return element;
  }

  function createLinkHotspot(hotspot) {
    var element = document.createElement("button");
    element.type = "button";
    element.className = "hotspot link";
    element.textContent = "↪";
    element.title = hotspot.title || "Abrir cena";
    element.addEventListener("click", function () {
      var target = scenes.find(function (scene) { return scene.data.id === hotspot.target; });
      if (target) switchScene(target);
    });
    return element;
  }

  var scenes = data.scenes.map(function (sceneData) {
    return { data: sceneData, scene: null, view: null };
  });

  function ensureSceneLoaded(scene) {
    if (scene.scene && scene.view) return scene;
    var sceneData = scene.data;
    var source = Marzipano.ImageUrlSource.fromString(sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg");
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

  function switchScene(scene) {
    ensureSceneLoaded(scene);
    viewer.stopMovement();
    viewer.setIdleMovement(null);
    scene.view.setParameters(scene.data.initialViewParameters || { yaw: 0, pitch: 0, fov: Math.PI / 2 });
    scene.scene.switchTo();
    currentScene = scene;
    currentSceneId = scene.data.id;
    sceneName.textContent = scene.data.name || scene.data.id;
    Array.prototype.forEach.call(sceneList.children, function (button) {
      button.classList.toggle("active", button.dataset.id === scene.data.id);
    });
    updateMapCaption(scene.data);
    updateMapMarkers();
    if (data.settings.autorotate) {
      viewer.setIdleMovement(3000, autorotate);
    }
  }

  scenes.forEach(function (scene) {
    var button = document.createElement("button");
    button.type = "button";
    button.dataset.id = scene.data.id;
    button.textContent = scene.data.name || scene.data.id;
    button.addEventListener("click", function () {
      switchScene(scene);
      if (window.innerWidth < 700) sceneList.classList.remove("open");
    });
    sceneList.appendChild(button);
  });

  sceneListToggle.addEventListener("click", function () {
    sceneList.classList.toggle("open");
  });

  function getScenePoint(scene) {
    var metadata = scene.data.metadata || {};
    var coordinates = metadata.coordinates;
    if (!coordinates) return null;
    var lat = Number(coordinates.latitude);
    var lon = Number(coordinates.longitude);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return {
      lat: lat,
      lon: lon,
      altitude: metadata.altitude,
      height: metadata.height,
      takenAt: metadata.takenAt,
      scene: scene
    };
  }

  function formatPhotoDate(value) {
    if (!value) return "Sem data";
    var match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (match) return match[3] + "/" + match[2] + "/" + match[1] + " " + match[4] + ":" + match[5];
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

  function normalizeSignedDegrees(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    number = ((number + 180) % 360 + 360) % 360 - 180;
    return Math.abs(number) < 0.000001 ? 0 : number;
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

  function updateMapCaption(sceneData) {
    if (!mapCaption || !sceneData) return;
    var metadata = sceneData.metadata || {};
    var parts = [photoLabel(sceneData), formatPhotoDate(metadata.takenAt)];
    if (metadata.height != null) parts.push("altura " + metadata.height + " m");
    if (metadata.altitude != null) parts.push(metadata.altitude + " m");
    mapCaption.textContent = parts.join(" | ");
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
    var width = mapCanvas.clientWidth || 320;
    var height = mapCanvas.clientHeight || 220;
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
    if (!mapPoints.length || !mapCanvas.clientWidth) return;
    mapTiles.innerHTML = "";
    var zoom = mapState.zoom;
    var size = Math.pow(2, zoom);
    var width = mapCanvas.clientWidth;
    var height = mapCanvas.clientHeight;
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

    if (origin && mapCanvas.clientWidth) {
      var rect = mapCanvas.getBoundingClientRect();
      var offsetX = origin.clientX - rect.left - mapCanvas.clientWidth / 2;
      var offsetY = origin.clientY - rect.top - mapCanvas.clientHeight / 2;
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
    if (!mapMarkers || !mapPoints.length || !mapCanvas.clientWidth) return;
    mapMarkers.innerHTML = "";
    var zoom = mapState.zoom;
    var centerX = lonToWorldX(mapState.lon, zoom);
    var centerY = latToWorldY(mapState.lat, zoom);
    var left = centerX - mapCanvas.clientWidth / 2;
    var top = centerY - mapCanvas.clientHeight / 2;
    mapPoints.forEach(function (point) {
      var marker = document.createElement("button");
      var details = [];
      if (point.takenAt) details.push(formatPhotoDate(point.takenAt));
      if (point.height != null) details.push("altura " + point.height + " m");
      if (point.altitude != null) details.push("altitude " + point.altitude + " m");
      marker.type = "button";
      marker.className = "map-marker" + (point.scene.data.id === currentSceneId ? " active" : "");
      marker.style.left = Math.round(lonToWorldX(point.lon, zoom) - left) + "px";
      marker.style.top = Math.round(latToWorldY(point.lat, zoom) - top) + "px";
      marker.title = details.length ? details.join(" | ") : "Abrir foto";
      if (point.scene.data.id === currentSceneId && isMapViewConeEnabled()) {
        marker.appendChild(createViewDirectionElement());
      }
      marker.addEventListener("click", function () {
        switchScene(point.scene);
      });
      mapMarkers.appendChild(marker);
    });
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
    cameraDirectionFrame = requestAnimationFrame(runCameraDirectionLoop);
  }

  function panMap(start, event) {
    var centerX = start.centerX - (event.clientX - start.x);
    var centerY = start.centerY - (event.clientY - start.y);
    mapState.lon = worldXToLon(centerX, mapState.zoom);
    mapState.lat = worldYToLat(centerY, mapState.zoom);
    renderMap();
  }

  mapPoints = scenes.map(getScenePoint).filter(Boolean);
  if (mapPoints.length) {
    mapCaption.textContent = mapPoints.length + " foto(s) com coordenadas EXIF.";
    fitMapToPoints();
    mapToggle.addEventListener("click", function () {
      mapPanel.classList.toggle("open");
      if (mapPanel.classList.contains("open")) {
        renderMap();
      }
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
    mapCanvas.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.target.closest(".map-marker, #mapPanel header")) return;
      mapDrag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        centerX: lonToWorldX(mapState.lon, mapState.zoom),
        centerY: latToWorldY(mapState.lat, mapState.zoom)
      };
      mapCanvas.classList.add("dragging");
      mapCanvas.setPointerCapture(event.pointerId);
    });
    mapCanvas.addEventListener("pointermove", function (event) {
      if (!mapDrag || mapDrag.id !== event.pointerId) return;
      panMap(mapDrag, event);
    });
    function endMapDrag(event) {
      if (!mapDrag || mapDrag.id !== event.pointerId) return;
      mapDrag = null;
      mapCanvas.classList.remove("dragging");
      if (mapCanvas.hasPointerCapture(event.pointerId)) {
        mapCanvas.releasePointerCapture(event.pointerId);
      }
    }
    mapCanvas.addEventListener("pointerup", endMapDrag);
    mapCanvas.addEventListener("pointercancel", endMapDrag);
    mapCanvas.addEventListener("wheel", function (event) {
      event.preventDefault();
      zoomMap(event.deltaY < 0 ? 1 : -1, event);
    }, { passive: false });
    window.addEventListener("resize", renderMap);
    if (!cameraDirectionFrame) {
      runCameraDirectionLoop();
    }
  } else {
    document.body.classList.add("hide-map");
    mapCaption.textContent = "Nenhuma cena possui coordenadas EXIF.";
  }

  fullscreenToggle.addEventListener("click", function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  var controls = viewer.controls();
  var velocity = 0.7;
  var friction = 3;
  [["viewLeft", "x", -velocity], ["viewRight", "x", velocity], ["viewUp", "y", -velocity], ["viewDown", "y", velocity], ["viewIn", "zoom", -velocity], ["viewOut", "zoom", velocity]].forEach(function (item) {
    controls.registerMethod(item[0], new Marzipano.ElementPressControlMethod(document.getElementById(item[0]), item[1], item[2], friction), true);
  });

  document.body.classList.toggle("hide-controls", data.settings.controls === false);
  document.body.classList.toggle("hide-fullscreen", data.settings.fullscreen === false);
  document.body.classList.toggle("hide-scenes", data.settings.sceneList === false);
  document.body.classList.toggle("hide-map-view-cone", !isMapViewConeEnabled());
  if (data.settings.sceneList !== false) sceneList.classList.add("open");
  if (scenes[0]) switchScene(scenes[0]);
})();

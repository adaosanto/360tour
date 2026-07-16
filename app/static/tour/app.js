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
  var fullscreenToggle = document.getElementById("fullscreenToggle");
  var viewer = new Marzipano.Viewer(panoElement, {
    controls: { mouseViewMode: data.settings.mouseViewMode || "drag" },
    stage: { progressive: true }
  });
  var autorotate = Marzipano.autorotate({ yawSpeed: 0.03, targetPitch: 0, targetFov: Math.PI / 2 });
  var tileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var mapPoints = [];
  var currentSceneId = null;
  var mapState = { lat: 0, lon: 0, zoom: 16 };

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
    var source = Marzipano.ImageUrlSource.fromString(sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg");
    var geometry = new Marzipano.CubeGeometry(sceneData.levels);
    var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180);
    var view = new Marzipano.RectilinearView(sceneData.initialViewParameters, limiter);
    var scene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });

    sceneData.infoHotspots.forEach(function (hotspot) {
      scene.hotspotContainer().createHotspot(createInfoHotspot(hotspot), { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });
    sceneData.linkHotspots.forEach(function (hotspot) {
      scene.hotspotContainer().createHotspot(createLinkHotspot(hotspot), { yaw: hotspot.yaw, pitch: hotspot.pitch });
    });
    return { data: sceneData, scene: scene, view: view };
  });

  function switchScene(scene) {
    viewer.stopMovement();
    viewer.setIdleMovement(null);
    scene.view.setParameters(scene.data.initialViewParameters);
    scene.scene.switchTo();
    currentSceneId = scene.data.id;
    sceneName.textContent = scene.data.name || scene.data.id;
    Array.prototype.forEach.call(sceneList.children, function (button) {
      button.classList.toggle("active", button.dataset.id === scene.data.id);
    });
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
    var coordinates = scene.data.metadata && scene.data.metadata.coordinates;
    if (!coordinates) return null;
    var lat = Number(coordinates.latitude);
    var lon = Number(coordinates.longitude);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return {
      lat: lat,
      lon: lon,
      altitude: scene.data.metadata.altitude,
      scene: scene
    };
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

  function tileUrl(level, col, row) {
    return tileUrlTemplate
      .replace("{level}", level)
      .replace("{col}", col)
      .replace("{row}", row);
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
        var image = document.createElement("img");
        image.alt = "";
        image.src = tileUrl(zoom, wrappedCol, row);
        image.style.left = Math.round(col * 256 - left) + "px";
        image.style.top = Math.round(row * 256 - top) + "px";
        mapTiles.appendChild(image);
      }
    }
    updateMapMarkers();
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
      var label = point.scene.data.name || point.scene.data.id;
      marker.type = "button";
      marker.className = "map-marker" + (point.scene.data.id === currentSceneId ? " active" : "");
      marker.style.left = Math.round(lonToWorldX(point.lon, zoom) - left) + "px";
      marker.style.top = Math.round(latToWorldY(point.lat, zoom) - top) + "px";
      marker.title = point.altitude == null ? label : label + " | altitude " + point.altitude + " m";
      marker.textContent = "";
      marker.addEventListener("click", function () {
        switchScene(point.scene);
      });
      mapMarkers.appendChild(marker);
    });
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
      mapState.zoom = Math.min(20, mapState.zoom + 1);
      renderMap();
    });
    mapZoomOut.addEventListener("click", function () {
      mapState.zoom = Math.max(2, mapState.zoom - 1);
      renderMap();
    });
    window.addEventListener("resize", renderMap);
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
  if (data.settings.sceneList !== false) sceneList.classList.add("open");
  if (scenes[0]) switchScene(scenes[0]);
})();

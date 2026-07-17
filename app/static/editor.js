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
  var autorenameCsvViewUrl = document.getElementById("autorenameCsvViewUrl");
  var autorenameCsvCiclo = document.getElementById("autorenameCsvCiclo");
  var autorenameCsvProfissional = document.getElementById("autorenameCsvProfissional");
  var autorenameCsvFinalidade = document.getElementById("autorenameCsvFinalidade");
  var autorenameCsvDepartamento = document.getElementById("autorenameCsvDepartamento");
  var autorenameCsvSituacao = document.getElementById("autorenameCsvSituacao");
  var previewAutorename = document.getElementById("previewAutorename");
  var applyAutorename = document.getElementById("applyAutorename");
  var exportAutorenameCsv = document.getElementById("exportAutorenameCsv");
  var autorenameStatus = document.getElementById("autorenameStatus");
  var autorenameMap = document.getElementById("autorenameMap");
  var autorenameMapTiles = document.getElementById("autorenameMapTiles");
  var autorenameMapLines = document.getElementById("autorenameMapLines");
  var autorenameMapMarkers = document.getElementById("autorenameMapMarkers");
  var autorenameMatches = document.getElementById("autorenameMatches");
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
  var uploadWorkflowActive = false;
  var autorenameTileUrlTemplate = "https://mt1.google.com/vt/lyrs=s&hl=en&z={level}&x={col}&y={row}";
  var uploadBatchMaxFiles = 5;
  var uploadBatchMaxBytes = 750 * 1024 * 1024;

  function requestJSON(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.detail || "Falha na requisicao.");
        return payload;
      });
    });
  }

  function requestBlob(url, options) {
    return fetch(url, options || {}).then(function (response) {
      if (response.ok) return response.blob();
      return response.json().then(function (payload) {
        throw new Error(payload.detail || "Falha na requisicao.");
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

  function normalizeProject(payload) {
    payload = payload || {};
    payload.settings = normalizeSettings(payload.settings);
    payload.scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
    payload.scenes.forEach(function (scene) {
      scene.infoHotspots = Array.isArray(scene.infoHotspots) ? scene.infoHotspots : [];
      scene.linkHotspots = Array.isArray(scene.linkHotspots) ? scene.linkHotspots : [];
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

  function autorenameCsvPayload() {
    var payload = autorenamePayload();
    payload.viewUrl = fieldValue(autorenameCsvViewUrl);
    payload.ciclo = fieldValue(autorenameCsvCiclo);
    payload.profissional = fieldValue(autorenameCsvProfissional);
    payload.finalidade = fieldValue(autorenameCsvFinalidade);
    payload.departamentoSolicitante = fieldValue(autorenameCsvDepartamento);
    payload.situacao = fieldValue(autorenameCsvSituacao);
    return payload;
  }

  function setAutorenameLoading(isLoading) {
    if (previewAutorename) previewAutorename.disabled = isLoading;
    if (applyAutorename) applyAutorename.disabled = isLoading || !autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount || (autorenamePreviewPayload.duplicatePointIds || []).length;
    if (exportAutorenameCsv) exportAutorenameCsv.disabled = isLoading || !autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount || (autorenamePreviewPayload.duplicatePointIds || []).length;
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
    for (var zoom = 18; zoom >= 2; zoom--) {
      var xs = points.map(function (point) { return lonToWorldX(point.longitude, zoom); });
      var ys = points.map(function (point) { return latToWorldY(point.latitude, zoom); });
      var spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      if (spanX <= width - 42 && spanY <= height - 42) return zoom;
    }
    return 2;
  }

  function autorenameTileUrl(level, col, row) {
    return autorenameTileUrlTemplate
      .replace("{level}", level)
      .replace("{col}", col)
      .replace("{row}", row);
  }

  function renderAutorenameMap(matches) {
    if (!autorenameMap || !autorenameMapTiles || !autorenameMapLines || !autorenameMapMarkers) return;
    var points = [];
    matches.forEach(function (match) {
      if (match.photo) points.push({ type: "photo", latitude: match.photo.latitude, longitude: match.photo.longitude, match: match });
      if (match.point && match.matched) points.push({ type: "point", latitude: match.point.latitude, longitude: match.point.longitude, match: match });
    });
    autorenameMap.hidden = !points.length;
    autorenameMapTiles.innerHTML = "";
    autorenameMapLines.innerHTML = "";
    autorenameMapMarkers.innerHTML = "";
    if (!points.length) return;

    var width = autorenameMap.clientWidth || 320;
    var height = autorenameMap.clientHeight || 260;
    var centerX18 = points.reduce(function (sum, point) { return sum + lonToWorldX(point.longitude, 18); }, 0) / points.length;
    var centerY18 = points.reduce(function (sum, point) { return sum + latToWorldY(point.latitude, 18); }, 0) / points.length;
    var zoom = chooseAutorenameMapZoom(points, width, height);
    var centerLon = worldXToLon(centerX18 / Math.pow(2, 18 - zoom), zoom);
    var centerLat = worldYToLat(centerY18 / Math.pow(2, 18 - zoom), zoom);
    var centerX = lonToWorldX(centerLon, zoom);
    var centerY = latToWorldY(centerLat, zoom);
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

    autorenameMapLines.setAttribute("viewBox", "0 0 " + width + " " + height);
    autorenameMapLines.setAttribute("width", width);
    autorenameMapLines.setAttribute("height", height);
    matches.forEach(function (match) {
      if (!match.matched || !match.photo || !match.point) return;
      var photo = screenPoint(match.photo);
      var point = screenPoint(match.point);
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", photo.x.toFixed(1));
      line.setAttribute("y1", photo.y.toFixed(1));
      line.setAttribute("x2", point.x.toFixed(1));
      line.setAttribute("y2", point.y.toFixed(1));
      autorenameMapLines.appendChild(line);
    });
    points.forEach(function (point) {
      var marker = document.createElement("span");
      var screen = screenPoint(point);
      marker.className = "autorename-marker " + point.type + (point.match.matched ? "" : " unmatched");
      marker.style.left = Math.round(screen.x) + "px";
      marker.style.top = Math.round(screen.y) + "px";
      marker.title = point.type === "photo"
        ? "Foto: " + (point.match.sourceFile || point.match.sceneName || point.match.sceneId)
        : "Ponto ArcGIS: " + point.match.point.id;
      autorenameMapMarkers.appendChild(marker);
    });
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

  function renderAutorenamePreview(payload) {
    autorenamePreviewPayload = payload;
    var duplicateIds = payload.duplicatePointIds || [];
    var status = payload.matchedCount + " de " + payload.sceneCount + " cenas com match em " + payload.pointCount + " pontos ArcGIS.";
    if (duplicateIds.length) {
      status += " Pontos duplicados: " + duplicateIds.join(", ") + ".";
    }
    setAutorenameStatus(status, !!duplicateIds.length);
    if (applyAutorename) {
      applyAutorename.disabled = !payload.matchedCount || !!duplicateIds.length;
    }
    if (exportAutorenameCsv) {
      exportAutorenameCsv.disabled = !payload.matchedCount || !!duplicateIds.length;
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
    var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180);
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
          if (applyAutorename) applyAutorename.disabled = true;
          if (exportAutorenameCsv) exportAutorenameCsv.disabled = true;
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

  if (exportAutorenameCsv) {
    exportAutorenameCsv.addEventListener("click", function () {
      if (!autorenamePreviewPayload || !autorenamePreviewPayload.matchedCount) return;
      setAutorenameStatus("Gerando CSV dos matches...");
      setAutorenameLoading(true);
      saveProject()
        .then(function () {
          return requestBlob("/api/projects/" + projectId + "/autorename/export-csv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autorenameCsvPayload())
          });
        })
        .then(function (blob) {
          var objectUrl = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = objectUrl;
          link.download = "autorename-matches-" + projectId + ".csv";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
          setAutorenameStatus("CSV gerado com " + autorenamePreviewPayload.matchedCount + " matches.");
        })
        .catch(function (error) {
          setAutorenameStatus(error.message, true);
        })
        .finally(function () {
          setAutorenameLoading(false);
        });
    });
  }

  function supportedPanoramaFile(file) {
    return /\.(jpe?g|png|tiff?)$/i.test(file.name);
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
    var totalBytes = files.reduce(function (sum, file) { return sum + file.size; }, 0);
    var batches = makeUploadBatches(files);
    var uploadedBytes = 0;
    uploadWorkflowActive = true;
    progressBox.hidden = false;
    progressBar.value = 0;
    progressText.textContent = "Preparando upload de " + files.length + " panorama(s), " + formatBytes(totalBytes) + ".";
    if (addFilesInput) addFilesInput.disabled = true;
    progressText.textContent = "Salvando configuracoes do projeto...";
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
      progressText.textContent = "Processamento iniciado para " + files.length + " panorama(s).";
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
      viewReadout.textContent = "yaw " + p.yaw.toFixed(3) + " | pitch " + p.pitch.toFixed(3) + " | fov " + p.fov.toFixed(3);
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

  loadProject();
})();

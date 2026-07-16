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
  var viewer;
  var project;
  var scenes = [];
  var currentIndex = 0;
  var saveTimer = null;
  var savePromise = null;
  var hasPendingSave = false;
  var selectedHotspot = null;
  var placingHotspot = null;

  function requestJSON(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.detail || "Falha na requisicao.");
        return payload;
      });
    });
  }

  function normalizeSettings(settings) {
    settings = settings || {};
    return {
      autorotate: !!settings.autorotate,
      controls: settings.controls !== false,
      fullscreen: settings.fullscreen !== false,
      sceneList: settings.sceneList !== false,
      mouseViewMode: settings.mouseViewMode === "qtvr" ? "qtvr" : "drag",
      showPhotoNames: !!settings.showPhotoNames
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
      var source = Marzipano.ImageUrlSource.fromString("/project-files/" + projectId + "/" + sceneData.tilePath + "/{z}/{f}/{y}/{x}.jpg");
      var geometry = new Marzipano.CubeGeometry(sceneData.levels);
      var limiter = Marzipano.RectilinearView.limit.traditional(sceneData.faceSize, 100 * Math.PI / 180, 120 * Math.PI / 180);
      var view = new Marzipano.RectilinearView(sceneData.initialViewParameters, limiter);
      var scene = viewer.createScene({ source: source, geometry: geometry, view: view, pinFirstLevel: true });
      return { data: sceneData, scene: scene, view: view, hotspotHandles: [] };
    });
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
    scenes[index].view.setParameters(scenes[index].data.initialViewParameters);
    scenes[index].scene.switchTo();
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
    scene.hotspotHandles.forEach(function (handle) { handle.destroy(); });
    scene.hotspotHandles = [];
  }

  function renderHotspots() {
    scenes.forEach(clearHotspotHandles);
    var scene = currentScene();
    if (!scene) return;
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

  ["settingAutorotate", "settingControls", "settingFullscreen", "settingSceneList", "settingShowPhotoNames"].forEach(function (id) {
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

  document.getElementById("addFiles").addEventListener("change", function (event) {
    if (!event.target.files.length) return;
    var formData = new FormData();
    Array.prototype.forEach.call(event.target.files, function (file) { formData.append("files", file); });
    progressBox.hidden = false;
    progressText.textContent = "Enviando novos panoramas...";
    fetch("/api/projects/" + projectId + "/panoramas", { method: "POST", body: formData })
      .then(function (response) { return response.json().then(function (payload) { if (!response.ok) throw new Error(payload.detail); return payload; }); })
      .then(pollProgress)
      .catch(function (error) { progressText.textContent = error.message; });
  });

  function pollProgress() {
    requestJSON("/api/projects/" + projectId + "/progress").then(function (state) {
      progressBox.hidden = state.status === "done" && state.percent >= 100;
      progressText.textContent = state.message || state.status;
      progressBar.value = state.percent || 0;
      if (state.status === "processing" || state.status === "ready") {
        setTimeout(pollProgress, 900);
      } else {
        loadProject();
      }
    }).catch(function (error) {
      progressText.textContent = error.message;
    });
  }

  document.getElementById("exportZip").addEventListener("click", function () {
    saveProject().then(function () {
      window.location.href = "/api/projects/" + projectId + "/export";
    }).catch(function () {});
  });

  document.getElementById("deleteProject").addEventListener("click", function () {
    if (!confirm("Excluir o projeto temporario?")) return;
    fetch("/api/projects/" + projectId, { method: "DELETE" }).then(function () { window.location.href = "/"; });
  });

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
      if (!viewer) {
        initViewer();
        updateReadout();
        buildScenes();
        renderCurrentSceneForm();
        renderSceneList();
        if (project.scenes.length) {
          switchScene(currentIndex);
        }
      } else {
        rebuildViewer();
      }
      pollInitialProgress();
    }).catch(function (error) {
      saveState.textContent = error.message;
    });
  }

  function pollInitialProgress() {
    requestJSON("/api/projects/" + projectId + "/progress").then(function (state) {
      if (state.status === "processing" || state.status === "ready") {
        progressBox.hidden = false;
        progressText.textContent = state.message || "Processando";
        progressBar.value = state.percent || 0;
        setTimeout(function () {
          requestJSON("/api/projects/" + projectId).then(function (payload) {
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

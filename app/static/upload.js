(function () {
  "use strict";

  var form = document.getElementById("uploadForm");
  var projectName = document.getElementById("projectName");
  var thumbnailInput = document.getElementById("thumbnailInput");
  var dropZone = document.getElementById("dropZone");
  var thumbnailPreview = document.getElementById("thumbnailPreview");
  var thumbnailName = document.getElementById("thumbnailName");
  var submitButton = document.getElementById("submitUpload");
  var submitLabel = document.getElementById("submitLabel");
  var qualityInput = document.getElementById("jpegQuality");
  var qualityValue = document.getElementById("qualityValue");
  var showPhotoNames = document.getElementById("showPhotoNames");
  var saveOriginalPhotos = document.getElementById("saveOriginalPhotos");
  var status = document.getElementById("uploadStatus");
  var statusMessage = document.getElementById("statusMessage");
  var statusPercent = document.getElementById("statusPercent");
  var progress = document.getElementById("uploadProgress");
  var projectList = document.getElementById("projectList");
  var refreshProjects = document.getElementById("refreshProjects");
  var thumbnailFile = null;
  var thumbnailUrl = null;
  var creating = false;

  function isSupported(file) {
    return /\.(jpe?g|png|webp|tiff?)$/i.test(file.name);
  }

  function setStatus(message, percent, isError) {
    status.hidden = false;
    status.classList.toggle("error", !!isError);
    statusMessage.textContent = message;
    statusPercent.textContent = isError ? "Erro" : Math.round(percent) + "%";
    progress.value = percent;
  }

  function hideStatus() {
    status.hidden = true;
    status.classList.remove("error");
    progress.value = 0;
  }

  function setCreating(value) {
    creating = value;
    submitButton.disabled = value;
    submitButton.classList.toggle("loading", value);
    dropZone.classList.toggle("disabled", value);
    submitLabel.textContent = value ? "Criando projeto" : "Criar projeto";
  }

  function responsePayload(xhr) {
    try {
      return JSON.parse(xhr.responseText || "{}");
    } catch (error) {
      return {};
    }
  }

  function formatDate(timestamp) {
    if (!timestamp) return "Sem data";
    return new Date(timestamp * 1000).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function statusLabel(statusText) {
    var labels = {
      ready: "Criado",
      processing: "Processando",
      done: "Processado",
      failed: "Falhou",
      saved: "Salvo"
    };
    return labels[statusText] || "Salvo";
  }

  function renderProjects(projects) {
    projectList.innerHTML = "";
    if (!projects.length) {
      var empty = document.createElement("p");
      empty.className = "project-list-message";
      empty.textContent = "Nenhum projeto temporario encontrado.";
      projectList.appendChild(empty);
      return;
    }

    projects.forEach(function (project) {
      var card = document.createElement("article");
      var thumb = document.createElement("a");
      var body = document.createElement("div");
      var title = document.createElement("h3");
      var meta = document.createElement("p");
      var actions = document.createElement("div");
      var edit = document.createElement("a");
      var view = document.createElement("a");

      card.className = "project-card";
      thumb.className = "project-thumb";
      thumb.href = project.editorUrl;
      thumb.setAttribute("aria-label", "Abrir editor de " + project.name);
      if (project.thumbnailUrl) {
        thumb.style.backgroundImage = "url('" + project.thumbnailUrl.replace(/'/g, "\\'") + "')";
        thumb.classList.add("has-image");
      } else {
        thumb.textContent = "360";
      }

      body.className = "project-card-body";
      title.textContent = project.name;
      meta.textContent = project.sceneCount + (project.sceneCount === 1 ? " cena" : " cenas") + " | " + statusLabel(project.status) + " | " + formatDate(project.updatedAt);

      actions.className = "project-actions";
      edit.href = project.editorUrl;
      edit.textContent = "Editar";
      edit.className = "project-action primary";
      view.href = project.viewUrl;
      view.textContent = "Visualizar";
      view.className = "project-action";
      if (!project.sceneCount) {
        view.setAttribute("aria-disabled", "true");
        view.classList.add("disabled");
      }

      actions.appendChild(edit);
      actions.appendChild(view);
      body.appendChild(title);
      body.appendChild(meta);
      body.appendChild(actions);
      card.appendChild(thumb);
      card.appendChild(body);
      projectList.appendChild(card);
    });
  }

  function loadProjects() {
    if (!projectList) return;
    projectList.innerHTML = '<p class="project-list-message">Carregando projetos...</p>';
    fetch("/api/projects", { cache: "no-store" })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) throw new Error(payload.detail || "Nao foi possivel carregar os projetos.");
          return payload;
        });
      })
      .then(function (payload) {
        renderProjects(payload.projects || []);
      })
      .catch(function (error) {
        projectList.innerHTML = "";
        var message = document.createElement("p");
        message.className = "project-list-message error";
        message.textContent = error.message;
        projectList.appendChild(message);
      });
  }

  function setThumbnail(file) {
    if (creating || !file) return;
    if (!isSupported(file)) {
      thumbnailInput.value = "";
      thumbnailFile = null;
      setStatus("Thumbnail em formato nao suportado.", 0, true);
      return;
    }

    thumbnailFile = file;
    thumbnailName.textContent = file.name;
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    thumbnailUrl = URL.createObjectURL(file);
    thumbnailPreview.style.backgroundImage = "url('" + thumbnailUrl.replace(/'/g, "\\'") + "')";
    thumbnailPreview.classList.add("has-image");
    hideStatus();
  }

  function submit() {
    if (creating) return;

    var data = new FormData();
    data.append("project_name", projectName.value.trim() || "Tour 360");
    data.append("tile_size", document.getElementById("tileSize").value);
    data.append("jpeg_quality", qualityInput.value);
    if (showPhotoNames && showPhotoNames.checked) {
      data.append("show_photo_names", "true");
    }
    data.append("save_original_photos", saveOriginalPhotos && saveOriginalPhotos.checked ? "true" : "false");
    if (thumbnailFile) {
      data.append("thumbnail", thumbnailFile, thumbnailFile.name);
    }

    var xhr = new XMLHttpRequest();
    setCreating(true);
    setStatus("Criando projeto...", 10, false);
    xhr.open("POST", "/api/projects");

    xhr.upload.addEventListener("progress", function (event) {
      if (!event.lengthComputable) return;
      var percent = Math.min(90, Math.round((event.loaded / event.total) * 90));
      setStatus("Enviando dados do projeto...", percent, false);
    });

    xhr.addEventListener("load", function () {
      var payload = responsePayload(xhr);
      if (xhr.status >= 200 && xhr.status < 300 && payload.editorUrl) {
        setStatus("Projeto criado. Abrindo editor...", 100, false);
        window.location.assign(payload.editorUrl);
        return;
      }
      setCreating(false);
      setStatus(payload.detail || "Nao foi possivel criar o projeto.", 0, true);
    });

    xhr.addEventListener("error", function () {
      setCreating(false);
      setStatus("Falha de conexao com o servidor.", 0, true);
    });

    xhr.addEventListener("abort", function () {
      setCreating(false);
      setStatus("Criacao cancelada.", 0, true);
    });

    xhr.send(data);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit();
  });

  thumbnailInput.addEventListener("change", function () {
    setThumbnail(thumbnailInput.files[0]);
  });

  qualityInput.addEventListener("input", function () {
    qualityValue.value = qualityInput.value + "%";
  });

  ["dragenter", "dragover"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      if (!creating) dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });

  dropZone.addEventListener("drop", function (event) {
    if (!creating) setThumbnail(event.dataTransfer.files[0]);
  });

  if (refreshProjects) {
    refreshProjects.addEventListener("click", loadProjects);
  }

  loadProjects();
})();

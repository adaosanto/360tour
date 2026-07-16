(function () {
  "use strict";

  var form = document.getElementById("uploadForm");
  var input = document.getElementById("fileInput");
  var dropZone = document.getElementById("dropZone");
  var fileQueue = document.getElementById("fileQueue");
  var fileList = document.getElementById("fileList");
  var fileCount = document.getElementById("fileCount");
  var clearFiles = document.getElementById("clearFiles");
  var submitButton = document.getElementById("submitUpload");
  var submitLabel = document.getElementById("submitLabel");
  var qualityInput = document.getElementById("jpegQuality");
  var qualityValue = document.getElementById("qualityValue");
  var status = document.getElementById("uploadStatus");
  var statusMessage = document.getElementById("statusMessage");
  var statusPercent = document.getElementById("statusPercent");
  var progress = document.getElementById("uploadProgress");
  var selectedFiles = [];
  var uploading = false;

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function extension(file) {
    var match = file.name.toLowerCase().match(/\.([^.]+)$/);
    return match ? match[1] : "arquivo";
  }

  function isSupported(file) {
    return /\.(jpe?g|png|tiff?)$/i.test(file.name);
  }

  function fileKey(file) {
    return [file.name, file.size, file.lastModified].join(":");
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

  function renderFiles() {
    fileList.innerHTML = "";
    selectedFiles.forEach(function (file) {
      var item = document.createElement("li");
      var details = document.createElement("span");
      var name = document.createElement("strong");
      var meta = document.createElement("small");
      var type = document.createElement("span");

      details.className = "file-details";
      name.textContent = file.name;
      meta.textContent = formatBytes(file.size);
      type.className = "file-type";
      type.textContent = extension(file).toUpperCase();
      details.appendChild(name);
      details.appendChild(meta);
      item.appendChild(type);
      item.appendChild(details);
      fileList.appendChild(item);
    });

    var total = selectedFiles.length;
    fileQueue.hidden = total === 0;
    fileCount.textContent = total === 0 ? "Nenhum arquivo" : total + (total === 1 ? " arquivo" : " arquivos");
    fileCount.classList.toggle("has-files", total > 0);
    submitButton.disabled = total === 0 || uploading;
  }

  function addFiles(files) {
    if (uploading) return;
    var currentKeys = {};
    var invalid = [];
    selectedFiles.forEach(function (file) { currentKeys[fileKey(file)] = true; });

    Array.prototype.forEach.call(files || [], function (file) {
      if (!isSupported(file)) {
        invalid.push(file.name);
        return;
      }
      if (!currentKeys[fileKey(file)]) {
        selectedFiles.push(file);
        currentKeys[fileKey(file)] = true;
      }
    });

    input.value = "";
    renderFiles();
    if (invalid.length) {
      setStatus("Formato nao suportado: " + invalid.join(", "), 0, true);
    } else {
      hideStatus();
    }
  }

  function setUploading(value) {
    uploading = value;
    submitButton.disabled = value || selectedFiles.length === 0;
    clearFiles.disabled = value;
    dropZone.classList.toggle("disabled", value);
    submitButton.classList.toggle("loading", value);
    submitLabel.textContent = value ? "Enviando panoramas" : "Processar panoramas";
  }

  function responsePayload(xhr) {
    try {
      return JSON.parse(xhr.responseText || "{}");
    } catch (error) {
      return {};
    }
  }

  function submit() {
    if (!selectedFiles.length || uploading) return;

    var data = new FormData();
    selectedFiles.forEach(function (file) { data.append("files", file, file.name); });
    data.append("tile_size", document.getElementById("tileSize").value);
    data.append("jpeg_quality", qualityInput.value);

    var xhr = new XMLHttpRequest();
    setUploading(true);
    setStatus("Enviando arquivos...", 0, false);
    xhr.open("POST", "/api/projects");

    xhr.upload.addEventListener("progress", function (event) {
      if (!event.lengthComputable) return;
      var percent = Math.min(95, Math.round((event.loaded / event.total) * 95));
      setStatus("Enviando arquivos...", percent, false);
    });

    xhr.upload.addEventListener("load", function () {
      setStatus("Criando o projeto...", 98, false);
    });

    xhr.addEventListener("load", function () {
      var payload = responsePayload(xhr);
      if (xhr.status >= 200 && xhr.status < 300 && payload.editorUrl) {
        setStatus("Projeto criado. Abrindo o editor...", 100, false);
        window.location.assign(payload.editorUrl);
        return;
      }
      setUploading(false);
      setStatus(payload.detail || "Nao foi possivel criar o projeto.", 0, true);
    });

    xhr.addEventListener("error", function () {
      setUploading(false);
      setStatus("Falha de conexao com o servidor.", 0, true);
    });

    xhr.addEventListener("abort", function () {
      setUploading(false);
      setStatus("Envio cancelado.", 0, true);
    });

    xhr.send(data);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit();
  });

  input.addEventListener("change", function () {
    addFiles(input.files);
  });

  clearFiles.addEventListener("click", function () {
    selectedFiles = [];
    input.value = "";
    hideStatus();
    renderFiles();
  });

  qualityInput.addEventListener("input", function () {
    qualityValue.value = qualityInput.value + "%";
  });

  dropZone.addEventListener("click", function () {
    if (!uploading) input.click();
  });

  dropZone.addEventListener("keydown", function (event) {
    if ((event.key === "Enter" || event.key === " ") && !uploading) {
      event.preventDefault();
      input.click();
    }
  });

  ["dragenter", "dragover"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      if (!uploading) dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });

  dropZone.addEventListener("drop", function (event) {
    if (!uploading) addFiles(event.dataTransfer.files);
  });

  renderFiles();
})();

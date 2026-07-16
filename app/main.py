from __future__ import annotations

import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .panorama_processor import PanoramaError, load_project, process_panorama, save_project, validate_options
from .tour_exporter import export_project


BASE_DIR = Path(__file__).resolve().parent
TEMP_DIR = BASE_DIR / "temp"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
TTL_HOURS = float(os.getenv("TEMP_PROJECT_TTL_HOURS", "24"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Marzipano Clone")
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/project-files", StaticFiles(directory=TEMP_DIR), name="project-files")

progress_state: dict[str, dict] = {}


def _project_dir(project_id: str) -> Path:
    try:
        uuid.UUID(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.") from exc
    path = TEMP_DIR / project_id
    if not path.exists():
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    return path


def _touch(path: Path) -> None:
    now = time.time()
    os.utime(path, (now, now))


def cleanup_expired_projects() -> None:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    max_age = TTL_HOURS * 3600
    now = time.time()
    for child in TEMP_DIR.iterdir():
        if child.is_dir() and now - child.stat().st_mtime > max_age:
            shutil.rmtree(child, ignore_errors=True)
            progress_state.pop(child.name, None)


def _create_project(tile_size: int, jpeg_quality: int) -> tuple[str, Path, dict]:
    validate_options(tile_size, jpeg_quality)
    project_id = str(uuid.uuid4())
    project_dir = TEMP_DIR / project_id
    (project_dir / "incoming").mkdir(parents=True)
    (project_dir / "uploads").mkdir()
    (project_dir / "tiles").mkdir()
    data = {
        "id": project_id,
        "createdAt": int(time.time()),
        "tileSize": tile_size,
        "jpegQuality": jpeg_quality,
        "settings": {
            "autorotate": False,
            "controls": True,
            "fullscreen": True,
            "sceneList": True,
            "mouseViewMode": "drag",
        },
        "scenes": [],
    }
    save_project(project_dir, data)
    progress_state[project_id] = {"status": "ready", "percent": 0, "message": "Projeto criado.", "errors": []}
    return project_id, project_dir, data


async def _save_uploads(files: list[UploadFile], incoming_dir: Path) -> list[Path]:
    paths = []
    allowed = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    for upload in files:
        original = Path(upload.filename or "panorama.jpg")
        suffix = original.suffix.lower()
        if suffix not in allowed:
            raise HTTPException(status_code=400, detail=f"Tipo de arquivo nao permitido: {upload.filename}")
        safe_name = "".join(c if c.isalnum() or c in ".-_" else "-" for c in original.name)[:120] or f"panorama{suffix}"
        target = incoming_dir / safe_name
        if target.exists():
            target = incoming_dir / f"{uuid.uuid4().hex}-{safe_name}"
        with target.open("wb") as fh:
            while chunk := await upload.read(1024 * 1024):
                fh.write(chunk)
        paths.append(target)
    return paths


def _process_files(project_id: str, files: list[str], tile_size: int, jpeg_quality: int) -> None:
    project_dir = TEMP_DIR / project_id
    try:
        project = load_project(project_dir)
        total = len(files)
        progress_state[project_id] = {"status": "processing", "percent": 1, "message": "Iniciando processamento.", "errors": []}
        next_index = len(project["scenes"]) + 1

        for offset, filename in enumerate(files):
            upload_path = project_dir / "incoming" / filename

            def set_progress(step: str, fraction: float, message: str) -> None:
                overall = ((offset + fraction) / total) * 100
                progress_state[project_id].update({"status": "processing", "percent": round(overall, 1), "message": message, "step": step})

            try:
                scene = process_panorama(upload_path, project_dir, next_index + offset, tile_size, jpeg_quality, set_progress)
                project["scenes"].append(scene)
                save_project(project_dir, project)
            except PanoramaError as exc:
                progress_state[project_id].setdefault("errors", []).append({"file": filename, "message": str(exc)})
            finally:
                upload_path.unlink(missing_ok=True)

        if project["scenes"]:
            progress_state[project_id].update({"status": "done", "percent": 100, "message": "Processamento concluido."})
        else:
            progress_state[project_id].update({"status": "failed", "percent": 100, "message": "Nenhum panorama valido foi processado."})
        _touch(project_dir)
    except Exception as exc:
        progress_state[project_id] = {"status": "failed", "percent": 100, "message": f"Falha no processamento: {exc}", "errors": []}


@app.middleware("http")
async def cleanup_middleware(request: Request, call_next):
    cleanup_expired_projects()
    return await call_next(request)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/projects")
async def create_project(
    background_tasks: BackgroundTasks,
    files: Annotated[list[UploadFile], File()],
    tile_size: Annotated[int, Form()] = 512,
    jpeg_quality: Annotated[int, Form()] = 85,
):
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos um panorama.")
    project_id, project_dir, _ = _create_project(tile_size, jpeg_quality)
    try:
        saved = await _save_uploads(files, project_dir / "incoming")
    except Exception:
        shutil.rmtree(project_dir, ignore_errors=True)
        progress_state.pop(project_id, None)
        raise
    background_tasks.add_task(_process_files, project_id, [p.name for p in saved], tile_size, jpeg_quality)
    return {"projectId": project_id, "editorUrl": f"/projects/{project_id}"}


@app.post("/api/projects/{project_id}/panoramas")
async def add_panoramas(
    project_id: str,
    background_tasks: BackgroundTasks,
    files: Annotated[list[UploadFile], File()],
    tile_size: Annotated[int | None, Form()] = None,
    jpeg_quality: Annotated[int | None, Form()] = None,
):
    project_dir = _project_dir(project_id)
    project = load_project(project_dir)
    tile_size = tile_size or int(project.get("tileSize", 512))
    jpeg_quality = jpeg_quality or int(project.get("jpegQuality", 85))
    validate_options(tile_size, jpeg_quality)
    if progress_state.get(project_id, {}).get("status") == "processing":
        raise HTTPException(status_code=409, detail="O projeto ainda esta processando.")
    saved = await _save_uploads(files, project_dir / "incoming")
    background_tasks.add_task(_process_files, project_id, [p.name for p in saved], tile_size, jpeg_quality)
    return {"projectId": project_id, "queued": len(saved)}


@app.get("/api/projects/{project_id}/progress")
async def project_progress(project_id: str):
    _project_dir(project_id)
    return progress_state.get(project_id, {"status": "unknown", "percent": 0, "message": "Sem progresso registrado.", "errors": []})


@app.get("/projects/{project_id}", response_class=HTMLResponse)
async def project_editor(project_id: str, request: Request):
    _project_dir(project_id)
    return templates.TemplateResponse("editor.html", {"request": request, "project_id": project_id})


@app.get("/api/projects/{project_id}")
async def project_data(project_id: str):
    project_dir = _project_dir(project_id)
    _touch(project_dir)
    return JSONResponse(load_project(project_dir))


@app.put("/api/projects/{project_id}")
async def save_project_data(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload.get("scenes"), list):
        raise HTTPException(status_code=400, detail="Projeto invalido: cenas ausentes.")
    if not isinstance(payload.get("settings"), dict):
        raise HTTPException(status_code=400, detail="Projeto invalido: configuracoes ausentes.")
    current = load_project(project_dir)
    current["settings"] = payload["settings"]
    current["scenes"] = payload["scenes"]
    save_project(project_dir, current)
    _touch(project_dir)
    return {"ok": True}


@app.get("/api/projects/{project_id}/export")
async def export_zip(project_id: str):
    project_dir = _project_dir(project_id)
    project = load_project(project_dir)
    if not project.get("scenes"):
        raise HTTPException(status_code=400, detail="Nao ha cenas para exportar.")
    zip_path = export_project(project_dir, STATIC_DIR)
    _touch(project_dir)
    return FileResponse(zip_path, media_type="application/zip", filename="tour.zip")


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    project_dir = _project_dir(project_id)
    shutil.rmtree(project_dir, ignore_errors=True)
    progress_state.pop(project_id, None)
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(PanoramaError)
async def panorama_exception_handler(request: Request, exc: PanoramaError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})

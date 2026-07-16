from __future__ import annotations

import json
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
from dotenv import load_dotenv

from .database import ProjectRecord, build_session_factory, make_database_url, upsert_project_record
from .panorama_processor import PanoramaError, extract_photo_metadata, load_project, process_panorama, save_project, validate_options
from .tour_exporter import export_project


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", str(BASE_DIR / "temp"))).expanduser().resolve()
TEMP_DIR = STORAGE_DIR
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
TTL_HOURS = float(os.getenv("TEMP_PROJECT_TTL_HOURS", "24"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_URL = make_database_url(TEMP_DIR, os.getenv("DATABASE_URL"))
SessionLocal = build_session_factory(DATABASE_URL)

app = FastAPI(title="Marzipano Clone")
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/project-files", StaticFiles(directory=TEMP_DIR), name="project-files")

progress_state: dict[str, dict] = {}

DEFAULT_PROJECT_SETTINGS = {
    "autorotate": False,
    "controls": True,
    "fullscreen": True,
    "sceneList": True,
    "mouseViewMode": "drag",
    "showPhotoNames": False,
}


def _db_session():
    return SessionLocal()


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


def _coerce_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "sim"}:
            return True
        if normalized in {"0", "false", "no", "off", "nao", "não"}:
            return False
    return bool(value)


def _normalize_project_settings(settings: dict | None) -> dict:
    normalized = DEFAULT_PROJECT_SETTINGS.copy()
    if isinstance(settings, dict):
        normalized.update(settings)
    for key in ("autorotate", "controls", "fullscreen", "sceneList", "showPhotoNames"):
        normalized[key] = _coerce_bool(normalized.get(key), DEFAULT_PROJECT_SETTINGS[key])
    if normalized.get("mouseViewMode") not in {"drag", "qtvr"}:
        normalized["mouseViewMode"] = "drag"
    return normalized


def _normalize_project(project: dict) -> dict:
    project["settings"] = _normalize_project_settings(project.get("settings"))
    project["scenes"] = project.get("scenes") if isinstance(project.get("scenes"), list) else []
    for scene in project["scenes"]:
        scene.setdefault("infoHotspots", [])
        scene.setdefault("linkHotspots", [])
    return project


def cleanup_expired_projects() -> None:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    max_age = TTL_HOURS * 3600
    now = time.time()
    for child in TEMP_DIR.iterdir():
        if child.is_dir() and now - child.stat().st_mtime > max_age:
            shutil.rmtree(child, ignore_errors=True)
            progress_state.pop(child.name, None)
            with _db_session() as session:
                record = session.get(ProjectRecord, child.name)
                if record:
                    session.delete(record)
                    session.commit()


def _project_summary(project_dir: Path) -> dict | None:
    try:
        project = _normalize_project(load_project(project_dir))
    except Exception:
        return None
    project_id = project.get("id") or project_dir.name
    thumbnail_path = project.get("thumbnailPath")
    return {
        "id": project_id,
        "name": project.get("name") or "Tour 360",
        "createdAt": project.get("createdAt"),
        "updatedAt": int(project_dir.stat().st_mtime),
        "sceneCount": len(project.get("scenes") or []),
        "thumbnailUrl": f"/project-files/{project_id}/{thumbnail_path}" if thumbnail_path else None,
        "editorUrl": f"/projects/{project_id}",
        "viewUrl": f"/view/{project_id}",
        "status": progress_state.get(project_id, {}).get("status", "saved"),
    }


def _record_summary(record: ProjectRecord) -> dict:
    thumbnail_url = f"/project-files/{record.id}/{record.thumbnail_path}" if record.thumbnail_path else None
    status = progress_state.get(record.id, {}).get("status", record.status)
    if status == "saved":
        status = "done" if record.scene_count else "ready"
    return {
        "id": record.id,
        "name": record.name,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "sceneCount": record.scene_count,
        "thumbnailUrl": thumbnail_url,
        "editorUrl": f"/projects/{record.id}",
        "viewUrl": f"/view/{record.id}",
        "status": status,
    }


def _sync_project_record(project_dir: Path, status: str | None = None) -> ProjectRecord | None:
    summary = _project_summary(project_dir)
    if not summary:
        return None
    project = _normalize_project(load_project(project_dir))
    fallback_status = "done" if project.get("scenes") else "ready"
    record_status = progress_state.get(summary["id"], {}).get("status", status or fallback_status)
    with _db_session() as session:
        return upsert_project_record(session, project=project, project_dir=project_dir, status=record_status)


def _backfill_missing_photo_metadata(project_dir: Path, project: dict) -> bool:
    changed = False
    for scene in project.get("scenes") or []:
        metadata = scene.setdefault("metadata", {})
        wanted_fields = ("takenAt", "height", "relativeAltitude", "absoluteAltitude", "altitude")
        if all(metadata.get(field) is not None for field in wanted_fields):
            continue
        source_file = scene.get("sourceFile")
        if not source_file:
            continue
        source_path = project_dir / "uploads" / source_file
        if not source_path.exists():
            continue
        extracted = extract_photo_metadata(source_path)
        for field in wanted_fields:
            if metadata.get(field) is None and extracted.get(field) is not None:
                metadata[field] = extracted[field]
                changed = True
        if metadata.get("coordinates") is None and extracted.get("coordinates") is not None:
            metadata["coordinates"] = extracted["coordinates"]
            metadata["hasGps"] = True
            changed = True
    if changed:
        save_project(project_dir, project)
    return changed


def _create_project(tile_size: int, jpeg_quality: int, name: str | None = None, show_photo_names: bool = False) -> tuple[str, Path, dict]:
    validate_options(tile_size, jpeg_quality)
    project_id = str(uuid.uuid4())
    project_dir = TEMP_DIR / project_id
    (project_dir / "incoming").mkdir(parents=True)
    (project_dir / "uploads").mkdir()
    (project_dir / "tiles").mkdir()
    (project_dir / "assets").mkdir()
    data = {
        "id": project_id,
        "name": (name or "Tour 360").strip()[:120] or "Tour 360",
        "createdAt": int(time.time()),
        "tileSize": tile_size,
        "jpegQuality": jpeg_quality,
        "thumbnailPath": None,
        "settings": _normalize_project_settings({"showPhotoNames": show_photo_names}),
        "scenes": [],
    }
    save_project(project_dir, data)
    progress_state[project_id] = {"status": "ready", "percent": 0, "message": "Projeto criado.", "errors": []}
    with _db_session() as session:
        upsert_project_record(session, project=data, project_dir=project_dir, status="ready")
    return project_id, project_dir, data


async def _save_thumbnail(upload: UploadFile | None, project_dir: Path) -> str | None:
    if upload is None or not upload.filename:
        return None
    original = Path(upload.filename)
    suffix = original.suffix.lower()
    allowed = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
    if suffix not in allowed:
        raise HTTPException(status_code=400, detail="Thumbnail deve ser JPEG, PNG, WebP ou TIFF.")

    target = project_dir / "assets" / f"thumbnail{suffix}"
    upload.file.seek(0)
    with target.open("wb") as fh:
        shutil.copyfileobj(upload.file, fh)

    try:
        from PIL import Image, ImageOps

        with Image.open(target) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail((960, 540), Image.Resampling.LANCZOS)
            output = project_dir / "assets" / "thumbnail.jpg"
            image.convert("RGB").save(output, "JPEG", quality=86, optimize=True)
        if target != output:
            target.unlink(missing_ok=True)
        return "assets/thumbnail.jpg"
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Thumbnail invalida ou imagem nao suportada.") from exc


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
        project = _normalize_project(load_project(project_dir))
        total = len(files)
        progress_state[project_id] = {"status": "processing", "percent": 1, "message": "Iniciando processamento.", "errors": []}
        with _db_session() as session:
            upsert_project_record(session, project=project, project_dir=project_dir, status="processing")
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
                with _db_session() as session:
                    upsert_project_record(session, project=project, project_dir=project_dir, status="processing")
            except PanoramaError as exc:
                progress_state[project_id].setdefault("errors", []).append({"file": filename, "message": str(exc)})
            finally:
                upload_path.unlink(missing_ok=True)

        if project["scenes"]:
            progress_state[project_id].update({"status": "done", "percent": 100, "message": "Processamento concluido."})
            final_status = "done"
        else:
            progress_state[project_id].update({"status": "failed", "percent": 100, "message": "Nenhum panorama valido foi processado."})
            final_status = "failed"
        _touch(project_dir)
        with _db_session() as session:
            upsert_project_record(session, project=project, project_dir=project_dir, status=final_status)
    except Exception as exc:
        progress_state[project_id] = {"status": "failed", "percent": 100, "message": f"Falha no processamento: {exc}", "errors": []}
        if project_dir.exists():
            try:
                failed_project = load_project(project_dir)
                with _db_session() as session:
                    upsert_project_record(session, project=failed_project, project_dir=project_dir, status="failed")
            except Exception:
                pass


@app.middleware("http")
async def cleanup_middleware(request: Request, call_next):
    cleanup_expired_projects()
    return await call_next(request)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/projects")
async def list_projects():
    for project_dir in TEMP_DIR.iterdir():
        if project_dir.is_dir() and (project_dir / "project.json").exists():
            _sync_project_record(project_dir)
    with _db_session() as session:
        records = session.query(ProjectRecord).order_by(ProjectRecord.updated_at.desc()).all()
        projects = [_record_summary(record) for record in records if Path(record.storage_path).exists()]
    return JSONResponse({"projects": projects}, headers={"Cache-Control": "no-store"})


@app.get("/api/storage")
async def storage_info():
    return {"storageDir": str(TEMP_DIR), "databaseUrl": DATABASE_URL}


@app.post("/api/projects")
async def create_project(
    background_tasks: BackgroundTasks,
    files: Annotated[list[UploadFile] | None, File()] = None,
    thumbnail: Annotated[UploadFile | None, File()] = None,
    project_name: Annotated[str | None, Form()] = None,
    show_photo_names: Annotated[bool, Form()] = False,
    tile_size: Annotated[int, Form()] = 512,
    jpeg_quality: Annotated[int, Form()] = 85,
):
    project_id, project_dir, project = _create_project(tile_size, jpeg_quality, project_name, show_photo_names)
    try:
        thumbnail_path = await _save_thumbnail(thumbnail, project_dir)
        if thumbnail_path:
            project["thumbnailPath"] = thumbnail_path
            save_project(project_dir, project)
            with _db_session() as session:
                upsert_project_record(session, project=project, project_dir=project_dir, status="ready")
        saved = await _save_uploads(files or [], project_dir / "incoming")
    except Exception:
        shutil.rmtree(project_dir, ignore_errors=True)
        progress_state.pop(project_id, None)
        with _db_session() as session:
            record = session.get(ProjectRecord, project_id)
            if record:
                session.delete(record)
                session.commit()
        raise
    if saved:
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
    project = _normalize_project(load_project(project_dir))
    tile_size = tile_size or int(project.get("tileSize", 512))
    jpeg_quality = jpeg_quality or int(project.get("jpegQuality", 85))
    validate_options(tile_size, jpeg_quality)
    if progress_state.get(project_id, {}).get("status") == "processing":
        raise HTTPException(status_code=409, detail="O projeto ainda esta processando.")
    saved = await _save_uploads(files, project_dir / "incoming")
    with _db_session() as session:
        upsert_project_record(session, project=project, project_dir=project_dir, status="processing")
    background_tasks.add_task(_process_files, project_id, [p.name for p in saved], tile_size, jpeg_quality)
    return {"projectId": project_id, "queued": len(saved)}


@app.get("/api/projects/{project_id}/progress")
async def project_progress(project_id: str):
    project_dir = _project_dir(project_id)
    state = progress_state.get(project_id)
    if state:
        return state
    project = _normalize_project(load_project(project_dir))
    if project.get("scenes"):
        return {"status": "done", "percent": 100, "message": "Projeto carregado do disco.", "errors": []}
    return {"status": "ready", "percent": 0, "message": "Projeto criado.", "errors": []}


@app.get("/projects/{project_id}", response_class=HTMLResponse)
async def project_editor(project_id: str, request: Request):
    _project_dir(project_id)
    return templates.TemplateResponse("editor.html", {"request": request, "project_id": project_id})


@app.get("/view/{project_id}", response_class=HTMLResponse)
async def project_view(project_id: str, request: Request):
    return _render_project_view(project_id, request, None)


@app.get("/view/{project_id}/{scene_id}", response_class=HTMLResponse)
async def project_view_scene(project_id: str, scene_id: str, request: Request):
    return _render_project_view(project_id, request, scene_id)


def _render_project_view(project_id: str, request: Request, scene_id: str | None) -> HTMLResponse:
    project_dir = _project_dir(project_id)
    project = _normalize_project(load_project(project_dir))
    if _backfill_missing_photo_metadata(project_dir, project):
        _sync_project_record(project_dir)
    show_btn_list = request.query_params.get("showBtnList", "true").lower() != "false"
    return templates.TemplateResponse(
        "view.html",
        {
            "request": request,
            "project_id": project_id,
            "initial_scene_id": scene_id or "",
            "show_btn_list": "true" if show_btn_list else "false",
            "project_json": json.dumps(project, ensure_ascii=False),
        },
    )


@app.get("/api/projects/{project_id}")
async def project_data(project_id: str):
    project_dir = _project_dir(project_id)
    _touch(project_dir)
    project = _normalize_project(load_project(project_dir))
    _backfill_missing_photo_metadata(project_dir, project)
    _sync_project_record(project_dir)
    return JSONResponse(project, headers={"Cache-Control": "no-store"})


@app.put("/api/projects/{project_id}")
async def save_project_data(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload.get("scenes"), list):
        raise HTTPException(status_code=400, detail="Projeto invalido: cenas ausentes.")
    if not isinstance(payload.get("settings"), dict):
        raise HTTPException(status_code=400, detail="Projeto invalido: configuracoes ausentes.")
    current = _normalize_project(load_project(project_dir))
    current["settings"] = _normalize_project_settings(payload["settings"])
    current["scenes"] = payload["scenes"]
    save_project(project_dir, current)
    _touch(project_dir)
    with _db_session() as session:
        upsert_project_record(session, project=current, project_dir=project_dir, status="saved")
    return {"ok": True}


@app.get("/api/projects/{project_id}/export")
async def export_zip(project_id: str):
    project_dir = _project_dir(project_id)
    project = _normalize_project(load_project(project_dir))
    _backfill_missing_photo_metadata(project_dir, project)
    if not project.get("scenes"):
        raise HTTPException(status_code=400, detail="Nao ha cenas para exportar.")
    zip_path = export_project(project_dir, STATIC_DIR)
    _touch(project_dir)
    _sync_project_record(project_dir)
    return FileResponse(zip_path, media_type="application/zip", filename="tour.zip")


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    project_dir = _project_dir(project_id)
    shutil.rmtree(project_dir, ignore_errors=True)
    progress_state.pop(project_id, None)
    with _db_session() as session:
        record = session.get(ProjectRecord, project_id)
        if record:
            session.delete(record)
            session.commit()
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(PanoramaError)
async def panorama_exception_handler(request: Request, exc: PanoramaError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})

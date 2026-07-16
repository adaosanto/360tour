from __future__ import annotations

import csv
import io
import json
import math
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
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
        wanted_fields = (
            "takenAt",
            "height",
            "relativeAltitude",
            "absoluteAltitude",
            "altitude",
            "gimbalRollDegree",
            "gimbalYawDegree",
            "gimbalPitchDegree",
            "flightRollDegree",
            "flightYawDegree",
            "flightPitchDegree",
            "cameraYaw",
            "cameraYawSource",
        )
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


def _as_number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371008.8
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _project_scene_point(scene: dict) -> tuple[float, float] | None:
    coordinates = (scene.get("metadata") or {}).get("coordinates") or {}
    lat = _as_number(coordinates.get("latitude"))
    lon = _as_number(coordinates.get("longitude"))
    if lat is None or lon is None:
        return None
    return lat, lon


def _feature_point_coordinates(feature: dict) -> tuple[float, float] | None:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Point" and isinstance(coordinates, list) and len(coordinates) >= 2:
        lon = _as_number(coordinates[0])
        lat = _as_number(coordinates[1])
        if lat is not None and lon is not None:
            return lat, lon
    return None


def _identifier_text(value) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        return str(value).strip()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _property_identifier(properties: dict, candidates: list[str]) -> str | None:
    for field in candidates:
        identifier = _identifier_text(properties.get(field))
        if identifier:
            return identifier
    return None


def _point_identifier(properties: dict, id_field: str) -> str | None:
    candidates = [id_field, "point_id", "ponto_id", "PONTO_ID", "OBJECTID", "ObjectId", "objectid", "id"]
    return _property_identifier(properties, candidates)


def _guid_identifier(properties: dict) -> str:
    candidates = ["globalid", "GlobalID", "GLOBALID", "GlobalId", "global_id", "guid", "GUID"]
    return _property_identifier(properties, candidates) or ""


def _arcgis_geojson_url(arcgis_url: str) -> str:
    parts = urllib.parse.urlsplit(arcgis_url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    normalized = []
    has_out_fields = False
    has_format = False
    for key, value in query:
        lower_key = key.lower()
        if lower_key == "outfields":
            has_out_fields = True
            normalized.append((key, "*"))
        elif lower_key == "f":
            has_format = True
            normalized.append((key, "pgeojson"))
        else:
            normalized.append((key, value))
    if not has_out_fields:
        normalized.append(("outFields", "*"))
    if not has_format:
        normalized.append(("f", "pgeojson"))
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(normalized), parts.fragment))


def _fetch_geojson_points(arcgis_url: str, id_field: str) -> list[dict]:
    if not arcgis_url or not arcgis_url.lower().startswith(("https://", "http://")):
        raise HTTPException(status_code=400, detail="Informe uma URL HTTP/HTTPS valida do ArcGIS.")
    request = urllib.request.Request(_arcgis_geojson_url(arcgis_url), headers={"User-Agent": "MarzipanoClone/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(20 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"ArcGIS retornou HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel consultar o ArcGIS: {exc.reason}") from exc
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Resposta do ArcGIS nao e um GeoJSON valido.") from exc
    if isinstance(payload, dict) and payload.get("error"):
        message = payload["error"].get("message") if isinstance(payload["error"], dict) else "Erro no ArcGIS."
        raise HTTPException(status_code=502, detail=f"ArcGIS: {message}")
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise HTTPException(status_code=502, detail="Resposta do ArcGIS nao contem features GeoJSON.")
    points = []
    for feature in features:
        if not isinstance(feature, dict):
            continue
        coordinates = _feature_point_coordinates(feature)
        properties = feature.get("properties") or {}
        point_id = _point_identifier(properties, id_field)
        if coordinates and point_id:
            points.append({
                "id": point_id,
                "guid": _guid_identifier(properties),
                "latitude": coordinates[0],
                "longitude": coordinates[1],
                "properties": properties,
            })
    return points


def _scene_height(scene: dict):
    metadata = scene.get("metadata") or {}
    for field in ("height", "relativeAltitude", "absoluteAltitude", "altitude"):
        if metadata.get(field) not in (None, ""):
            return metadata.get(field)
    return ""


def _autorename_payload_options(payload: dict) -> tuple[str, float, str]:
    arcgis_url = str(payload.get("arcgisUrl") or "").strip()
    max_distance = _as_number(payload.get("maxDistanceMeters"))
    id_field = str(payload.get("idField") or "OBJECTID").strip() or "OBJECTID"
    if max_distance is None or max_distance <= 0:
        raise HTTPException(status_code=400, detail="Distancia maxima deve ser maior que zero.")
    return arcgis_url, max_distance, id_field


def _build_autorename_matches(project: dict, points: list[dict], max_distance: float) -> list[dict]:
    matches = []
    for scene in project.get("scenes") or []:
        scene_point = _project_scene_point(scene)
        if not scene_point:
            matches.append({
                "sceneId": scene.get("id"),
                "sceneName": scene.get("name"),
                "sourceFile": scene.get("sourceFile"),
                "height": _scene_height(scene),
                "matched": False,
                "reason": "Cena sem coordenadas GPS.",
            })
            continue
        best = None
        for point in points:
            distance = _haversine_meters(scene_point[0], scene_point[1], point["latitude"], point["longitude"])
            if best is None or distance < best["distanceMeters"]:
                best = {**point, "distanceMeters": distance}
        if not best:
            matches.append({
                "sceneId": scene.get("id"),
                "sceneName": scene.get("name"),
                "sourceFile": scene.get("sourceFile"),
                "height": _scene_height(scene),
                "photo": {"latitude": scene_point[0], "longitude": scene_point[1]},
                "matched": False,
                "reason": "Nenhum ponto ArcGIS retornado.",
            })
            continue
        within_distance = best["distanceMeters"] <= max_distance
        matches.append({
            "sceneId": scene.get("id"),
            "sceneName": scene.get("name"),
            "sourceFile": scene.get("sourceFile"),
            "height": _scene_height(scene),
            "photo": {"latitude": scene_point[0], "longitude": scene_point[1]},
            "point": {"id": best["id"], "guid": best.get("guid") or "", "latitude": best["latitude"], "longitude": best["longitude"]},
            "distanceMeters": round(best["distanceMeters"], 2),
            "matched": within_distance,
            "reason": None if within_distance else f"Fora do limite de {max_distance:g} m.",
            "newId": best["id"] if within_distance else None,
            "newName": f"PONTO {best['id']}" if within_distance else None,
        })
    return matches


def _autorename_preview(project_dir: Path, payload: dict) -> dict:
    arcgis_url, max_distance, id_field = _autorename_payload_options(payload)
    project = _normalize_project(load_project(project_dir))
    _backfill_missing_photo_metadata(project_dir, project)
    points = _fetch_geojson_points(arcgis_url, id_field)
    matches = _build_autorename_matches(project, points, max_distance)
    matched_count = sum(1 for match in matches if match.get("matched"))
    duplicate_ids = sorted({
        match["newId"]
        for match in matches
        if match.get("matched") and sum(1 for item in matches if item.get("newId") == match["newId"]) > 1
    })
    return {
        "pointCount": len(points),
        "sceneCount": len(project.get("scenes") or []),
        "matchedCount": matched_count,
        "unmatchedCount": len(matches) - matched_count,
        "duplicatePointIds": duplicate_ids,
        "matches": matches,
    }


def _csv_payload_value(payload: dict, key: str) -> str:
    return str(payload.get(key) or "").strip()


def _scene_link(base_url: str, project_id: str, scene_id: str) -> str:
    quoted_project = urllib.parse.quote(project_id, safe="")
    quoted_scene = urllib.parse.quote(str(scene_id), safe="")
    return f"{base_url.rstrip('/')}/view/{quoted_project}/{quoted_scene}"


def _autorename_csv(project_id: str, project_dir: Path, payload: dict, base_url: str) -> str:
    preview = _autorename_preview(project_dir, payload)
    if preview["duplicatePointIds"]:
        raise HTTPException(
            status_code=400,
            detail="Mais de uma foto corresponde ao mesmo ponto: " + ", ".join(preview["duplicatePointIds"]),
        )
    rows = []
    fixed_values = {
        "Ciclo": _csv_payload_value(payload, "ciclo"),
        "Profissional": _csv_payload_value(payload, "profissional"),
        "Finalidade": _csv_payload_value(payload, "finalidade"),
        "DepartamentoSolicitante": _csv_payload_value(payload, "departamentoSolicitante"),
        "Situacao": _csv_payload_value(payload, "situacao"),
    }
    for match in preview["matches"]:
        if not match.get("matched"):
            continue
        point = match.get("point") or {}
        scene_id = str(match.get("newId") or match.get("sceneId") or "")
        rows.append({
            "OBJECTID": point.get("id") or match.get("newId") or "",
            "guid": point.get("guid") or "",
            "Observação": match.get("sourceFile") or match.get("sceneName") or match.get("sceneId") or "",
            "Altura": match.get("height") or "",
            "Ciclo": fixed_values["Ciclo"],
            "ImagemLink": _scene_link(base_url, project_id, scene_id),
            "Profissional": fixed_values["Profissional"],
            "Finalidade": fixed_values["Finalidade"],
            "DepartamentoSolicitante": fixed_values["DepartamentoSolicitante"],
            "Situacao": fixed_values["Situacao"],
        })
    output = io.StringIO()
    fieldnames = [
        "OBJECTID",
        "guid",
        "Observação",
        "Altura",
        "Ciclo",
        "ImagemLink",
        "Profissional",
        "Finalidade",
        "DepartamentoSolicitante",
        "Situacao",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


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


@app.post("/api/projects/{project_id}/autorename/preview")
async def autorename_project_preview(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload invalido.")
    preview = _autorename_preview(project_dir, payload)
    return JSONResponse(preview, headers={"Cache-Control": "no-store"})


@app.post("/api/projects/{project_id}/autorename/apply")
async def autorename_project_apply(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload invalido.")
    preview = _autorename_preview(project_dir, payload)
    if preview["duplicatePointIds"]:
        raise HTTPException(
            status_code=400,
            detail="Mais de uma foto corresponde ao mesmo ponto: " + ", ".join(preview["duplicatePointIds"]),
        )
    project = _normalize_project(load_project(project_dir))
    matches_by_scene_id = {
        match["sceneId"]: match
        for match in preview["matches"]
        if match.get("matched") and match.get("newId")
    }
    old_to_new = {}
    target_ids = []
    for scene in project.get("scenes") or []:
        match = matches_by_scene_id.get(scene.get("id"))
        next_id = str(match["newId"]) if match else str(scene.get("id"))
        target_ids.append(next_id)
        if match:
            old_to_new[str(scene.get("id"))] = next_id
    duplicate_scene_ids = sorted({scene_id for scene_id in target_ids if target_ids.count(scene_id) > 1})
    if duplicate_scene_ids:
        raise HTTPException(
            status_code=400,
            detail="A renomeacao geraria IDs duplicados: " + ", ".join(duplicate_scene_ids),
        )
    for scene in project.get("scenes") or []:
        match = matches_by_scene_id.get(scene.get("id"))
        if match:
            scene["id"] = str(match["newId"])
            scene["name"] = str(match["newName"])
            metadata = scene.setdefault("metadata", {})
            metadata["arcgisPointId"] = str(match["newId"])
            metadata["arcgisMatchDistanceMeters"] = match.get("distanceMeters")
            metadata["arcgisMatchedPoint"] = match.get("point")
        for hotspot in scene.get("linkHotspots") or []:
            target = str(hotspot.get("target"))
            if target in old_to_new:
                hotspot["target"] = old_to_new[target]
    save_project(project_dir, project)
    _touch(project_dir)
    with _db_session() as session:
        upsert_project_record(session, project=project, project_dir=project_dir, status="saved")
    preview["project"] = project
    return JSONResponse(preview, headers={"Cache-Control": "no-store"})


@app.post("/api/projects/{project_id}/autorename/export-csv")
async def autorename_project_export_csv(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload invalido.")
    csv_text = _autorename_csv(project_id, project_dir, payload, str(request.base_url))
    filename = f"autorename-matches-{project_id}.csv"
    return Response(
        csv_text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


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

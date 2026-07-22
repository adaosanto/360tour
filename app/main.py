from __future__ import annotations

import csv
import datetime as dt
import ipaddress
import io
import json
import math
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv

from .database import ProjectRecord, build_session_factory, insert_photo_access_log, make_database_url, upsert_project_record
from .panorama_processor import PanoramaError, extract_photo_metadata, load_project, process_panorama, save_project, validate_options
from .tour_exporter import export_project


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", str(BASE_DIR / "temp"))).expanduser().resolve()
TEMP_DIR = STORAGE_DIR
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
TTL_HOURS = float(os.getenv("TEMP_PROJECT_TTL_HOURS", "24"))
ARCGIS_TOKEN_URL = os.getenv("ARCGIS_TOKEN_URL", "http://192.168.173.99:8090/api/sma/token/")
ARCGIS_360_QUERY_URL = os.getenv(
    "ARCGIS_360_QUERY_URL",
    "https://services8.arcgis.com/MRbkurfLm8nmQrDq/ArcGIS/rest/services/Imagens_360/FeatureServer/0/query",
)
ARCGIS_360_ID_FIELD = os.getenv("ARCGIS_360_ID_FIELD", "OBJECTID")
ARCGIS_360_IMAGES_URL = os.getenv(
    "ARCGIS_360_IMAGES_URL",
    "https://services8.arcgis.com/MRbkurfLm8nmQrDq/ArcGIS/rest/services/Imagens_360/FeatureServer/1",
)
ARCGIS_DATE_TIMEZONE = os.getenv("ARCGIS_DATE_TIMEZONE", "America/Cuiaba")
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "true").strip().lower() not in {"0", "false", "no", "off"}
CSV_VIEW_URL_DEFAULT = os.getenv(
    "CSV_VIEW_URL_DEFAULT",
    "https://georaster.lucasdorioverde.mt.gov.br/fotos/app360/index.php/",
)
TEMP_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_URL = make_database_url(TEMP_DIR, os.getenv("DATABASE_URL"))
SessionLocal = build_session_factory(DATABASE_URL)

app = FastAPI(title="Marzipano Clone")
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/project-files", StaticFiles(directory=TEMP_DIR), name="project-files")

progress_state: dict[str, dict] = {}
arcgis_token_cache: dict[str, str | float] = {}

DEFAULT_PROJECT_SETTINGS = {
    "autorotate": False,
    "controls": True,
    "fullscreen": True,
    "sceneList": True,
    "mouseViewMode": "drag",
    "showPhotoNames": False,
    "showMapViewCone": True,
    "saveOriginalPhotos": True,
}


def _db_session():
    return SessionLocal()


def _valid_client_ip(value: str | None) -> str | None:
    candidate = str(value or "").strip()
    if not candidate:
        return None
    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1:candidate.index("]")]
    elif candidate.count(":") == 1 and "." in candidate:
        candidate = candidate.split(":", 1)[0]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _request_client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for", "")
        for candidate in forwarded_for.split(","):
            address = _valid_client_ip(candidate)
            if address:
                return address
        real_ip = _valid_client_ip(request.headers.get("x-real-ip"))
        if real_ip:
            return real_ip
    direct_ip = _valid_client_ip(request.client.host if request.client else None)
    return direct_ip or "0.0.0.0"


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


def _coerce_signed_degrees(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    number = ((number + 180) % 360) - 180
    return 0.0 if abs(number) < 0.000001 else round(number, 6)


def _normalize_project_settings(settings: dict | None) -> dict:
    normalized = DEFAULT_PROJECT_SETTINGS.copy()
    if isinstance(settings, dict):
        normalized.update(settings)
    for key in ("autorotate", "controls", "fullscreen", "sceneList", "showPhotoNames", "showMapViewCone", "saveOriginalPhotos"):
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
        scene["headingOffset"] = _coerce_signed_degrees(scene.get("headingOffset", 0))
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
    normalized_properties = {
        re.sub(r"[^a-z0-9]", "", str(key).lower()): value
        for key, value in properties.items()
    }
    for field in candidates:
        identifier = _identifier_text(properties.get(field))
        if identifier:
            return identifier
        normalized_field = re.sub(r"[^a-z0-9]", "", str(field).lower())
        identifier = _identifier_text(normalized_properties.get(normalized_field))
        if identifier:
            return identifier
    return None


def _point_identifier(properties: dict, id_field: str) -> str | None:
    candidates = [id_field, "point_id", "ponto_id", "PONTO_ID", "OBJECTID", "ObjectId", "objectid", "id"]
    return _property_identifier(properties, candidates)


def _guid_identifier(properties: dict) -> str:
    candidates = [
        "GlobalID",
        "globalId",
        "globalID",
        "GLOBALID",
        "GlobalId",
        "globalid",
        "global_id",
        "GLOBAL_ID",
        "guid",
        "GUID",
    ]
    return _property_identifier(properties, candidates) or ""


def _fetch_arcgis_token() -> str:
    now = time.time()
    cached_token = str(arcgis_token_cache.get("token") or "").strip()
    cached_expires = _as_number(arcgis_token_cache.get("expires")) or 0
    if cached_token and cached_expires - 60 > now:
        return cached_token

    request = urllib.request.Request(ARCGIS_TOKEN_URL, headers={"User-Agent": "MarzipanoClone/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(1024 * 1024)
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Servico de token retornou HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel buscar token ArcGIS: {exc.reason}") from exc

    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Resposta do servico de token nao e um JSON valido.") from exc

    token = str(payload.get("token") or "").strip() if isinstance(payload, dict) else ""
    expires = _as_number(payload.get("expires")) if isinstance(payload, dict) else None
    if not token:
        raise HTTPException(status_code=502, detail="Servico de token nao retornou token ArcGIS.")

    arcgis_token_cache["token"] = token
    arcgis_token_cache["expires"] = expires or (now + 300)
    return token


def _arcgis_json_request(
    endpoint: str,
    params: dict,
    *,
    method: str = "GET",
    timeout: int = 30,
    max_bytes: int = 20 * 1024 * 1024,
) -> dict:
    if not endpoint.lower().startswith(("https://", "http://")):
        raise HTTPException(status_code=500, detail="URL do ArcGIS invalida.")

    for attempt in range(2):
        request_params = {**params, "f": "json", "token": _fetch_arcgis_token()}
        encoded = urllib.parse.urlencode(request_params).encode("utf-8")
        if method == "POST":
            request = urllib.request.Request(
                endpoint,
                data=encoded,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                    "User-Agent": "MarzipanoClone/1.0",
                },
                method="POST",
            )
        else:
            separator = "&" if "?" in endpoint else "?"
            request = urllib.request.Request(
                f"{endpoint}{separator}{encoded.decode('utf-8')}",
                headers={"User-Agent": "MarzipanoClone/1.0"},
            )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(max_bytes)
        except urllib.error.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"ArcGIS retornou HTTP {exc.code}.") from exc
        except urllib.error.URLError as exc:
            raise HTTPException(status_code=502, detail=f"Nao foi possivel consultar o ArcGIS: {exc.reason}") from exc

        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Resposta do ArcGIS nao e um JSON valido.") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=502, detail="Resposta inesperada do ArcGIS.")

        error = payload.get("error")
        if not error:
            return payload
        code = error.get("code") if isinstance(error, dict) else None
        if code in {498, 499} and attempt == 0:
            arcgis_token_cache.clear()
            continue
        message = error.get("message") if isinstance(error, dict) else "Erro no ArcGIS."
        details = error.get("details") if isinstance(error, dict) else None
        if isinstance(details, list) and details:
            message = f"{message}: {'; '.join(str(item) for item in details if item)}"
        raise HTTPException(status_code=502, detail=f"ArcGIS: {message}")

    raise HTTPException(status_code=502, detail="Nao foi possivel autenticar no ArcGIS.")


def _arcgis_geojson_url(arcgis_url: str, token: str) -> str:
    parts = urllib.parse.urlsplit(arcgis_url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    normalized = []
    has_where = False
    has_out_fields = False
    has_format = False
    has_return_geometry = False
    for key, value in query:
        lower_key = key.lower()
        if lower_key == "token":
            continue
        if lower_key == "where":
            has_where = True
            normalized.append((key, value or "1=1"))
        elif lower_key == "outfields":
            has_out_fields = True
            normalized.append((key, "*"))
        elif lower_key == "f":
            has_format = True
            normalized.append((key, "pgeojson"))
        elif lower_key == "returngeometry":
            has_return_geometry = True
            normalized.append((key, "true"))
        else:
            normalized.append((key, value))
    if not has_where:
        normalized.append(("where", "1=1"))
    if not has_out_fields:
        normalized.append(("outFields", "*"))
    if not has_return_geometry:
        normalized.append(("returnGeometry", "true"))
    if not has_format:
        normalized.append(("f", "pgeojson"))
    normalized.append(("token", token))
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(normalized), parts.fragment))


def _fetch_geojson_points() -> list[dict]:
    if not ARCGIS_360_QUERY_URL.lower().startswith(("https://", "http://")):
        raise HTTPException(status_code=500, detail="ARCGIS_360_QUERY_URL invalida.")
    token = _fetch_arcgis_token()
    request = urllib.request.Request(_arcgis_geojson_url(ARCGIS_360_QUERY_URL, token), headers={"User-Agent": "MarzipanoClone/1.0"})
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
        point_id = _point_identifier(properties, ARCGIS_360_ID_FIELD)
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


def _scene_year(scene: dict) -> str:
    metadata = scene.get("metadata") or {}
    candidates = [metadata.get("takenAt"), metadata.get("dateTime"), metadata.get("date")]
    candidates.extend([scene.get("sourceFile"), scene.get("name"), scene.get("id")])
    for value in candidates:
        match = re.search(r"\b(20\d{2}|19\d{2})\b", str(value or ""))
        if match:
            return match.group(1)
    return ""


def _scene_realization_date(scene: dict) -> str:
    metadata = scene.get("metadata") or {}
    candidates = [metadata.get("takenAt"), metadata.get("dateTime"), metadata.get("date")]
    candidates.extend([scene.get("sourceFile"), scene.get("name"), scene.get("id")])
    for value in candidates:
        text = str(value or "")
        match = re.search(r"\b(20\d{2}|19\d{2})[:/-](\d{2})[:/-](\d{2})\b", text)
        if match:
            return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return ""


def _csv_guid(value) -> str:
    guid = str(value or "").strip()
    if not guid:
        return ""
    guid = guid.strip("{}")
    return f"{{{guid}}}"


def _autorename_payload_options(payload: dict) -> float:
    max_distance = _as_number(payload.get("maxDistanceMeters"))
    if max_distance is None or max_distance <= 0:
        raise HTTPException(status_code=400, detail="Distancia maxima deve ser maior que zero.")
    return max_distance


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
                "year": _scene_year(scene),
                "realizationDate": _scene_realization_date(scene),
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
                "year": _scene_year(scene),
                "realizationDate": _scene_realization_date(scene),
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
            "year": _scene_year(scene),
            "realizationDate": _scene_realization_date(scene),
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
    max_distance = _autorename_payload_options(payload)
    project = _normalize_project(load_project(project_dir))
    _backfill_missing_photo_metadata(project_dir, project)
    points = _fetch_geojson_points()
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


def _csv_view_url(payload: dict) -> str:
    return _csv_payload_value(payload, "viewUrl") or CSV_VIEW_URL_DEFAULT


def _scene_link(view_url: str, project_id: str, scene_id: str) -> str:
    quoted_project = urllib.parse.quote(project_id, safe="")
    quoted_scene = urllib.parse.quote(str(scene_id), safe="")
    replacements = {
        "{projectid}": quoted_project,
        "{projectId}": quoted_project,
        "{project_id}": quoted_project,
        "{photoId}": quoted_scene,
        "{photoid}": quoted_scene,
        "{sceneId}": quoted_scene,
        "{sceneid}": quoted_scene,
    }
    if any(token in view_url for token in replacements):
        link = view_url
        for token, value in replacements.items():
            link = link.replace(token, value)
        return link
    separator = "&" if "?" in view_url else "?"
    return f"{view_url.rstrip('/')}/{quoted_project}/{quoted_scene}{separator}showBtnList=false"


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
    view_url = _csv_view_url(payload)
    for match in preview["matches"]:
        if not match.get("matched"):
            continue
        point = match.get("point") or {}
        scene_id = str(match.get("newId") or match.get("sceneId") or "")
        rows.append({
            "OBJECTID": point.get("id") or match.get("newId") or "",
            "guid": _csv_guid(point.get("guid")),
            "Observação": match.get("sourceFile") or match.get("sceneName") or match.get("sceneId") or "",
            "Altura": match.get("height") or "",
            "Ano": match.get("year") or "",
            "DataRealizacao": match.get("realizationDate") or "",
            "Ciclo": fixed_values["Ciclo"],
            "ImagemLink": _scene_link(view_url, project_id, scene_id),
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
        "Ano",
        "DataRealizacao",
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


def _required_arcgis_code(payload: dict, key: str, label: str, allowed: set[int]) -> int:
    value = _csv_payload_value(payload, key)
    try:
        code = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Selecione {label}.") from exc
    if code not in allowed:
        raise HTTPException(status_code=400, detail=f"Valor invalido para {label}.")
    return code


def _arcgis_sync_form_values(payload: dict) -> dict:
    return {
        "Ciclo": _required_arcgis_code(payload, "ciclo", "o ciclo", {1, 2, 3, 4, 5, 6}),
        "Profissional": _required_arcgis_code(payload, "profissional", "o profissional", {3, 4}),
        "Finalidade": _required_arcgis_code(payload, "finalidade", "a finalidade", {1, 2, 3, 4}),
        "DepartamentoSolicitante": _required_arcgis_code(
            payload,
            "departamentoSolicitante",
            "o departamento solicitante",
            {1},
        ),
        "Situacao": _required_arcgis_code(payload, "situacao", "a situacao", {1, 2, 3}),
    }


def _arcgis_date_milliseconds(value) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        timezone = ZoneInfo(ARCGIS_DATE_TIMEZONE)
    except ZoneInfoNotFoundError:
        timezone = dt.timezone.utc
    try:
        parsed = dt.datetime.strptime(text[:10], "%Y-%m-%d").replace(tzinfo=timezone)
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)


def _normalized_arcgis_guid(value) -> str:
    return str(value or "").strip().strip("{}").lower()


def _normalized_photo_name(value) -> str:
    text = urllib.parse.unquote(str(value or "").strip()).replace("\\", "/")
    return text.rsplit("/", 1)[-1].casefold()


def _normalized_image_link(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parts = urllib.parse.urlsplit(text)
    path = parts.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, "", ""))


def _fetch_arcgis_image_index() -> tuple[set[str], set[tuple[str, str]], int]:
    endpoint = f"{ARCGIS_360_IMAGES_URL.rstrip('/')}/query"
    page_size = 2000
    offset = 0
    feature_count = 0
    image_links: set[str] = set()
    photo_identities: set[tuple[str, str]] = set()
    seen_object_ids: set[str] = set()

    while True:
        response = _arcgis_json_request(
            endpoint,
            {
                "where": "1=1",
                "outFields": "OBJECTID,ImagemLink,guid,Obervacao",
                "returnGeometry": "false",
                "orderByFields": "OBJECTID ASC",
                "resultOffset": offset,
                "resultRecordCount": page_size,
            },
        )
        features = response.get("features")
        if not isinstance(features, list):
            raise HTTPException(status_code=502, detail="Consulta da tabela ArcGIS nao retornou features.")
        if not features:
            break

        new_object_ids = set()
        for feature in features:
            attributes = feature.get("attributes") if isinstance(feature, dict) else None
            if not isinstance(attributes, dict):
                continue
            object_id = str(attributes.get("OBJECTID") or "")
            if object_id:
                new_object_ids.add(object_id)
            image_link = _normalized_image_link(attributes.get("ImagemLink"))
            if image_link:
                image_links.add(image_link)
            guid = _normalized_arcgis_guid(attributes.get("guid"))
            photo_name = _normalized_photo_name(attributes.get("Obervacao"))
            if guid and photo_name:
                photo_identities.add((guid, photo_name))
        if new_object_ids and new_object_ids.issubset(seen_object_ids):
            raise HTTPException(status_code=502, detail="A paginacao da tabela ArcGIS repetiu a mesma pagina.")
        seen_object_ids.update(new_object_ids)
        feature_count += len(features)
        offset += len(features)
        if len(features) < page_size and not response.get("exceededTransferLimit"):
            break
        if offset > 2_000_000:
            raise HTTPException(status_code=502, detail="A tabela ArcGIS excedeu o limite de paginacao esperado.")

    return image_links, photo_identities, feature_count


def _arcgis_image_candidates(project_id: str, preview: dict, payload: dict) -> list[dict]:
    fixed_values = _arcgis_sync_form_values(payload)
    view_url = _csv_view_url(payload)
    duplicate_point_ids = set(preview.get("duplicatePointIds") or [])
    candidates = []
    candidate_links: set[str] = set()

    for match in preview.get("matches") or []:
        if not match.get("matched"):
            continue
        point = match.get("point") or {}
        scene_id = str(match.get("newId") or match.get("sceneId") or "")
        image_link = _scene_link(view_url, project_id, scene_id).strip()
        guid = _csv_guid(point.get("guid"))
        invalid_reason = ""
        autorename_applied = (
            str(match.get("sceneId") or "") == str(match.get("newId") or "")
            and str(match.get("sceneName") or "") == str(match.get("newName") or "")
        )
        if not autorename_applied:
            invalid_reason = "Aplique o autorename antes de sincronizar esta imagem."
        elif str(match.get("newId") or "") in duplicate_point_ids:
            invalid_reason = "Mais de uma foto corresponde ao mesmo ponto neste projeto."
        elif not guid:
            invalid_reason = "O ponto correspondente nao possui GlobalID."
        elif not image_link:
            invalid_reason = "Nao foi possivel montar o ImagemLink."
        elif image_link in candidate_links:
            invalid_reason = "Outra foto deste projeto gera o mesmo ImagemLink."
        candidate_links.add(image_link)

        attributes = {
            "guid": guid,
            "Altitude": str(match.get("height") or "")[:255],
            "Ciclo": fixed_values["Ciclo"],
            "DataRealizacao": _arcgis_date_milliseconds(match.get("realizationDate")),
            "ImagemLink": image_link,
            "Profissional": fixed_values["Profissional"],
            "Finalidade": fixed_values["Finalidade"],
            "DepartamentoSolicitante": fixed_values["DepartamentoSolicitante"],
            "Obervacao": str(match.get("sourceFile") or match.get("sceneName") or match.get("sceneId") or "")[:255],
            "Situacao": fixed_values["Situacao"],
            "Ano": str(match.get("year") or "")[:256],
        }
        candidates.append({
            "sceneId": match.get("sceneId"),
            "sourceFile": match.get("sourceFile") or match.get("sceneName") or match.get("sceneId") or "",
            "pointId": point.get("id") or match.get("newId") or "",
            "distanceMeters": match.get("distanceMeters"),
            "imageLink": image_link,
            "attributes": attributes,
            "status": "invalid" if invalid_reason else "pending",
            "reason": invalid_reason or None,
        })
    return candidates


def _autorename_arcgis_sync_preview(project_id: str, project_dir: Path, payload: dict) -> dict:
    match_preview = _autorename_preview(project_dir, payload)
    candidates = _arcgis_image_candidates(project_id, match_preview, payload)
    existing_links, existing_photo_identities, existing_feature_count = _fetch_arcgis_image_index()
    for candidate in candidates:
        if candidate["status"] != "pending":
            continue
        attributes = candidate["attributes"]
        normalized_link = _normalized_image_link(candidate["imageLink"])
        photo_identity = (
            _normalized_arcgis_guid(attributes.get("guid")),
            _normalized_photo_name(attributes.get("Obervacao")),
        )
        if normalized_link and normalized_link in existing_links:
            candidate["status"] = "existing"
            candidate["reason"] = "ImagemLink ja existe na tabela ArcGIS, desconsiderando query params."
        elif all(photo_identity) and photo_identity in existing_photo_identities:
            candidate["status"] = "existing"
            candidate["reason"] = "A mesma foto ja existe para este ponto, embora o projeto ou a URL seja diferente."

    return {
        "pointCount": match_preview["pointCount"],
        "sceneCount": match_preview["sceneCount"],
        "matchedCount": match_preview["matchedCount"],
        "existingFeatureCount": existing_feature_count,
        "createCount": sum(1 for item in candidates if item["status"] == "pending"),
        "alreadyExistsCount": sum(1 for item in candidates if item["status"] == "existing"),
        "invalidCount": sum(1 for item in candidates if item["status"] == "invalid"),
        "records": candidates,
    }


def _add_arcgis_image_features(candidates: list[dict]) -> tuple[list[dict], list[dict]]:
    endpoint = f"{ARCGIS_360_IMAGES_URL.rstrip('/')}/addFeatures"
    created = []
    failed = []
    batch_size = 100
    for start in range(0, len(candidates), batch_size):
        batch = candidates[start:start + batch_size]
        response = _arcgis_json_request(
            endpoint,
            {
                "features": json.dumps(
                    [{"attributes": item["attributes"]} for item in batch],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "rollbackOnFailure": "true",
            },
            method="POST",
            timeout=60,
        )
        results = response.get("addResults")
        if not isinstance(results, list) or len(results) != len(batch):
            raise HTTPException(status_code=502, detail="ArcGIS retornou um resultado incompleto no addFeatures.")
        for candidate, result in zip(batch, results):
            record = {key: value for key, value in candidate.items() if key != "attributes"}
            if isinstance(result, dict) and result.get("success"):
                record.update({
                    "status": "created",
                    "objectId": result.get("objectId"),
                    "globalId": result.get("globalId"),
                    "reason": None,
                })
                created.append(record)
            else:
                error = result.get("error") if isinstance(result, dict) else None
                message = error.get("description") if isinstance(error, dict) else "Falha ao criar registro."
                record.update({"status": "failed", "reason": message})
                failed.append(record)
    return created, failed


def _create_project(
    tile_size: int,
    jpeg_quality: int,
    name: str | None = None,
    show_photo_names: bool = False,
    save_original_photos: bool = True,
) -> tuple[str, Path, dict]:
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
        "settings": _normalize_project_settings({
            "showPhotoNames": show_photo_names,
            "saveOriginalPhotos": save_original_photos,
        }),
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


def _safe_upload_name(filename: str | None) -> str:
    original = Path(filename or "panorama.jpg")
    suffix = original.suffix.lower()
    allowed = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    if suffix not in allowed:
        raise HTTPException(status_code=400, detail=f"Tipo de arquivo nao permitido: {filename}")
    return "".join(c if c.isalnum() or c in ".-_" else "-" for c in original.name)[:120] or f"panorama{suffix}"


async def _save_uploads(files: list[UploadFile], incoming_dir: Path, existing_names: list[str] | None = None) -> tuple[list[Path], list[str]]:
    paths = []
    prepared = []
    seen = set()
    skipped = []
    existing = {name.casefold() for name in existing_names or [] if name}
    existing.update(path.name.casefold() for path in incoming_dir.iterdir() if path.is_file())
    for upload in files:
        safe_name = _safe_upload_name(upload.filename)
        key = safe_name.casefold()
        if key in seen or key in existing:
            skipped.append(safe_name)
            continue
        seen.add(key)
        prepared.append((upload, safe_name))
    for upload, safe_name in prepared:
        target = incoming_dir / safe_name
        with target.open("wb") as fh:
            while chunk := await upload.read(1024 * 1024):
                fh.write(chunk)
        paths.append(target)
    return paths, sorted(skipped, key=str.casefold)


def _process_files(project_id: str, files: list[str], tile_size: int, jpeg_quality: int) -> None:
    project_dir = TEMP_DIR / project_id
    try:
        project = _normalize_project(load_project(project_dir))
        save_original_photos = project["settings"].get("saveOriginalPhotos", True)
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
                scene = process_panorama(
                    upload_path,
                    project_dir,
                    next_index + offset,
                    tile_size,
                    jpeg_quality,
                    set_progress,
                    save_original=save_original_photos,
                )
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
    save_original_photos: Annotated[bool, Form()] = True,
    tile_size: Annotated[int, Form()] = 512,
    jpeg_quality: Annotated[int, Form()] = 85,
):
    project_id, project_dir, project = _create_project(
        tile_size,
        jpeg_quality,
        project_name,
        show_photo_names,
        save_original_photos,
    )
    try:
        thumbnail_path = await _save_thumbnail(thumbnail, project_dir)
        if thumbnail_path:
            project["thumbnailPath"] = thumbnail_path
            save_project(project_dir, project)
            with _db_session() as session:
                upsert_project_record(session, project=project, project_dir=project_dir, status="ready")
        saved, skipped = await _save_uploads(files or [], project_dir / "incoming")
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
    return {"projectId": project_id, "editorUrl": f"/projects/{project_id}", "skipped": skipped}


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
    existing_names = [scene.get("sourceFile") for scene in project.get("scenes", []) if scene.get("sourceFile")]
    saved, skipped = await _save_uploads(files, project_dir / "incoming", existing_names)
    if saved:
        with _db_session() as session:
            upsert_project_record(session, project=project, project_dir=project_dir, status="processing")
        background_tasks.add_task(_process_files, project_id, [p.name for p in saved], tile_size, jpeg_quality)
    return {"projectId": project_id, "queued": len(saved), "skipped": skipped}


@app.post("/api/projects/{project_id}/panoramas/upload")
async def upload_panoramas_batch(
    project_id: str,
    files: Annotated[list[UploadFile], File()],
    clear_existing: Annotated[bool, Form()] = False,
):
    project_dir = _project_dir(project_id)
    project = _normalize_project(load_project(project_dir))
    if progress_state.get(project_id, {}).get("status") == "processing":
        raise HTTPException(status_code=409, detail="O projeto ainda esta processando.")
    incoming_dir = project_dir / "incoming"
    if clear_existing:
        for existing in incoming_dir.iterdir():
            if existing.is_file():
                existing.unlink(missing_ok=True)
    existing_names = [scene.get("sourceFile") for scene in project.get("scenes", []) if scene.get("sourceFile")]
    saved, skipped = await _save_uploads(files, incoming_dir, existing_names)
    _touch(project_dir)
    message = f"{len(saved)} arquivo(s) novo(s) recebidos para processamento."
    if skipped:
        message += f" {len(skipped)} duplicado(s) ignorado(s)."
    progress_state[project_id] = {
        "status": "uploading",
        "percent": 0,
        "message": message,
        "errors": [],
    }
    return {"projectId": project_id, "uploaded": len(saved), "files": [path.name for path in saved], "skipped": skipped}


@app.post("/api/projects/{project_id}/panoramas/process")
async def process_uploaded_panoramas(
    project_id: str,
    background_tasks: BackgroundTasks,
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
    incoming_dir = project_dir / "incoming"
    files = sorted(path.name for path in incoming_dir.iterdir() if path.is_file())
    if not files:
        raise HTTPException(status_code=400, detail="Nenhum panorama enviado para processar.")
    progress_state[project_id] = {
        "status": "queued",
        "percent": 0,
        "message": f"{len(files)} panorama(s) aguardando processamento.",
        "errors": [],
    }
    with _db_session() as session:
        upsert_project_record(session, project=project, project_dir=project_dir, status="processing")
    background_tasks.add_task(_process_files, project_id, files, tile_size, jpeg_quality)
    return {"projectId": project_id, "queued": len(files)}


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


@app.post("/api/projects/{project_id}/metrics/photo-access")
async def record_photo_access(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > 4096:
        raise HTTPException(status_code=413, detail="Payload de metrica muito grande.")
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Payload de metrica invalido.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload de metrica invalido.")

    photo_id = str(payload.get("photoId") or "").strip()
    if not photo_id or len(photo_id) > 255:
        raise HTTPException(status_code=400, detail="ID da foto invalido.")
    project = _normalize_project(load_project(project_dir))
    if not any(str(scene.get("id") or "") == photo_id for scene in project.get("scenes") or []):
        raise HTTPException(status_code=404, detail="Foto nao encontrada neste projeto.")

    with _db_session() as session:
        insert_photo_access_log(
            session,
            project_id=project_id,
            photo_id=photo_id,
            ip_address=_request_client_ip(request),
            accessed_at=int(time.time()),
        )
    return Response(status_code=204)


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
            metadata["arcgisPointGlobalId"] = (match.get("point") or {}).get("guid") or ""
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


@app.post("/api/projects/{project_id}/autorename/arcgis/preview")
async def autorename_project_arcgis_preview(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload invalido.")
    preview = _autorename_arcgis_sync_preview(project_id, project_dir, payload)
    return JSONResponse(preview, headers={"Cache-Control": "no-store"})


@app.post("/api/projects/{project_id}/autorename/arcgis/commit")
async def autorename_project_arcgis_commit(project_id: str, request: Request):
    project_dir = _project_dir(project_id)
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload invalido.")

    # Reconsulta a tabela imediatamente antes da escrita para evitar duplicidade entre preview e confirmacao.
    preview = _autorename_arcgis_sync_preview(project_id, project_dir, payload)
    pending = [record for record in preview["records"] if record.get("status") == "pending"]
    created, failed = _add_arcgis_image_features(pending) if pending else ([], [])
    unchanged = []
    for record in preview["records"]:
        if record.get("status") == "pending":
            continue
        unchanged.append({key: value for key, value in record.items() if key != "attributes"})

    return JSONResponse(
        {
            "existingFeatureCount": preview["existingFeatureCount"],
            "submittedCount": len(pending),
            "createdCount": len(created),
            "alreadyExistsCount": preview["alreadyExistsCount"],
            "invalidCount": preview["invalidCount"],
            "failedCount": len(failed),
            "records": unchanged + created + failed,
        },
        headers={"Cache-Control": "no-store"},
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
    current = _normalize_project(current)
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

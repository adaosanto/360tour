from __future__ import annotations

import json
import math
import os
import re
import shutil
from html import unescape
from pathlib import Path
from typing import Callable

import numpy as np
import py360convert
from PIL import ExifTags, Image, ImageOps


PIL_IMAGE_MAX_PIXELS = os.getenv("PIL_IMAGE_MAX_PIXELS", "1000000000").strip().lower()
if PIL_IMAGE_MAX_PIXELS in {"", "0", "none", "false", "off"}:
    Image.MAX_IMAGE_PIXELS = None
else:
    try:
        Image.MAX_IMAGE_PIXELS = int(PIL_IMAGE_MAX_PIXELS)
    except ValueError:
        Image.MAX_IMAGE_PIXELS = 1000000000

FACE_NAMES = ["f", "r", "b", "l", "u", "d"]


class PanoramaError(Exception):
    pass


def slugify(value: str, fallback: str) -> str:
    value = Path(value).stem.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or fallback


def validate_options(tile_size: int, jpeg_quality: int) -> tuple[int, int]:
    tile_size = int(tile_size)
    jpeg_quality = int(jpeg_quality)
    if tile_size < 128 or tile_size > 2048:
        raise PanoramaError("O tamanho do tile deve ficar entre 128 e 2048 px.")
    if jpeg_quality < 40 or jpeg_quality > 100:
        raise PanoramaError("A qualidade JPEG deve ficar entre 40 e 100.")
    return tile_size, jpeg_quality


def _load_panorama(upload_path: Path) -> Image.Image:
    try:
        image = Image.open(upload_path)
        image = ImageOps.exif_transpose(image)
        image.load()
    except Exception as exc:
        raise PanoramaError(f"Arquivo invalido ou imagem nao suportada: {upload_path.name}") from exc

    width, height = image.size
    if width < 512 or height < 256:
        raise PanoramaError("Panorama muito pequeno. Use pelo menos 512x256 px.")
    if abs((width / height) - 2.0) > 0.01:
        raise PanoramaError(f"Panorama precisa ter proporcao 2:1. Recebido: {width}x{height}.")
    return image.convert("RGB")


def _as_float(value) -> float | None:
    try:
        if isinstance(value, tuple) and len(value) == 2:
            numerator, denominator = value
            return float(numerator) / float(denominator)
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _dms_to_decimal(value, ref: str | None) -> float | None:
    if not value or len(value) != 3:
        return None
    degrees = _as_float(value[0])
    minutes = _as_float(value[1])
    seconds = _as_float(value[2])
    if degrees is None or minutes is None or seconds is None:
        return None
    decimal = degrees + (minutes / 60.0) + (seconds / 3600.0)
    if ref in {"S", "W"}:
        decimal *= -1
    return round(decimal, 8)


def _round_or_none(value) -> float | None:
    number = _as_float(value)
    return round(number, 2) if number is not None else None


def _extract_xmp_attributes(upload_path: Path) -> dict:
    try:
        with upload_path.open("rb") as fh:
            text = fh.read(2 * 1024 * 1024).decode("utf-8", errors="ignore")
    except Exception:
        return {}

    attrs = {}
    for match in re.finditer(r'([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)="([^"]*)"', text):
        name = match.group(1)
        value = unescape(match.group(2)).strip()
        local_name = name.split(":", 1)[-1]
        attrs[name] = value
        attrs[local_name] = value
    return attrs


def _apply_xmp_metadata(metadata: dict, attrs: dict) -> None:
    if not attrs:
        return

    taken_at = attrs.get("CreateDate") or attrs.get("DateTimeOriginal") or attrs.get("ModifyDate")
    if taken_at and not metadata.get("takenAt"):
        metadata["takenAt"] = taken_at

    latitude = _as_float(attrs.get("GpsLatitude") or attrs.get("GPSLatitude"))
    longitude = _as_float(attrs.get("GpsLongitude") or attrs.get("GPSLongitude"))
    if latitude is not None and longitude is not None:
        metadata["coordinates"] = {"latitude": round(latitude, 8), "longitude": round(longitude, 8)}
        metadata["hasGps"] = True

    absolute_altitude = _round_or_none(attrs.get("AbsoluteAltitude") or attrs.get("GPSAltitude"))
    relative_altitude = _round_or_none(attrs.get("RelativeAltitude"))
    if absolute_altitude is not None:
        metadata["absoluteAltitude"] = absolute_altitude
        if metadata.get("altitude") is None:
            metadata["altitude"] = absolute_altitude
    if relative_altitude is not None:
        metadata["relativeAltitude"] = relative_altitude
        metadata["height"] = relative_altitude

    orientation_fields = {
        "gimbalRollDegree": "GimbalRollDegree",
        "gimbalYawDegree": "GimbalYawDegree",
        "gimbalPitchDegree": "GimbalPitchDegree",
        "flightRollDegree": "FlightRollDegree",
        "flightYawDegree": "FlightYawDegree",
        "flightPitchDegree": "FlightPitchDegree",
    }
    for output_key, xmp_key in orientation_fields.items():
        value = _round_or_none(attrs.get(xmp_key))
        if value is not None:
            metadata[output_key] = value
    if metadata.get("gimbalYawDegree") is not None:
        metadata["cameraYaw"] = metadata["gimbalYawDegree"]
        metadata["cameraYawSource"] = "gimbalYawDegree"


def extract_photo_metadata(upload_path: Path) -> dict:
    metadata = {
        "source": "exif",
        "coordinates": None,
        "altitude": None,
        "height": None,
        "absoluteAltitude": None,
        "relativeAltitude": None,
        "gimbalRollDegree": None,
        "gimbalYawDegree": None,
        "gimbalPitchDegree": None,
        "flightRollDegree": None,
        "flightYawDegree": None,
        "flightPitchDegree": None,
        "cameraYaw": None,
        "cameraYawSource": None,
        "takenAt": None,
        "hasGps": False,
    }
    xmp_attrs = _extract_xmp_attributes(upload_path)
    try:
        with Image.open(upload_path) as image:
            exif = image.getexif()
            if not exif:
                _apply_xmp_metadata(metadata, xmp_attrs)
                return metadata

            tags = {
                ExifTags.TAGS.get(tag, tag): value
                for tag, value in exif.items()
            }
            taken_at = tags.get("DateTimeOriginal") or tags.get("DateTimeDigitized") or tags.get("DateTime")
            if taken_at:
                metadata["takenAt"] = str(taken_at)

            gps_raw = exif.get_ifd(ExifTags.IFD.GPSInfo) if hasattr(ExifTags, "IFD") else exif.get(34853, {})
            gps = {
                ExifTags.GPSTAGS.get(tag, tag): value
                for tag, value in dict(gps_raw or {}).items()
            }
            latitude = _dms_to_decimal(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef"))
            longitude = _dms_to_decimal(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef"))
            altitude = _as_float(gps.get("GPSAltitude"))
            if altitude is not None and gps.get("GPSAltitudeRef") in {1, b"\x01"}:
                altitude *= -1
            if latitude is not None and longitude is not None:
                metadata["coordinates"] = {"latitude": latitude, "longitude": longitude}
                metadata["hasGps"] = True
            if altitude is not None:
                metadata["altitude"] = round(altitude, 2)
                metadata["absoluteAltitude"] = metadata["altitude"]
            _apply_xmp_metadata(metadata, xmp_attrs)
            return metadata
    except Exception:
        _apply_xmp_metadata(metadata, xmp_attrs)
        return metadata


def _nearest_power_of_two(value: int) -> int:
    return 2 ** int(math.floor(math.log2(max(1, value))))


def _save_face_tiles(face: Image.Image, scene_dir: Path, face_name: str, levels: list[dict], jpeg_quality: int) -> None:
    for z, level in enumerate(levels):
        level_size = int(level["size"])
        tile_size = int(level["tileSize"])
        resized = face.resize((level_size, level_size), Image.Resampling.LANCZOS)
        cols = math.ceil(level_size / tile_size)
        rows = math.ceil(level_size / tile_size)
        for y in range(rows):
            for x in range(cols):
                left = x * tile_size
                upper = y * tile_size
                tile = resized.crop((left, upper, min(left + tile_size, level_size), min(upper + tile_size, level_size)))
                if tile.size != (tile_size, tile_size):
                    padded = Image.new("RGB", (tile_size, tile_size))
                    padded.paste(tile, (0, 0))
                    tile = padded
                output = scene_dir / str(z) / face_name / str(y)
                output.mkdir(parents=True, exist_ok=True)
                tile.save(output / f"{x}.jpg", "JPEG", quality=jpeg_quality, optimize=True)


def process_panorama(
    upload_path: Path,
    project_dir: Path,
    index: int,
    tile_size: int,
    jpeg_quality: int,
    progress: Callable[[str, float, str], None] | None = None,
    save_original: bool = True,
) -> dict:
    tile_size, jpeg_quality = validate_options(tile_size, jpeg_quality)
    scene_id = slugify(upload_path.name, f"cena-{index}")
    scene_dir = project_dir / "tiles" / scene_id
    if scene_dir.exists():
        scene_id = f"{scene_id}-{index}"
        scene_dir = project_dir / "tiles" / scene_id
    scene_dir.mkdir(parents=True, exist_ok=True)

    def notify(step: str, fraction: float, message: str) -> None:
        if progress:
            progress(step, fraction, message)

    notify("validating", 0.05, f"Validando {upload_path.name}")
    metadata = extract_photo_metadata(upload_path)
    image = _load_panorama(upload_path)
    width, height = image.size
    face_size = _nearest_power_of_two(width // 4)
    if face_size < tile_size:
        face_size = tile_size

    notify("cubemap", 0.20, f"Convertendo {upload_path.name} em cubemap")
    cube = py360convert.e2c(np.asarray(image), face_w=face_size, mode="bilinear", cube_format="dict")

    levels = []
    size = tile_size
    while size < face_size:
        levels.append({"tileSize": tile_size, "size": size})
        size *= 2
    levels.append({"tileSize": tile_size, "size": face_size})
    if len(levels) > 1:
        levels[0]["fallbackOnly"] = True

    total_faces = len(FACE_NAMES)
    for i, face_name in enumerate(FACE_NAMES):
        notify("tiles", 0.25 + (0.65 * i / total_faces), f"Gerando tiles da face {face_name}")
        raw_face = cube[face_name.upper()] if face_name.upper() in cube else cube[face_name]
        face_image = Image.fromarray(raw_face).convert("RGB")
        _save_face_tiles(face_image, scene_dir, face_name, levels, jpeg_quality)

    if save_original:
        uploads_dir = project_dir / "uploads"
        uploads_dir.mkdir(exist_ok=True)
        shutil.copyfile(upload_path, uploads_dir / upload_path.name)
    notify("done", 0.95, f"Finalizando {upload_path.name}")

    return {
        "id": scene_id,
        "name": Path(upload_path.name).stem,
        "sourceFile": upload_path.name,
        "originalSaved": bool(save_original),
        "tilePath": f"tiles/{scene_id}",
        "levels": levels,
        "faceSize": face_size,
        "initialViewParameters": {"yaw": 0, "pitch": 0, "fov": 1.5707963267948966},
        "headingOffset": 0,
        "linkHotspots": [],
        "infoHotspots": [],
        "originalSize": {"width": width, "height": height},
        "metadata": metadata,
    }


def load_project(project_dir: Path) -> dict:
    with (project_dir / "project.json").open("r", encoding="utf-8") as fh:
        return json.load(fh)


def save_project(project_dir: Path, data: dict) -> None:
    tmp_path = project_dir / "project.json.tmp"
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp_path.replace(project_dir / "project.json")

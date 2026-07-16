from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path


EXPORT_FILES = ["index.html", "app.js", "style.css", "marzipano.js", "README.txt"]


def _write_data_js(export_dir: Path, project: dict) -> None:
    payload = {
        "settings": project.get("settings", {}),
        "scenes": project.get("scenes", []),
    }
    (export_dir / "data.js").write_text(
        "window.data = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )


def export_project(project_dir: Path, static_dir: Path) -> Path:
    project = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    export_dir = project_dir / "export"
    if export_dir.exists():
        shutil.rmtree(export_dir)
    export_dir.mkdir(parents=True)

    for filename in EXPORT_FILES:
        source = static_dir / filename if filename == "marzipano.js" else static_dir / "tour" / filename
        shutil.copyfile(source, export_dir / filename)

    _write_data_js(export_dir, project)
    shutil.copytree(project_dir / "tiles", export_dir / "tiles")

    zip_path = project_dir / "tour.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(export_dir.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(export_dir).as_posix())
    return zip_path

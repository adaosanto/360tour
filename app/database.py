from __future__ import annotations

from pathlib import Path

from sqlalchemy import BigInteger, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


class Base(DeclarativeBase):
    pass


class ProjectRecord(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    thumbnail_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    scene_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="saved", nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)


class PhotoAccessLog(Base):
    __tablename__ = "photo_access_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    photo_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    accessed_at: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)


def make_database_url(storage_dir: Path, configured_url: str | None) -> str:
    if configured_url:
        return configured_url
    return f"sqlite:///{(storage_dir / 'projects.sqlite3').as_posix()}"


def build_session_factory(database_url: str):
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    engine = create_engine(database_url, connect_args=connect_args)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def upsert_project_record(session: Session, *, project: dict, project_dir: Path, status: str = "saved") -> ProjectRecord:
    project_id = project.get("id") or project_dir.name
    now = int(project_dir.stat().st_mtime if project_dir.exists() else project.get("createdAt", 0))
    record = session.get(ProjectRecord, project_id)
    if record is None:
        record = ProjectRecord(
            id=project_id,
            name=project.get("name") or "Tour 360",
            storage_path=str(project_dir),
            thumbnail_path=project.get("thumbnailPath"),
            scene_count=len(project.get("scenes") or []),
            status=status,
            created_at=int(project.get("createdAt") or now),
            updated_at=now,
        )
        session.add(record)
    else:
        record.name = project.get("name") or "Tour 360"
        record.storage_path = str(project_dir)
        record.thumbnail_path = project.get("thumbnailPath")
        record.scene_count = len(project.get("scenes") or [])
        record.status = status
        record.updated_at = now
    session.commit()
    return record


def insert_photo_access_log(
    session: Session,
    *,
    project_id: str,
    photo_id: str,
    ip_address: str,
    accessed_at: int,
) -> PhotoAccessLog:
    record = PhotoAccessLog(
        project_id=project_id,
        photo_id=photo_id,
        ip_address=ip_address,
        accessed_at=accessed_at,
    )
    session.add(record)
    session.commit()
    return record

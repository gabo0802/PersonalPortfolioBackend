#!/usr/bin/env python3
"""Export the public portfolio tables from Supabase into JSON snapshots."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
TABLES = (
    "skills",
    "projects",
    "experiences",
    "project_skills",
    "experience_skills",
)
ORDER_BY = {
    "skills": "slug.asc",
    "projects": "created_at.desc,slug.asc",
    "experiences": "order_index.asc,slug.asc",
    "project_skills": "project_slug.asc,skill_slug.asc",
    "experience_skills": "experience_slug.asc,skill_slug.asc",
}
REQUIRED_FIELDS = {
    "skills": ("slug", "name", "visual", "proficiency"),
    "projects": ("slug", "title", "summary", "description", "links", "thumbnail", "gallery"),
    "experiences": ("slug", "title", "description", "order_index"),
    "project_skills": ("project_slug", "skill_slug"),
    "experience_skills": ("experience_slug", "skill_slug"),
}
PRIMARY_TABLES = {"skills", "projects", "experiences"}


class ExportError(RuntimeError):
    """An expected exporter or validation failure."""


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    if not path.is_file():
        raise ExportError(f"Environment path is not a file: {path}")

    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()

        key, separator, value = line.partition("=")
        if not separator or not key.strip():
            raise ExportError(f"Invalid environment entry on line {line_number} of {path}")

        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def read_configuration() -> tuple[str, str]:
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("REACT_APP_SUPABASE_URL")
    anon_key = os.getenv("SUPABASE_ANON_KEY") or os.getenv("REACT_APP_SUPABASE_ANON_KEY")

    if not supabase_url:
        raise ExportError("Missing SUPABASE_URL or REACT_APP_SUPABASE_URL")
    if not anon_key:
        raise ExportError("Missing SUPABASE_ANON_KEY or REACT_APP_SUPABASE_ANON_KEY")

    parsed_url = urlparse(supabase_url)
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise ExportError("SUPABASE_URL must be an absolute HTTP(S) URL")

    return supabase_url.rstrip("/"), anon_key


def fetch_table(supabase_url: str, anon_key: str, table: str) -> list[dict[str, Any]]:
    query: dict[str, str] = {"select": "*"}
    if table in ORDER_BY:
        query["order"] = ORDER_BY[table]

    endpoint = f"{supabase_url}/rest/v1/{quote(table, safe='')}?{urlencode(query)}"
    request = Request(
        endpoint,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {anon_key}",
            "apikey": anon_key,
        },
    )

    try:
        with urlopen(request, timeout=20) as response:
            body = response.read()
    except HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise ExportError(f"Supabase request failed for {table} (HTTP {error.code}){suffix}") from error
    except URLError as error:
        raise ExportError(f"Supabase request failed for {table}: {error.reason}") from error
    except TimeoutError as error:
        raise ExportError(f"Supabase request timed out for {table}") from error

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExportError(f"Supabase returned invalid JSON for {table}") from error

    if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
        raise ExportError(f"Supabase returned a non-row response for {table}")

    return payload


def require_string(row: dict[str, Any], table: str, index: int, field: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ExportError(f"{table}[{index}] requires a non-empty string field: {field}")
    return value


def validate_rows(table: str, rows: list[dict[str, Any]]) -> None:
    if table in PRIMARY_TABLES and not rows:
        raise ExportError(f"Supabase returned no rows for required table: {table}")

    for index, row in enumerate(rows):
        missing = [field for field in REQUIRED_FIELDS[table] if field not in row]
        if missing:
            fields = ", ".join(missing)
            raise ExportError(f"{table}[{index}] is missing required fields: {fields}")

        for field in REQUIRED_FIELDS[table]:
            if field not in {"links", "thumbnail", "gallery", "order_index"}:
                require_string(row, table, index, field)

        if table == "projects":
            if not isinstance(row["links"], dict):
                raise ExportError(f"projects[{index}].links must be an object")
            if row["thumbnail"] is not None and not isinstance(row["thumbnail"], str):
                raise ExportError(f"projects[{index}].thumbnail must be a string or null")
            if not isinstance(row["gallery"], list):
                raise ExportError(f"projects[{index}].gallery must be an array")
            for media_index, media in enumerate(row["gallery"]):
                if not isinstance(media, dict) or not isinstance(media.get("url"), str):
                    raise ExportError(
                        f"projects[{index}].gallery[{media_index}] requires a url"
                    )

        if table == "experiences" and not isinstance(row["order_index"], int):
            raise ExportError(f"experiences[{index}].order_index must be an integer")


def validate_relationships(snapshot: dict[str, list[dict[str, Any]]]) -> None:
    skill_slugs = {row["slug"] for row in snapshot["skills"]}
    project_slugs = {row["slug"] for row in snapshot["projects"]}
    experience_slugs = {row["slug"] for row in snapshot["experiences"]}

    seen_project_relationships: set[tuple[str, str]] = set()
    for row in snapshot["project_skills"]:
        relationship = (row["project_slug"], row["skill_slug"])
        if relationship in seen_project_relationships:
            raise ExportError(f"Duplicate project_skills relationship: {relationship}")
        if row["project_slug"] not in project_slugs:
            raise ExportError(f"project_skills references unknown project: {row['project_slug']}")
        if row["skill_slug"] not in skill_slugs:
            raise ExportError(f"project_skills references unknown skill: {row['skill_slug']}")
        seen_project_relationships.add(relationship)

    seen_experience_relationships: set[tuple[str, str]] = set()
    for row in snapshot["experience_skills"]:
        relationship = (row["experience_slug"], row["skill_slug"])
        if relationship in seen_experience_relationships:
            raise ExportError(f"Duplicate experience_skills relationship: {relationship}")
        if row["experience_slug"] not in experience_slugs:
            raise ExportError(
                f"experience_skills references unknown experience: {row['experience_slug']}"
            )
        if row["skill_slug"] not in skill_slugs:
            raise ExportError(f"experience_skills references unknown skill: {row['skill_slug']}")
        seen_experience_relationships.add(relationship)


def write_json(path: Path, rows: list[dict[str, Any]]) -> None:
    serialized = json.dumps(rows, ensure_ascii=False, indent=2, sort_keys=True)
    path.write_text(f"{serialized}\n", encoding="utf-8")


def replace_snapshot(snapshot: dict[str, list[dict[str, Any]]]) -> None:
    staging_dir = REPO_ROOT / f".{DATA_DIR.name}.staging-{uuid.uuid4().hex}"
    backup_dir = REPO_ROOT / f".{DATA_DIR.name}.backup-{uuid.uuid4().hex}"

    try:
        staging_dir.mkdir(parents=True)
        for table, rows in snapshot.items():
            write_json(staging_dir / f"{table}.json", rows)

        if DATA_DIR.exists():
            if not DATA_DIR.is_dir():
                raise ExportError(f"Snapshot path is not a directory: {DATA_DIR}")
            DATA_DIR.rename(backup_dir)

        try:
            staging_dir.rename(DATA_DIR)
        except OSError as error:
            if backup_dir.exists() and not DATA_DIR.exists():
                backup_dir.rename(DATA_DIR)
            raise ExportError(f"Unable to activate the new snapshot: {error}") from error
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        if backup_dir.exists():
            if DATA_DIR.exists():
                shutil.rmtree(backup_dir)
            else:
                backup_dir.rename(DATA_DIR)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=REPO_ROOT / ".env",
        help="dotenv-style file containing Supabase credentials (default: .env)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        load_dotenv(args.env_file)
        supabase_url, anon_key = read_configuration()
        snapshot = {
            table: fetch_table(supabase_url, anon_key, table)
            for table in TABLES
        }
        for table, rows in snapshot.items():
            validate_rows(table, rows)
        validate_relationships(snapshot)
        replace_snapshot(snapshot)
    except ExportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    counts = ", ".join(f"{table}={len(snapshot[table])}" for table in TABLES)
    print(f"Snapshot updated in {DATA_DIR}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

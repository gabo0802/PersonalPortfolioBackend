#!/usr/bin/env python3
"""Add public portfolio rows to Supabase through its PostgREST API."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from sync_supabase import ExportError, load_dotenv, read_configuration


REPO_ROOT = Path(__file__).resolve().parents[1]
TABLES = ("skills", "projects", "experiences")
RELATION_TABLES = ("project_skills", "experience_skills")
ALLOWED_TOP_LEVEL_KEYS = set(TABLES)
REQUIRED_FIELDS = {
    "skills": ("slug", "name", "visual", "proficiency"),
    "projects": ("slug", "title", "summary", "description"),
    "experiences": ("slug", "title", "description", "order_index"),
}
TABLE_FIELDS = {
    "skills": ("slug", "name", "visual", "proficiency", "category", "is_featured"),
    "projects": ("slug", "title", "summary", "description", "links", "thumbnail", "gallery"),
    "experiences": (
        "slug",
        "title",
        "subtitle",
        "timeframe",
        "description",
        "order_index",
    ),
}


class MutationError(ExportError):
    """An expected input, preflight, or Supabase mutation failure."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=REPO_ROOT / ".env",
        help="dotenv-style file containing Supabase credentials (default: .env)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run validation and preflight checks without inserting rows",
    )
    return parser.parse_args()


def read_payload() -> dict[str, list[dict[str, Any]]]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise MutationError(f"Input is not valid JSON: {error}") from error

    if not isinstance(payload, dict):
        raise MutationError("Input must be a JSON object")
    unknown_keys = set(payload) - ALLOWED_TOP_LEVEL_KEYS
    if unknown_keys:
        raise MutationError(f"Unsupported top-level fields: {', '.join(sorted(unknown_keys))}")

    normalized: dict[str, list[dict[str, Any]]] = {}
    for table in TABLES:
        rows = payload.get(table, [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise MutationError(f"{table} must be an array of objects")
        normalized[table] = rows

    if not any(normalized.values()):
        raise MutationError("At least one skill, project, or experience is required")

    return normalized


def require_string(value: Any, field: str, table: str, index: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MutationError(f"{table}[{index}].{field} must be a non-empty string")
    return value


def validate_gallery(gallery: Any, table: str, index: int) -> None:
    if not isinstance(gallery, list):
        raise MutationError(f"{table}[{index}].gallery must be an array")
    for media_index, media in enumerate(gallery):
        if not isinstance(media, dict) or not isinstance(media.get("url"), str):
            raise MutationError(f"{table}[{index}].gallery[{media_index}] requires a url")


def validate_skill_slugs(row: dict[str, Any], table: str, index: int) -> list[str]:
    skill_slugs = row.get("skill_slugs", [])
    if not isinstance(skill_slugs, list) or any(
        not isinstance(slug, str) or not slug.strip() for slug in skill_slugs
    ):
        raise MutationError(f"{table}[{index}].skill_slugs must be an array of non-empty strings")
    if len(skill_slugs) != len(set(skill_slugs)):
        raise MutationError(f"{table}[{index}].skill_slugs contains duplicates")
    return skill_slugs


def normalize_rows(payload: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    normalized: dict[str, list[dict[str, Any]]] = {table: [] for table in TABLES}

    for table in TABLES:
        for index, source_row in enumerate(payload[table]):
            missing = [field for field in REQUIRED_FIELDS[table] if field not in source_row]
            if missing:
                raise MutationError(
                    f"{table}[{index}] is missing required fields: {', '.join(missing)}"
                )

            row = {
                field: source_row[field]
                for field in TABLE_FIELDS[table]
                if field in source_row
            }
            require_string(row["slug"], "slug", table, index)

            for field in REQUIRED_FIELDS[table]:
                if field != "order_index":
                    require_string(row[field], field, table, index)

            if table == "skills":
                if "category" in row and row["category"] is not None:
                    require_string(row["category"], "category", table, index)
                if "is_featured" in row and not isinstance(row["is_featured"], bool):
                    raise MutationError(f"{table}[{index}].is_featured must be boolean")

            if table == "projects":
                row.setdefault("links", {})
                row.setdefault("thumbnail", None)
                row.setdefault("gallery", [])
                if not isinstance(row["links"], dict):
                    raise MutationError(f"{table}[{index}].links must be an object")
                if row["thumbnail"] is not None:
                    require_string(row["thumbnail"], "thumbnail", table, index)
                validate_gallery(row["gallery"], table, index)

            if table == "experiences":
                if isinstance(row["order_index"], bool) or not isinstance(
                    row["order_index"], int
                ):
                    raise MutationError(f"{table}[{index}].order_index must be an integer")
                row.setdefault("subtitle", None)
                row.setdefault("timeframe", None)
                for field in ("subtitle", "timeframe"):
                    if row[field] is not None:
                        require_string(row[field], field, table, index)

            validate_skill_slugs(source_row, table, index) if table != "skills" else None
            normalized[table].append(row)

    return normalized


def request_json(
    supabase_url: str,
    anon_key: str,
    method: str,
    table: str,
    query: dict[str, str] | None = None,
    rows: list[dict[str, Any]] | None = None,
) -> Any:
    endpoint = f"{supabase_url}/rest/v1/{quote(table, safe='')}"
    if query:
        endpoint = f"{endpoint}?{urlencode(query)}"

    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {anon_key}",
        "apikey": anon_key,
    }
    body = None
    if rows is not None:
        body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"

    try:
        with urlopen(Request(endpoint, data=body, headers=headers, method=method), timeout=20) as response:
            response_body = response.read()
    except HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise MutationError(
            f"Supabase {method} failed for {table} (HTTP {error.code}){suffix}"
        ) from error
    except URLError as error:
        raise MutationError(f"Supabase {method} failed for {table}: {error.reason}") from error
    except TimeoutError as error:
        raise MutationError(f"Supabase {method} timed out for {table}") from error

    if not response_body:
        return []
    try:
        return json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MutationError(f"Supabase returned invalid JSON for {table}") from error


def fetch_existing_rows(
    supabase_url: str, anon_key: str
) -> dict[str, list[dict[str, Any]]]:
    raw_rows = {
        "skills": request_json(
            supabase_url,
            anon_key,
            "GET",
            "skills",
            {"select": "slug"},
        ),
        "projects": request_json(
            supabase_url,
            anon_key,
            "GET",
            "projects",
            {"select": "slug"},
        ),
        "experiences": request_json(
            supabase_url,
            anon_key,
            "GET",
            "experiences",
            {"select": "slug"},
        ),
        "project_skills": request_json(
            supabase_url,
            anon_key,
            "GET",
            "project_skills",
            {"select": "project_slug,skill_slug"},
        ),
        "experience_skills": request_json(
            supabase_url,
            anon_key,
            "GET",
            "experience_skills",
            {"select": "experience_slug,skill_slug"},
        ),
    }
    normalized_rows: dict[str, list[dict[str, Any]]] = {}
    for table, rows in raw_rows.items():
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise MutationError(f"Supabase returned an invalid response for {table}")
        normalized_rows[table] = rows
    return normalized_rows


def validate_preflight(
    normalized: dict[str, list[dict[str, Any]]],
    existing: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    existing_slugs = {
        table: {row["slug"] for row in existing[table]} for table in TABLES
    }
    for table in TABLES:
        requested_slugs = [row["slug"] for row in normalized[table]]
        if len(requested_slugs) != len(set(requested_slugs)):
            raise MutationError(f"Request contains duplicate {table} slugs")
        conflicts = sorted(set(requested_slugs) & existing_slugs[table])
        if conflicts:
            raise MutationError(
                f"{table} slugs already exist: {', '.join(conflicts)}"
            )

    available_skills = existing_slugs["skills"] | {
        row["slug"] for row in normalized["skills"]
    }
    project_relationships: list[dict[str, Any]] = []
    for index, row in enumerate(normalized["projects"]):
        project_relationships.extend(
            {"project_slug": row["slug"], "skill_slug": skill_slug}
            for skill_slug in validate_skill_slugs(row, "projects", index)
        )

    experience_relationships: list[dict[str, Any]] = []
    for index, row in enumerate(normalized["experiences"]):
        experience_relationships.extend(
            {"experience_slug": row["slug"], "skill_slug": skill_slug}
            for skill_slug in validate_skill_slugs(row, "experiences", index)
        )

    for relation in project_relationships:
        if relation["skill_slug"] not in available_skills:
            raise MutationError(
                f"project_skills references unknown skill: {relation['skill_slug']}"
            )
    for relation in experience_relationships:
        if relation["skill_slug"] not in available_skills:
            raise MutationError(
                f"experience_skills references unknown skill: {relation['skill_slug']}"
            )

    existing_project_relationships = {
        (row["project_slug"], row["skill_slug"]) for row in existing["project_skills"]
    }
    existing_experience_relationships = {
        (row["experience_slug"], row["skill_slug"])
        for row in existing["experience_skills"]
    }
    if len(project_relationships) != len(
        {(row["project_slug"], row["skill_slug"]) for row in project_relationships}
    ):
        raise MutationError("Request contains duplicate project_skills relationships")
    if len(experience_relationships) != len(
        {(row["experience_slug"], row["skill_slug"]) for row in experience_relationships}
    ):
        raise MutationError("Request contains duplicate experience_skills relationships")
    if existing_project_relationships.intersection(
        (row["project_slug"], row["skill_slug"]) for row in project_relationships
    ):
        raise MutationError("Request contains existing project_skills relationships")
    if existing_experience_relationships.intersection(
        (row["experience_slug"], row["skill_slug"]) for row in experience_relationships
    ):
        raise MutationError("Request contains existing experience_skills relationships")

    return project_relationships, experience_relationships


def apply_changes(
    supabase_url: str,
    anon_key: str,
    normalized: dict[str, list[dict[str, Any]]],
    project_relationships: list[dict[str, Any]],
    experience_relationships: list[dict[str, Any]],
) -> list[str]:
    completed_stages: list[str] = []
    stages: tuple[tuple[str, str, list[dict[str, Any]]], ...] = (
        ("skills", "skills", normalized["skills"]),
        ("projects", "projects", normalized["projects"]),
        ("experiences", "experiences", normalized["experiences"]),
        ("project_skills", "project_skills", project_relationships),
        ("experience_skills", "experience_skills", experience_relationships),
    )

    try:
        for stage_name, table, rows in stages:
            if not rows:
                continue
            request_json(supabase_url, anon_key, "POST", table, rows=rows)
            completed_stages.append(stage_name)
    except MutationError as error:
        completed = ", ".join(completed_stages) or "none"
        raise MutationError(
            f"{error}. Completed stages before failure: {completed}"
        ) from error

    return completed_stages


def main() -> int:
    args = parse_args()

    try:
        load_dotenv(args.env_file)
        supabase_url, anon_key = read_configuration()
        payload = read_payload()
        normalized = normalize_rows(payload)
        existing = fetch_existing_rows(supabase_url, anon_key)
        project_relationships, experience_relationships = validate_preflight(
            normalized, existing
        )

        planned = {
            "skills": len(normalized["skills"]),
            "projects": len(normalized["projects"]),
            "experiences": len(normalized["experiences"]),
            "project_skills": len(project_relationships),
            "experience_skills": len(experience_relationships),
        }
        if args.dry_run:
            print(json.dumps({"status": "dry-run", "planned": planned}, indent=2))
            return 0

        completed_stages = apply_changes(
            supabase_url,
            anon_key,
            normalized,
            project_relationships,
            experience_relationships,
        )
    except ExportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": "success",
                "completed_stages": completed_stages,
                "inserted": planned,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

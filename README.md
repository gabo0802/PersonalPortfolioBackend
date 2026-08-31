# PersonalPortfolioBackend

This repository stores the public portfolio snapshot used as a fallback by
`PersonalPortfolio2.0`. Supabase remains the primary live data source.

## Data snapshot

The `data/` directory mirrors the five public Supabase table families:

- `skills.json`
- `projects.json`
- `experiences.json`
- `project_skills.json`
- `experience_skills.json`

The files preserve the public rows returned by Supabase. The frontend joins
the relationship files locally and keeps its existing normalized data
contract.

## Refreshing the snapshot locally

The exporter uses only the public Supabase REST API and has no third-party
Python dependencies:

```bash
python3 scripts/sync_supabase.py --env-file .env
```

The environment file must provide `SUPABASE_URL` and
`SUPABASE_ANON_KEY`. The existing frontend names
`REACT_APP_SUPABASE_URL` and `REACT_APP_SUPABASE_ANON_KEY` are also accepted.
The exporter validates all five responses and relationship references before
atomically replacing the previous snapshot.

Review the generated files and commit them manually. The optional
`sync-data.yml` workflow runs the same exporter and commits changed files
directly to `main`.

### Action secrets

The backend workflows expect these GitHub Actions secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `FRONTEND_DISPATCH_TOKEN`

The dispatch token only needs permission to trigger workflows in
`gabo0802/PersonalPortfolio2.0`. Never use a `service_role` key for the
exporter.

## Adding portfolio content

Invoke the repository-local `/portfolio-content` skill when you want to add
public projects, experiences, or job skills from a natural-language
description. It validates the proposed rows, writes them through Supabase's
public REST API, and refreshes the five JSON snapshot files only after the
database write succeeds.

The skill is add-only: existing slugs are reported as conflicts, and it never
commits or pushes generated files. Supabase remains the live source of truth.

## Resume

`GabrielCastejonSWE.tex` is the source of truth for the resume.
`GabrielCastejonSWE.pdf` is generated from it and is bundled by the frontend.
The optional `build-resume.yml` workflow compiles the PDF and commits only
that generated output.

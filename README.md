# PersonalPortfolioBackend

This repository holds the portfolio content and resume used by
`PersonalPortfolio2.0`. The JSON files in `data/` are the single source of
truth: the frontend bundles them at build time (through its `backend` git
submodule) and makes no database calls. Supabase is no longer read.

## Data

`data/` contains five files:

- `skills.json`
- `projects.json`
- `experiences.json`
- `project_skills.json` (links a `project_slug` to a `skill_slug`)
- `experience_skills.json` (links an `experience_slug` to a `skill_slug`)

Rules the frontend tests enforce (the admin UI checks them before saving):

- Slugs are unique within each file, and links point at real rows.
- `experiences[].order_index` values are unique. Lower numbers show first.
- Every experience links at least one skill.
- `proficiency` is one of Expert, Proficient, Experienced, Novice, Exposed.

Files use 2-space indentation, keys sorted alphabetically, UTF-8 characters
written as-is, and a trailing newline. Rows keep their existing order; new
rows go where they sort (skills by slug, projects newest first, experiences by
`order_index`, links by parent slug then skill slug).

## Editing data with the admin UI

```bash
npm run admin
```

Then open <http://localhost:4310>. It needs Node 20+ and no `npm install`.
Set `ADMIN_PORT` to use another port.

- Skills, Projects and Experiences tabs with search, create, edit and delete.
- Pick a project's or experience's skills from the existing skills list.
- Drag experiences (or use ↑ ↓) to change `order_index`.
- Renaming a slug updates every link to it. Deleting a row removes its links.
- New rows get an `id` and `created_at` in the same format as existing ones.
- Edits stay in the browser until you press **Save to data/** (or ⌘S/Ctrl+S).
  Saving is blocked while any validation problem is listed.
- **Review diff & commit** shows `git diff -- data/*.json`. From there you can
  commit only the data files, then push. Other modified files (such as the
  resume sources) are never included.

The server listens on 127.0.0.1 only and lives in `admin/`, which the frontend
never copies or deploys.

After editing the JSON by hand, run `npm run check-data` for the same
validation and format check (`npm run check-data -- --fix` rewrites drifted
formatting without reordering rows).

## Deploying

Pushing changes under `data/` (or the resume PDF) to `main` runs
`notify-frontend.yml`, which redeploys the frontend. It needs a
`FRONTEND_DISPATCH_TOKEN` secret that can trigger workflows in
`gabo0802/PersonalPortfolio2.0`.

## Adding content with an agent

The repository-local `/portfolio-content` skill turns a natural-language
description into rows in `data/*.json`. It validates the same rules as the
admin UI and never commits or pushes.

## Resume

`GabrielCastejonSWE.tex` is the source of truth for the resume.
`GabrielCastejonSWE.pdf` is generated from it and is bundled by the frontend.
The optional `build-resume.yml` workflow compiles the PDF and commits only
that generated output.

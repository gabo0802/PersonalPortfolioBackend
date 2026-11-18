---
name: portfolio-content
description: Add or edit public portfolio projects, experiences, and skills in data/*.json, the single source of truth for the portfolio site.
disable-model-invocation: true
---

# Portfolio content

Use this skill only when the user explicitly invokes `/portfolio-content` or
asks to run this portfolio-content workflow.

The five files in `data/` are the single source of truth for the portfolio
site. The frontend bundles them at build time; there is no database behind
them (the old Supabase project is retired).

For hands-on editing the user can also run `npm run admin` (a local browser
UI). This skill is for turning a natural-language description into rows.

## Decision gates

Resolve uncertainty before proposing an edit:

- Preserve factual content from a resume or source document, but ask whether
  the public description should remain verbatim or be synthesized into prose.
- Treat dates, titles, slugs, and `order_index` values as user-owned data. Ask
  for missing values, warn about order collisions, and do not silently reindex
  unrelated rows.
- Distinguish existing catalog skills from new skill definitions. Link an
  existing skill only when the user approves its relevance; for a new skill,
  confirm its slug and required metadata (`name`, `visual`, `proficiency`)
  before writing it. Do not add skills merely because a tool or concept
  appears incidentally in prose.
- When the user approves a group of skills without individual levels, present
  the proposed levels and categories for confirmation rather than treating
  inferred defaults as facts.
- Updates and deletes are allowed, but confirm the exact rows first. Renaming
  a slug must also update every link row that uses it; deleting a row must
  also delete its link rows.

## Row shapes

Every primary row has `id` (a new random UUID v4) and `created_at`
(UTC, shaped like `2026-05-29T03:16:24.470823+00:00`).

- `skills.json`: `slug`, `name`, `visual` (badge image URL, usually
  shields.io), `proficiency` (Expert, Proficient, Experienced, Novice or
  Exposed), `category` (text or null), `is_featured` (boolean).
- `projects.json`: `slug`, `title`, `summary`, `description`,
  `links` (`{"demo": url|null, "repo": url|null}`), `thumbnail` (url or null),
  `gallery` (array of `{"caption", "type": "image"|"video", "url"}`).
- `experiences.json`: `slug`, `title`, `subtitle` (text or null),
  `timeframe` (text or null), `description`, `order_index` (unique integer,
  0 shows first).
- `project_skills.json`: `{"project_slug", "skill_slug"}`.
- `experience_skills.json`: `{"experience_slug", "skill_slug"}`.

Slugs use lowercase letters, digits and single dashes, and are unique within
their file. Every link must point at an existing row, without duplicates, and
every experience needs at least one linked skill (the frontend tests fail
otherwise).

## Workflow

1. Parse the description into proposed rows after the decision gates.
   Preserve user-provided text, URLs, ordering, and nullability. Derive a slug
   only when the user accepts it. Complete this step when every requested
   entity has every required field.
2. Present a concise plan grouped by file: new rows, changed fields, deleted
   rows, and link rows added or removed. Get confirmation before editing.
3. Edit `data/*.json` directly. Keep existing rows where they are, and insert
   new rows at their sorted position: skills by `slug`; projects newest
   `created_at` first; experiences by `order_index`; link rows by parent slug,
   then `skill_slug`.
4. From the repository root, run:

   ```bash
   npm run check-data
   ```

   It applies the same validation as the admin UI and checks the stable format
   (2-space indent, sorted keys, raw UTF-8, trailing newline). If only the
   format drifted, run `npm run check-data -- --fix`. Fix any reported
   problem and rerun until it passes.
5. Report what changed and show `git diff --stat -- data`. Do not commit or
   push; the user reviews and commits (pushing `data/` to `main` redeploys the
   site).

## Completion report

Use this shape:

```text
Added: skills=<n>, projects=<n>, experiences=<n>, links=<n>
Updated: <rows>   Deleted: <rows>
Check: npm run check-data passed
Files: <changed data files>
Commit: not created
```

The data is public. Keep secrets, private contact details and credentials out
of it.

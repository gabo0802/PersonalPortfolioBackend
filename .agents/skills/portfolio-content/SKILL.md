---
name: portfolio-content
description: Add public portfolio projects, experiences, and job skills to Supabase, then refresh the backend JSON snapshot.
disable-model-invocation: true
---

# Portfolio content

Use this skill only when the user explicitly invokes `/portfolio-content` or
asks to run this portfolio-content workflow.

This is an add-only workflow for the public portfolio data. Supabase remains
the live source of truth, and `data/*.json` is the repository snapshot used by
the frontend fallback.

## Decision gates

Classify the request before building a payload:

- **Live add**: insert new Supabase rows through the workflow below. Existing
   slugs are conflicts; explain that this writer cannot update or delete them.
- **Local queue**: if the user asks to defer a live write, create a clearly
   named SQL queue file with the approved rows and guarded inserts. Do not
   contact Supabase or claim that the live data changed.
- **Local snapshot**: if the user explicitly asks to change local JSON, update
   the relevant primary and relationship snapshots together, validate their
   references and ordering, and label the result as local or pending. Do not
   imply that it was synchronized from Supabase.

When a user asks to update an existing row, do not silently turn that request
into a second live row. Explain the add-only limitation and ask which mode or
approved update path they want. Treat the latest user correction as the
authoritative requirement and regenerate the proposed payload when it changes.

Resolve uncertainty before proposing a write:

- Preserve factual content from a resume or source document, but ask whether
   the public description should remain verbatim or be synthesized into prose.
- Treat dates, titles, slugs, and `order_index` values as user-owned data. Ask
   for missing values, warn about order collisions, and do not silently reindex
   unrelated rows.
- Distinguish existing catalog skills from new skill definitions. Link an
   existing skill only when the user approves its relevance; for a new skill,
   confirm its slug and required metadata (`name`, `visual`, and
   `proficiency`) before writing it. Do not add skills merely because a tool or
   concept appears incidentally in prose.
- When the user approves a group of skills without individual levels, present
   the proposed levels and categories for confirmation rather than treating
   inferred defaults as facts.

## Input contract

Turn the user's description into one JSON payload with these top-level arrays:

```json
{
  "skills": [],
  "projects": [],
  "experiences": []
}
```

Required fields:

- `skills`: `slug`, `name`, `visual`, `proficiency`
- `projects`: `slug`, `title`, `summary`, `description`
- `experiences`: `slug`, `title`, `description`, `order_index`

Optional fields:

- skills: `category`, `is_featured`
- projects: `links`, `thumbnail`, `gallery`
- experiences: `subtitle`, `timeframe`
- projects and experiences: `skill_slugs`

`skill_slugs` creates rows in the appropriate join table. If a referenced
skill is new, include its complete skill object in the same request. Ask for
missing required values or an explicit `order_index`; do not invent content.

## Workflow

1. Parse the description into the payload above after the decision gates.
   Preserve user-provided text, URLs, ordering, and nullability. Derive a slug
   only when the user accepts the proposed slug. Complete this step when every
   requested entity has a payload entry and every required field is present.
2. Present a concise write plan grouped by entity and get confirmation before
   mutating the database. Include the exact description, new skill metadata,
   and relationships. Treat an existing slug as a conflict; this live workflow
   does not update or delete rows. Complete this step when the user confirms
   the exact rows and relationships to insert.
3. From the backend repository root, run the add-only writer with the local
   environment file:

   ```bash
   printf '%s' '<validated-payload-json>' |
     python3 scripts/apply_portfolio_content.py --env-file .env
   ```

   Use a temporary payload file or an equivalent safe stdin mechanism when the
   payload is large. Never print environment values or credentials.
   Complete this step when the writer reports a successful database mutation
   or returns a surfaced error.
4. The writer preflights existing slugs, duplicate relationships, referenced
   skills, and required field types. It inserts skills first, then parent
   projects/experiences, then relationship rows. If any stage fails, report
   completed stages and stop; do not claim the whole request succeeded.
   Complete this step when every requested stage succeeded or the partial
   failure is explicitly reported.
5. Only after the writer exits successfully, refresh the repository snapshot:

   ```bash
   python3 scripts/sync_supabase.py --env-file .env
   ```
   Complete this step when the updater exits successfully and reports the
   refreshed table counts.
6. Report both outcomes separately: Supabase mutation status and snapshot
   synchronization status, including inserted counts and generated files.
   Inspect `git status --short -- data` so the user knows what changed.
   Complete this step when the report distinguishes database and snapshot
   outcomes and lists every changed data file.
7. Do not commit or push. The user reviews and commits the generated snapshot
   and any skill/repository changes themselves. Complete this step when no Git
   commit or push has been performed.

## Local-only handling

Use this branch only when the user explicitly requests local persistence or a
deferred queue:

- A queue file contains only the user-confirmed SQL and should use guarded,
   reviewable inserts. Keep credentials and environment values out of it.
- A local snapshot update must cover every affected file: the relevant primary
   table, any new skill rows, and every relationship table. Preserve the
   repository's JSON shape, unique ordering, and referential integrity.
- Validate JSON parsing, required fields, relationship references, duplicate
   relationships, and any user-specified ordering after the edit.
- Report remote status separately from local status. A local queue or snapshot
   is not a Supabase mutation or synchronization.

## Supabase boundary

The writer uses Supabase's PostgREST table API with the public anon key from
`.env`; it does not execute arbitrary SQL. An anon API key cannot safely
execute arbitrary SQL unless a deliberately exposed RPC exists. If RLS rejects
an insert, surface the table and error, stop, and ask the user to configure an
appropriate policy or approved RPC separately. Never substitute a
`service_role` key or bypass RLS.

Because the anon key is public, do not recommend a broad anonymous insert
policy as the default. Prefer an approved server-side RPC or authenticated
write path. If the user explicitly chooses temporary anonymous access, scope it
to the confirmed operation and provide the cleanup statement.

For timeouts or service availability failures, stop the remote workflow and
offer the local queue or local snapshot branch. Do not claim a write succeeded
without a successful writer response.

The complete public dataset is readable by visitors. Keep secrets, private
contact details, credentials, and administrator data out of these tables and
payloads.

## Completion report

Use this shape:

```text
Supabase: succeeded/failed
Inserted: skills=<n>, projects=<n>, experiences=<n>, relationships=<n>
Snapshot: updated/failed
Files: <changed data files>
Commit: not created
```

For local-only work, use `Supabase: not contacted` and report queue or snapshot
status separately from any remote result.

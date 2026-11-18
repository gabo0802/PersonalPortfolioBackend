// Shared by the admin server (Node) and the admin page (browser).
// It defines how data/*.json is validated and serialized, so both sides agree
// on what a valid, stably formatted snapshot looks like.

export const TABLES = [
  "skills",
  "projects",
  "experiences",
  "project_skills",
  "experience_skills",
];

export const PROFICIENCIES = ["Expert", "Proficient", "Experienced", "Novice", "Exposed"];

export const GALLERY_TYPES = ["image", "video"];

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Preferred row order, matching the order the files were originally exported
// in from Supabase. Saving keeps the existing order of rows so diffs
// only show real edits; new rows are inserted at their sorted position.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ROW_ORDER = {
  skills: (a, b) => compare(a.slug, b.slug),
  projects: (a, b) => compare(b.created_at ?? "", a.created_at ?? "") || compare(a.slug, b.slug),
  experiences: (a, b) => a.order_index - b.order_index || compare(a.slug, b.slug),
  project_skills: (a, b) =>
    compare(a.project_slug, b.project_slug) || compare(a.skill_slug, b.skill_slug),
  experience_skills: (a, b) =>
    compare(a.experience_slug, b.experience_slug) || compare(a.skill_slug, b.skill_slug),
};

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

/** Return a copy of rows with row inserted before the first row that sorts after it. */
export function insertSorted(table, rows, row) {
  const index = rows.findIndex((existing) => ROW_ORDER[table](row, existing) < 0);
  const next = [...rows];
  next.splice(index === -1 ? rows.length : index, 0, row);
  return next;
}

const rowKey = (table, row) => {
  if (table === "project_skills") return `${row.project_slug}\u0000${row.skill_slug}`;
  if (table === "experience_skills") return `${row.experience_slug}\u0000${row.skill_slug}`;
  return row.id;
};

/**
 * Keep rows that already existed in their original order and move rows that
 * are new (not in originalRows) to their sorted position.
 */
export function placeNewRows(table, rows, originalRows) {
  const known = new Set(originalRows.map((row) => rowKey(table, row)));
  let placed = rows.filter((row) => known.has(rowKey(table, row)));
  for (const row of rows) {
    if (!known.has(rowKey(table, row))) placed = insertSorted(table, placed, row);
  }
  return placed;
}

/**
 * Serialize one table exactly like the exporter's
 * json.dumps(indent=2, sort_keys=True, ensure_ascii=False) plus a newline.
 * Row order is kept as given.
 */
export function serializeTable(rows) {
  return `${JSON.stringify(sortKeysDeep(rows), null, 2)}\n`;
}

/** Timestamp in the same shape Supabase produced: 2026-05-29T03:16:24.470823+00:00 */
export function timestampNow(date = new Date()) {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isNullableString = (value) => value === null || typeof value === "string";

/**
 * Validate a whole snapshot. Returns a list of { table, slug, field, message }
 * problems; an empty list means the snapshot is safe to save.
 */
export function validateSnapshot(snapshot) {
  const problems = [];
  const add = (table, slug, field, message) => problems.push({ table, slug, field, message });

  for (const table of TABLES) {
    if (!Array.isArray(snapshot[table])) {
      add(table, null, null, `${table} must be an array`);
      return problems;
    }
  }

  const checkPrimary = (table, required) => {
    const slugs = new Map();
    const ids = new Map();
    snapshot[table].forEach((row, index) => {
      const label = row.slug || `#${index + 1}`;
      for (const field of required) {
        if (!isNonEmptyString(row[field])) add(table, label, field, `${field} is required`);
      }
      if (isNonEmptyString(row.slug) && !SLUG_PATTERN.test(row.slug)) {
        add(table, label, "slug", "slug may only use lowercase letters, digits and single dashes");
      }
      if (!isNonEmptyString(row.id)) add(table, label, "id", "id is missing");
      if (!isNonEmptyString(row.created_at)) add(table, label, "created_at", "created_at is missing");
      if (slugs.has(row.slug)) add(table, label, "slug", `slug "${row.slug}" is used twice`);
      slugs.set(row.slug, true);
      if (row.id && ids.has(row.id)) add(table, label, "id", `id "${row.id}" is used twice`);
      ids.set(row.id, true);
    });
    return new Set(slugs.keys());
  };

  const skillSlugs = checkPrimary("skills", ["slug", "name", "visual", "proficiency"]);
  const projectSlugs = checkPrimary("projects", ["slug", "title", "summary", "description"]);
  const experienceSlugs = checkPrimary("experiences", ["slug", "title", "description"]);

  for (const row of snapshot.skills) {
    if (isNonEmptyString(row.proficiency) && !PROFICIENCIES.includes(row.proficiency)) {
      add("skills", row.slug, "proficiency", `proficiency must be one of ${PROFICIENCIES.join(", ")}`);
    }
    if (!isNullableString(row.category)) add("skills", row.slug, "category", "category must be text or empty");
    if (typeof row.is_featured !== "boolean") add("skills", row.slug, "is_featured", "is_featured must be true or false");
  }

  for (const row of snapshot.projects) {
    if (!row.links || typeof row.links !== "object" || Array.isArray(row.links)) {
      add("projects", row.slug, "links", "links must be an object");
    } else {
      for (const [key, value] of Object.entries(row.links)) {
        if (!isNullableString(value)) add("projects", row.slug, "links", `links.${key} must be a URL or empty`);
      }
    }
    if (!isNullableString(row.thumbnail)) add("projects", row.slug, "thumbnail", "thumbnail must be a URL or empty");
    if (!Array.isArray(row.gallery)) {
      add("projects", row.slug, "gallery", "gallery must be a list");
    } else {
      row.gallery.forEach((media, index) => {
        if (!media || !isNonEmptyString(media.url)) {
          add("projects", row.slug, "gallery", `gallery item ${index + 1} needs a URL`);
        } else if (media.type !== undefined && !GALLERY_TYPES.includes(media.type)) {
          add("projects", row.slug, "gallery", `gallery item ${index + 1} type must be image or video`);
        }
      });
    }
  }

  const orderIndexes = new Map();
  for (const row of snapshot.experiences) {
    if (!Number.isInteger(row.order_index)) {
      add("experiences", row.slug, "order_index", "order_index must be a whole number");
    } else if (orderIndexes.has(row.order_index)) {
      add(
        "experiences",
        row.slug,
        "order_index",
        `order_index ${row.order_index} is also used by "${orderIndexes.get(row.order_index)}"`,
      );
    } else {
      orderIndexes.set(row.order_index, row.slug);
    }
    if (!isNullableString(row.subtitle)) add("experiences", row.slug, "subtitle", "subtitle must be text or empty");
    if (!isNullableString(row.timeframe)) add("experiences", row.slug, "timeframe", "timeframe must be text or empty");
  }

  const checkLinks = (table, parentField, parentTable, parentSlugs) => {
    const seen = new Set();
    for (const row of snapshot[table]) {
      const parent = row[parentField];
      const key = `${parent}\u0000${row.skill_slug}`;
      if (seen.has(key)) add(table, parent, "skill_slug", `"${row.skill_slug}" is linked twice`);
      seen.add(key);
      if (!parentSlugs.has(parent)) add(table, parent, parentField, `links to a missing ${parentTable.slice(0, -1)} "${parent}"`);
      if (!skillSlugs.has(row.skill_slug)) add(table, parent, "skill_slug", `links to a missing skill "${row.skill_slug}"`);
    }
  };
  checkLinks("project_skills", "project_slug", "projects", projectSlugs);
  checkLinks("experience_skills", "experience_slug", "experiences", experienceSlugs);

  // The frontend test suite requires every experience to list at least one skill.
  const linkedExperiences = new Set(snapshot.experience_skills.map((row) => row.experience_slug));
  for (const row of snapshot.experiences) {
    if (row.slug && !linkedExperiences.has(row.slug)) {
      add("experiences", row.slug, "skills", "pick at least one skill (the frontend tests require it)");
    }
  }

  return problems;
}

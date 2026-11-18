import {
  PROFICIENCIES,
  GALLERY_TYPES,
  SLUG_PATTERN,
  TABLES,
  insertSorted,
  serializeTable,
  timestampNow,
  validateSnapshot,
} from "/lib/schema.mjs";

// ---------------------------------------------------------------------------
// State

const state = {
  snapshot: null, // working copy being edited
  saved: {}, // serialized tables as last loaded/saved, for change detection
  savedIds: new Set(), // ids that exist on disk (to mark new rows)
  version: null,
  problems: [],
  git: null,
  tab: readPreference("tab", "skills"),
  selected: { skills: null, projects: null, experiences: null }, // row ids
  search: "",
};

const TAB_LABELS = { skills: "Skills", projects: "Projects", experiences: "Experiences" };
const NEW_LABELS = { skills: "+ New skill", projects: "+ New project", experiences: "+ New experience" };
const JOINS = {
  projects: { table: "project_skills", field: "project_slug" },
  experiences: { table: "experience_skills", field: "experience_slug" },
};
const PROBLEM_TAB = {
  skills: "skills",
  projects: "projects",
  project_skills: "projects",
  experiences: "experiences",
  experience_skills: "experiences",
};

const $ = (id) => document.getElementById(id);

// For brand-new rows, typing a title/name fills the slug until it is edited by hand.
const slugSyncers = new WeakMap();
const syncSlug = (row, text) => slugSyncers.get(row)?.(text);

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(`portfolio-admin:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePreference(key, value) {
  try {
    localStorage.setItem(`portfolio-admin:${key}`, value);
  } catch {
    /* storage unavailable; not important */
  }
}

// ---------------------------------------------------------------------------
// Small DOM helper

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  return el;
}

function toast(message, kind = "info") {
  const el = h("div", { class: `toast ${kind}` }, message);
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4000);
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json", "X-Portfolio-Admin": "1" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Data helpers

const rows = (table) => state.snapshot[table];
const findById = (table, id) => rows(table).find((row) => row.id === id) ?? null;
const findBySlug = (table, slug) => rows(table).find((row) => row.slug === slug) ?? null;
const skillName = (slug) => findBySlug("skills", slug)?.name ?? slug;

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function linkedSkills(table, slug) {
  const join = JOINS[table];
  return rows(join.table)
    .filter((link) => link[join.field] === slug)
    .map((link) => link.skill_slug);
}

function skillUsage(slug) {
  return {
    projects: rows("project_skills").filter((l) => l.skill_slug === slug).map((l) => l.project_slug),
    experiences: rows("experience_skills").filter((l) => l.skill_slug === slug).map((l) => l.experience_slug),
  };
}

function changedTables() {
  return TABLES.filter((table) => serializeTable(rows(table)) !== state.saved[table]);
}

const isDirty = () => changedTables().length > 0;

function experiencesByOrder() {
  return [...rows("experiences")].sort(
    (a, b) => (a.order_index ?? Infinity) - (b.order_index ?? Infinity) || a.slug.localeCompare(b.slug),
  );
}

/** Rename a slug and every link that points at it. Returns an error message or null. */
function renameSlug(table, row, nextSlug) {
  const previous = row.slug;
  if (nextSlug === previous) return null;
  if (!nextSlug) return "Slug cannot be empty";
  if (!SLUG_PATTERN.test(nextSlug)) return "Use lowercase letters, digits and single dashes";
  if (rows(table).some((other) => other !== row && other.slug === nextSlug)) {
    return `Another ${table.slice(0, -1)} already uses "${nextSlug}"`;
  }
  row.slug = nextSlug;
  if (!previous) return null;
  if (table === "skills") {
    for (const join of Object.values(JOINS)) {
      for (const link of rows(join.table)) if (link.skill_slug === previous) link.skill_slug = nextSlug;
    }
  } else {
    const join = JOINS[table];
    for (const link of rows(join.table)) if (link[join.field] === previous) link[join.field] = nextSlug;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loading and saving

function adopt(data) {
  state.snapshot = structuredClone(data.snapshot);
  state.version = data.version;
  state.saved = Object.fromEntries(TABLES.map((t) => [t, serializeTable(data.snapshot[t])]));
  state.savedIds = new Set(
    ["skills", "projects", "experiences"].flatMap((t) => data.snapshot[t].map((row) => row.id)),
  );
  if (data.git) state.git = data.git;
}

async function load() {
  try {
    adopt(await api("GET", "/api/data"));
    refresh({ editor: true });
  } catch (error) {
    toast(`Could not load data: ${error.message}`, "error");
  }
}

async function save() {
  if (state.problems.length) {
    toast("Fix the problems listed at the top before saving.", "error");
    return;
  }
  try {
    const result = await api("POST", "/api/save", { version: state.version, snapshot: state.snapshot });
    adopt(result);
    refresh({ editor: true });
    toast(result.written.length ? `Saved ${result.written.join(", ")}` : "Nothing to save", "ok");
  } catch (error) {
    if (error.data?.problems) state.problems = error.data.problems;
    refresh();
    toast(error.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Rendering: top bar, tabs, problems

function refresh({ list = true, editor = false } = {}) {
  state.problems = validateSnapshot(state.snapshot);
  renderStatus();
  renderTabs();
  renderProblems();
  if (list) renderList();
  if (editor) renderEditor();
  else renderRowProblems();
}

function renderStatus() {
  const changed = changedTables();
  const pills = [];
  if (changed.length) {
    pills.push(h("span", { class: "pill dirty", title: changed.map((t) => `data/${t}.json`).join("\n") },
      `Unsaved edits in ${changed.length} file${changed.length > 1 ? "s" : ""}`));
  } else {
    pills.push(h("span", { class: "pill good" }, "Saved"));
  }
  if (state.problems.length) {
    pills.push(h("span", { class: "pill bad" }, `${state.problems.length} problem${state.problems.length > 1 ? "s" : ""}`));
  }
  const pending = state.git?.status?.trim() ? state.git.status.trim().split("\n").length : 0;
  if (pending) pills.push(h("span", { class: "pill" }, `${pending} uncommitted data file${pending > 1 ? "s" : ""}`));
  if (state.git?.ahead) pills.push(h("span", { class: "pill" }, `${state.git.ahead} commit${state.git.ahead > 1 ? "s" : ""} to push`));
  $("status").replaceChildren(...pills);
  $("branch").textContent = state.git ? `on ${state.git.branch}` : "";
  $("save").disabled = !changed.length || state.problems.length > 0;
  $("discard").disabled = !changed.length;
}

function renderTabs() {
  $("tabs").replaceChildren(
    ...Object.keys(TAB_LABELS).map((tab) =>
      h("button", {
        type: "button",
        role: "tab",
        "aria-selected": String(tab === state.tab),
        onClick: () => switchTab(tab),
      }, TAB_LABELS[tab], h("span", { class: "count" }, rows(tab).length)),
    ),
  );
}

function switchTab(tab, selectSlug) {
  state.tab = tab;
  writePreference("tab", tab);
  if (selectSlug) {
    const row = findBySlug(tab, selectSlug);
    if (row) state.selected[tab] = row.id;
  }
  state.search = "";
  $("search").value = "";
  refresh({ editor: true });
}

function renderProblems() {
  const box = $("problems");
  box.hidden = state.problems.length === 0;
  if (box.hidden) return;
  box.replaceChildren(
    h("strong", null, "Saving is blocked until these are fixed:"),
    h("ul", null, state.problems.slice(0, 50).map((problem) =>
      h("li", null,
        h("a", { onClick: () => switchTab(PROBLEM_TAB[problem.table], problem.slug) },
          `${problem.table} › ${problem.slug ?? "?"}`),
        `: ${problem.message}`),
    )),
  );
}

function rowProblems(table, row) {
  const own = state.problems.filter((p) => p.table === table && (p.slug === row.slug || (!row.slug && p.slug?.startsWith("#"))));
  const join = JOINS[table];
  const linked = join ? state.problems.filter((p) => p.table === join.table && p.slug === row.slug) : [];
  return [...own, ...linked];
}

// ---------------------------------------------------------------------------
// Rendering: list

const COLUMNS = {
  skills: [
    { label: "Badge", render: (r) => (r.visual ? h("img", { class: "badge-img", src: r.visual, alt: "", loading: "lazy" }) : "") },
    { label: "Name", render: (r) => r.name },
    { label: "Slug", render: (r) => r.slug, class: "muted" },
    { label: "Category", render: (r) => r.category ?? "" },
    { label: "Proficiency", render: (r) => r.proficiency },
    { label: "★", render: (r) => (r.is_featured ? "★" : "") },
    { label: "Used", render: (r) => { const u = skillUsage(r.slug); return u.projects.length + u.experiences.length; }, class: "num" },
  ],
  projects: [
    { label: "", render: (r) => (r.thumbnail ? h("img", { class: "thumb", src: r.thumbnail, alt: "", loading: "lazy" }) : h("div", { class: "thumb" })) },
    { label: "Title", render: (r) => r.title },
    { label: "Slug", render: (r) => r.slug, class: "muted" },
    { label: "Summary", render: (r) => r.summary, class: "clip" },
    { label: "Skills", render: (r) => linkedSkills("projects", r.slug).length, class: "num" },
  ],
  experiences: [
    { label: "#", render: (r) => r.order_index, class: "num" },
    { label: "Title", render: (r) => r.title },
    { label: "Subtitle", render: (r) => r.subtitle ?? "", class: "clip" },
    { label: "Timeframe", render: (r) => r.timeframe ?? "", class: "muted" },
    { label: "Skills", render: (r) => linkedSkills("experiences", r.slug).length, class: "num" },
  ],
};

function matchesSearch(row, query) {
  if (!query) return true;
  const text = JSON.stringify(row).toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

function renderList() {
  const table = state.tab;
  const query = state.search.trim();
  const ordered = table === "experiences" ? experiencesByOrder() : rows(table);
  const visible = ordered.filter((row) => matchesSearch(row, query));
  const reorderable = table === "experiences" && !query;
  const problemSlugs = new Set(state.problems.filter((p) => PROBLEM_TAB[p.table] === table).map((p) => p.slug));

  $("create").textContent = NEW_LABELS[table];
  $("search").placeholder = `Search ${TAB_LABELS[table].toLowerCase()}…`;
  $("list-hint").textContent =
    table === "experiences"
      ? reorderable
        ? "Drag rows (or use ↑ ↓ in the editor) to change order_index. Lower numbers show first on the site."
        : "Clear the search to reorder."
      : table === "projects"
        ? "The site lists projects newest first (by created_at)."
        : "";

  const columns = COLUMNS[table];
  const head = h("thead", null, h("tr", null, reorderable ? h("th", null, "") : null, columns.map((c) => h("th", null, c.label))));
  const body = h("tbody");
  for (const row of visible) {
    const classes = [
      row.id === state.selected[table] ? "active" : "",
      problemSlugs.has(row.slug) ? "has-problem" : "",
      state.savedIds.has(row.id) ? "" : "is-new",
    ].join(" ");
    const tr = h("tr", { class: classes, onClick: () => select(table, row.id) },
      reorderable ? h("td", { class: "handle", title: "Drag to reorder" }, "⠿") : null,
      columns.map((c) => h("td", { class: c.class ?? "" }, c.render(row))),
    );
    if (reorderable) makeDraggable(tr, row);
    body.append(tr);
  }
  if (!visible.length) body.append(h("tr", null, h("td", { colspan: columns.length + 1, class: "muted" }, "No rows match.")));
  $("rows").replaceChildren(head, body);
}

let dragId = null;
function makeDraggable(tr, row) {
  tr.draggable = true;
  tr.addEventListener("dragstart", (event) => {
    dragId = row.id;
    tr.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  tr.addEventListener("dragend", () => tr.classList.remove("dragging"));
  tr.addEventListener("dragover", (event) => {
    event.preventDefault();
    tr.classList.add("drop-target");
  });
  tr.addEventListener("dragleave", () => tr.classList.remove("drop-target"));
  tr.addEventListener("drop", (event) => {
    event.preventDefault();
    tr.classList.remove("drop-target");
    if (!dragId || dragId === row.id) return;
    const target = experiencesByOrder().findIndex((r) => r.id === row.id);
    moveExperience(dragId, target);
  });
}

/**
 * Move an experience to a new position. Reuses the existing order_index values
 * (so only moved rows change in the diff) unless they collide.
 */
function moveExperience(id, targetIndex) {
  const ordered = experiencesByOrder();
  const from = ordered.findIndex((r) => r.id === id);
  if (from === -1 || targetIndex < 0 || targetIndex >= ordered.length || from === targetIndex) return;
  const values = ordered.map((r) => r.order_index);
  const reusable = values.every(Number.isInteger) && new Set(values).size === values.length;
  const slots = reusable ? [...values].sort((a, b) => a - b) : ordered.map((_, i) => i);
  const [moved] = ordered.splice(from, 1);
  ordered.splice(targetIndex, 0, moved);
  ordered.forEach((row, index) => { row.order_index = slots[index]; });
  refresh({ editor: true });
}

function select(table, id) {
  state.selected[table] = id;
  renderList();
  renderEditor();
}

// ---------------------------------------------------------------------------
// Rendering: editor

function changed({ list = true } = {}) {
  refresh({ list });
}

function field(label, control, { required = false, hint } = {}) {
  return h("div", { class: "field" },
    h("label", null, label, required ? h("span", { class: "req" }, " *") : null),
    control,
    hint ? h("p", { class: "hint" }, hint) : null,
  );
}

function textInput(row, key, { nullable = false, multiline = false, long = false, onAfter } = {}) {
  const props = {
    value: row[key] ?? "",
    onInput: (event) => {
      const value = event.target.value;
      row[key] = nullable && value.trim() === "" ? null : value;
      onAfter?.(value);
      changed();
    },
  };
  return multiline ? h("textarea", { ...props, class: long ? "long" : "" }) : h("input", { type: "text", ...props });
}

function slugInput(table, row, autoFrom) {
  const input = h("input", {
    type: "text",
    value: row.slug,
    spellcheck: "false",
    onChange: (event) => {
      const error = renameSlug(table, row, event.target.value.trim());
      if (error) {
        toast(error, "error");
        event.target.value = row.slug;
      }
      changed();
    },
  });
  // For brand-new rows, keep the slug in sync with the title until edited by hand.
  if (autoFrom && !state.savedIds.has(row.id)) {
    let manual = Boolean(row.slug) && row.slug !== slugify(row[autoFrom] ?? "");
    input.addEventListener("input", () => { manual = true; });
    slugSyncers.set(row, (text) => {
      if (manual) return;
      const next = slugify(text);
      if (next && !renameSlug(table, row, next)) input.value = next;
    });
  }
  return input;
}

function urlInput(row, key, { nullable = true, preview } = {}) {
  const img = preview ? h("img", { class: preview, src: row[key] || null, alt: "", hidden: !row[key] }) : null;
  const input = h("input", {
    type: "url",
    value: row[key] ?? "",
    spellcheck: "false",
    onInput: (event) => {
      const value = event.target.value.trim();
      row[key] = nullable && value === "" ? null : value;
      if (img) {
        img.hidden = !value;
        if (value) img.src = value;
      }
      changed();
    },
  });
  return h("div", null, input, img);
}

function renderEditor() {
  const table = state.tab;
  const row = findById(table, state.selected[table]);
  const pane = $("editor");
  if (!row) {
    pane.replaceChildren(h("p", { class: "empty" }, `Select a row on the left, or click "${NEW_LABELS[table]}".`));
    return;
  }
  const isNew = !state.savedIds.has(row.id);
  const heading = row.name || row.title || "Untitled";
  const children = [
    h("div", { class: "editor-head" },
      h("h2", null, heading, isNew ? h("span", { class: "pill good", style: "margin-left:8px" }, "new") : null),
      h("button", { type: "button", class: "danger", onClick: () => removeRow(table, row) }, "Delete"),
    ),
    h("div", { class: "row-problems", id: "row-problems" }),
  ];

  if (table === "skills") children.push(...skillFields(row));
  if (table === "projects") children.push(...projectFields(row));
  if (table === "experiences") children.push(...experienceFields(row));

  children.push(h("p", { class: "meta" }, `id ${row.id}`, h("br"), `created_at ${row.created_at}`));
  pane.replaceChildren(...children);
  renderRowProblems();
}

function renderRowProblems() {
  const box = document.getElementById("row-problems");
  if (!box) return;
  const row = findById(state.tab, state.selected[state.tab]);
  const problems = row ? rowProblems(state.tab, row) : [];
  box.replaceChildren(...(problems.length ? [h("ul", null, problems.map((p) => h("li", null, p.message)))] : []));
}

function skillFields(row) {
  const categories = [...new Set(rows("skills").map((s) => s.category).filter(Boolean))].sort();
  const usage = skillUsage(row.slug);
  const badge = urlInput(row, "visual", { nullable: false, preview: "badge-img preview" });
  return [
    h("div", { class: "row-2" },
      field("Name", textInput(row, "name", { onAfter: (v) => syncSlug(row, v) }), { required: true }),
      field("Slug", slugInput("skills", row, "name"), { required: true, hint: "Renaming updates every project/experience link." }),
    ),
    h("div", { class: "row-2" },
      field("Proficiency",
        h("select", { onChange: (e) => { row.proficiency = e.target.value; changed(); }, value: row.proficiency },
          PROFICIENCIES.map((p) => h("option", { value: p }, p))),
        { required: true }),
      field("Category",
        h("div", null,
          h("input", { type: "text", list: "categories", value: row.category ?? "", onInput: (e) => { row.category = e.target.value.trim() || null; changed(); } }),
          h("datalist", { id: "categories" }, categories.map((c) => h("option", { value: c })))),
      ),
    ),
    field("Badge image URL", badge, {
      required: true,
      hint: h("span", null, "Usually a shields.io badge. ",
        h("button", { type: "button", class: "small", onClick: () => {
          const label = encodeURIComponent((row.name || "Skill").replace(/-/g, "--").replace(/ /g, "_"));
          row.visual = `https://img.shields.io/badge/${label}-555555?style=for-the-badge&logo=${encodeURIComponent(row.slug || "")}&logoColor=white`;
          changed();
          renderEditor();
        } }, "Fill a shields.io template"),
        " then adjust the color hex and logo name."),
    }),
    h("div", { class: "field inline" },
      h("input", { type: "checkbox", id: "featured", checked: row.is_featured, onChange: (e) => { row.is_featured = e.target.checked; changed(); } }),
      h("label", { for: "featured" }, "Featured skill")),
    field("Used by", h("div", { class: "usage" },
      usage.projects.length || usage.experiences.length
        ? [
            ...usage.projects.map((slug) => h("div", null, "Project: ", h("a", { onClick: () => switchTab("projects", slug) }, findBySlug("projects", slug)?.title ?? slug))),
            ...usage.experiences.map((slug) => h("div", null, "Experience: ", h("a", { onClick: () => switchTab("experiences", slug) }, findBySlug("experiences", slug)?.title ?? slug))),
          ]
        : h("span", { class: "muted" }, "Not linked to any project or experience yet."))),
  ];
}

function projectFields(row) {
  const linkInput = (key) =>
    h("input", {
      type: "url",
      value: row.links?.[key] ?? "",
      spellcheck: "false",
      onInput: (e) => {
        row.links = { ...row.links, [key]: e.target.value.trim() || null };
        changed();
      },
    });
  return [
    h("div", { class: "row-2" },
      field("Title", textInput(row, "title", { onAfter: (v) => syncSlug(row, v) }), { required: true }),
      field("Slug", slugInput("projects", row, "title"), { required: true, hint: "Used in the project URL on the site." }),
    ),
    field("Summary", textInput(row, "summary", { multiline: true }), { required: true, hint: "One line shown on the project card." }),
    field("Description", textInput(row, "description", { multiline: true, long: true }), { required: true }),
    h("div", { class: "row-2" },
      field("Repository URL", linkInput("repo")),
      field("Demo URL", linkInput("demo")),
    ),
    field("Thumbnail URL", urlInput(row, "thumbnail", { preview: "preview" })),
    field("Gallery", galleryEditor(row)),
    field("Skills", skillPicker("projects", row)),
  ];
}

function experienceFields(row) {
  const ordered = experiencesByOrder();
  const position = ordered.indexOf(row);
  return [
    h("div", { class: "row-2" },
      field("Title", textInput(row, "title", { onAfter: (v) => syncSlug(row, v) }), { required: true, hint: "The role, e.g. Software Engineer I." }),
      field("Slug", slugInput("experiences", row, "title"), { required: true }),
    ),
    h("div", { class: "row-2" },
      field("Subtitle", textInput(row, "subtitle", { nullable: true }), { hint: "Company · team · location" }),
      field("Timeframe", textInput(row, "timeframe", { nullable: true }), { hint: "e.g. May 2025 – Jan 2026" }),
    ),
    field("Order",
      h("div", { style: "display:flex;gap:8px;align-items:center" },
        h("input", {
          type: "number",
          step: "1",
          style: "width:100px",
          value: row.order_index ?? "",
          onInput: (e) => {
            const value = e.target.value;
            row.order_index = value === "" ? null : Number(value);
            changed();
          },
        }),
        h("button", { type: "button", disabled: position <= 0, onClick: () => moveExperience(row.id, position - 1) }, "↑ Up"),
        h("button", { type: "button", disabled: position >= ordered.length - 1, onClick: () => moveExperience(row.id, position + 1) }, "↓ Down"),
        h("button", { type: "button", class: "ghost", disabled: position <= 0, onClick: () => moveExperience(row.id, 0) }, "Move to top"),
      ),
      { required: true, hint: `Position ${position + 1} of ${ordered.length}. order_index must be unique; 0 shows first.` }),
    field("Description", textInput(row, "description", { multiline: true, long: true }), { required: true }),
    field("Skills", skillPicker("experiences", row), { required: true }),
  ];
}

function galleryEditor(row) {
  const container = h("div");
  const draw = () => {
    const items = row.gallery.map((media, index) => {
      const preview = media.type === "video"
        ? h("div", { class: "thumb", title: "Video" }, "▶")
        : h("img", { class: "thumb", src: media.url || null, alt: "" });
      const update = (key, value) => {
        const next = { ...media };
        if (value === undefined) delete next[key];
        else next[key] = value;
        row.gallery = row.gallery.map((m, i) => (i === index ? next : m));
        media = next;
        changed({ list: false });
      };
      const move = (delta) => {
        const target = index + delta;
        const next = [...row.gallery];
        [next[index], next[target]] = [next[target], next[index]];
        row.gallery = next;
        changed({ list: false });
        draw();
      };
      return h("div", { class: "gallery-item" },
        preview,
        h("div", { class: "stack" },
          h("input", { type: "url", placeholder: "Image or video URL", value: media.url ?? "", spellcheck: "false", onInput: (e) => update("url", e.target.value.trim()) }),
          h("input", { type: "text", placeholder: "Caption", value: media.caption ?? "", onInput: (e) => update("caption", e.target.value || undefined) }),
          h("select", { value: media.type ?? "", onChange: (e) => { update("type", e.target.value || undefined); draw(); } },
            h("option", { value: "" }, "type: not set"),
            GALLERY_TYPES.map((t) => h("option", { value: t }, t))),
        ),
        h("div", { class: "tools" },
          h("button", { type: "button", class: "small", disabled: index === 0, onClick: () => move(-1) }, "↑"),
          h("button", { type: "button", class: "small", disabled: index === row.gallery.length - 1, onClick: () => move(1) }, "↓"),
          h("button", { type: "button", class: "small danger", onClick: () => {
            row.gallery = row.gallery.filter((_, i) => i !== index);
            changed({ list: false });
            draw();
          } }, "✕"),
        ),
      );
    });
    container.replaceChildren(
      ...items,
      h("button", { type: "button", class: "small", onClick: () => {
        row.gallery = [...row.gallery, { caption: "", type: "image", url: "" }];
        changed({ list: false });
        draw();
      } }, "+ Add image or video"),
    );
  };
  draw();
  return container;
}

function skillPicker(table, row) {
  const join = JOINS[table];
  const search = h("input", { type: "search", placeholder: "Filter skills…" });
  const body = h("div");

  const toggle = (skillSlug, on) => {
    if (on) {
      state.snapshot[join.table] = insertSorted(join.table, rows(join.table), { [join.field]: row.slug, skill_slug: skillSlug });
    } else {
      state.snapshot[join.table] = rows(join.table).filter((l) => !(l[join.field] === row.slug && l.skill_slug === skillSlug));
    }
    changed();
    draw();
  };

  const draw = () => {
    if (!row.slug) {
      body.replaceChildren(h("p", { class: "muted" }, "Set a slug first, then pick skills."));
      return;
    }
    const linked = new Set(linkedSkills(table, row.slug));
    const chips = [...linked]
      .sort((a, b) => skillName(a).localeCompare(skillName(b)))
      .map((slug) => h("span", { class: "chip" }, skillName(slug), h("button", { type: "button", title: "Remove", onClick: () => toggle(slug, false) }, "×")));

    const query = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const skill of [...rows("skills")].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!skill.slug) continue;
      if (query && !`${skill.name} ${skill.slug} ${skill.category ?? ""}`.toLowerCase().includes(query)) continue;
      const group = skill.category || "Uncategorized";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(skill);
    }
    const list = [...groups.keys()].sort().map((group) =>
      h("div", { class: "picker-group" },
        h("h4", null, group),
        h("div", { class: "picker-options" }, groups.get(group).map((skill) =>
          h("label", null,
            h("input", { type: "checkbox", checked: linked.has(skill.slug), onChange: (e) => toggle(skill.slug, e.target.checked) }),
            skill.name)))));

    body.replaceChildren(
      h("div", { class: "chips" }, chips.length ? chips : h("span", { class: "muted" }, "No skills linked yet.")),
      h("div", { class: "picker-list" }, list.length ? list : h("p", { class: "muted" }, "No skills match. Add it on the Skills tab first.")),
    );
  };

  search.addEventListener("input", draw);
  draw();
  return h("div", { class: "picker" }, search, body);
}

// ---------------------------------------------------------------------------
// Create / delete

function createRow() {
  const table = state.tab;
  const base = { id: crypto.randomUUID(), created_at: timestampNow(), slug: "" };
  let row;
  if (table === "skills") {
    row = { ...base, name: "", visual: "", proficiency: "Experienced", category: null, is_featured: false };
  } else if (table === "projects") {
    row = { ...base, title: "", summary: "", description: "", links: { demo: null, repo: null }, thumbnail: null, gallery: [] };
  } else {
    const indexes = rows("experiences").map((r) => r.order_index).filter(Number.isInteger);
    const next = indexes.length ? Math.max(...indexes) + 1 : 0;
    row = { ...base, title: "", subtitle: null, timeframe: null, description: "", order_index: next };
  }
  state.snapshot[table] = [...rows(table), row];
  state.search = "";
  $("search").value = "";
  state.selected[table] = row.id;
  refresh({ editor: true });
  $("editor").querySelector("input")?.focus();
}

function removeRow(table, row) {
  const label = row.name || row.title || row.slug || "this row";
  let detail = "";
  if (table === "skills") {
    const usage = skillUsage(row.slug);
    const count = usage.projects.length + usage.experiences.length;
    if (count) detail = `\n\nIt is linked to ${usage.projects.length} project(s) and ${usage.experiences.length} experience(s); those links will be removed too.`;
  } else {
    const count = linkedSkills(table, row.slug).length;
    if (count) detail = `\n\nIts ${count} skill link(s) will be removed too.`;
  }
  if (!confirm(`Delete "${label}"?${detail}\n\nNothing is written until you press Save.`)) return;

  state.snapshot[table] = rows(table).filter((r) => r !== row);
  if (row.slug) {
    if (table === "skills") {
      for (const join of Object.values(JOINS)) {
        state.snapshot[join.table] = rows(join.table).filter((l) => l.skill_slug !== row.slug);
      }
    } else {
      const join = JOINS[table];
      state.snapshot[join.table] = rows(join.table).filter((l) => l[join.field] !== row.slug);
    }
  }
  state.selected[table] = null;
  refresh({ editor: true });
}

// ---------------------------------------------------------------------------
// Git review dialog

function diffView(diff) {
  return h("div", { class: "diff" }, diff.split("\n").map((line) => {
    const kind = line.startsWith("diff --git") ? "file"
      : line.startsWith("@@") ? "hunk"
      : line.startsWith("+") && !line.startsWith("+++") ? "add"
      : line.startsWith("-") && !line.startsWith("---") ? "del"
      : "";
    return h("div", { class: kind }, line || " ");
  }));
}

async function openReview() {
  const dialog = $("git-dialog");
  const body = $("git-body");
  try {
    state.git = await api("GET", "/api/git");
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  renderStatus();
  const { diff, status, branch, ahead } = state.git;
  const parts = [];
  if (isDirty()) {
    parts.push(h("div", { class: "notice" }, "You have unsaved edits in the browser. This diff shows only what is saved in data/. Save first to include them."));
  }
  if (diff.trim()) {
    parts.push(h("p", { class: "muted" }, "git diff -- data/*.json"), diffView(diff));
    const message = h("input", { type: "text", value: "content: update portfolio data", "aria-label": "Commit message" });
    const commit = h("button", { type: "button", class: "primary", onClick: async () => {
      commit.disabled = true;
      try {
        const result = await api("POST", "/api/commit", { message: message.value });
        state.git = result.git;
        toast(`Committed ${result.sha} (data files only)`, "ok");
        openReview();
      } catch (error) {
        toast(error.message, "error");
        commit.disabled = false;
      }
    } }, "Commit data files");
    parts.push(h("div", { class: "commit-row" }, message, commit),
      h("p", { class: "hint" }, "Commits only data/*.json. Other modified files (like the resume) are left alone."));
  } else {
    parts.push(h("p", null, status.trim() ? status : "No uncommitted changes in data/."));
  }
  if (ahead) {
    const push = h("button", { type: "button", onClick: async () => {
      if (!confirm(`Push ${ahead} commit(s) on ${branch} to its remote? Pushing data/ to main triggers the frontend redeploy.`)) return;
      push.disabled = true;
      try {
        const result = await api("POST", "/api/push", {});
        state.git = result.git;
        toast(result.output || "Pushed", "ok");
        openReview();
      } catch (error) {
        toast(error.message, "error");
        push.disabled = false;
      }
    } }, `Push ${ahead} commit${ahead > 1 ? "s" : ""} on ${branch}`);
    parts.push(h("hr"), h("p", null, `${ahead} local commit${ahead > 1 ? "s are" : " is"} not pushed yet.`), push);
  }
  body.replaceChildren(...parts);
  if (!dialog.open) dialog.showModal();
  renderStatus();
}

// ---------------------------------------------------------------------------
// Wiring

$("save").addEventListener("click", save);
$("review").addEventListener("click", openReview);
$("create").addEventListener("click", createRow);
$("discard").addEventListener("click", () => {
  if (confirm("Discard all unsaved edits and reload from data/?")) load();
});
$("reload").addEventListener("click", () => {
  if (!isDirty() || confirm("Reloading discards your unsaved edits. Continue?")) load();
});
$("search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderList();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    if (!$("save").disabled) save();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.snapshot && isDirty()) event.preventDefault();
});

if (!TAB_LABELS[state.tab]) state.tab = "skills";
load();

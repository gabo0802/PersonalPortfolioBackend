#!/usr/bin/env node
// Local-only admin server for data/*.json. Run with `npm run admin`.
// It binds to 127.0.0.1, has no dependencies, and never deploys anything:
// it reads and writes the JSON files, shows `git diff`, and commits or pushes
// only when you press those buttons.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  TABLES,
  placeNewRows,
  serializeTable,
  timestampNow,
  validateSnapshot,
} from "./lib/schema.mjs";

const run = promisify(execFile);
const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ADMIN_DIR, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const DATA_PATHS = TABLES.map((table) => `data/${table}.json`);
const HOST = "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 4310);

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/lib/schema.mjs": ["lib/schema.mjs", "text/javascript; charset=utf-8"],
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function readSnapshot() {
  const snapshot = {};
  const raw = {};
  for (const table of TABLES) {
    raw[table] = await fs.readFile(path.join(DATA_DIR, `${table}.json`), "utf8");
    snapshot[table] = JSON.parse(raw[table]);
  }
  const version = createHash("sha256").update(TABLES.map((t) => raw[t]).join("\u0000")).digest("hex");
  return { snapshot, raw, version };
}

async function git(...args) {
  const { stdout } = await run("git", args, { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function gitState() {
  const [diff, status, branch] = await Promise.all([
    git("diff", "--no-color", "--", ...DATA_PATHS),
    git("status", "--short", "--", ...DATA_PATHS),
    git("rev-parse", "--abbrev-ref", "HEAD"),
  ]);
  let ahead = null;
  try {
    ahead = Number((await git("rev-list", "--count", "@{upstream}..HEAD")).trim());
  } catch {
    ahead = null; // no upstream configured
  }
  return { diff, status, branch: branch.trim(), ahead };
}

// Fill id/created_at for rows the page created, in the same shape as existing rows.
function fillGeneratedFields(snapshot) {
  for (const table of ["skills", "projects", "experiences"]) {
    for (const row of snapshot[table]) {
      if (!row.id) row.id = crypto.randomUUID();
      if (!row.created_at) row.created_at = timestampNow();
    }
  }
}

async function writeAtomically(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, "utf8");
  await fs.rename(temporary, filePath);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

const routes = {
  "GET /api/data": async () => {
    const { snapshot, version } = await readSnapshot();
    return { snapshot, version, problems: validateSnapshot(snapshot), git: await gitState() };
  },

  "GET /api/git": async () => gitState(),

  "POST /api/save": async (body) => {
    const current = await readSnapshot();
    if (body.version !== current.version) {
      throw new HttpError(409, "data/*.json changed on disk since the page loaded. Reload to pick up those changes, then redo your edits.");
    }
    const snapshot = body.snapshot;
    if (!snapshot || typeof snapshot !== "object") throw new HttpError(400, "Missing snapshot");
    fillGeneratedFields(snapshot);
    const problems = validateSnapshot(snapshot);
    if (problems.length) throw new HttpError(422, "Fix the validation problems before saving", { problems });

    const written = [];
    for (const table of TABLES) {
      const rows = placeNewRows(table, snapshot[table], current.snapshot[table]);
      const contents = serializeTable(rows);
      if (contents !== current.raw[table]) {
        await writeAtomically(path.join(DATA_DIR, `${table}.json`), contents);
        written.push(`data/${table}.json`);
      }
    }
    const saved = await readSnapshot();
    return { written, snapshot: saved.snapshot, version: saved.version, git: await gitState() };
  },

  "POST /api/commit": async (body) => {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new HttpError(400, "Write a commit message first");
    const { snapshot } = await readSnapshot();
    const problems = validateSnapshot(snapshot);
    if (problems.length) throw new HttpError(422, "data/*.json on disk does not validate", { problems });
    const { status } = await gitState();
    if (!status.trim()) throw new HttpError(400, "No data changes to commit");
    // A pathspec commit includes only the data files, never other staged or
    // modified files (such as the resume sources).
    await git("commit", "-m", message, "--", ...DATA_PATHS);
    const sha = (await git("rev-parse", "--short", "HEAD")).trim();
    return { sha, git: await gitState() };
  },

  "POST /api/push": async () => {
    const { stdout, stderr } = await run("git", ["push"], { cwd: REPO_ROOT });
    return { output: `${stdout}${stderr}`.trim(), git: await gitState() };
  },
};

const server = http.createServer(async (request, response) => {
  const send = (status, body, type = "application/json; charset=utf-8") => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };

  try {
    // Only answer pages served from this machine (guards against DNS rebinding).
    const host = request.headers.host ?? "";
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) {
      throw new HttpError(403, "Forbidden host");
    }
    const url = new URL(request.url, `http://${host}`);

    if (request.method === "GET" && STATIC_FILES[url.pathname]) {
      const [file, type] = STATIC_FILES[url.pathname];
      return send(200, await fs.readFile(path.join(ADMIN_DIR, file)), type);
    }

    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, "Not found");

    let body = {};
    if (request.method === "POST") {
      // A custom header forces a CORS preflight, so other sites cannot post here.
      if (request.headers["x-portfolio-admin"] !== "1") throw new HttpError(403, "Missing admin header");
      body = await readBody(request);
    }
    send(200, await handler(body));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error.stderr?.trim() || error.message || String(error);
    if (status === 500) console.error(error);
    send(status, { error: message, ...(error.extra ?? {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Portfolio admin running at http://localhost:${PORT}`);
  console.log(`Editing ${DATA_DIR}`);
  console.log("Press Ctrl+C to stop.");
});

#!/usr/bin/env node
// Validate data/*.json with the same rules as the admin UI and check that each
// file uses the stable format. Run `npm run check-data`; add `-- --fix` to
// rewrite files whose formatting drifted (row order is kept).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TABLES, serializeTable, validateSnapshot } from "./lib/schema.mjs";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const fix = process.argv.includes("--fix");

const snapshot = {};
const drifted = [];
for (const table of TABLES) {
  const file = path.join(DATA_DIR, `${table}.json`);
  const raw = await fs.readFile(file, "utf8");
  try {
    snapshot[table] = JSON.parse(raw);
  } catch (error) {
    console.error(`data/${table}.json is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  const formatted = serializeTable(snapshot[table]);
  if (formatted !== raw) {
    drifted.push(`data/${table}.json`);
    if (fix) await fs.writeFile(file, formatted, "utf8");
  }
}

const problems = validateSnapshot(snapshot);
for (const problem of problems) {
  console.error(`${problem.table} › ${problem.slug ?? "?"}: ${problem.message}`);
}
if (drifted.length) {
  console.error(`${fix ? "Reformatted" : "Not in the stable format (run with --fix)"}: ${drifted.join(", ")}`);
}

const counts = TABLES.map((table) => `${table}=${snapshot[table].length}`).join(", ");
if (problems.length || (drifted.length && !fix)) {
  console.error(`Check failed (${counts})`);
  process.exit(1);
}
console.log(`data/*.json is valid (${counts})`);

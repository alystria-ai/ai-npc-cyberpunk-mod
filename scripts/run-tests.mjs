#!/usr/bin/env node
// Runs the npm test suite with `node --test`.
//
// The file list used to live inline in package.json's "test" script, which grew
// past the Windows command-line limit (npm runs it through cmd.exe). This runner
// finds the test files itself, so a new *.test.mjs under bridge/, packaging/, addons/ or
// scripts/ is picked up without editing package.json.
//
// Usage: node scripts/run-tests.mjs [extra node --test args, e.g. --test-reporter=dot]

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_DIRS = ["bridge", "packaging", "scripts", "auth-backend", "auth-backend-cf", "addons"];
const TEST_SUFFIX = ".test.mjs";
const NODE_TEST_FLAGS = ["--test", "--test-concurrency=8"];

// Each spawned node process gets at most this many characters of arguments.
// The full list fits in one batch with Windows' 32,767-character limit; the
// batching is a safety net for when the suite grows past it.
const MAX_ARG_CHARS = 20000;

// Test files that exist in the repo but are deliberately NOT run by `npm test`. Each entry names its file and says why on the same line
// (scripts/run-tests.test.mjs checks both). The list is empty: every test file runs.
export const EXCLUDE = new Set([
]);

function walk(dir, out) {
  // A checkout may lack one of the search folders (an add-on repository removes addons/): skip it instead of ending the run.
  if (!existsSync(path.join(ROOT, dir))) return out;
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) out.push(rel);
  }
  return out;
}

// All test files under the search dirs, minus EXCLUDE, sorted and slash-separated.
export function collectTestFiles() {
  const found = [];
  for (const dir of SEARCH_DIRS) walk(dir, found);
  return found.filter((file) => !EXCLUDE.has(file)).sort();
}

function batches(files, extraArgs) {
  const out = [];
  let current = [];
  let chars = [...NODE_TEST_FLAGS, ...extraArgs].join(" ").length;
  for (const file of files) {
    if (current.length > 0 && chars + file.length + 1 > MAX_ARG_CHARS) {
      out.push(current);
      current = [];
      chars = [...NODE_TEST_FLAGS, ...extraArgs].join(" ").length;
    }
    current.push(file);
    chars += file.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function runNodeTest(files, extraArgs) {
  return new Promise((resolve) => {
    const args = [...NODE_TEST_FLAGS, ...extraArgs, ...files];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (error) => {
      console.error(`run-tests: failed to start node: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) console.error(`run-tests: batch stopped by signal ${signal}`);
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const files = collectTestFiles();
  const groups = batches(files, extraArgs);
  console.log(`run-tests: ${files.length} test files in ${groups.length} batch(es)`);

  let failed = false;
  for (const group of groups) {
    const code = await runNodeTest(group, extraArgs);
    if (code !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

// Run only when executed directly, so the file list can be imported for checks.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

# File History and Keyboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PiTech session dragging, highlighted-item deletion, and file/text undo-redo reliable and reversible.

**Architecture:** Add a persisted filesystem action journal that stores reversible `copy`, `move`, and `write` operations. Canonical path guards block junction escapes, per-root trash keeps deletes on the source volume, and complete multi-step mutations share the journal's serialized transaction queue. One client keyboard router leaves editable controls native and sends workspace undo/redo to the server.

**Tech Stack:** Node.js CommonJS, `node:fs/promises`, existing HTTP server, browser JavaScript, Node test runner, Chrome DevTools browser harness.

**Spec:** `docs/superpowers/specs/2026-08-29-file-history-and-keyboard-design.md`

## Execution Progress

- [x] Task 1: Persisted filesystem action journal
- [x] Task 2: Server integration
- [x] Task 3: Browser interaction and shortcuts
- [x] Task 4: Full verification and review
- [ ] Task 5: Final GitHub commit and push

## Global Constraints

- No new dependency.
- Text controls retain native browser undo and redo.
- Terminal commands, updates, credentials, settings, and unrelated UI actions remain outside history.
- Paths must remain inside existing PiTech session, project, context, skill, or configured file-root boundaries.
- A failed operation or failed journal write must not leave a partially applied action.
- Existing unrelated working-tree changes must remain unstaged.
- The user requested one final GitHub commit after implementation and review, so do not make intermediate commits.

## File Structure

- Create `file-history.js`: persisted reversible-operation journal and trash handling.
- Create `tests/file-history.test.cjs`: direct red/green coverage for journaling, delete groups, writes, conflicts, transaction serialization, per-root trash, and restart persistence.
- Create `safe-path.js` and `tests/safe-path.test.cjs`: canonical path and junction-escape guards.
- Modify `server.js`: initialize history, route filesystem mutations through it, protect private history paths, and expose undo/redo plus batch delete.
- Modify `file-tree.js` and `tests/file-tree.test.cjs`: keep the private journal and trash out of the explorer.
- Modify `pi/scripts/projects.mjs` and `tests/project-context.test.mjs`: refuse project-session destination overwrite and remove partial copies when manifest updates fail.
- Modify `public/app.js`: copy-compatible drag, highlighted deletion, and keyboard routing.
- Modify `tests/fixes-browser.cjs`: real browser interaction checks without mutating user files.
- Modify `.gitignore`, `package.json`, and `tests/release.test.cjs`: keep per-root trash private and run every regression through the canonical test gate.
- Create `docs/superpowers/specs/2026-08-29-file-history-and-keyboard-design.md` and this plan as review artifacts.

---

### Task 1: Persisted Filesystem Action Journal

**Files:**
- Create: `file-history.js`
- Create: `tests/file-history.test.cjs`

**Interfaces:**
- Produces: `createFileHistory({ journalPath, trashDir, trashForPath, isAllowedPath })`.
- Produces methods: `recordApplied(label, operations)`, `recordTransaction(makeAction)`, `deletePaths(paths, label)`, `renamePath(from, to, label)`, `writeText(file, text, label)`, `undo()`, `redo()`, and `status()`.
- Operation shapes:
  - `{ kind: 'copy', from: string, to: string }`
  - `{ kind: 'move', from: string, to: string }`
  - `{ kind: 'write', path: string, before: string, after: string }`

- [ ] **Step 1: Write failing unit tests**

Use temporary roots and assert exact data restoration:

```js
const history = createFileHistory({
  journalPath: path.join(root, 'history.json'),
  trashDir: path.join(root, 'trash'),
  isAllowedPath: (value) => path.resolve(value).startsWith(path.resolve(root) + path.sep),
});

await history.writeText(file, 'after', 'edit file');
assert.equal(fs.readFileSync(file, 'utf8'), 'after');
await history.undo();
assert.equal(fs.readFileSync(file, 'utf8'), 'before');
await history.redo();
assert.equal(fs.readFileSync(file, 'utf8'), 'after');
```

Also cover grouped deletion, redo clearing after a new action, restart persistence by recreating the store, stale-state conflicts, copied-file digests, concurrent request serialization, tampered-journal path rejection, single rollback after journal failure, hostile trash junctions, and rejection outside the allowed root.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --test tests/file-history.test.cjs
```

Expected: failure because `file-history.js` does not exist.

- [ ] **Step 3: Implement the minimal journal**

Use atomic JSON writes and reversible operation order:

```js
function createFileHistory({ journalPath, trashDir, trashForPath, isAllowedPath }) {
  async function recordApplied(label, operations) { /* validate after-state, append, atomically save; reverse on save failure */ }
  async function recordTransaction(makeAction) { /* serialize external filesystem work plus recording */ }
  async function deletePaths(paths, label = 'delete files') { /* create unique trash moves and apply as one action */ }
  async function renamePath(from, to, label = 'rename file') { /* apply one move and record */ }
  async function writeText(file, text, label = 'edit file') { /* read before, write after, record */ }
  async function undo() { /* reverse latest undo entry; persist only after success */ }
  async function redo() { /* replay latest redo entry; persist only after success */ }
  function status() { return { canUndo: undo.length > 0, canRedo: redo.length > 0 }; }
  return { recordApplied, recordTransaction, deletePaths, renamePath, writeText, undo, redo, status };
}
```

Apply forward operations in array order and reverse operations in reverse array order. A `write` verifies current text equals the expected side before writing. A `move` requires its source to exist and destination not to exist. A `copy` requires its source to exist and destination not to exist. Roll back already-applied operations if any later operation or journal write fails.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node --test tests/file-history.test.cjs
```

Expected: all file-history tests pass with no warnings.

- [ ] **Step 5: Review without committing**

Confirm the module exports only `createFileHistory`, uses no dependency, and contains no path bypass or destructive permanent-delete fallback.

---

### Task 2: Route Server File Mutations Through History

**Files:**
- Modify: `server.js:20-40, 640-730, 760-875`
- Modify: `pi/scripts/projects.mjs:45-59`
- Test: `tests/file-history.test.cjs`

**Interfaces:**
- Consumes: Task 1 `createFileHistory` and its methods.
- Produces endpoints: `POST /api/history/undo`, `POST /api/history/redo`, and `POST /api/fs/delete-batch`.
- Existing `/api/sessions/copy`, `/api/fs/delete`, `/api/fs/rename`, `/api/file/save`, and `/api/conversations/organize` return the same existing success fields plus history state where useful.

- [ ] **Step 1: Add failing API-focused tests around route behavior**

Add a small exported route helper only if direct testing requires it; otherwise extend the history tests with the exact operation batches the routes will use. Required assertions:

```js
await history.recordApplied('copy session into project', [
  { kind: 'copy', from: source, to: destination },
  { kind: 'write', path: manifest, before: manifestBefore, after: manifestAfter },
]);
await history.undo();
assert.equal(fs.existsSync(destination), false);
assert.equal(fs.readFileSync(manifest, 'utf8'), manifestBefore);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run `node --test tests/file-history.test.cjs`.

Expected: the new project-copy/group assertions fail until operation recording is integrated correctly.

- [ ] **Step 3: Initialize one server history instance**

Use:

```js
const history = createFileHistory({
  journalPath: path.join(AGENT, '.pitech-history.json'),
  trashDir: path.join(AGENT, '.pitech-trash'),
  trashForPath: historyTrashForPath,
  isAllowedPath: historyPathAllowed,
});
```

`historyPathAllowed` accepts existing PiTech roots and private per-root trash. `safe-path.js` canonicalizes existing paths and destination parents before comparing boundaries so symlinks and junctions cannot escape.

- [ ] **Step 4: Add undo, redo, and grouped-delete endpoints**

Return concise descriptions and availability:

```js
const result = await history.undo();
return sendJson(res, 200, { ok: true, ...result, ...history.status() });
```

`/api/fs/delete` delegates to the same reversible delete path with one item. `/api/fs/delete-batch` validates a non-empty unique string array before one grouped history action.

- [ ] **Step 5: Integrate copy, rename, save, and session metadata writes**

- Project copy captures `project.md` before and after, performs each exclusive copy before registering it for rollback, and runs copy, manifest append, and recording inside `recordTransaction` with `copy` plus `write` operations. Empty source directories return without creating a project.
- `addSessionToProject` uses `fs.copyFile(srcFile, dst, constants.COPYFILE_EXCL)` so an existing project session is never overwritten.
- File rename uses `renamePath`; project-manifest title changes are grouped with the move through `recordApplied`.
- File save uses `writeText` so before and after text are preserved.
- Conversation rename/folder movement captures `STATE_FILE` before and after and records one `write` operation; conflict checks prevent overwriting later unrelated state.

- [ ] **Step 6: Run syntax and focused tests**

Run:

```powershell
node --check server.js
node --check file-history.js
node --test tests/file-history.test.cjs
```

Expected: exit 0 for all commands.

- [ ] **Step 7: Review without committing**

Check every mutation records only after success, rolls back on history failure, and preserves existing API response compatibility.

---

### Task 3: Fix Dragging and Add Keyboard Routing

**Files:**
- Modify: `public/app.js:446-530, 680-790, 1850-1980`
- Test: `tests/fixes-browser.cjs`

**Interfaces:**
- Consumes: Task 2 history and batch-delete endpoints.
- Produces client helpers: `isEditableTarget(target)`, `deleteSelection()`, and `runHistory(action)`.

- [ ] **Step 1: Write failing browser assertions**

Patch `window.fetch` only for mutation endpoints so user files remain untouched. Add checks that:

```js
// A native drag from a visible past session to a project issues /api/sessions/copy.
// Delete with selected rows opens one confirmation; confirming posts one path array.
// Ctrl+Z posts /api/history/undo outside editors.
// Ctrl+Y and Ctrl+Shift+Z post /api/history/redo outside editors.
// The same shortcuts inside a textarea do not call history endpoints.
```

- [ ] **Step 2: Run the browser test and verify RED**

Run:

```powershell
node tests/fixes-browser.cjs
```

Expected: drag request, Delete confirmation, and history shortcut assertions fail against current code.

- [ ] **Step 3: Make past-session drag copy-compatible**

Change the drag source to:

```js
e.dataTransfer.effectAllowed = 'copyMove';
```

Keep conversation-folder targets using move and project targets using copy.

- [ ] **Step 4: Add highlighted deletion**

Collect the current selected rows once, keep the selection on failure, and use one confirmation:

```js
async function deleteSelection() {
  const entries = selectedEntries();
  if (!entries.length) return;
  confirmModal(`Delete ${entries.length} selected item${entries.length === 1 ? '' : 's'}?`,
    'This can be restored with Ctrl+Z.', 'Delete', async () => {
      const result = await apiPost('/api/fs/delete-batch', { paths: entries.map((entry) => entry.path) });
      if (result.ok) { clearSelection(); await fetchState(); }
      showToast(result.ok ? `Deleted ${entries.length} item${entries.length === 1 ? '' : 's'}` : `Delete failed: ${result.error || 'unknown'}`);
    });
}
```

- [ ] **Step 5: Add one global shortcut router**

```js
function isEditableTarget(target) {
  return target instanceof Element && !!target.closest('input, textarea, [contenteditable="true"]');
}

document.addEventListener('keydown', (event) => {
  if (isEditableTarget(event.target)) return;
  if (event.key === 'Delete' && !event.repeat && selectedKeys.size) { event.preventDefault(); deleteSelection(); return; }
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  const action = key === 'z' && !event.shiftKey ? 'undo' : (key === 'y' || (key === 'z' && event.shiftKey)) ? 'redo' : null;
  if (!action) return;
  event.preventDefault();
  runHistory(action);
});
```

`runHistory` posts to the matching endpoint, refreshes state after success, and uses existing toasts for success/conflict errors.

- [ ] **Step 6: Run browser tests and verify GREEN**

Run `node tests/fixes-browser.cjs`.

Expected: all existing and new browser assertions pass with zero collected JavaScript errors.

- [ ] **Step 7: Review without committing**

Confirm editable controls are never intercepted, key repeat cannot duplicate deletion, and no user data was changed by browser tests.

---

### Task 4: Full Verification and Defect Review

**Files:**
- Review: all files changed by Tasks 1-3 plus the spec and plan.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verification evidence and a defect-free final diff.

- [ ] **Step 1: Run focused history tests**

Run `node --test tests/file-history.test.cjs`.

Expected: all pass.

- [ ] **Step 2: Run the repository test suite**

Run `npm test`.

Expected: exit 0 with zero failed tests.

- [ ] **Step 3: Run browser checks**

Run `npm run test:browser`.

Expected: exit 0, including drag, deletion, and shortcut assertions.

- [ ] **Step 4: Run syntax and dependency checks**

Run:

```powershell
node --check server.js
node --check file-history.js
node --check public/app.js
npm audit --omit=dev
```

Expected: syntax exits 0 and audit reports zero vulnerabilities.

- [ ] **Step 5: Review the exact diff**

Check:

- Every spec requirement maps to implementation and a test.
- No permanent delete remains on the affected file/session routes.
- No unsafe path or stale-state overwrite is possible.
- No unrelated existing worktree change is staged.
- No generated history, trash, config, log, vendor, or test artifact is tracked.

- [ ] **Step 6: Correct any finding through another red-green cycle**

For each defect, add or tighten the smallest failing test, verify its failure, apply the minimal fix, and rerun the focused plus full checks.

---

### Task 5: Final GitHub Commit and Push

**Files:**
- Stage only the implementation, tests, spec, and plan listed above.

**Interfaces:**
- Produces: one reviewed commit on the existing feature branch and a pushed GitHub branch.

- [ ] **Step 1: Confirm GitHub and worktree state**

Run `gh --version`, `gh auth status`, `git status -sb`, and inspect the full unstaged diff.

- [ ] **Step 2: Stage only intended paths**

```powershell
git add file-history.js tests/file-history.test.cjs server.js pi/scripts/projects.mjs public/app.js tests/fixes-browser.cjs docs/superpowers/specs/2026-08-29-file-history-and-keyboard-design.md docs/superpowers/plans/2026-08-29-file-history-and-keyboard.md
```

Do not stage `README.md`, `package.json`, `pi/extensions/pi-webui.ts`, `setup.js`, `tests/release.test.cjs`, `pi/scripts/openrouter-catalog.mjs`, or `tests/openrouter-catalog.test.mjs` unless a final diff proves they were required by this feature.

- [ ] **Step 3: Verify the staged diff and rerun the release gate**

Run `git diff --cached --check`, inspect `git diff --cached`, then rerun focused tests, `npm test`, and `npm run test:browser` against the staged worktree.

- [ ] **Step 4: Create the final commit**

```powershell
git commit -m "feat(webui): add reversible file actions"
```

- [ ] **Step 5: Push the existing feature branch**

```powershell
git push -u origin agent/persistent-session-file-organization
```

- [ ] **Step 6: Verify remote parity**

Confirm local `HEAD` equals the remote branch SHA and report the commit, branch, checks, and intentionally unstaged unrelated files.

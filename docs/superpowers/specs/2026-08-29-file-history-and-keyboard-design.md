# PiTech File History and Keyboard Design

**Date:** 2026-08-29
**Author:** Haxnstuff

## Goal

Make PiTech file and text operations predictable and reversible:

- Past sessions can be dragged into projects.
- Highlighted past sessions and file-tree entries can be deleted with `Delete`.
- `Ctrl+Z` and `Ctrl+Y` undo and redo text edits or the latest PiTech-managed file action.

## Scope

Undoable PiTech-managed actions:

- Copying a past session into a project.
- Moving or renaming supported files and session metadata.
- Deleting one or more highlighted sessions or file-tree entries.
- Saving edited file content.

Text controls keep native browser undo and redo while focused. PiTech action history applies when focus is outside an editable control.

Excluded:

- Terminal commands and their side effects.
- Pi or extension updates.
- Authentication credentials.
- Settings, panel positions, external application launches, and other unrelated UI actions.

## Approach

Use a persisted action journal plus private PiTech trash directories on each configured file root.

Each successful mutation records enough information to reverse and replay it. Deletes move items into same-volume trash instead of destroying them immediately. A new action clears the redo stack. Grouped deletion is one history entry and is undone or redone as one action.

This is preferred over full filesystem snapshots, which copy too much data, and Windows Recycle Bin integration, which is platform-specific and cannot provide dependable redo.

## Storage

Store the journal under the existing Pi agent data area and reversible payloads beside their configured root:

- Journal: `~/.pi/agent/.pitech-history.json`
- Reversible payloads: `<configured-root>/.pitech-trash/`

Per-root trash keeps rename-based deletion atomic when PiTech and the user profile are on different Windows volumes. PiTech rejects a pre-existing trash directory if it is a symlink or junction outside that configured root.

The journal contains two ordered arrays: `undo` and `redo`. Entries include an ID, action type, timestamp, and only the paths, content snapshots, or copied-file digest required by that action. Writes use a temporary file followed by rename so a partial write cannot corrupt the journal. History mutations run through one serialized queue so rapid requests cannot race the same entry.

Path validation remains mandatory when recording and replaying persisted entries. Existing paths and destination parents are canonicalized through `realpath`, so junctions and symlinks cannot escape configured roots. History operations may only touch paths already allowed by PiTech's existing session, project, and file-root boundaries or paths inside PiTech trash. The journal and trash stay hidden from the file explorer and cannot be targeted by user file APIs.

## Server Behavior

Add one small history module responsible for:

- Loading and atomically saving the journal.
- Recording successful actions.
- Undoing and redoing one action at a time.
- Moving deleted items to and from unique trash paths.
- Clearing redo after a new action.

Existing mutation endpoints remain the source of truth. Multi-step external mutations, including project session copies and manifest updates, execute inside the same serialized history transaction and record only after every step succeeds. Add:

- `POST /api/history/undo`
- `POST /api/history/redo`
- `POST /api/fs/delete-batch`

Responses return `ok`, a concise action description, and whether further undo or redo is available.

Action payloads:

- **Project session copy:** source path and created project destination path.
- **Rename or move:** previous and new paths, or previous and new session metadata values.
- **Delete batch:** original paths and unique trash paths.
- **File save:** file path plus before and after text.

Undo and redo stop without changing the journal when filesystem state no longer matches the recorded precondition. The API returns a clear conflict error rather than overwriting unrelated data.

## Client Behavior

### Dragging sessions

Past-session drag sources advertise a copy-compatible operation. Project drop targets continue copying through the existing session-copy API. A successful copy becomes one history entry.

### Delete key

When highlighted past-session or file-tree rows exist and focus is not in an editable control, `Delete` opens one confirmation dialog. Confirming sends all selected paths to the batch-delete endpoint. Canceling changes nothing.

The keyboard handler ignores repeated keydown events and does not intercept `Delete` inside inputs, textareas, or content-editable elements.

### Undo and redo

A capture-phase document keyboard handler recognizes:

- `Ctrl+Z` as undo.
- `Ctrl+Y` and `Ctrl+Shift+Z` as redo.

When an editable control is focused, the browser handles the shortcut natively. Otherwise PiTech calls the history endpoint and refreshes state after success. This routing prevents a global handler from breaking native text editing.

## Failure Handling

- Failed mutations do not create history entries.
- Empty session directories return `copied: 0` without creating a project.
- Partial grouped operations roll back before returning an error, and a journal failure never invokes the same rollback twice.
- Undo and redo validate every source and destination before mutating anything.
- A copied-file digest blocks undo or redo if either copy endpoint changed after recording.
- Persisted operations are revalidated against current path boundaries before replay.
- Journal write failure causes the originating operation to fail or roll back; PiTech must not report an action as undoable when it was not recorded.
- UI errors use the existing toast surface and retain the current selection when an operation fails.

## Testing

### Unit and API checks

- A project accepts a past-session drag operation that supports copying.
- Session-copy history undo removes the copied destination; redo restores it.
- Batch delete moves every selected item to trash as one action.
- Undo restores exact paths and contents; redo removes them again.
- File-save undo restores the previous text; redo restores the new text.
- A new action clears redo.
- History survives server restart.
- Boundary and conflict checks reject unsafe or stale paths, including junction escapes, without data loss.
- Deletes select private trash on the same configured root as each source.
- Concurrent undo requests serialize across distinct history entries.
- A changed copied session is never deleted by undo.
- A failed project-manifest append removes its partial session copy and reports cleanup failure instead of suppressing it.
- A hostile `.pitech-trash` junction is rejected before deletion.
- Project rename works when `project.md` has no conventional title heading.

### Browser checks

- Real drag/drop of a past session into a project succeeds.
- `Delete` on multiple highlighted sessions/files opens one confirmation and submits one grouped action.
- `Delete` inside text controls remains native.
- `Ctrl+Z`, `Ctrl+Y`, and `Ctrl+Shift+Z` route correctly inside and outside inputs, textareas, and inherited or `plaintext-only` content-editable controls.
- No browser console errors occur during the flow.

## Delivery

Run focused red/green tests, the complete Node test suite, browser checks, syntax checks, and the release self-check. Review the final diff and stage only files belonging to this feature; unrelated existing changes remain unstaged. Commit and push only after every requested behavior and review gate passes.

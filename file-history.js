// PiTech by Haxnstuff
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function createFileHistory({ journalPath, trashDir, trashForPath = () => trashDir, isAllowedPath }) {
  if (!journalPath || !trashDir || typeof trashForPath !== 'function' || typeof isAllowedPath !== 'function') {
    throw new TypeError('journalPath, trashDir, trashForPath, and isAllowedPath are required');
  }

  let state = loadJournal(journalPath);

  function status() {
    return { canUndo: state.undo.length > 0, canRedo: state.redo.length > 0 };
  }

  function result(changed, label = null) {
    return { changed, label, ...status() };
  }

  function assertAllowed(value) {
    const resolved = path.resolve(String(value || ''));
    if (!isAllowedPath(resolved)) throw new Error(`path is not allowed: ${resolved}`);
    return resolved;
  }

  function normalizeOperation(raw) {
    if (!raw || !['copy', 'move', 'write'].includes(raw.kind)) throw new Error('invalid history operation');
    if (raw.kind === 'write') {
      const validSnapshot = (value) => value === null || typeof value === 'string';
      if (!validSnapshot(raw.before) || !validSnapshot(raw.after) || raw.before === raw.after) throw new Error('write history requires distinct text snapshots');
      return { kind: 'write', path: assertAllowed(raw.path), before: raw.before, after: raw.after };
    }
    if (raw.kind === 'copy' && raw.digest != null && !/^[a-f0-9]{64}$/.test(raw.digest)) throw new Error('copy history has an invalid digest');
    return {
      kind: raw.kind,
      from: assertAllowed(raw.from),
      to: assertAllowed(raw.to),
      ...(raw.kind === 'copy' && raw.digest ? { digest: raw.digest } : {}),
    };
  }

  async function persist(next) {
    const dir = path.dirname(journalPath);
    const temp = path.join(dir, `.${path.basename(journalPath)}.${process.pid}.${randomUUID()}.tmp`);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await fs.promises.rename(temp, journalPath);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function exists(value) {
    try { await fs.promises.access(value); return true; } catch { return false; }
  }

  async function readText(value) {
    return fs.promises.readFile(value, 'utf8');
  }

  async function digestFile(value) {
    return createHash('sha256').update(await fs.promises.readFile(value)).digest('hex');
  }

  async function addCopyDigests(operations, side) {
    return Promise.all(operations.map(async (operation) => operation.kind === 'copy' && !operation.digest
      ? { ...operation, digest: await digestFile(operation[side]) }
      : operation));
  }

  function requireCopyDigests(operations) {
    if (operations.some((operation) => operation.kind === 'copy' && !operation.digest)) throw new Error('copy history is missing its content digest');
    return operations;
  }

  async function readSnapshot(value) {
    try { return await readText(value); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function atomicWrite(value, text) {
    const temp = path.join(path.dirname(value), `.${path.basename(value)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temp, text, 'utf8');
      await fs.promises.rename(temp, value);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function replaceSnapshot(value, snapshot) {
    if (snapshot === null) return fs.promises.rm(value, { force: true });
    await fs.promises.mkdir(path.dirname(value), { recursive: true });
    return atomicWrite(value, snapshot);
  }

  async function checkForward(operation) {
    if (operation.kind === 'write') {
      if (await readSnapshot(operation.path) !== operation.before) throw new Error(`${operation.path} changed since this action was recorded`);
      return;
    }
    if (!await exists(operation.from)) throw new Error(`source no longer exists: ${operation.from}`);
    if (await exists(operation.to)) throw new Error(`destination already exists: ${operation.to}`);
    if (operation.kind === 'copy' && operation.digest && await digestFile(operation.from) !== operation.digest) {
      throw new Error(`${operation.from} changed since this action was recorded`);
    }
  }

  async function checkReverse(operation) {
    if (operation.kind === 'write') {
      if (await readSnapshot(operation.path) !== operation.after) throw new Error(`${operation.path} changed since this action was recorded`);
      return;
    }
    if (!await exists(operation.to)) throw new Error(`recorded destination no longer exists: ${operation.to}`);
    if (operation.kind === 'copy' && (!operation.digest || await digestFile(operation.to) !== operation.digest)) {
      throw new Error(`${operation.to} changed since this action was recorded`);
    }
    if (operation.kind === 'move' && await exists(operation.from)) throw new Error(`original path already exists: ${operation.from}`);
  }

  async function checkApplied(operation) {
    if (operation.kind === 'write') {
      if (await readSnapshot(operation.path) !== operation.after) throw new Error(`${operation.path} does not match the recorded edit`);
      return;
    }
    if (!await exists(operation.to)) throw new Error(`recorded destination does not exist: ${operation.to}`);
    if (operation.kind === 'copy') {
      if (!operation.digest || await digestFile(operation.to) !== operation.digest || await digestFile(operation.from) !== operation.digest) {
        throw new Error(`${operation.to} does not match the recorded copy`);
      }
    }
    if (operation.kind === 'move' && await exists(operation.from)) throw new Error(`recorded source still exists: ${operation.from}`);
  }

  async function applyForward(operation) {
    if (operation.kind === 'write') return replaceSnapshot(operation.path, operation.after);
    if (operation.kind === 'copy') return fs.promises.copyFile(operation.from, operation.to, fs.constants.COPYFILE_EXCL);
    return fs.promises.rename(operation.from, operation.to);
  }

  async function applyReverse(operation) {
    if (operation.kind === 'write') return replaceSnapshot(operation.path, operation.before);
    if (operation.kind === 'copy') return fs.promises.rm(operation.to, { recursive: true, force: false });
    return fs.promises.rename(operation.to, operation.from);
  }

  async function transact(operations, direction) {
    const ordered = direction === 'forward' ? operations : [...operations].reverse();
    const applied = [];
    try {
      for (const operation of ordered) {
        if (direction === 'forward') {
          await checkForward(operation);
          await applyForward(operation);
        } else {
          await checkReverse(operation);
          await applyReverse(operation);
        }
        applied.push(operation);
      }
    } catch (error) {
      try {
        for (const operation of [...applied].reverse()) {
          if (direction === 'forward') await applyReverse(operation); else await applyForward(operation);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'history action and rollback both failed');
      }
      throw error;
    }
  }

  async function saveApplied(label, operations) {
    const entry = { id: randomUUID(), label: String(label || 'file action'), timestamp: new Date().toISOString(), operations };
    const next = { undo: [...state.undo, entry], redo: [] };
    try {
      await persist(next);
    } catch (error) {
      await transact(operations, 'reverse');
      const failure = new Error(`history journal failed; action was reversed: ${error.message}`, { cause: error });
      failure.historyReversed = true;
      throw failure;
    }
    state = next;
    return result(true, entry.label);
  }

  async function execute(label, rawOperations) {
    let operations = rawOperations.map(normalizeOperation);
    if (!operations.length) return result(false);
    operations = await addCopyDigests(operations, 'from');
    await transact(operations, 'forward');
    return saveApplied(label, operations);
  }

  async function perform(label, rawOperations) {
    return execute(label, rawOperations);
  }

  async function recordApplied(label, rawOperations) {
    let operations = rawOperations.map(normalizeOperation);
    if (!operations.length) return result(false);
    operations = await addCopyDigests(operations, 'to');
    for (const operation of operations) await checkApplied(operation);
    return saveApplied(label, operations);
  }

  async function recordTransaction(makeAction) {
    let action;
    try {
      action = await makeAction();
      if (!action || !Array.isArray(action.operations)) throw new Error('transaction must return history operations');
      const recorded = await recordApplied(action.label, action.operations);
      return { ...recorded, ...(action.value || {}) };
    } catch (error) {
      if (!error.historyReversed && typeof action?.rollback === 'function') {
        try { await action.rollback(); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'transaction and rollback both failed'); }
      }
      throw error;
    }
  }

  async function deletePaths(values, label = 'delete files') {
    const unique = [...new Set(values.map(assertAllowed))]
      .sort((a, b) => a.length - b.length)
      .filter((value, index, rows) => !rows.slice(0, index).some((parent) => value.startsWith(parent + path.sep)));
    if (!unique.length) return result(false);
    for (const value of unique) if (!await exists(value)) throw new Error(`path no longer exists: ${value}`);
    const actionId = randomUUID();
    const operations = unique.map((from, index) => {
      const actionDir = path.join(assertAllowed(trashForPath(from)), actionId);
      return { kind: 'move', from, to: path.join(actionDir, `${index}-${path.basename(from)}`) };
    });
    await Promise.all([...new Set(operations.map((operation) => path.dirname(operation.to)))]
      .map((dir) => fs.promises.mkdir(dir, { recursive: true })));
    return execute(label, operations);
  }

  async function renamePath(from, to, label = 'rename file') {
    return execute(label, [{ kind: 'move', from, to }]);
  }

  async function writeText(file, text, label = 'edit file') {
    const target = assertAllowed(file);
    const before = await readText(target);
    const after = String(text);
    if (before === after) return result(false);
    return execute(label, [{ kind: 'write', path: target, before, after }]);
  }

  async function undo() {
    const entry = state.undo.at(-1);
    if (!entry) return result(false);
    if (!Array.isArray(entry.operations)) throw new Error('history entry has invalid operations');
    const operations = requireCopyDigests(entry.operations.map(normalizeOperation));
    await transact(operations, 'reverse');
    const next = { undo: state.undo.slice(0, -1), redo: [...state.redo, entry] };
    try {
      await persist(next);
    } catch (error) {
      await transact(operations, 'forward');
      throw new Error(`history journal failed; undo was reversed: ${error.message}`, { cause: error });
    }
    state = next;
    return result(true, entry.label);
  }

  async function redo() {
    const entry = state.redo.at(-1);
    if (!entry) return result(false);
    if (!Array.isArray(entry.operations)) throw new Error('history entry has invalid operations');
    const operations = requireCopyDigests(entry.operations.map(normalizeOperation));
    await transact(operations, 'forward');
    const next = { undo: [...state.undo, entry], redo: state.redo.slice(0, -1) };
    try {
      await persist(next);
    } catch (error) {
      await transact(operations, 'reverse');
      throw new Error(`history journal failed; redo was reversed: ${error.message}`, { cause: error });
    }
    state = next;
    return result(true, entry.label);
  }

  let queue = Promise.resolve();
  const serialize = (operation) => {
    const pending = queue.then(operation, operation);
    queue = pending.catch(() => {});
    return pending;
  };

  return {
    perform: (...args) => serialize(() => perform(...args)),
    recordApplied: (...args) => serialize(() => recordApplied(...args)),
    recordTransaction: (makeAction) => serialize(() => recordTransaction(makeAction)),
    deletePaths: (...args) => serialize(() => deletePaths(...args)),
    renamePath: (...args) => serialize(() => renamePath(...args)),
    writeText: (...args) => serialize(() => writeText(...args)),
    undo: () => serialize(undo),
    redo: () => serialize(redo),
    status,
  };
}

function loadJournal(journalPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (!Array.isArray(parsed.undo) || !Array.isArray(parsed.redo)) throw new Error('history journal has an invalid shape');
    return { undo: parsed.undo, redo: parsed.redo };
  } catch (error) {
    if (error.code === 'ENOENT') return { undo: [], redo: [] };
    throw error;
  }
}

module.exports = { createFileHistory };

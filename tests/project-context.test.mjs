// PiTech by Haxnstuff
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as projects from '../pi/scripts/projects.mjs';

test('reserves project command aliases and does not duplicate them in completions', () => {
  assert.equal(projects.isReservedProjectName?.('OFF'), true);
  assert.equal(projects.isReservedProjectName?.('none'), true);
  const items = projects.projectCompletionItems?.([
    { name: 'off', sessions: [] },
    { name: 'none', sessions: [] },
    { name: 'Other', sessions: [] },
  ], '', true);

  assert.deepEqual(items, [
    { value: 'off', label: 'off', description: 'Leave the active project' },
    { value: 'Other', label: 'Other', description: '0 sessions' },
  ]);
});

test('returns pi-compatible project completion items', () => {
  const items = projects.projectCompletionItems?.([
    { name: 'PiTech', sessions: [{}, {}] },
    { name: 'Other', sessions: [] },
  ], 'pi', true);

  assert.deepEqual(items, [{ value: 'PiTech', label: 'PiTech', description: '2 sessions' }]);
});

test('excludes the current session copy from project context', () => {
  const sessions = projects.otherProjectSessions?.([
    { file: 'current.jsonl' },
    { file: 'other.jsonl' },
  ], 'C:\\sessions\\current.jsonl');

  assert.deepEqual(sessions, [{ file: 'other.jsonl' }]);
});

test('formats compaction-aware project history without tool output', () => {
  const context = projects.formatProjectContext?.('Apollo', [
    {
      file: 'auth.jsonl',
      title: 'Authentication',
      messages: [
        { role: 'compactionSummary', summary: 'Earlier work chose SQLite.' },
        { role: 'user', content: 'Which auth approach should we use?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Use OAuth with PKCE.' },
            { type: 'toolCall', name: 'bash', arguments: {} },
          ],
        },
        { role: 'toolResult', content: [{ type: 'text', text: 'secret tool output' }] },
      ],
    },
    {
      file: 'ui.jsonl',
      title: 'Dashboard UI',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep the dashboard dark.' }] }],
    },
  ], { maxChars: 4000, perSessionChars: 1000 });

  assert.ok(context, 'formatProjectContext must return project history');
  assert.match(context, /Active project: Apollo/);
  assert.match(context, /Authentication/);
  assert.match(context, /Dashboard UI/);
  assert.match(context, /Summary: Earlier work chose SQLite\./);
  assert.match(context, /User: Which auth approach should we use\?/);
  assert.match(context, /Assistant: Use OAuth with PKCE\./);
  assert.match(context, /User: Keep the dashboard dark\./);
  assert.doesNotMatch(context, /secret tool output/);
});

test('keeps the complete session index while bounding detailed excerpts', () => {
  const context = projects.formatProjectContext?.('Apollo', [
    { file: 'one.jsonl', title: 'Session One', messages: [{ role: 'user', content: 'A'.repeat(1200) }] },
    { file: 'two.jsonl', title: 'Session Two', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'B'.repeat(1200) }] }] },
  ], { maxChars: 900, perSessionChars: 600 });

  assert.ok(context, 'formatProjectContext must return project history');
  assert.ok(Buffer.byteLength(context, 'utf8') <= 900, `context exceeded limit: ${Buffer.byteLength(context, 'utf8')} bytes`);
  assert.match(context, /Session One/);
  assert.match(context, /Session Two/);
  assert.match(context, /truncated/i);
});

test('bounds Unicode-heavy project context by UTF-8 bytes', () => {
  const context = projects.formatProjectContext?.('Apollo', [
    { file: 'unicode.jsonl', title: 'Unicode', messages: [{ role: 'user', content: '🚀'.repeat(1200) }] },
  ], { maxBytes: 900, perSessionBytes: 600 });

  assert.ok(context, 'formatProjectContext must return project history');
  assert.ok(Buffer.byteLength(context, 'utf8') <= 900, `context exceeded limit: ${Buffer.byteLength(context, 'utf8')} bytes`);
  assert.doesNotMatch(context, /�/);
  assert.match(context, /truncated/i);
});

test('failed project manifest append removes the copied session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-project-copy-'));
  const source = path.join(home, 'source.jsonl');
  fs.writeFileSync(source, '{"session":true}\n');
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'pi', 'scripts', 'projects.mjs')).href;
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    const projects = await import(${JSON.stringify(moduleUrl)});
    const project = await projects.newProject('Rollback');
    await fs.promises.rm(project.manifest, { force: true });
    await fs.promises.mkdir(project.manifest);
    let failed = false;
    try { await projects.addSessionToProject('Rollback', ${JSON.stringify(source)}); }
    catch { failed = true; }
    const destination = path.join(project.dir, 'sessions', path.basename(${JSON.stringify(source)}));
    if (!failed || fs.existsSync(destination)) process.exit(1);
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || 'copy rollback subprocess failed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

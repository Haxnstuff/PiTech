// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { migrateSessions } = require('../conversation-store');

const sessionLine = (id, cwd, parentSession) => JSON.stringify({
  type: 'session',
  id,
  cwd,
  ...(parentSession ? { parentSession } : {}),
  timestamp: '2026-08-28T12:00:00.000Z',
});

async function allJsonl(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.jsonl')) out.push(file);
    }
  }
  await walk(dir);
  return out.sort();
}

test('migrates every cwd session into one flat conversations folder and repairs fork links', async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pitech-conversations-'));
  const sessions = path.join(base, 'sessions');
  const conversations = path.join(base, 'conversations');
  const first = path.join(sessions, 'cwd-one', '2026-08-28T12-00-00-000Z_one.jsonl');
  const child = path.join(sessions, 'cwd-two', 'agent', 'run-0', 'session.jsonl');
  const sibling = path.join(sessions, 'cwd-three', 'agent', 'run-0', 'session.jsonl');
  await fs.promises.mkdir(path.dirname(first), { recursive: true });
  await fs.promises.mkdir(path.dirname(child), { recursive: true });
  await fs.promises.mkdir(path.dirname(sibling), { recursive: true });
  await fs.promises.writeFile(first, `${sessionLine('one', 'C:\\\\one')}\n{"message":"keep me"}\n`);
  await fs.promises.writeFile(child, `${sessionLine('two', 'C:\\\\two', first)}\n{"message":"child"}\n`);
  await fs.promises.writeFile(sibling, `${sessionLine('three', 'C:\\\\three', first)}\n{"message":"sibling"}\n`);

  const result = await migrateSessions(sessions, conversations);
  const files = await allJsonl(conversations);
  assert.equal(result.moved.length, 3);
  assert.equal(files.length, 3);
  assert.equal(new Set(files.map((file) => path.basename(file))).size, 3, 'flat destination names must not collide');
  assert.equal((await allJsonl(sessions)).length, 0, 'old cwd folders must no longer contain sessions');

  const firstDestination = result.moved.find((item) => item.source === path.normalize(first)).destination;
  const childDestination = result.moved.find((item) => item.source === path.normalize(child)).destination;
  const childHeader = JSON.parse((await fs.promises.readFile(childDestination, 'utf8')).split('\n')[0]);
  assert.equal(childHeader.cwd, 'C:\\\\two');
  assert.equal(childHeader.parentSession, firstDestination, 'fork metadata must point at the moved parent');
  assert.match(await fs.promises.readFile(childDestination, 'utf8'), /\{"message":"child"\}/);

  const again = await migrateSessions(sessions, conversations);
  assert.equal(again.moved.length, 0, 'migration must be idempotent');
  assert.equal((await allJsonl(conversations)).length, 3);
  await fs.promises.rm(base, { recursive: true, force: true });
});

// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('server wires reversible file mutations and history endpoints', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/file-history'\)/);
  assert.match(server, /urlPath === '\/api\/history\/undo'/);
  assert.match(server, /urlPath === '\/api\/history\/redo'/);
  assert.match(server, /urlPath === '\/api\/fs\/delete-batch'/);
  assert.match(server, /history\.deletePaths\(/);
  assert.match(server, /history\.renamePath\(|history\.recordTransaction\(/);
  assert.match(server, /history\.writeText\(/);
  assert.match(server, /require\('\.\/safe-path'\)/);
  assert.match(server, /function reversibleUserPathAllowed/);
  assert.match(server, /function historyTrashForPath/);
  assert.match(server, /insideRoot\(root, trash\)/);
  assert.match(server, /if \(!files\.length\)/);
  assert.match(server, /copyFile\(file,[\s\S]*copies\.push\([\s\S]*appendFile\(\s*manifest/);
  assert.match(server, /manifestAfter !== manifestBefore/);
  assert.match(server, /unique\.every\(reversibleUserPathAllowed\)/);
  assert.match(server, /isAllowedFile\(roots, p\).*reversibleUserPathAllowed\(p\)/s);
});

test('project session copies refuse overwrite and become reversible', () => {
  const projects = read('pi/scripts/projects.mjs');
  const server = read('server.js');
  assert.match(projects, /COPYFILE_EXCL/);
  assert.doesNotMatch(projects, /fs\.rm\(dst[\s\S]*?\.catch\(/);
  assert.match(server, /copy \$\{copies\.length\} session/);
  assert.match(server, /history\.recordTransaction/);
  assert.match(server, /kind: 'copy'/);
  assert.match(server, /project\.md|manifest/);
});

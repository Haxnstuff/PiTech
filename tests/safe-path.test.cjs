// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalPath, isWithinRealRoot, samePath } = require('../safe-path');

test('canonical path guards reject junction and symlink escapes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pitech-safe-path-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(isWithinRealRoot(root, link), false, 'a trash-root junction must not count as private storage');
    assert.equal(isWithinRealRoot(root, path.join(link, 'secret.txt')), false);
    assert.equal(isWithinRealRoot(root, path.join(root, 'future', 'file.txt')), true);
    assert.equal(isWithinRealRoot(root, root), false);
    assert.equal(isWithinRealRoot(root, root, true), true);
    assert.equal(samePath(canonicalPath(root), root), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

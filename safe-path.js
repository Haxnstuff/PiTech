// PiTech by Haxnstuff
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalPath(value) {
  let current = path.resolve(String(value || ''));
  const suffix = [];
  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function samePath(left, right) {
  try { return pathKey(canonicalPath(left)) === pathKey(canonicalPath(right)); }
  catch { return false; }
}

function isWithinRealRoot(root, target, allowRoot = false) {
  try {
    const relative = path.relative(canonicalPath(root), canonicalPath(target));
    return allowRoot && !relative
      || Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

module.exports = { canonicalPath, isWithinRealRoot, pathKey, samePath };

// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.name, 'pitech');
assert.equal(pkg.author, 'Haxnstuff');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository?.url, 'https://github.com/Haxnstuff/PiTech.git');
assert.equal(pkg.scripts?.test, 'node tests/release.test.cjs');

const ignored = read('.gitignore');
for (const entry of ['node_modules/', 'config.json', 'server.log', 'public/vendor/', 'chrome-test-profile/']) {
  assert.match(ignored, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `.gitignore must contain ${entry}`);
}

const setup = read('setup.js');
assert.match(setup, /pi[\\/',\s]+extensions[\\/',\s]+pi-webui\.ts/s);
assert.match(setup, /pi[\\/',\s]+scripts[\\/',\s]+projects\.mjs/s);
assert.match(setup, /agentDir\s*=\s*path\.join\(os\.homedir\(\), '\.pi', 'agent'\)/);
assert.match(setup, /path\.join\(agentDir, 'extensions', 'pi-webui\.ts'\)/);

const readme = read('README.md');
assert.match(readme, /git clone https:\/\/github\.com\/Haxnstuff\/PiTech\.git/);
assert.match(readme, /npm run setup/);
assert.match(readme, /Haxnstuff/);
assert.match(read('LICENSE'), /Copyright \(c\) 2026 Haxnstuff/);

const css = read('public/style.css');
assert.match(css, /input\[type="checkbox"\]\s*{[^}]*appearance:\s*none/s);
assert.match(css, /input\[type="checkbox"\]:checked::after\s*{[^}]*var\(--bg\)/s);
assert.match(css, /\.custom-colors input\[type="color"\]\s*{[^}]*color-scheme:\s*dark/s);
assert.match(css, /::-webkit-color-swatch-wrapper/);

for (const file of [
  'server.js',
  'setup.js',
  'start-hidden.vbs',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'pi/extensions/pi-webui.ts',
  'pi/scripts/projects.mjs',
]) {
  const head = read(file).split(/\r?\n/).slice(0, 5).join('\n');
  assert.match(head, /Haxnstuff/, `${file} must be signed by Haxnstuff`);
}

console.log('PiTech release checks passed');

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
assert.equal(pkg.version, '1.1.2');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository?.url, 'https://github.com/Haxnstuff/PiTech.git');
assert.equal(pkg.scripts?.test, 'node --test tests/clipboard.test.cjs tests/project-context.test.mjs && node tests/release.test.cjs');
assert.equal(pkg.scripts?.['test:browser'], 'node tests/clipboard-browser.cjs');

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

const html = read('public/index.html');
assert.match(html, /<h4>Glow<\/h4>/);
for (const id of ['glow-blur', 'glow-density', 'glow-pop', 'glow-color']) {
  assert.match(html, new RegExp(`id="${id}"`), `settings must expose ${id}`);
}
assert.match(html, /id="glow-blur"[^>]*type="range"[^>]*min="0"[^>]*max="24"/);
assert.match(html, /id="glow-density"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
assert.match(html, /id="glow-pop"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);

const app = read('public/app.js');
assert.match(app, /const GLOW_KEY = 'pi-glow'/);
assert.match(app, /setProperty\('--glow-color'/);
assert.match(app, /setProperty\('--glow-pop-alpha'/);
assert.match(app, /glow-blur.*addEventListener\('input'/s);

const css = read('public/style.css');
assert.match(css, /--glow-color:/);
assert.match(css, /--glow-blur:/);
assert.match(css, /\.custom-colors\.hidden\s*{[^}]*display:\s*none/s);
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
  'public/clipboard.js',
  'public/style.css',
  'pi/extensions/pi-webui.ts',
  'pi/scripts/projects.mjs',
]) {
  const head = read(file).split(/\r?\n/).slice(0, 5).join('\n');
  assert.match(head, /Haxnstuff/, `${file} must be signed by Haxnstuff`);
}

console.log('PiTech release checks passed');

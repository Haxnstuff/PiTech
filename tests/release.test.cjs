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
assert.equal(pkg.scripts?.test, 'node --test tests/clipboard.test.cjs tests/conversations.test.cjs tests/conversation-organizer.test.cjs tests/path-notes.test.cjs tests/file-tree.test.cjs tests/project-context.test.mjs && node tests/release.test.cjs');
assert.equal(pkg.scripts?.['test:browser'], 'node tests/clipboard-browser.cjs && node tests/notepad-browser.cjs && node tests/conversation-api.test.cjs && node tests/fixes-browser.cjs');

const ignored = read('.gitignore');
for (const entry of ['node_modules/', 'config.json', 'server.log', 'public/vendor/', 'chrome-test-profile/']) {
  assert.match(ignored, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `.gitignore must contain ${entry}`);
}

const setup = read('setup.js');
assert.match(setup, /pi[\\/',\s]+extensions[\\/',\s]+pi-webui\.ts/s);
assert.match(setup, /pi[\\/',\s]+scripts[\\/',\s]+projects\.mjs/s);
assert.match(setup, /agentDir\s*=\s*path\.join\(os\.homedir\(\), '\.pi', 'agent'\)/);
assert.match(setup, /path\.join\(agentDir, 'extensions', 'pi-webui\.ts'\)/);
assert.match(setup, /path\.join\(agentDir, 'scripts', 'path-notes\.js'\)/);
assert.doesNotMatch(setup, /path\.join\(agentDir, 'extensions', 'path-notes\.js'\)/);

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
for (const id of ['notepad-btn', 'notepad-panel', 'notepad-head', 'notepad-tab-list', 'notepad-textarea', 'notepad-new-tab', 'notepad-rename', 'notepad-resize', 'file-root-select']) {
  assert.match(html, new RegExp(`id="${id}"`), `notepad must expose ${id}`);
}
assert.match(html, /id="new-project-btn"[\s\S]*id="notepad-btn"/);
assert.match(html, /id="new-session"[\s\S]*id="skills-btn"[\s\S]*id="mcp-btn"/);
for (const id of ['skills-panel', 'skills-head', 'skills-close', 'skills-resize', 'file-tree', 'file-root-name', 'file-root-select']) {
  assert.match(html, new RegExp(`id="${id}"`), `file tree and Skills panel must expose ${id}`);
}
assert.match(html, /id="sidebar-right"[\s\S]*id="file-tree"/);
assert.doesNotMatch(html.match(/<aside id="sidebar-right"[\s\S]*?<\/aside>/)?.[0] || '', /id="skills-list"/);
assert.match(html, /used in current prompt/);
assert.match(html, /data-ctx="convhead"/);
assert.match(html, /right-click to organize/);
assert.match(html, /id="glow-blur"[^>]*type="range"[^>]*min="0"[^>]*max="24"/);
assert.match(html, /id="glow-density"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
assert.match(html, /id="glow-pop"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);

const app = read('public/app.js');
assert.match(app, /const KNOWN_PROVIDERS = \[[\s\S]*['"]openrouter['"]/);
assert.match(app, /const GLOW_KEY = 'pi-glow'/);
assert.match(app, /setProperty\('--glow-color'/);
assert.match(app, /setProperty\('--glow-pop-alpha'/);
assert.match(app, /glow-blur.*addEventListener\('input'/s);
assert.match(app, /const NOTEPAD_KEY = 'pi-notepads'/);
assert.match(app, /makePanelMoveable\(notepadPanel, 'notepad-head', 'notepad-resize', 'pi-notepad-panel'\)/);
assert.match(app, /notepadTextarea\.addEventListener\('input'/);
assert.match(app, /tab\.dataset\.ctx = 'notepad-tab'/);
assert.match(app, /label: 'Rename Tab'/);
assert.match(app, /label: 'Delete Tab'/);
assert.match(app, /function deleteNotepad/);
assert.match(app, /notepadState\.activeId/);
assert.match(app, /function openSkills/);
assert.match(app, /function renderFileTree/);
assert.match(app, /fileRoots/);
assert.match(app, /encodeURIComponent\(treeRootId/);
assert.match(app, /function updateTreeActivity/);
assert.match(app, /const openTreeDirs = new Set\(\)/);
assert.match(app, /openTreeDirs\.add/);
assert.match(app, /conversationFolders/);
assert.match(app, /api\/conversations\/organize/);
assert.match(app, /Move to folder/);
assert.match(app, /Rename conversation/);

const extension = read('pi/extensions/pi-webui.ts');
assert.match(extension, /PI_SUBAGENT_DEPTH/);
assert.match(extension, /tool_execution_start/);
assert.match(extension, /read.*event\.toolName/s);
assert.match(extension, /pi\.on\("input"/);
assert.match(extension, /skillFiles/);
assert.match(extension, /PITECH_STATE_FILE/);
assert.match(extension, /\.\.\/scripts\/path-notes\.js/);
assert.match(extension, /extractPaths/);
assert.match(extension, /appendPaths/);
assert.match(extension, /event\.prompt/);
assert.match(extension, /webui-editing-/);

const server = read('server.js');
assert.match(server, /CONVERSATIONS_DIR/);
assert.match(server, /PI_CODING_AGENT_SESSION_DIR/);
assert.match(server, /urlPath === '\/api\/tree'/);
assert.match(server, /urlPath === '\/api\/conversations\/organize'/);
assert.match(server, /ensurePathNotes/);
assert.match(server, /terminalInput/);
assert.match(server, /aggregateEditing/);

const css = read('public/style.css');
assert.match(css, /--glow-color:/);
assert.match(css, /--glow-blur:/);
assert.match(css, /\.custom-colors\.hidden\s*{[^}]*display:\s*none/s);
assert.match(css, /input\[type="checkbox"\]\s*{[^}]*appearance:\s*none/s);
assert.match(css, /input\[type="checkbox"\]:checked::after\s*{[^}]*var\(--bg\)/s);
assert.match(css, /\.custom-colors input\[type="color"\]\s*{[^}]*color-scheme:\s*dark/s);
assert.match(css, /::-webkit-color-swatch-wrapper/);
assert.match(css, /\.notepad-panel\s*{[^}]*background:\s*var\(--panel\)/s);
assert.match(css, /\.notepad-textarea\s*{[^}]*background:\s*var\(--term-bg\)/s);
assert.match(css, /\.file-head \.form-select\s*{[^}]*color-scheme:\s*dark/s);
assert.match(css, /\.conv-folder\.drag-over/);

for (const file of [
  'server.js',
  'file-tree.js',
  'conversation-store.js',
  'conversation-meta.js',
  'setup.js',
  'start-hidden.vbs',
  'public/index.html',
  'public/app.js',
  'public/clipboard.js',
  'public/style.css',
  'tests/notepad-browser.cjs',
  'tests/conversation-api.test.cjs',
  'tests/conversation-organizer.test.cjs',
  'tests/path-notes.test.cjs',
  'tests/fixes-browser.cjs',
  'tests/conversations.test.cjs',
  'pi/extensions/pi-webui.ts',
  'pi/scripts/path-notes.js',
  'pi/scripts/projects.mjs',
]) {
  const head = read(file).split(/\r?\n/).slice(0, 5).join('\n');
  assert.match(head, /Haxnstuff/, `${file} must be signed by Haxnstuff`);
}

console.log('PiTech release checks passed');

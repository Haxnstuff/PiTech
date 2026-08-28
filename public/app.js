/* PiTech by Haxnstuff — xterm.js + WebSocket bridge + workspace sidebars */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const dotEl = $('dot');
  const wrap = $('term-wrap');
  const toastEl = $('toast');
  const leftSide = $('sidebar-left');
  const rightSide = $('sidebar-right');
  const ctxList = $('ctx-list');
  const projList = $('projects-list');
  const convList = $('conv-list');
  const fileTree = $('file-tree');
  const fileRootSelect = $('file-root-select');
  const fileRootName = $('file-root-name');
  const skillsPanel = $('skills-panel');
  const skillsList = $('skills-list');
  const skillCount = $('skill-count');
  const skillSearch = $('skill-search');
  const skillFilter = $('skill-filter');
  const mcpPanel = $('mcp-panel');
  const mcpList = $('mcp-list');
  const npModal = $('np-modal');
  const npInput = $('np-input');
  const notepadPanel = $('notepad-panel');
  const notepadTabList = $('notepad-tab-list');
  const notepadTextarea = $('notepad-textarea');
  const clipboard = PiTechClipboard.createClipboard({
    readText: () => navigator.clipboard?.readText
      ? navigator.clipboard.readText()
      : Promise.reject(new Error('clipboard unavailable')),
    writeText: (text) => navigator.clipboard?.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('clipboard unavailable')),
  });

  let ws = null;
  let retryTimer = null;
  let ptyAlive = true;
  let state = null;
  let lastSig = '';
  let hashHandled = false;
  const APP_VERSION = 13;
  function showVersionBanner() {
    const b = $('version-banner');
    if (!b || !b.classList.contains('hidden')) return;
    b.classList.remove('hidden');
    $('version-reload').addEventListener('click', () => window.location.reload());
  }
  let lastUpdateClick = null;
  const openGroups = new Set();
  const openProjects = new Set();
  const openSkillGroups = new Set();
  const openTreeDirs = new Set();
  let skillQuery = '';
  let skillActiveOnly = false;
  let treeRoot = null;
  let treeRootId = null;
  let selectedFileRoot = null;
  const selectedKeys = new Set();
  let selectedKind = null;
  let selectionAnchor = null;
  let nativeSpellcheckTarget = null;

  const NOTEPAD_KEY = 'pi-notepads';
  let notepadSaveWarned = false;
  function createNotepadId() {
    return globalThis.crypto?.randomUUID?.() || `note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function loadNotepadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(NOTEPAD_KEY) || 'null'); } catch {}
    const notes = [];
    const ids = new Set();
    for (const raw of Array.isArray(saved?.notes) ? saved.notes : []) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || '').trim();
      if (!id || ids.has(id)) continue;
      notes.push({
        id,
        title: String(raw.title || '').trim() || `Note ${notes.length + 1}`,
        content: typeof raw.content === 'string' ? raw.content : '',
      });
      ids.add(id);
    }
    if (!notes.length) notes.push({ id: 'note-1', title: 'Note 1', content: '' });
    const activeId = notes.some((note) => note.id === saved?.activeId) ? saved.activeId : notes[0].id;
    return { activeId, notes };
  }
  let notepadState = loadNotepadState();
  function saveNotepadState() {
    try {
      localStorage.setItem(NOTEPAD_KEY, JSON.stringify(notepadState));
    } catch {
      if (!notepadSaveWarned) {
        notepadSaveWarned = true;
        showToast('Notepad could not be saved locally');
      }
    }
  }

  // ---------------- terminal ----------------
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.3,
    scrollback: 5000,
    theme: {
      background: '#0a0a0b',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      cursorAccent: '#0a0a0b',
      selectionBackground: 'rgba(167, 139, 250, 0.28)',
      black: '#18181b', red: '#f87171', green: '#4ade80', yellow: '#facc15',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7',
      brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#fafafa',
    },
  });
  window.__term = term; // debug handle
  const host = $('term-host');
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // fit + safety margins so the last row AND last column are never clipped.
  // The fit addon measures the parent's border-box, so the terminal lives in
  // a padding-free host; the safety pass catches any residual rounding.
  function fitTerm() {
    try { fit.fit(); } catch {}
    const d = term._core?._renderService?.dimensions;
    if (!d || !d.css || !d.css.cellHeight || !d.css.cellWidth) return;
    const availH = host.clientHeight;
    const availW = host.clientWidth;
    let cols = term.cols, rows = term.rows;
    if (d.css.height > availH + 1) rows = Math.max(4, Math.floor((availH - 2) / d.css.cellHeight));
    if (d.css.width > availW + 1) cols = Math.max(10, Math.floor((availW - 2) / d.css.cellWidth));
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  }
  new ResizeObserver(() => { fitTerm(); sendSize(); }).observe(wrap);
  fitTerm();
  if (document.fonts?.ready) document.fonts.ready.then(() => { fitTerm(); sendSize(); });

  // ---------------- themes / palettes ----------------
  const THEMES = {
    slate: {
      label: 'Slate',
      vars: { '--bg': '#09090b', '--panel': '#0c0c0d', '--term-bg': '#0a0a0b', '--border': '#232326', '--border-hi': '#333338', '--text': '#e4e4e7', '--dim': '#8b8b94', '--accent': '#a78bfa', '--ok': '#4ade80', '--warn': '#facc15', '--err': '#f87171', '--logo-a': '#b794f6', '--logo-b': '#818cf8' },
      xterm: { background: '#0a0a0b', foreground: '#e4e4e7', cursor: '#e4e4e7', cursorAccent: '#0a0a0b', selectionBackground: 'rgba(167,139,250,0.28)', black: '#18181b', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e4e4e7', brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa' },
    },
    mocha: {
      label: 'Catppuccin Mocha',
      vars: { '--bg': '#11111b', '--panel': '#181825', '--term-bg': '#1e1e2e', '--border': '#313244', '--border-hi': '#45475a', '--text': '#cdd6f4', '--dim': '#a6adc8', '--accent': '#89b4fa', '--ok': '#a6e3a1', '--warn': '#f9e2af', '--err': '#f38ba8', '--logo-a': '#89b4fa', '--logo-b': '#cba6f7' },
      xterm: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: 'rgba(137,180,250,0.3)', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#cdd6f4', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#cdd6f4' },
    },
    nord: {
      label: 'Nord',
      vars: { '--bg': '#2e3440', '--panel': '#272c36', '--term-bg': '#2e3440', '--border': '#3b4252', '--border-hi': '#434c5e', '--text': '#d8dee9', '--dim': '#81a1c1', '--accent': '#88c0d0', '--ok': '#a3be8c', '--warn': '#ebcb8b', '--err': '#bf616a', '--logo-a': '#88c0d0', '--logo-b': '#b48ead' },
      xterm: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: 'rgba(136,192,208,0.3)', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
    },
    tokyo: {
      label: 'Tokyo Night',
      vars: { '--bg': '#1a1b26', '--panel': '#16161e', '--term-bg': '#1a1b26', '--border': '#24283b', '--border-hi': '#33467c', '--text': '#c0caf5', '--dim': '#565f89', '--accent': '#7aa2f7', '--ok': '#9ece6a', '--warn': '#e0af68', '--err': '#f7768e', '--logo-a': '#7aa2f7', '--logo-b': '#bb9af7' },
      xterm: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: 'rgba(122,162,247,0.3)', black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5', brightBlack: '#565f89', brightRed: '#ff7a93', brightGreen: '#b9f27c', brightYellow: '#ff9e64', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#a9b1d6' },
    },
    dracula: {
      label: 'Dracula',
      vars: { '--bg': '#282a36', '--panel': '#21222c', '--term-bg': '#282a36', '--border': '#3b3d4f', '--border-hi': '#4d4f68', '--text': '#f8f8f2', '--dim': '#6272a4', '--accent': '#bd93f9', '--ok': '#50fa7b', '--warn': '#f1fa8c', '--err': '#ff5555', '--logo-a': '#bd93f9', '--logo-b': '#6272a4' },
      xterm: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(189,147,249,0.3)', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
    },
    cyberpunk: {
      label: 'Cyberpunk',
      font: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      vars: { '--bg': '#0a0a0a', '--panel': '#111111', '--term-bg': '#0a0a0a', '--border': '#333320', '--border-hi': '#4d4d26', '--text': '#f2f2e6', '--dim': '#8f8f7a', '--accent': '#fcee0a', '--ok': '#00ff9f', '--warn': '#ffb300', '--err': '#ff003c', '--logo-a': '#fcee0a', '--logo-b': '#ff003c' },
      xterm: { background: '#0a0a0a', foreground: '#f2f2e6', cursor: '#fcee0a', cursorAccent: '#0a0a0a', selectionBackground: 'rgba(252,238,10,0.25)', black: '#1c1c1c', red: '#ff003c', green: '#00ff9f', yellow: '#fcee0a', blue: '#00e5ff', magenta: '#ff2a6d', cyan: '#00e5ff', white: '#f2f2e6', brightBlack: '#3d3d3d', brightRed: '#ff5c85', brightGreen: '#66ffc2', brightYellow: '#fff56b', brightBlue: '#66f0ff', brightMagenta: '#ff7ab8', brightCyan: '#7df9ff', brightWhite: '#ffffff' },
    },
    torntech: {
      label: 'TornTech',
      font: '"Share Tech Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
      vars: { '--bg': '#0d0d0d', '--panel': '#141414', '--term-bg': '#0d0d0d', '--border': '#2a2a2a', '--border-hi': '#3c3c3c', '--text': '#d0d0d0', '--dim': '#888888', '--accent': '#ff9900', '--ok': '#00cc66', '--warn': '#ffcc00', '--err': '#ff3333', '--logo-a': '#ff9900', '--logo-b': '#ffa826' },
      xterm: { background: '#0d0d0d', foreground: '#d0d0d0', cursor: '#ff9900', cursorAccent: '#0d0d0d', selectionBackground: 'rgba(255,153,0,0.3)', black: '#141414', red: '#ff3333', green: '#00cc66', yellow: '#ffcc00', blue: '#5bb2ff', magenta: '#ff9900', cyan: '#5bb2ff', white: '#ffffff', brightBlack: '#555555', brightRed: '#ff6666', brightGreen: '#33ff99', brightYellow: '#ffe066', brightBlue: '#88ccff', brightMagenta: '#ffa826', brightCyan: '#88ddff', brightWhite: '#ffffff' },
    },
  };
  const DEFAULT_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';
  const CUSTOM_KEY = 'pi-theme-custom';
  const GLOW_KEY = 'pi-glow';
  const DEFAULT_GLOW = { blur: 8, density: 55, pop: 65, color: null };
  let glowSettings = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(GLOW_KEY) || 'null');
      return { ...DEFAULT_GLOW, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch { return { ...DEFAULT_GLOW }; }
  })();
  const clampGlow = (value, fallback, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : fallback;
  };
  const validHex = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : null;
  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  function applyGlow(fallbackColor) {
    const blur = clampGlow(glowSettings.blur, DEFAULT_GLOW.blur, 24);
    const density = clampGlow(glowSettings.density, DEFAULT_GLOW.density, 100) / 100;
    const pop = clampGlow(glowSettings.pop, DEFAULT_GLOW.pop, 100) / 100;
    const color = validHex(glowSettings.color) || validHex(fallbackColor) || '#a78bfa';
    const rgb = hexRgb(color) || '167, 139, 250';
    const root = document.documentElement;
    root.style.setProperty('--glow-color', color);
    root.style.setProperty('--glow-rgb', rgb);
    root.style.setProperty('--glow-blur', `${blur}px`);
    root.style.setProperty('--glow-density', String(density));
    root.style.setProperty('--glow-pop', String(pop));
    root.style.setProperty('--glow-alpha', (density * 0.45).toFixed(3));
    root.style.setProperty('--glow-pop-blur', `${Math.round(blur * (0.35 + pop * 0.65))}px`);
    root.style.setProperty('--glow-pop-alpha', (density * pop * 0.75).toFixed(3));
  }
  let customVars = (() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null'); } catch { return null; }
  })() || { ...THEMES.slate.vars };
  let currentTheme = localStorage.getItem('pi-theme') || 'slate';
  if (!THEMES[currentTheme] && currentTheme !== 'custom') currentTheme = 'slate';

  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function applyTheme(name) {
    if (!THEMES[name] && name !== 'custom') name = 'slate';
    currentTheme = name;
    document.documentElement.dataset.theme = name;
    const vars = name === 'custom' ? customVars : THEMES[name].vars;
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    applyGlow(vars['--accent']);
    term.options.fontFamily = name === 'custom' ? DEFAULT_FONT : (THEMES[name].font || DEFAULT_FONT);
    const pal = name === 'custom' ? THEMES.slate.xterm : THEMES[name].xterm;
    term.options.theme = {
      ...pal,
      foreground: vars['--accent'], // the theme's main color drives terminal text
      cursor: vars['--accent'],
      cursorAccent: vars['--term-bg'],
      selectionBackground: hexA(vars['--accent'], 0.3),
    };
    localStorage.setItem('pi-theme', name);
    renderThemeSwatches();
  }

  const CUSTOM_EDIT_KEYS = [['--bg', 'Background'], ['--panel', 'Panel'], ['--term-bg', 'Terminal'], ['--border', 'Border'], ['--text', 'Text'], ['--dim', 'Muted'], ['--accent', 'Accent']];

  function renderThemeSwatches() {
    const box = $('theme-swatches');
    if (!box) return;
    box.innerHTML = '';
    for (const [key, t] of Object.entries(THEMES)) {
      const b = document.createElement('div');
      b.className = 'theme-swatch' + (currentTheme === key ? ' active' : '');
      b.innerHTML = `<span class="sw-preview" style="background:${t.vars['--term-bg']}"><i style="background:${t.vars['--accent']}"></i></span><span>${esc(t.label)}</span>`;
      b.addEventListener('click', () => applyTheme(key));
      box.appendChild(b);
    }
    const cb = document.createElement('div');
    cb.className = 'theme-swatch' + (currentTheme === 'custom' ? ' active' : '');
    cb.innerHTML = `<span class="sw-preview" style="background:${customVars['--term-bg']}"><i style="background:${customVars['--accent']}"></i></span><span>Custom</span>`;
    cb.addEventListener('click', () => applyTheme('custom'));
    box.appendChild(cb);
    renderCustomColors();
  }

  function renderCustomColors() {
    const box = $('custom-colors');
    if (!box) return;
    box.innerHTML = '';
    for (const [key, label] of CUSTOM_EDIT_KEYS) {
      const lab = document.createElement('label');
      lab.innerHTML = `<span>${label}</span>`;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = customVars[key] || '#888888';
      input.addEventListener('input', () => {
        customVars[key] = input.value;
        localStorage.setItem(CUSTOM_KEY, JSON.stringify(customVars));
        if (currentTheme === 'custom') {
          document.documentElement.style.setProperty(key, input.value);
          term.options.theme = { ...term.options.theme, background: customVars['--term-bg'], foreground: customVars['--accent'], cursor: customVars['--accent'], selectionBackground: hexA(customVars['--accent'], 0.3) };
          const sw = document.querySelector('.theme-swatch:last-child .sw-preview');
          if (sw) { sw.style.background = customVars['--term-bg']; sw.firstElementChild.style.background = customVars['--accent']; }
        }
      });
      lab.appendChild(input);
      box.appendChild(lab);
    }
    box.classList.toggle('hidden', currentTheme !== 'custom');
  }

  applyTheme(currentTheme);

  function setStatus(text, cls) {
    statusEl.textContent = text;
    dotEl.className = 'dot' + (cls ? ' ' + cls : '');
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 5000);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function sendSize() {
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  // ---------------- WebSocket ----------------
  function connect() {
    clearTimeout(retryTimer);
    setStatus('connecting…', '');
    ws = new WebSocket('ws://' + location.host + '/ws');

    ws.onopen = () => {
      ptyAlive = true;
      setStatus('connected', 'on');
      sendSize();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'restart') {
        ptyAlive = true;
        term.reset();
        setStatus('connected', 'on');
      } else if (msg.type === 'exit') {
        ptyAlive = false;
        setStatus('shell exited', 'off');
        showToast('pi exited — the PowerShell shell is still open. Type pi to relaunch.');
      }
    };

    ws.onclose = () => {
      setStatus('reconnecting…', '');
      retryTimer = setTimeout(connect, 1000);
    };
  }

  term.onData((data) => send({ type: 'input', data }));

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'V')) {
      if (e.key === 'C') {
        if (term.hasSelection()) copyText(term.getSelection());
      } else {
        pasteToTerminal();
      }
      return false;
    }
    return true;
  });

  // ---------------- header buttons ----------------
  $('restart').addEventListener('click', () => send({ type: 'restart' }));

  $('new-session').addEventListener('click', () => {
    if (!ptyAlive) { showToast('pi is not running — press Restart first'); return; }
    send({ type: 'input', data: '/new\r' });
    showToast('Sent /new to pi');
  });

  // ---------------- sidebars (toggle + persist) ----------------
  const sb = {
    left: localStorage.getItem('pi-sb-left') !== '0',
    right: localStorage.getItem('pi-sb-right') !== '0',
  };
  function applySidebars() {
    leftSide.classList.toggle('hidden', !sb.left);
    rightSide.classList.toggle('hidden', !sb.right);
    $('toggle-left').classList.toggle('active', sb.left);
    $('toggle-right').classList.toggle('active', sb.right);
    $('resize-left').classList.toggle('hidden', !sb.left);
    $('resize-right').classList.toggle('hidden', !sb.right);
    setTimeout(fitTerm, 120);
  }
  $('toggle-left').addEventListener('click', () => {
    sb.left = !sb.left;
    localStorage.setItem('pi-sb-left', sb.left ? '1' : '0');
    applySidebars();
  });
  $('toggle-right').addEventListener('click', () => {
    sb.right = !sb.right;
    localStorage.setItem('pi-sb-right', sb.right ? '1' : '0');
    applySidebars();
  });
  applySidebars();

  // ---------------- sidebar splitters (drag to resize) ----------------
  function makeResizer(handle, sidebar, dir, key) {
    let startX = 0, startW = 0, raf = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const delta = dir === 'left' ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.round(Math.min(480, Math.max(180, startW + delta)));
        sidebar.style.width = w + 'px';
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitTerm(); });
      };
      const onUp = () => {
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        localStorage.setItem(key, String(sidebar.getBoundingClientRect().width));
        fitTerm();
        sendSize();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  makeResizer($('resize-left'), leftSide, 'left', 'pi-sbw-left');
  makeResizer($('resize-right'), rightSide, 'right', 'pi-sbw-right');
  for (const [el, key] of [[leftSide, 'pi-sbw-left'], [rightSide, 'pi-sbw-right']]) {
    const w = parseInt(localStorage.getItem(key) || '', 10);
    if (w >= 180 && w <= 480) el.style.width = w + 'px';
  }

  function clearSelection() {
    selectedKeys.clear();
    selectedKind = null;
    selectionAnchor = null;
    applySelection();
  }

  function rowsForSelection(kind, origin) {
    if (kind === 'session') {
      return [...convList.querySelectorAll('.session-row[data-select-kind="session"]')]
        .filter((row) => row.offsetParent !== null);
    }
    const list = origin?.closest('ul') || fileTree;
    return [...list.querySelectorAll(':scope > .tree-item > .tree-row[data-select-kind="file"]')]
      .filter((row) => row.offsetParent !== null);
  }

  function applySelection() {
    for (const row of document.querySelectorAll('[data-select-kind][data-select-key]')) {
      const selected = row.dataset.selectKind === selectedKind && selectedKeys.has(row.dataset.selectKey);
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  function selectRow(row, event, open) {
    const kind = row.dataset.selectKind;
    const key = row.dataset.selectKey;
    if (!kind || !key || (!event.ctrlKey && !event.metaKey && !event.shiftKey)) {
      clearSelection();
      open();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (selectedKind !== kind) {
      selectedKeys.clear();
      selectedKind = kind;
      selectionAnchor = null;
    }
    if (event.shiftKey) {
      const rows = rowsForSelection(kind, row);
      const anchor = selectionAnchor && rows.some((item) => item.dataset.selectKey === selectionAnchor)
        ? selectionAnchor : key;
      const start = rows.findIndex((item) => item.dataset.selectKey === anchor);
      const end = rows.findIndex((item) => item === row);
      if (start < 0 || end < 0) selectedKeys.add(key);
      else for (const item of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) selectedKeys.add(item.dataset.selectKey);
      selectionAnchor = anchor;
    } else {
      if (selectedKeys.has(key)) selectedKeys.delete(key); else selectedKeys.add(key);
      selectionAnchor = key;
    }
    if (!selectedKeys.size) {
      selectedKind = null;
      selectionAnchor = null;
    }
    applySelection();
  }

  function prepareContextSelection(target) {
    const row = target instanceof Element ? target.closest('[data-select-kind][data-select-key]') : null;
    if (!row) return;
    const kind = row.dataset.selectKind;
    const key = row.dataset.selectKey;
    if (selectedKind === kind && selectedKeys.has(key)) return;
    selectedKeys.clear();
    selectedKind = kind;
    selectionAnchor = key;
    selectedKeys.add(key);
    applySelection();
  }

  function selectedEntriesFor(ctx) {
    if (!ctx.selectKind || selectedKind !== ctx.selectKind) return [];
    const seen = new Set();
    const entries = [];
    for (const row of document.querySelectorAll('[data-select-kind][data-select-key]')) {
      const key = row.dataset.selectKey;
      if (row.dataset.selectKind !== ctx.selectKind || !selectedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        path: row.dataset.path || key,
        name: row.dataset.name || key,
        type: row.dataset.fileType || '',
      });
    }
    return entries;
  }

  // ---------------- state ----------------
  async function fetchState() {
    try {
      const r = await fetch('/api/state');
      if (!r.ok) return;
      state = await r.json();
      renderAll();
      if (!hashHandled) { hashHandled = true; handleHash(); }
      if (typeof state.appVersion === 'number' && state.appVersion > APP_VERSION) showVersionBanner();
    } catch {}
  }

  // re-render only when something actually changed (keeps open menus, scroll,
  // and the search box stable across the background poll)
  function renderAll() {
    if (!state) return;
    const sig = JSON.stringify({
      p: state.projects.map((x) => [x.name, x.sessions.length, x.sessions.map((s) => [s.file, s.mtime, s.title])]),
      c: [
        ...(state.conversationFolders || []).map((folder) => [folder.name, folder.total]),
        ...(state.conversations || []).map((s) => [s.path, s.mtime, s.title, s.folder, s.pinned]),
      ],
      x: state.context.map((f) => [f.file, f.mtime]),
      sk: state.skills.map((s) => [s.name, s.label, s.active, s.disabled]),
      fr: [state.fileRootId, ...(state.fileRoots || []).map((root) => [root.id, root.path])],
      e: state.editing,
      u: state.updates,
      ur: state.updateRunning,
    });
    if (sig === lastSig) return;
    lastSig = sig;
    const convScroll = convList.scrollTop;
    const skillScroll = skillsList.scrollTop;
    renderContext();
    renderProjects();
    renderConversations();
    renderSkills();
    if (!selectedFileRoot || !(state.fileRoots || []).some((root) => root.id === selectedFileRoot)) renderFileTree();
    else updateTreeActivity();
    renderUpdates();
    applySelection();
    convList.scrollTop = convScroll;
    skillsList.scrollTop = skillScroll;
  }

  // ---------------- conditional update buttons ----------------
  const updateBtns = $('update-btns');
  const updatePiBtn = $('update-pi-btn');
  const updateExtBtn = $('update-ext-btn');

  function renderUpdates() {
    const u = state.updates;
    const piUp = !!(u && u.pi && u.pi.update);
    const extUp = !!(u && u.extensions && u.extensions.length);
    updatePiBtn.classList.toggle('hidden', !piUp);
    updateExtBtn.classList.toggle('hidden', !extUp);
    updateBtns.classList.toggle('hidden', !piUp && !extUp);
    if (piUp) {
      $('update-pi-sub').textContent = `${u.pi.current} → ${u.pi.latest}`;
      updatePiBtn.disabled = state.updateRunning;
    }
    if (extUp) {
      $('update-ext-sub').textContent = `${u.extensions.length} extension(s): ` + u.extensions.map((e) => e.name.replace(/^npm:|^git:/, '')).slice(0, 3).join(', ') + (u.extensions.length > 3 ? '…' : '');
      updateExtBtn.disabled = state.updateRunning;
    }
    // completion toast when a clicked update finishes
    if (lastUpdateClick && !state.updateRunning && Date.now() - lastUpdateClick.ts < 600000) {
      const t = lastUpdateClick.target;
      lastUpdateClick = null;
      showToast(t === 'pi' ? 'pi updated — restarting the session…' : 'Extensions updated — reloading pi…');
    }
  }

  async function startUpdate(target) {
    try {
      const r = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const j = await r.json();
      if (j.ok) {
        lastUpdateClick = { target, ts: Date.now() };
        showToast(target === 'pi' ? 'Updating pi…' : 'Updating extensions…');
        fetchState();
      } else {
        showToast('Update failed: ' + (j.error || 'unknown'));
      }
    } catch {
      showToast('Update failed — is the server reachable?');
    }
  }
  updatePiBtn.addEventListener('click', () => startUpdate('pi'));
  updateExtBtn.addEventListener('click', () => startUpdate('extensions'));

  // context files
  function renderContext() {
    ctxList.innerHTML = '';
    if (!state.context.length) {
      ctxList.innerHTML = '<div class="empty-note" data-ctx="ctxhead">no context notes yet — right-click to create files</div>';
      return;
    }
    for (const f of state.context) {
      const li = document.createElement('li');
      li.className = 'file-row';
      li.title = f.path;
      li.dataset.ctx = 'ctxfile';
      li.dataset.path = f.path;
      li.dataset.name = f.file;
      li.innerHTML = `<span class="f-name">${esc(f.file)}</span><span class="f-meta">${fmtSize(f.size)}</span>`;
      ctxList.appendChild(li);
    }
  }

  // projects (accordion folders; expanded sessions appear below; drop targets)
  function renderProjects() {
    projList.innerHTML = '';
    if (!state.projects.length) {
      projList.innerHTML = '<div class="empty-note">no projects yet — use New Project or /new-project</div>';
      return;
    }
    for (const p of state.projects) {
      const li = document.createElement('li');
      li.className = 'project-row' + (openProjects.has(p.name) ? ' open' : '') + (pinsOf('projects').includes(p.name) ? ' pinned' : '');
      li.innerHTML = `<div class="p-label-row" data-ctx="project" data-name="${esc(p.name)}" data-path="${esc(p.dir)}" title="Click to expand · drop sessions here"><span class="g-caret">▶</span><span class="p-name">${esc(p.name)}</span><span class="p-count">${p.sessions.length}</span></div>`;
      const ul = document.createElement('ul');
      ul.className = 'p-sessions';
      if (!p.sessions.length) {
        ul.innerHTML = '<li class="empty-note">no sessions yet — drag past conversations here</li>';
      } else {
        for (const s of p.sessions) {
          const srow = document.createElement('li');
          srow.className = 'session-row';
          srow.draggable = true;
          srow.title = s.path;
          srow.dataset.ctx = 'psession';
          srow.dataset.path = s.path;
          srow.dataset.name = s.file;
          srow.innerHTML = `<span class="s-time">${fmtTime(s.mtime)}</span><span class="s-snippet">${esc(s.title || s.file)}</span>`;
          srow.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', JSON.stringify({ src: s.path }));
            e.dataTransfer.effectAllowed = 'copy';
          });
          srow.addEventListener('click', () => loadSession(s.path, s.title));
          ul.appendChild(srow);
        }
      }
      li.appendChild(ul);
      li.querySelector('.p-label-row').addEventListener('click', () => {
        if (openProjects.has(p.name)) openProjects.delete(p.name); else openProjects.add(p.name);
        li.classList.toggle('open');
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        let src;
        try { src = JSON.parse(e.dataTransfer.getData('text/plain')).src; } catch { return; }
        const r = await fetch('/api/sessions/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: p.name, src }),
        });
        const j = await r.json();
        showToast(j.ok ? `Copied ${j.copied} session(s) into "${p.name}"` : 'Copy failed: ' + (j.error || 'unknown'));
        fetchState();
      });
      projList.appendChild(li);
    }
  }

  // Past Sessions stays flat for Pi; folders are lightweight display metadata.
  function renderConversations() {
    convList.innerHTML = '';
    const sessions = Array.isArray(state?.conversations) ? state.conversations : [];
    const folders = Array.isArray(state?.conversationFolders) ? state.conversationFolders : [];
    $('conv-count').textContent = sessions.length ? sessions.length : '';
    if (!sessions.length && !folders.length) {
      convList.innerHTML = '<div class="empty-note">no past conversations yet</div>';
      return;
    }

    const addSession = (parent, session) => {
      const row = document.createElement('li');
      row.className = 'session-row' + (session.pinned ? ' pinned' : '');
      row.draggable = true;
      row.title = session.path + (session.folder ? ` · ${session.folder}` : '');
      row.dataset.ctx = 'session';
      row.dataset.path = session.path;
      row.dataset.name = session.title || session.file;
      row.dataset.selectKind = 'session';
      row.dataset.selectKey = session.path;
      row.innerHTML = `<span class="s-time">${fmtTime(session.mtime)}</span><span class="s-snippet">${esc(session.title || session.file)}</span>`;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ src: session.path }));
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('click', (event) => selectRow(row, event, () => loadSession(session.path, session.title)));
      parent.appendChild(row);
    };

    const pinned = sessions.filter((session) => session.pinned);
    if (pinned.length) {
      const label = document.createElement('li');
      label.className = 'conv-subhead';
      label.textContent = 'Pinned';
      convList.appendChild(label);
      for (const session of pinned) addSession(convList, session);
    }

    for (const folder of folders) {
      const folderSessions = sessions.filter((session) => session.folder === folder.name);
      const li = document.createElement('li');
      const key = 'folder:' + folder.name;
      li.className = 'conv-group conv-folder' + (openGroups.has(key) ? ' open' : '');
      const header = document.createElement('div');
      header.className = 'g-label-row';
      header.dataset.ctx = 'convfolder';
      header.dataset.name = folder.name;
      header.title = 'Click to expand · drop conversations here';
      header.innerHTML = `<span class="g-caret">▶</span><span class="g-label">${esc(folder.name)}</span><span class="g-count">${folderSessions.length}</span>`;
      const list = document.createElement('ul');
      list.className = 'conv-sessions';
      if (!folderSessions.length) list.innerHTML = '<li class="empty-note">empty folder</li>';
      else for (const session of folderSessions) addSession(list, session);
      header.addEventListener('click', () => {
        if (openGroups.has(key)) openGroups.delete(key); else openGroups.add(key);
        li.classList.toggle('open');
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        let src;
        try { src = JSON.parse(e.dataTransfer.getData('text/plain')).src; } catch { return; }
        const result = await apiPost('/api/conversations/organize', { path: src, folder: folder.name });
        showToast(result.ok ? `Moved to "${folder.name}"` : 'Move failed: ' + (result.error || 'unknown'));
        if (result.ok) fetchState();
      });
      li.appendChild(header);
      li.appendChild(list);
      convList.appendChild(li);
    }

    const unfiled = sessions.filter((session) => !session.folder);
    for (const session of unfiled) addSession(convList, session);
  }

  // skills (green = used in current prompt; search + active-only filter;
  // groups are accordions — expanded rows appear below the group header)
  function renderSkills() {
    const q = skillQuery.trim().toLowerCase();
    const filtering = q || skillActiveOnly;
    const items = state.skills.filter((s) => {
      if (skillActiveOnly && !s.active) return false;
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const used = state.skills.filter((skill) => skill.active).length;
    skillCount.textContent = `${used}/${state.skills.length} used`;
    skillsList.innerHTML = '';
    if (!items.length) {
      skillsList.innerHTML = '<div class="empty-note">no matching skills</div>';
      return;
    }
    const groups = [];
    for (const s of items) {
      const g = groups[groups.length - 1];
      if (g && g.label === s.label) g.items.push(s);
      else groups.push({ label: s.label, items: [s] });
    }
    for (const g of groups) {
      if (!openSkillGroups.has(g.label)) openSkillGroups.add(g.label); // default open
      const wrap = document.createElement('div');
      wrap.className = 'skill-wrap';
      if (!filtering && !openSkillGroups.has(g.label)) wrap.classList.add('closed');
      const h = document.createElement('div');
      h.className = 'skill-group';
      h.innerHTML = `<span class="g-caret">▶</span><span>${esc(g.label)}</span><span class="g-count">${g.items.length}</span>`;
      const rows = document.createElement('div');
      rows.className = 'skill-rows';
      for (const s of g.items) {
        const li = document.createElement('li');
        li.className = 'skill-row' + (pinsOf('skills').includes(s.name) ? ' pinned' : '') + (s.disabled ? ' disabled' : '');
        li.title = s.desc ? s.desc + '\n' + s.file : s.file;
        li.dataset.ctx = 'skill';
        li.dataset.name = s.name;
        li.dataset.path = s.file;
        li.dataset.disabled = s.disabled ? '1' : '0';
        li.innerHTML = `<span class="dot2${s.active ? ' on' : ''}"></span><span class="s-name">${esc(s.name)}</span>`;
        rows.appendChild(li);
      }
      h.addEventListener('click', () => {
        if (openSkillGroups.has(g.label)) openSkillGroups.delete(g.label); else openSkillGroups.add(g.label);
        wrap.classList.toggle('closed');
      });
      wrap.appendChild(h);
      wrap.appendChild(rows);
      skillsList.appendChild(wrap);
    }
  }

  skillSearch.addEventListener('input', () => { skillQuery = skillSearch.value; renderSkills(); });
  skillFilter.addEventListener('change', () => { skillActiveOnly = skillFilter.checked; renderSkills(); });

  // ---------------- file tree ----------------
  function normalizedTreePath(value) {
    return String(value || '').replace(/\\/g, '/').toLowerCase();
  }

  function updateTreeActivity() {
    const editing = new Map();
    for (const item of state?.editing || []) {
      const key = normalizedTreePath(item.path);
      if (!editing.has(key)) editing.set(key, new Set());
      editing.get(key).add(item.who);
    }
    for (const row of fileTree.querySelectorAll('.tree-row[data-path]')) {
      const marker = row.querySelector('.tree-activity');
      marker.replaceChildren();
      for (const who of ['pi', 'sub']) {
        if (!editing.get(normalizedTreePath(row.dataset.path))?.has(who)) continue;
        const dot = document.createElement('span');
        dot.className = `edit-dot ${who}`;
        dot.title = who === 'pi' ? 'Pi is editing this file' : 'A subagent is editing this file';
        marker.appendChild(dot);
      }
    }
  }

  async function loadTreeDir(dir, host) {
    host.innerHTML = '<li class="empty-note">loading…</li>';
    try {
      const r = await fetch('/api/tree?root=' + encodeURIComponent(treeRootId || 'agent') + '&path=' + encodeURIComponent(dir));
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'failed to load folder');
      host.innerHTML = '';
      if (!data.entries.length) host.innerHTML = '<li class="empty-note">empty folder</li>';
      for (const entry of data.entries) {
        const item = document.createElement('li');
        item.className = 'tree-item';
        const row = document.createElement('div');
        row.className = `tree-row ${entry.type}`;
        row.dataset.ctx = 'file';
        row.dataset.path = entry.path;
        row.dataset.name = entry.name;
        row.dataset.fileType = entry.type;
        row.dataset.selectKind = 'file';
        row.dataset.selectKey = entry.path;
        row.title = entry.path;
        row.innerHTML = `<span class="g-caret">${entry.type === 'directory' ? '▶' : ''}</span><span class="tree-name">${esc(entry.name)}</span><span class="tree-activity"></span>`;
        item.appendChild(row);
        if (entry.type === 'directory') {
          const children = document.createElement('ul');
          children.className = 'tree-children';
          item.appendChild(children);
          if (openTreeDirs.has(entry.path)) {
            item.classList.add('open');
            children.dataset.loaded = '1';
            loadTreeDir(entry.path, children);
          }
          row.addEventListener('click', (event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
              selectRow(row, event, () => {});
              return;
            }
            clearSelection();
            item.classList.toggle('open');
            if (item.classList.contains('open')) openTreeDirs.add(entry.path); else openTreeDirs.delete(entry.path);
            if (item.classList.contains('open') && !children.dataset.loaded) {
              children.dataset.loaded = '1';
              loadTreeDir(entry.path, children);
            }
          });
        } else {
          row.addEventListener('click', (event) => selectRow(row, event, () => loadFile(entry.path, entry.name)));
        }
        host.appendChild(item);
      }
      updateTreeActivity();
      applySelection();
    } catch (error) {
      host.innerHTML = `<li class="empty-note">${esc(error.message || 'failed to load files')}</li>`;
    }
  }

  function renderFileTree() {
    const roots = Array.isArray(state?.fileRoots) ? state.fileRoots : [];
    const previousRoot = selectedFileRoot;
    const available = roots.find((root) => root.id === selectedFileRoot);
    const selected = available || roots.find((root) => root.id === state.fileRootId) || roots[0];
    selectedFileRoot = selected?.id || null;
    if (previousRoot && previousRoot !== selectedFileRoot) openTreeDirs.clear();
    treeRootId = selectedFileRoot;
    treeRoot = selected?.path || null;
    fileRootSelect.innerHTML = '';
    for (const root of roots) {
      const option = document.createElement('option');
      option.value = root.id;
      option.textContent = root.label;
      option.title = root.hint || root.path || root.label;
      fileRootSelect.appendChild(option);
    }
    fileRootSelect.value = selectedFileRoot || '';
    fileRootSelect.disabled = roots.length < 2;
    fileRootName.textContent = selected?.label || '';
    fileRootName.title = selected?.hint || selected?.path || '';
    fileTree.innerHTML = '';
    if (!treeRoot) {
      fileTree.innerHTML = '<li class="empty-note">no Pi roots available</li>';
      return;
    }
    loadTreeDir(treeRoot, fileTree);
  }

  fileRootSelect.addEventListener('change', () => {
    selectedFileRoot = fileRootSelect.value || null;
    openTreeDirs.clear();
    renderFileTree();
  });

  // ---------------- Skills floating panel ----------------
  const applySkillsSaved = makePanelMoveable(skillsPanel, 'skills-head', 'skills-resize', 'pi-skills-panel');
  function openSkills() {
    applySkillsSaved();
    if (state) renderSkills();
    skillsPanel.classList.remove('hidden');
  }
  function closeSkills() { skillsPanel.classList.add('hidden'); }
  $('skills-btn').addEventListener('click', () => {
    if (skillsPanel.classList.contains('hidden')) openSkills(); else closeSkills();
  });
  $('skills-close').addEventListener('click', closeSkills);
  document.addEventListener('click', (e) => {
    if (!skillsPanel.classList.contains('hidden') && !skillsPanel.contains(e.target) && e.target.id !== 'skills-btn' && !e.target.closest('#ctx-menu')) closeSkills();
  });

  // ---------------- MCP floating panel ----------------
  const applyMcpSaved = makePanelMoveable($('mcp-panel'), 'mcp-head', 'mcp-resize', 'pi-mcp-panel');

  function openMcp() {
    applyMcpSaved();
    // render from the polled state when available (instant); otherwise fetch
    const st = state || null;
    const render = (mcp) => {
      mcpList.innerHTML = '';
      if (!mcp.length) {
        mcpList.innerHTML = '<div class="empty-note">no MCP servers configured</div>';
      }
      for (const s of mcp) {
        const li = document.createElement('li');
        li.className = (state && state.pins && state.pins.mcp.includes(s.name)) ? 'pinned' : '';
        li.dataset.ctx = 'mcprow';
        li.dataset.name = s.name;
        li.dataset.endpoint = s.endpoint || '';
        li.dataset.enabled = s.enabled ? '1' : '0';
        li.innerHTML = `
          <span class="dot2${s.enabled ? ' on' : ''}"></span>
          <div class="mcp-body">
            <div class="mcp-name">${esc(s.name)}</div>
            <div class="mcp-meta"><span class="mcp-type">${esc(s.type)}</span> · ${esc(s.endpoint || '—')}${s.tools != null ? ` · ${s.tools} tools` : ''}</div>
          </div>`;
        mcpList.appendChild(li);
      }
    };
    if (st && st.mcp) {
      render(st.mcp);
    } else {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3000);
      fetch('/api/state', { signal: ctl.signal })
        .then((r) => r.json())
        .then((j) => { if (j && j.mcp) render(j.mcp); })
        .catch(() => {})
        .finally(() => clearTimeout(to));
    }
    mcpPanel.classList.remove('hidden');
  }
  function closeMcp() { mcpPanel.classList.add('hidden'); }
  $('mcp-btn').addEventListener('click', () => {
    if (mcpPanel.classList.contains('hidden')) openMcp(); else closeMcp();
  });
  $('mcp-close').addEventListener('click', closeMcp);
  document.addEventListener('click', (e) => {
    if (!mcpPanel.classList.contains('hidden') && !mcpPanel.contains(e.target) && e.target.id !== 'mcp-btn' && !e.target.closest('#ctx-menu')) closeMcp();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !skillsPanel.classList.contains('hidden')) closeSkills();
    if (e.key === 'Escape' && !mcpPanel.classList.contains('hidden')) closeMcp();
    if (e.key === 'Escape' && !sessPanel.classList.contains('hidden')) closeSessionPanel();
    if (e.key === 'Escape' && !notepadPanel.classList.contains('hidden')) closeNotepad();
    if (e.key === 'Escape' && !npModal.classList.contains('hidden')) closeNp();
    if (e.key === 'Escape' && !$('confirm-modal').classList.contains('hidden')) $('confirm-cancel').click();
    if (e.key === 'Escape' && !$('prompt-modal').classList.contains('hidden')) $('prompt-cancel').click();
    if (e.key === 'Escape' && !settingsPanel.classList.contains('hidden')) closeSettings();
  });

  // ---------------- session viewer panel (moveable + resizable) -------------
  const sessPanel = $('session-panel');
  const sessTitle = $('session-title');
  const sessMeta = $('session-meta');
  const sessBody = $('session-body');

  // ---------------- generic floating-panel mover (move + resize) ----------
  function makePanelMoveable(panel, headId, resizeId, storageKey) {
    const head = $(headId);
    const resize = $(resizeId);
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
    })();
    const applySaved = () => {
      if (saved && saved.w) {
        panel.style.left = saved.x + 'px';
        panel.style.top = saved.y + 'px';
        panel.style.width = saved.w + 'px';
        panel.style.height = saved.h + 'px';
      }
    };
    const drag = (startEv, mode) => {
      const r = panel.getBoundingClientRect();
      const sx = startEv.clientX, sy = startEv.clientY;
      const base = { x: r.left, y: r.top, w: r.width, h: r.height };
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (mode === 'move') {
          const x = Math.max(-r.width + 80, Math.min(window.innerWidth - r.width - 10, base.x + dx));
          const y = Math.max(0, Math.min(window.innerHeight - 40, base.y + dy));
          panel.style.left = x + 'px';
          panel.style.top = y + 'px';
        } else {
          const curLeft = panel.getBoundingClientRect().left;
          const maxW = Math.max(340, window.innerWidth - curLeft - 16);
          panel.style.width = Math.max(340, Math.min(maxW, base.w + dx)) + 'px';
          panel.style.height = Math.max(240, Math.min(window.innerHeight - 80, base.h + dy)) + 'px';
        }
      };
      const onUp = () => {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const rr = panel.getBoundingClientRect();
        localStorage.setItem(storageKey, JSON.stringify({ x: rr.left, y: rr.top, w: rr.width, h: rr.height }));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      drag(e, 'move');
    });
    resize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drag(e, 'resize');
    });
    return applySaved;
  }
  const applySessionSaved = makePanelMoveable(sessPanel, 'session-head', 'session-resize', 'pi-sess-panel');
  const applySettingsSaved = makePanelMoveable($('settings-panel'), 'settings-head', 'settings-resize', 'pi-settings-panel');
  const applyNotepadSaved = makePanelMoveable(notepadPanel, 'notepad-head', 'notepad-resize', 'pi-notepad-panel');

  function activeNotepad() {
    return notepadState.notes.find((note) => note.id === notepadState.activeId) || notepadState.notes[0];
  }
  function renderNotepad() {
    const active = activeNotepad();
    notepadTabList.replaceChildren();
    for (const note of notepadState.notes) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'notepad-tab' + (note.id === active.id ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(note.id === active.id));
      tab.setAttribute('aria-controls', 'notepad-textarea');
      tab.dataset.ctx = 'notepad-tab';
      tab.dataset.id = note.id;
      tab.dataset.name = note.title;
      tab.title = note.title;
      tab.textContent = note.title;
      tab.addEventListener('click', () => selectNotepad(note.id));
      notepadTabList.appendChild(tab);
    }
    notepadTextarea.value = active.content;
  }
  function selectNotepad(id) {
    if (!notepadState.notes.some((note) => note.id === id)) return;
    notepadState.activeId = id;
    saveNotepadState();
    renderNotepad();
    notepadTextarea.focus();
  }
  function newNotepad() {
    let number = notepadState.notes.length + 1;
    while (notepadState.notes.some((note) => note.title === `Note ${number}`)) number++;
    const note = { id: createNotepadId(), title: `Note ${number}`, content: '' };
    notepadState.notes.push(note);
    notepadState.activeId = note.id;
    saveNotepadState();
    renderNotepad();
    notepadTextarea.focus();
  }
  function renameNotepad(id = notepadState.activeId) {
    const note = notepadState.notes.find((item) => item.id === id);
    if (!note) return;
    promptModal('Rename Tab', note.title, (title) => {
      note.title = title;
      saveNotepadState();
      renderNotepad();
      notepadTextarea.focus();
    });
  }
  function deleteNotepad(id = notepadState.activeId) {
    const index = notepadState.notes.findIndex((note) => note.id === id);
    if (index < 0) return;
    const note = notepadState.notes[index];
    confirmModal('Delete Tab?', `Delete "${note.title}"? This cannot be undone.`, 'Delete', () => {
      if (notepadState.notes.length === 1) {
        const replacement = { id: createNotepadId(), title: 'Note 1', content: '' };
        notepadState.notes.splice(0, 1, replacement);
        notepadState.activeId = replacement.id;
      } else {
        notepadState.notes.splice(index, 1);
        if (notepadState.activeId === id) notepadState.activeId = notepadState.notes[Math.min(index, notepadState.notes.length - 1)].id;
      }
      saveNotepadState();
      renderNotepad();
      notepadTextarea.focus();
    });
  }
  function openNotepad() {
    applyNotepadSaved();
    renderNotepad();
    notepadPanel.classList.remove('hidden');
    setTimeout(() => notepadTextarea.focus(), 30);
  }
  function closeNotepad() { notepadPanel.classList.add('hidden'); }
  $('notepad-btn').addEventListener('click', () => {
    if (notepadPanel.classList.contains('hidden')) openNotepad(); else notepadTextarea.focus();
  });
  $('notepad-close').addEventListener('click', closeNotepad);
  $('notepad-new-tab').addEventListener('click', newNotepad);
  $('notepad-rename').addEventListener('click', () => renameNotepad());
  notepadTextarea.addEventListener('input', () => {
    activeNotepad().content = notepadTextarea.value;
    saveNotepadState();
  });

  function loadSession(file, title) {
    sessTitle.textContent = title || 'Conversation';
    sessMeta.textContent = 'loading…';
    sessBody.innerHTML = '<div class="empty-note">loading conversation…</div>';
    applySessionSaved();
    sessPanel.classList.remove('hidden');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    fetch('/api/session?file=' + encodeURIComponent(file), { signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => {
        clearTimeout(to);
        if (!j.ok && j.error) throw new Error(j.error);
        renderSession(j);
      })
      .catch((e) => {
        clearTimeout(to);
        sessMeta.textContent = '';
        sessBody.innerHTML = `<div class="empty-note">failed to load: ${esc(e.message || 'unknown')}</div>`;
      });
  }

  function renderSession(s) {
    if (s.name) sessTitle.textContent = s.name;
    const meta = [];
    if (s.cwd) meta.push(s.cwd);
    if (s.model) meta.push(s.model);
    if (s.started) meta.push(new Date(s.started).toLocaleString());
    sessMeta.textContent = meta.join('  ·  ');
    sessBody.innerHTML = '';
    if (!s.messages.length) {
      sessBody.innerHTML = '<div class="empty-note">no messages in this session</div>';
      return;
    }
    for (const m of s.messages) {
      const div = document.createElement('div');
      div.className = 'msg ' + m.role;
      const head = document.createElement('div');
      head.className = 'm-head';
      const who = m.role === 'user' ? 'You'
        : m.role === 'assistant' ? 'pi'
        : m.role === 'tool' ? 'tool · ' + (m.name || '')
        : 'result' + (m.name ? ' · ' + m.name : '');
      head.textContent = who + (m.ts ? '  ·  ' + fmtTime(new Date(m.ts).getTime()) : '');
      div.appendChild(head);
      if (m.role === 'assistant' && m.thinking) {
        const th = document.createElement('div');
        th.className = 'm-thinking';
        th.textContent = m.thinking;
        div.appendChild(th);
      }
      const txt = document.createElement('div');
      txt.className = 'm-text';
      txt.textContent = m.text || m.input || '';
      div.appendChild(txt);
      sessBody.appendChild(div);
    }
    sessBody.scrollTop = 0;
  }

  function closeSessionPanel() { sessPanel.classList.add('hidden'); }
  $('session-close').addEventListener('click', closeSessionPanel);

  // ---------------- New Project modal ----------------
  function openNp() {
    npInput.value = '';
    npModal.classList.remove('hidden');
    setTimeout(() => npInput.focus(), 30);
  }
  function closeNp() { npModal.classList.add('hidden'); }
  $('new-project-btn').addEventListener('click', openNp);
  $('np-cancel').addEventListener('click', closeNp);
  npModal.addEventListener('click', (e) => { if (e.target === npModal) closeNp(); });
  npInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('np-ok').click(); });
  $('np-ok').addEventListener('click', async () => {
    const name = npInput.value.trim();
    if (!name) return;
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      closeNp();
      if (j.ok) {
        showToast(`Project "${j.project.name}" created`);
        fetchState();
      } else {
        showToast('Failed: ' + (j.error || 'unknown'));
      }
    } catch { closeNp(); }
  });

  // ---------------- settings panel ----------------
  const settingsPanel = $('settings-panel');
  const KNOWN_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'google', 'xai', 'groq', 'mistral', 'ollama', 'huggingface', 'openrouter'];

  function openSettings() {
    applySettingsSaved();
    settingsPanel.classList.remove('hidden');
    renderThemeSwatches();
    renderGlowControls();
    refreshSettingsData();
  }
  function closeSettings() { settingsPanel.classList.add('hidden'); }
  $('settings-btn').addEventListener('click', () => {
    if (settingsPanel.classList.contains('hidden')) openSettings(); else closeSettings();
  });
  $('settings-close').addEventListener('click', closeSettings);

  function activeAccent() {
    const vars = currentTheme === 'custom' ? customVars : THEMES[currentTheme]?.vars;
    return vars?.['--accent'] || THEMES.slate.vars['--accent'];
  }

  const GLOW_CONTROLS = [
    { id: 'glow-blur', outputId: 'glow-blur-value', key: 'blur', suffix: 'px', max: 24 },
    { id: 'glow-density', outputId: 'glow-density-value', key: 'density', suffix: '%', max: 100 },
    { id: 'glow-pop', outputId: 'glow-pop-value', key: 'pop', suffix: '%', max: 100 },
  ];

  function renderGlowControls() {
    for (const { id, outputId, key, suffix, max } of GLOW_CONTROLS) {
      const input = $(id);
      const output = $(outputId);
      if (!input || !output) continue;
      input.value = String(Math.round(clampGlow(glowSettings[key], DEFAULT_GLOW[key], max)));
      output.textContent = input.value + suffix;
    }
    const color = $('glow-color');
    if (color) color.value = validHex(glowSettings.color) || activeAccent();
  }

  function setupGlowControls() {
    for (const { id, outputId, key, suffix, max } of GLOW_CONTROLS) {
      const input = $(id);
      const output = $(outputId);
      input.addEventListener('input', () => {
        glowSettings[key] = Math.round(clampGlow(input.value, DEFAULT_GLOW[key], max));
        output.textContent = input.value + suffix;
        localStorage.setItem(GLOW_KEY, JSON.stringify(glowSettings));
        applyGlow(activeAccent());
      });
    }
    $('glow-color').addEventListener('input', (e) => {
      glowSettings.color = validHex(e.target.value);
      localStorage.setItem(GLOW_KEY, JSON.stringify(glowSettings));
      applyGlow(activeAccent());
    });
  }
  setupGlowControls();

  async function refreshSettingsData() {
    try {
      const r = await fetch('/api/state');
      const st = await r.json();
      const list = $('settings-mcp-list');
      list.innerHTML = '';
      for (const s of st.mcp) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="dot2${s.enabled ? ' on' : ''}"></span><span>${esc(s.name)}</span>`;
        const rm = document.createElement('button');
        rm.className = 'icon-btn rm';
        rm.title = 'Remove';
        rm.textContent = '×';
        rm.addEventListener('click', async () => {
          const j = await apiPost('/api/mcp/remove', { name: s.name });
          showToast(j.ok ? 'Removed ' + s.name + ' — restart pi to unload' : 'Failed: ' + (j.error || ''));
          refreshSettingsData();
        });
        li.appendChild(rm);
        list.appendChild(li);
      }
    } catch {}
    try {
      const r = await fetch('/api/auth');
      const j = await r.json();
      const configured = new Set(j.providers || []);
      const box = $('provider-btns');
      box.innerHTML = '';
      for (const p of [...new Set([...KNOWN_PROVIDERS, ...configured])]) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = configured.has(p) ? p + ' ✓' : p;
        b.title = 'Open /login in the pi terminal';
        b.addEventListener('click', () => {
          if (!ptyAlive) { showToast('pi is not running — press Restart first'); return; }
          send({ type: 'input', data: '/login\r' });
          showToast('Login flow opened in the terminal');
        });
        box.appendChild(b);
      }
      $('auth-status').textContent = configured.size ? 'Configured: ' + [...configured].join(', ') : 'No providers configured yet.';
    } catch {}
    const v = (state && state.updates && state.updates.pi && state.updates.pi.current) || '?';
    $('about-line').textContent = 'pi ' + v + ' · webUI on port ' + location.port + ' · localhost only';
  }

  $('mcp-add').addEventListener('click', async () => {
    const name = $('mcp-name').value.trim();
    const type = $('mcp-type').value;
    const endpoint = $('mcp-endpoint').value.trim();
    const enabled = $('mcp-enabled').checked;
    if (!name || !endpoint) { showToast('Name and endpoint required'); return; }
    const body = type === 'http' ? { name, type, url: endpoint, enabled } : { name, type, command: endpoint, enabled };
    const j = await apiPost('/api/mcp', body);
    if (j.ok) {
      showToast('MCP server added — restart pi to load it');
      $('mcp-name').value = '';
      $('mcp-endpoint').value = '';
      refreshSettingsData();
    } else showToast('Failed: ' + (j.error || ''));
  });

  $('skill-create').addEventListener('click', async () => {
    const j = await apiPost('/api/skills', {
      name: $('skill-name').value,
      description: $('skill-desc').value,
      content: $('skill-content').value,
    });
    if (j.ok) {
      showToast('Skill created — run /reload in pi to load it');
      $('skill-name').value = '';
      $('skill-desc').value = '';
      $('skill-content').value = '';
    } else showToast('Failed: ' + (j.error || ''));
  });

  $('skill-import').addEventListener('click', async () => {
    const j = await apiPost('/api/skills/import', { path: $('skill-import-path').value });
    if (j.ok) {
      showToast('Imported skill "' + j.name + '" — run /reload in pi');
      $('skill-import-path').value = '';
    } else showToast('Import failed: ' + (j.error || ''));
  });

  $('auth-save').addEventListener('click', async () => {
    const j = await apiPost('/api/auth/key', { provider: $('auth-provider').value, key: $('auth-key').value });
    if (j.ok) {
      showToast('API key saved for ' + j.provider);
      $('auth-key').value = '';
      refreshSettingsData();
    } else showToast('Failed: ' + (j.error || ''));
  });

  // ---------------- right-click context menu ----------------
  const ctxMenu = $('ctx-menu');

  function pinsOf(list) {
    return (state && state.pins && state.pins[list]) || [];
  }

  async function copyText(value) {
    const text = String(value ?? '');
    if (!text) return false;
    const systemCopy = await clipboard.copy(text);
    showToast(systemCopy ? 'Copied to clipboard' : 'Copied inside PiTech — browser clipboard permission is blocked');
    return true;
  }
  async function readClipboardText(silent = false) {
    try {
      return await clipboard.read();
    } catch (error) {
      if (!silent) showToast(error.message);
      return '';
    }
  }
  async function pasteToTerminal() {
    const text = await readClipboardText();
    if (!text) return;
    term.focus();
    term.paste(text);
  }
  function sendInput(data) { send({ type: 'input', data }); }
  function linkFor(kind, value) {
    return location.origin + location.pathname + '#' + kind + '=' + encodeURIComponent(value);
  }
  function apiPost(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .catch(() => ({ ok: false, error: 'network' }));
  }

  function hideMenu() { ctxMenu.classList.add('hidden'); } // keep DOM so click targets stay attached for closest()

  function buildMenu(items, ctxLabel) {
    ctxMenu.innerHTML = '';
    if (ctxLabel) {
      const brand = document.createElement('div');
      brand.className = 'ctx-brand';
      brand.innerHTML = '<span class="ctx-brand-pi">pi</span><span class="ctx-brand-ctx">' + esc(ctxLabel) + '</span>';
      ctxMenu.appendChild(brand);
    }
    for (const it of items) {
      if (it === 'sep') {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        ctxMenu.appendChild(s);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '') + (it.sub ? ' has-sub' : '');
      el.textContent = it.label;
      if (it.sub) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = '›';
        el.appendChild(caret);
        const sub = document.createElement('div');
        sub.className = 'ctx-sub';
        for (const si of it.sub) {
          const sel = document.createElement('div');
          sel.className = 'ctx-item';
          sel.textContent = si.label;
          sel.addEventListener('click', (e) => { e.stopPropagation(); hideMenu(); si.run(); });
          sub.appendChild(sel);
        }
        el.appendChild(sub);
      } else if (!it.disabled && it.run) {
        el.addEventListener('click', () => { hideMenu(); it.run(); });
      }
      ctxMenu.appendChild(el);
    }
  }

  function ctxLabelFor(ctx) {
    switch (ctx.kind) {
      case 'terminal': return 'terminal';
      case 'input': return 'text field';
      case 'generic': return 'workspace';
      case 'session': case 'psession': return 'conversation';
      case 'convfolder': return 'conversation folder';
      case 'convhead': return 'past sessions';
      case 'filehead': return 'files';
      case 'project': return 'project · ' + ctx.name;
      case 'file': return 'file · ' + ctx.name;
      case 'ctxfile': return 'context file · ' + ctx.name;
      case 'skill': return 'skill · ' + ctx.name;
      case 'mcprow': return 'MCP server · ' + ctx.name;
      case 'ctxhead': return 'context folder';
      case 'projhead': return 'projects';
      case 'notepad-tab': return 'notepad tab · ' + ctx.name;
      default: return String(ctx.kind || 'pi');
    }
  }

  function showMenu(x, y, items, ctxLabel) {
    buildMenu(items, ctxLabel);
    ctxMenu.classList.remove('hidden');
    const r = ctxMenu.getBoundingClientRect();
    let px = Math.min(x, window.innerWidth - r.width - 8);
    let py = Math.min(y, window.innerHeight - r.height - 8);
    px = Math.max(4, px);
    py = Math.max(4, py);
    ctxMenu.classList.toggle('sub-left', px + r.width + 140 > window.innerWidth);
    ctxMenu.style.left = px + 'px';
    ctxMenu.style.top = py + 'px';
    maybeAppendOpenLink();
  }

  // "Open link" appears when the clipboard holds a URL
  let openLinkAdded = false;
  function maybeAppendOpenLink() {
    openLinkAdded = false;
    readClipboardText(true).then((t) => {
      if (openLinkAdded || ctxMenu.classList.contains('hidden')) return;
      const m = String(t || '').trim().match(/^https?:\/\/\S+$/);
      if (!m) return;
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.textContent = 'Open link';
      el.addEventListener('click', () => { hideMenu(); window.open(m[0], '_blank'); });
      ctxMenu.appendChild(s);
      ctxMenu.appendChild(el);
      openLinkAdded = true;
    });
  }

  function confirmModal(title, msg, okLabel, onOk) {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = msg;
    $('confirm-ok').textContent = okLabel || 'Delete';
    const modal = $('confirm-modal');
    modal.classList.remove('hidden');
    const close = () => { modal.classList.add('hidden'); $('confirm-ok').onclick = null; };
    $('confirm-cancel').onclick = close;
    $('confirm-ok').onclick = () => { close(); onOk(); };
  }

  function promptModal(title, initial, onOk) {
    $('prompt-title').textContent = title;
    $('prompt-input').value = initial || '';
    const modal = $('prompt-modal');
    modal.classList.remove('hidden');
    const close = () => { modal.classList.add('hidden'); $('prompt-ok').onclick = null; };
    const ok = () => { const v = $('prompt-input').value.trim(); if (!v) return; close(); onOk(v); };
    $('prompt-cancel').onclick = close;
    $('prompt-ok').onclick = ok;
    $('prompt-input').onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
    setTimeout(() => { $('prompt-input').focus(); $('prompt-input').select(); }, 30);
  }

  function renameDelta(oldValue, newValue) {
    let start = 0;
    while (start < oldValue.length && start < newValue.length && oldValue[start] === newValue[start]) start++;
    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (oldEnd > start && newEnd > start && oldValue[oldEnd - 1] === newValue[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { start, end: oldEnd, text: newValue.slice(start, newEnd) };
  }

  async function applyBulk(entries, endpoint, bodyFor, message) {
    let failed = 0;
    for (const entry of entries) {
      const result = await apiPost(endpoint, bodyFor(entry));
      if (!result.ok) failed++;
    }
    showToast(failed ? `${entries.length - failed} ${message}; ${failed} failed` : `${entries.length} ${message}`);
    clearSelection();
    fetchState();
  }

  function openBulkRename(entries, kind) {
    const modal = $('bulk-rename-modal');
    const list = $('bulk-rename-list');
    const fields = [];
    let values = [];
    let applying = false;
    list.replaceChildren();
    for (const entry of entries) {
      const label = document.createElement('label');
      label.className = 'bulk-rename-row';
      const caption = document.createElement('span');
      caption.textContent = entry.name;
      const input = document.createElement('input');
      input.value = entry.name;
      input.autocomplete = 'off';
      input.spellcheck = false;
      label.append(caption, input);
      list.appendChild(label);
      fields.push(input);
    }
    values = fields.map((input) => input.value);
    const syncCaret = (position) => {
      for (const input of fields) {
        const caret = Math.min(Math.max(0, position), input.value.length);
        input.setSelectionRange(caret, caret);
      }
    };
    fields.forEach((input, index) => {
      const followCaret = () => syncCaret(input.selectionStart ?? input.value.length);
      input.addEventListener('focus', followCaret);
      input.addEventListener('click', followCaret);
      input.addEventListener('select', followCaret);
      input.addEventListener('keyup', followCaret);
      input.addEventListener('input', () => {
        if (applying) return;
        const delta = renameDelta(values[index], input.value);
        const nextValues = values.map((value, itemIndex) => itemIndex === index
          ? input.value
          : value.slice(0, Math.min(delta.start, value.length))
            + delta.text
            + value.slice(Math.min(delta.end, value.length)));
        applying = true;
        fields.forEach((field, itemIndex) => { field.value = nextValues[itemIndex]; });
        applying = false;
        values = nextValues;
        syncCaret(delta.start + delta.text.length);
      });
    });
    $('bulk-rename-sub').textContent = `${entries.length} ${kind === 'session' ? 'sessions' : 'files'} · edit any row; the caret stays aligned`;
    modal.classList.remove('hidden');
    const close = () => {
      modal.classList.add('hidden');
      list.replaceChildren();
      clearSelection();
    };
    $('bulk-rename-cancel').onclick = close;
    $('bulk-rename-ok').onclick = async () => {
      const button = $('bulk-rename-ok');
      button.disabled = true;
      let failed = 0;
      for (let i = 0; i < entries.length; i++) {
        const name = fields[i].value.trim();
        if (!name) { failed++; continue; }
        const result = kind === 'session'
          ? await apiPost('/api/conversations/organize', { path: entries[i].path, title: name })
          : await apiPost('/api/fs/rename', { path: entries[i].path, name });
        if (!result.ok) failed++;
      }
      if (failed) {
        button.disabled = false;
        showToast(`${entries.length - failed} renamed; ${failed} failed`);
        return;
      }
      close();
      showToast(`${entries.length} renamed`);
      fetchState();
    };
    setTimeout(() => { fields[0]?.focus(); syncCaret(fields[0]?.value.length || 0); }, 30);
  }

  function wordAtInput(input) {
    const value = input.value || '';
    let start = input.selectionStart ?? 0;
    let end = input.selectionEnd ?? start;
    if (start === end) {
      if (start === value.length) start--;
      if (start < 0 || !/[A-Za-z0-9_'-]/.test(value[start])) return '';
      end = start + 1;
      while (start > 0 && /[A-Za-z0-9_'-]/.test(value[start - 1])) start--;
      while (end < value.length && /[A-Za-z0-9_'-]/.test(value[end])) end++;
    }
    const word = value.slice(start, end);
    return /^[A-Za-z0-9_'-]+$/.test(word) ? word : '';
  }

  function armNativeSpellcheck(input) {
    input.spellcheck = true;
    nativeSpellcheckTarget = input;
    input.focus();
    showToast('Spellcheck armed — right-click again for browser suggestions');
  }

  function togglePin(list, name, pin) {
    apiPost('/api/pin', { list, name, pin }).then(async () => {
      await fetchState();
      if (!mcpPanel.classList.contains('hidden')) openMcp(); // live-refresh the open panel
    });
  }
  function confirmDelete(ctx) {
    confirmModal('Delete ' + (ctx.name || ctx.kind) + '?', 'This permanently deletes it. This cannot be undone.', 'Delete', () => {
      apiPost('/api/fs/delete', { path: ctx.path }).then((j) => {
        showToast(j.ok ? 'Deleted' : 'Delete failed: ' + (j.error || ''));
        fetchState();
      });
    });
  }

  function menuFor(ctx) {
    const items = [];
    if (ctx.kind === 'terminal') {
      items.push({ label: 'Copy', disabled: !ctx.selection, run: () => copyText(ctx.selection) });
      items.push({ label: 'Paste', run: pasteToTerminal });
      items.push({ label: 'Paste without formatting', run: pasteToTerminal });
      items.push('sep');
      items.push({ label: 'Undo', run: () => sendInput('\u001a') });
      items.push({ label: 'Redo', run: () => sendInput('\u0019') });
      return items;
    }
    if (ctx.kind === 'input') {
      const inp = ctx.el;
      const selected = ctx.selection;
      const doPaste = async () => {
        const text = await readClipboardText();
        if (!text) return;
        inp.focus();
        inp.setRangeText(text, selected.start, selected.end, 'end');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      };
      items.push({ label: 'Copy', disabled: !selected.text, run: () => copyText(selected.text) });
      items.push({ label: 'Cut', disabled: !selected.text, run: () => {
        if (!selected.text) return;
        copyText(selected.text);
        inp.setRangeText('', selected.start, selected.end, 'end');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } });
      items.push({ label: 'Paste', run: doPaste });
      items.push({ label: 'Paste without formatting', run: doPaste });
      if (ctx.word && inp.spellcheck) items.push({ label: 'Spellcheck', run: () => armNativeSpellcheck(inp) });
      items.push('sep');
      items.push({ label: 'Select All', run: () => { inp.focus(); inp.select(); } });
      return items;
    }
    if (ctx.kind === 'generic') {
      items.push({ label: 'Copy', disabled: !ctx.selection, run: () => copyText(ctx.selection) });
      items.push({ label: 'Paste', run: pasteToTerminal });
      items.push({ label: 'Paste without formatting', run: pasteToTerminal });
      return items;
    }
    if (ctx.kind === 'notepad-tab') {
      items.push({ label: 'Rename Tab', run: () => renameNotepad(ctx.id) });
      items.push({ label: 'Delete Tab', danger: true, run: () => deleteNotepad(ctx.id) });
      return items;
    }
    const selected = selectedEntriesFor(ctx);
    if (selected.length > 1 && ctx.selectKind === 'session') {
      items.push({ label: 'Rename selected', run: () => openBulkRename(selected, 'session') });
      const folders = (state?.conversationFolders || []).map((folder) => ({
        label: folder.name,
        run: () => applyBulk(selected, '/api/conversations/organize', (entry) => ({ path: entry.path, folder: folder.name }), `moved to "${folder.name}"`),
      }));
      folders.unshift({
        label: 'Unfiled',
        run: () => applyBulk(selected, '/api/conversations/organize', (entry) => ({ path: entry.path, folder: null }), 'unfiled'),
      });
      items.push({ label: 'Move selected to folder', sub: folders });
      const pin = !selected.every((entry) => pinsOf('conversations').includes(entry.key));
      items.push({ label: pin ? 'Pin selected' : 'Unpin selected', run: () => applyBulk(selected, '/api/pin', (entry) => ({ list: 'conversations', name: entry.key, pin }), pin ? 'pinned' : 'unpinned') });
      items.push({ label: 'Clear selection', run: clearSelection });
      return items;
    }
    if (selected.length > 1 && ctx.selectKind === 'file') {
      items.push({ label: 'Rename selected', run: () => openBulkRename(selected, 'file') });
      items.push({ label: 'Copy paths', run: () => copyText(selected.map((entry) => entry.path).join('\\n')) });
      items.push({ label: 'Clear selection', run: clearSelection });
      return items;
    }
    const pinKey = ctx.kind === 'session' ? ctx.path : ctx.name;
    const pinned = !!ctx.list && pinsOf(ctx.list).includes(pinKey);
    if (ctx.list) {
      items.push({ label: pinned ? 'Unpin' : 'Pin', run: () => togglePin(ctx.list, pinKey, !pinned) });
    }
    if (ctx.kind === 'session' || ctx.kind === 'psession') {
      items.push({ label: 'Open', run: () => loadSession(ctx.path, ctx.name) });
      if (ctx.kind === 'session') {
        items.push({ label: 'Rename', run: () => promptModal('Rename conversation', ctx.name, (title) => apiPost('/api/conversations/organize', { path: ctx.path, title }).then((j) => { showToast(j.ok ? 'Conversation renamed' : 'Rename failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
        const folders = (state?.conversationFolders || []).map((folder) => ({
          label: folder.name,
          run: () => apiPost('/api/conversations/organize', { path: ctx.path, folder: folder.name }).then((j) => { showToast(j.ok ? `Moved to "${folder.name}"` : 'Move failed: ' + (j.error || '')); if (j.ok) fetchState(); }),
        }));
        folders.unshift({
          label: 'Unfiled',
          run: () => apiPost('/api/conversations/organize', { path: ctx.path, folder: null }).then((j) => { showToast(j.ok ? 'Conversation unfiled' : 'Move failed: ' + (j.error || '')); if (j.ok) fetchState(); }),
        });
        items.push({ label: 'Move to folder', sub: folders });
      }
      items.push({ label: 'Copy', run: () => copyText(ctx.path) });
      items.push({ label: 'Copy link', run: () => copyText(linkFor('session', ctx.path)) });
      items.push({ label: 'Show in Explorer', run: () => apiPost('/api/open', { path: ctx.path, mode: 'explorer' }) });
      items.push('sep');
      items.push({ label: 'Delete', danger: true, run: () => confirmDelete(ctx) });
    } else if (ctx.kind === 'convfolder') {
      items.push({ label: 'Rename', run: () => promptModal('Rename conversation folder', ctx.name, (name) => apiPost('/api/conversations/folders', { action: 'rename', oldName: ctx.name, newName: name }).then((j) => { showToast(j.ok ? 'Folder renamed' : 'Rename failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
      items.push({ label: 'Delete folder', danger: true, run: () => confirmModal('Delete folder "' + ctx.name + '"?', 'Conversations stay safe and become unfiled.', 'Delete folder', () => apiPost('/api/conversations/folders', { action: 'delete', name: ctx.name }).then((j) => { showToast(j.ok ? 'Folder deleted' : 'Delete failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
    } else if (ctx.kind === 'project') {
      items.push({ label: 'Rename', run: () => promptModal('Rename project', ctx.name, (v) => apiPost('/api/fs/rename', { path: ctx.path, name: v }).then(() => fetchState())) });
      items.push({ label: 'Copy', run: () => copyText(ctx.name) });
      items.push({ label: 'Copy link', run: () => copyText(linkFor('project', ctx.name)) });
      items.push({ label: 'Show in Explorer', run: () => apiPost('/api/open', { path: ctx.path, mode: 'explorer' }) });
      items.push('sep');
      items.push({ label: 'Delete', danger: true, run: () => confirmDelete(ctx) });
    } else if (ctx.kind === 'file') {
      if (ctx.fileType === 'file') items.push({ label: 'Open', run: () => loadFile(ctx.path, ctx.name) });
      items.push({ label: 'Rename', run: () => promptModal('Rename file', ctx.name, (v) => apiPost('/api/fs/rename', { path: ctx.path, name: v }).then((j) => { showToast(j.ok ? 'File renamed' : 'Rename failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
      items.push({ label: 'Copy', run: () => copyText(ctx.path) });
      items.push({ label: 'Show in Explorer', run: () => apiPost('/api/open', { path: ctx.path, mode: 'explorer' }) });
    } else if (ctx.kind === 'ctxfile') {
      items.push({ label: 'Open', run: () => loadFile(ctx.path, ctx.name) });
      items.push({ label: 'Rename', run: () => promptModal('Rename file', ctx.name, (v) => apiPost('/api/fs/rename', { path: ctx.path, name: v }).then(() => fetchState())) });
      items.push({ label: 'Copy', run: () => copyText(ctx.path) });
      items.push({ label: 'Show in Explorer', run: () => apiPost('/api/open', { path: ctx.path, mode: 'explorer' }) });
      items.push('sep');
      items.push({ label: 'Delete', danger: true, run: () => confirmDelete(ctx) });
    } else if (ctx.kind === 'skill') {
      const skillRoots = (state && state.skillRoots) || [];
      if (skillRoots.some((r) => ctx.path.startsWith(r))) {
        items.push({
          label: ctx.disabled ? 'Enable' : 'Disable',
          run: () => apiPost('/api/skill/toggle', { name: ctx.name, enabled: ctx.disabled }).then((j) => {
            showToast(j.ok ? (ctx.disabled ? 'Skill enabled — run /reload in pi' : 'Skill disabled — run /reload in pi') : 'Failed: ' + (j.error || ''));
            fetchState();
          }),
        });
      }
      items.push({ label: 'Open', run: () => loadFile(ctx.path, ctx.name) });
      items.push({ label: 'Copy', run: () => copyText(ctx.name) });
      items.push({ label: 'Copy link', run: () => copyText(linkFor('skill', ctx.name)) });
      if (skillRoots.some((r) => ctx.path.startsWith(r))) {
        items.push('sep');
        items.push({ label: 'Delete', danger: true, run: () => confirmDelete(ctx) });
      }
    } else if (ctx.kind === 'mcprow') {
      items.push({
        label: ctx.enabled ? 'Disable' : 'Enable',
        run: () => apiPost('/api/mcp/toggle', { name: ctx.name, enabled: !ctx.enabled }).then(async (j) => {
          showToast(j.ok ? (ctx.enabled ? ctx.name + ' disabled — restart pi to unload' : ctx.name + ' enabled') : 'Failed: ' + (j.error || ''));
          await fetchState();
          if (!mcpPanel.classList.contains('hidden')) openMcp();
        }),
      });
      items.push({ label: 'Copy', run: () => copyText(ctx.name) });
      if (/^https?:/i.test(ctx.endpoint)) {
        items.push({ label: 'Copy link', run: () => copyText(ctx.endpoint) });
        items.push({ label: 'Open link', run: () => window.open(ctx.endpoint, '_blank') });
      }
    } else if (ctx.kind === 'convhead') {
      items.push({ label: 'New Folder', run: () => promptModal('New conversation folder', 'Research', (name) => apiPost('/api/conversations/folders', { action: 'create', name }).then((j) => { showToast(j.ok ? 'Folder created' : 'Create failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
    } else if (ctx.kind === 'filehead') {
      items.push({ label: 'New Folder', run: () => promptModal('New folder in files', 'new-folder', (name) => apiPost('/api/fs/new-folder', { root: selectedFileRoot || 'agent', name }).then((j) => { showToast(j.ok ? 'Folder created' : 'Create failed: ' + (j.error || '')); if (j.ok) fetchState(); })) });
    } else if (ctx.kind === 'ctxhead') {
      items.push({ label: 'New Folder', run: () => promptModal('New folder in context', 'new-folder', (v) => apiPost('/api/fs/new-folder', { name: v }).then((j) => { showToast(j.ok ? 'Folder created' : 'Failed: ' + (j.error || '')); fetchState(); })) });
      items.push({
        label: 'New File', sub: ['txt', 'md', 'cfg'].map((ext) => ({
          label: '.' + ext,
          run: () => promptModal('New .' + ext + ' file in context', 'new-file.' + ext, (v) => apiPost('/api/fs/new-file', { name: v }).then((j) => { showToast(j.ok ? 'File created' : 'Failed: ' + (j.error || '')); fetchState(); })),
        })),
      });
    } else if (ctx.kind === 'projhead') {
      items.push({ label: 'New Project', run: () => openNp() });
    }
    return items;
  }

  let rightClickInputSelection = null;
  let rightClickTerminalSelection = '';
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    const t = e.target instanceof Element ? e.target : document.body;
    const input = t.closest('input, textarea');
    if (input) {
      rightClickInputSelection = {
        el: input,
        selection: PiTechClipboard.captureSelection(input.value, input.selectionStart, input.selectionEnd),
      };
      return;
    }
    rightClickInputSelection = null;
    if (t.closest('#term-wrap')) rightClickTerminalSelection = term.getSelection();
  }, true);

  function resolveContext(target) {
    const t = target instanceof Element ? target : document.body;
    const el = t.closest('[data-ctx]');
    if (el) {
      const ctx = { kind: el.dataset.ctx, id: el.dataset.id || '', name: el.dataset.name || '', path: el.dataset.path || '', endpoint: el.dataset.endpoint || '', fileType: el.dataset.fileType || '', selectKind: el.dataset.selectKind || '', enabled: el.dataset.enabled !== '0', disabled: el.dataset.disabled === '1' };
      if (ctx.kind === 'skill' || ctx.kind === 'mcprow') ctx.list = ctx.kind === 'skill' ? 'skills' : 'mcp';
      else if (ctx.kind === 'session') ctx.list = 'conversations';
      else if (ctx.kind === 'project') ctx.list = 'projects';
      return ctx;
    }
    const inp = t.closest('input, textarea');
    if (inp) {
      const selection = rightClickInputSelection?.el === inp
        ? rightClickInputSelection.selection
        : PiTechClipboard.captureSelection(inp.value, inp.selectionStart, inp.selectionEnd);
      rightClickInputSelection = null;
      return { kind: 'input', el: inp, selection, word: wordAtInput(inp) };
    }
    if (t.closest('#term-wrap')) {
      const selection = rightClickTerminalSelection || term.getSelection();
      rightClickTerminalSelection = '';
      return { kind: 'terminal', selection };
    }
    return { kind: 'generic', selection: term.getSelection() };
  }

  // Capture phase on window: fires before xterm's own contextmenu handlers (or any
  // stopPropagation) can interfere, so the native browser menu can never appear.
  window.addEventListener('contextmenu', (e) => {
    const editable = e.target instanceof Element ? e.target.closest('input, textarea') : null;
    if (nativeSpellcheckTarget && nativeSpellcheckTarget === editable) {
      nativeSpellcheckTarget = null;
      return;
    }
    nativeSpellcheckTarget = null;
    e.preventDefault();
    prepareContextSelection(e.target);
    const ctx = resolveContext(e.target);
    if (ctx.kind === 'terminal') {
      e.stopPropagation();
      if (!ctx.selection && !e.shiftKey) {
        hideMenu();
        pasteToTerminal();
        return;
      }
    }
    const items = menuFor(ctx);
    if (items && items.length) showMenu(e.clientX, e.clientY, items, ctxLabelFor(ctx));
  }, true);
  document.addEventListener('click', (e) => { if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) hideMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
  window.addEventListener('blur', hideMenu);

  // ---------------- file viewer + light editor (reuses the session panel) ----------------
  let viewerPath = null;
  function loadFile(path, title) {
    viewerPath = path;
    sessTitle.textContent = title || 'File';
    sessMeta.textContent = 'loading…';
    sessBody.innerHTML = '<div class="empty-note">loading…</div>';
    applySessionSaved();
    sessPanel.classList.remove('hidden');
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    fetch('/api/file?path=' + encodeURIComponent(path), { signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => {
        clearTimeout(to);
        if (!j.ok && j.error) throw new Error(j.error);
        sessMeta.textContent = path;
        sessBody.innerHTML = '';
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn';
        editBtn.textContent = 'Edit';
        actions.appendChild(editBtn);
        sessBody.appendChild(actions);
        const pre = document.createElement('pre');
        pre.className = 'file-view';
        pre.textContent = j.text;
        sessBody.appendChild(pre);
        const startEdit = () => {
          const ta = document.createElement('textarea');
          ta.className = 'file-edit';
          ta.value = j.text;
          ta.spellcheck = true;
          const saveBtn = document.createElement('button');
          saveBtn.className = 'btn';
          saveBtn.textContent = 'Save';
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn';
          cancelBtn.textContent = 'Cancel';
          actions.innerHTML = '';
          actions.appendChild(saveBtn);
          actions.appendChild(cancelBtn);
          pre.replaceWith(ta);
          cancelBtn.addEventListener('click', () => { ta.replaceWith(pre); actions.innerHTML = ''; actions.appendChild(editBtn); });
          saveBtn.addEventListener('click', () => {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
            fetch('/api/file/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path, text: ta.value }),
            })
              .then((r) => r.json())
              .then((res) => {
                if (!res.ok) throw new Error(res.error || 'save failed');
                j.text = ta.value;
                pre.textContent = ta.value;
                ta.replaceWith(pre);
                actions.innerHTML = '';
                actions.appendChild(editBtn);
                sessMeta.textContent = path + ' — saved';
              })
              .catch((e) => { saveBtn.disabled = false; saveBtn.textContent = 'Save failed: ' + (e.message || '?'); });
          });
        };
        editBtn.addEventListener('click', startEdit);
      })
      .catch((e) => {
        clearTimeout(to);
        sessMeta.textContent = '';
        sessBody.innerHTML = `<div class="empty-note">failed to load: ${esc(e.message || 'unknown')}</div>`;
      });
  }

  // ---------------- hash links (open on load) ----------------
  function handleHash() {
    const h = location.hash;
    if (!h || h.length < 3) return;
    const m = h.slice(1).match(/^([a-z]+)=(.*)$/);
    if (!m) return;
    const kind = m[1], v = decodeURIComponent(m[2]);
    if (kind === 'session') loadSession(v, v.split(/[\\/]/).pop());
    else if (kind === 'project') {
      openProjects.add(v);
      setTimeout(() => {
        const el = [...projList.querySelectorAll('.project-row')].find((r) => r.querySelector('.p-label-row')?.dataset.name === v);
        el?.scrollIntoView({ block: 'center' });
      }, 400);
    } else if (kind === 'skill') {
      openSkills();
      setTimeout(() => {
        const el = [...skillsList.querySelectorAll('.skill-row')].find((r) => r.dataset.name === v);
        el?.scrollIntoView({ block: 'center' });
        el?.classList.add('flash');
      }, 400);
    } else if (kind === 'mcp') openMcp();
  }
  window.__handleHash = handleHash;

  // ---------------- helpers ----------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return date + ' ' + time;
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  connect();
  fetchState();
  setInterval(fetchState, 10000);
})();

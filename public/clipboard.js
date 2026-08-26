// PiTech by Haxnstuff
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiTechClipboard = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function copyWithExecCommand(text, doc = root.document) {
    if (!doc?.body?.appendChild || typeof doc.execCommand !== 'function') return false;
    const area = doc.createElement('textarea');
    const active = doc.activeElement;
    area.value = String(text ?? '');
    area.setAttribute?.('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;';
    doc.body.appendChild(area);
    let copied = false;
    try {
      area.focus?.();
      area.select?.();
      copied = doc.execCommand('copy') === true;
    } catch {}
    area.remove?.();
    if (area.parentNode) area.parentNode.removeChild(area);
    active?.focus?.();
    return copied;
  }

  function createClipboard({
    readText,
    writeText,
    fallbackCopy = copyWithExecCommand,
    preferLegacy = /Firefox\//.test(root?.navigator?.userAgent || ''),
  }) {
    let lastExplicitCopy = '';

    return {
      async copy(text) {
        lastExplicitCopy = String(text ?? '');
        const tryLegacy = () => {
          try { return fallbackCopy(lastExplicitCopy) === true; } catch { return false; }
        };
        if (preferLegacy && tryLegacy()) return true;
        try {
          await writeText(lastExplicitCopy);
          return true;
        } catch {
          return tryLegacy();
        }
      },
      async read() {
        try {
          return String((await readText()) ?? '');
        } catch {
          if (lastExplicitCopy) return lastExplicitCopy;
          throw new Error('Clipboard access is blocked. Copy inside PiTech or allow clipboard permission.');
        }
      },
    };
  }

  function captureSelection(value, start, end) {
    const text = String(value ?? '');
    const clamp = (n) => Math.max(0, Math.min(text.length, Number.isInteger(n) ? n : text.length));
    const a = clamp(start);
    const b = clamp(end);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return { start: from, end: to, text: text.slice(from, to) };
  }

  return { createClipboard, captureSelection, copyWithExecCommand };
});

// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const { openBrowserHarness, wait } = require('./browser-harness.cjs');

async function main() {
  const browser = await openBrowserHarness({ profilePrefix: 'pitech-browser-', portStart: 9300, portEnd: 9800 });
  const { appUrl, send, evaluate, clickPoint, sentFrames, jsErrors } = browser;
  try {
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Log.enable');
    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardReadWrite' }, setting: 'granted' });
    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardSanitizedWrite' }, setting: 'granted' });
    for (let i = 0; i < 40; i++) {
      const ready = await evaluate(`location.href.startsWith('http') && !!document.getElementById('notepad-btn')`);
      if (ready) break;
      await wait(250);
    }
    await wait(800);

    await evaluate(`(() => {
      const input = document.createElement('input');
      input.id = 'clipboard-test-input';
      input.value = 'Before Test After';
      input.style.cssText = 'position:fixed;left:20px;top:20px;width:240px;z-index:99999';
      document.body.appendChild(input);
      input.focus();
      input.setSelectionRange(7, 11);
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
      input.setSelectionRange(0, 17);
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 30 }));
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
          writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        },
      });
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: (command) => command === 'copy',
      });
    })()`);
    const copyPoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('#ctx-menu > .ctx-item')].find((el) => el.textContent.trim() === 'Copy');
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickPoint(copyPoint);
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('toast').textContent`), 'Copied to clipboard', 'Firefox fallback must report a successful copy');

    await send('Browser.setPermission', { origin: appUrl, permission: { name: 'clipboardReadWrite' }, setting: 'denied' });
    await evaluate(`(() => {
      const input = document.getElementById('clipboard-test-input');
      input.value = 'AB';
      input.focus();
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 30 }));
      input.setSelectionRange(2, 2);
    })()`);
    const pastePoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('#ctx-menu > .ctx-item')].find((el) => el.textContent.trim() === 'Paste');
      const r = item.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickPoint(pastePoint);
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('clipboard-test-input').value`), 'ATestB', 'input paste must use the right-click caret captured before the menu took focus');

    await evaluate(`(() => {
      window.__term.selectAll();
      const r = document.getElementById('term-wrap').getBoundingClientRect();
      document.getElementById('term-wrap').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
      window.__term.clearSelection();
      document.getElementById('term-wrap').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    })()`);
    const terminalMenuAfterSelectionClear = await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`);
    assert.equal(terminalMenuAfterSelectionClear, false, 'Firefox right-click must preserve terminal selection for the custom menu');
    await evaluate(`document.getElementById('ctx-menu').classList.add('hidden')`);
    const before = sentFrames.length;
    const terminalPoint = await evaluate(`(() => {
      window.__term.clearSelection();
      const r = document.getElementById('term-wrap').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickPoint(terminalPoint, 'right');
    await wait(300);
    const pasted = sentFrames.slice(before).map((frame) => {
      try {
        const message = JSON.parse(frame);
        return message.type === 'input' ? message.data : '';
      } catch { return ''; }
    }).join('');
    assert.match(pasted, /Test/, 'ordinary terminal right-click must paste cached clipboard text');
    assert.doesNotMatch(pasted, /Before Test After/, 'terminal paste must use only the original highlighted span');
    assert.equal(await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`), true, 'ordinary terminal right-click must not open the menu');

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...terminalPoint, button: 'right', modifiers: 8, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...terminalPoint, button: 'right', modifiers: 8, clickCount: 1 });
    await wait(150);
    assert.equal(await evaluate(`document.getElementById('ctx-menu').classList.contains('hidden')`), false, 'Shift+right-click must open terminal actions');
    assert.equal(await evaluate(`[...document.querySelectorAll('#ctx-menu > .ctx-item')].some((el) => el.textContent.trim() === 'Paste')`), true, 'terminal actions must include Paste');

    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
    await wait(100);
    assert.deepEqual(jsErrors, [], `browser JavaScript errors:\n${jsErrors.join('\n')}`);
    console.log('PiTech clipboard browser checks passed');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const { openBrowserHarness, wait } = require('./browser-harness.cjs');

async function main() {
  const browser = await openBrowserHarness({ profilePrefix: 'pitech-fixes-', portStart: 10400, portEnd: 10700 });
  try {
    const { evaluate, send } = browser;
    const pressKey = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode });
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate(`document.querySelectorAll('#file-root-select option').length > 0`)) break;
      await wait(250);
    }
    await evaluate(`document.getElementById('skills-btn')?.click()`);
    const initial = await evaluate(`(() => ({
      roots: [...document.querySelectorAll('#file-root-select option')].map((option) => option.value),
      rootLabels: [...document.querySelectorAll('#file-root-select option')].map((option) => option.textContent),
      selectedRoot: document.getElementById('file-root-select')?.value,
      activeSkills: document.querySelectorAll('#skills-list .skill-row .dot2.on').length,
      skillCount: document.getElementById('skill-count')?.textContent,
      nestedConversationGroups: document.querySelectorAll('#conv-list .conv-nest > .conv-group').length,
      conversationHeader: document.querySelector('#conv-list .conv-top')?.textContent || '',
      fileRootLabel: document.getElementById('file-root-name')?.textContent,
      pickerColorScheme: getComputedStyle(document.getElementById('file-root-select')).colorScheme,
      fileHeaderContext: document.querySelector('.file-head')?.dataset.ctx || '',
      pastSessionsHeader: document.querySelector('h3[data-ctx="convhead"]')?.textContent || '',
      pathsFolder: [...document.querySelectorAll('#file-tree > .tree-item > .tree-row .tree-name')].some((item) => item.textContent === 'Paths'),
    }))()`);
    assert.deepEqual(initial.roots, ['agent', 'shared', 'pitech']);
    assert.deepEqual(initial.rootLabels, ['Pi workspace', 'Shared agent files', 'PiTech project']);
    assert.equal(initial.selectedRoot, 'agent');
    assert.equal(initial.activeSkills, 0, 'unused skills must not be shown as active');
    assert.match(initial.skillCount, /^0\/\d+ used$/);
    assert.equal(initial.nestedConversationGroups, 0, 'Past Sessions must not contain a redundant conversations folder');
    assert.equal(initial.conversationHeader, '', 'conversation rows should render directly under Past Sessions');
    assert.equal(initial.fileRootLabel, 'Pi workspace');
    assert.equal(initial.pickerColorScheme, 'dark', 'file root picker must use the PiTech dark palette');
    assert.equal(initial.fileHeaderContext, 'filehead');
    assert.match(initial.pastSessionsHeader, /^Past Sessions/);
    assert.equal(initial.pathsFolder, true, 'Paths folder must be visible in the Pi workspace');

    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.__pitechMutationCalls = [];
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (['/api/sessions/copy', '/api/fs/delete-batch', '/api/history/undo', '/api/history/redo'].includes(url)) {
          let body = null;
          try { body = JSON.parse(init.body || 'null'); } catch {}
          window.__pitechMutationCalls.push({ url, body });
          return Promise.resolve(new Response(JSON.stringify({ ok: true, copied: 1, changed: true, label: 'browser check' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return originalFetch(input, init);
      };
    })()`);

    const dragPoints = await evaluate(`(() => {
      const session = [...document.querySelectorAll('#conv-list .session-row[data-ctx="session"]')].find((row) => row.offsetParent !== null);
      const project = [...document.querySelectorAll('#projects-list .project-row')].find((row) => row.offsetParent !== null);
      if (!session || !project) return null;
      const a = session.getBoundingClientRect();
      const b = project.getBoundingClientRect();
      return { from: { x: a.left + a.width / 2, y: a.top + a.height / 2 }, to: { x: b.left + b.width / 2, y: b.top + 8 } };
    })()`);
    assert.ok(dragPoints, 'a past session and project must be visible for drag verification');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...dragPoints.from });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...dragPoints.from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 12; step++) {
      const ratio = step / 12;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: dragPoints.from.x + (dragPoints.to.x - dragPoints.from.x) * ratio,
        y: dragPoints.from.y + (dragPoints.to.y - dragPoints.from.y) * ratio,
        button: 'left',
        buttons: 1,
      });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...dragPoints.to, button: 'left', buttons: 0, clickCount: 1 });
    await wait(200);
    const dragCall = await evaluate(`window.__pitechMutationCalls.find((call) => call.url === '/api/sessions/copy') || null`);
    assert.ok(dragCall?.body?.src, 'dragging a past session into a project must issue a copy request');

    const sessionSelection = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#conv-list .session-row[data-ctx="session"]')]
        .filter((row) => row.offsetParent !== null).slice(0, 3);
      if (rows.length < 3) return 0;
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      return document.querySelectorAll('#conv-list .session-row.selected').length;
    })()`);
    assert.equal(sessionSelection, 3, 'ctrl-click and shift-click must select a session range');

    const sessionMenu = await evaluate(`(() => {
      const row = document.querySelector('#conv-list .session-row.selected');
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      return document.getElementById('ctx-menu')?.textContent || '';
    })()`);
    assert.match(sessionMenu, /Rename selected/);
    await evaluate(`(() => [...document.querySelectorAll('#ctx-menu .ctx-item')].find((item) => item.textContent.trim() === 'Rename selected')?.click())()`);
    await wait(100);
    const renameEditor = await evaluate(`({ count: document.querySelectorAll('#bulk-rename-list input').length, visible: !document.getElementById('bulk-rename-modal')?.classList.contains('hidden') })`);
    assert.equal(renameEditor.count, 3, 'bulk rename must show one editor per selected session');
    assert.equal(renameEditor.visible, true);
    const syncedRename = await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#bulk-rename-list input')];
      const first = inputs[0];
      first.focus();
      first.setSelectionRange(4, 4);
      first.dispatchEvent(new Event('select', { bubbles: true }));
      first.setRangeText('X', 4, 4, 'end');
      first.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'X' }));
      return inputs.map((input) => ({ value: input.value, caret: input.selectionStart }));
    })()`);
    assert.equal(syncedRename.every((item) => item.value[4] === 'X' && item.caret === 5), true, 'bulk rename must mirror edits and caret positions');
    await evaluate(`document.getElementById('bulk-rename-cancel')?.click()`);

    const filesMenu = await evaluate(`(() => {
      const head = document.querySelector('.file-head');
      head?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      return document.getElementById('ctx-menu')?.textContent || '';
    })()`);
    assert.match(filesMenu, /New Folder/);
    await evaluate(`document.getElementById('ctx-menu')?.classList.add('hidden')`);

    const fileSelection = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#file-tree > .tree-item > .tree-row')].slice(0, 2);
      if (rows.length < 2) return 0;
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      return document.querySelectorAll('#file-tree .tree-row.selected').length;
    })()`);
    assert.equal(fileSelection, 2, 'ctrl-click must select multiple files');
    const fileMenu = await evaluate(`(() => {
      const row = document.querySelector('#file-tree .tree-row.selected');
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      return document.getElementById('ctx-menu')?.textContent || '';
    })()`);
    assert.match(fileMenu, /Rename selected/);
    await evaluate(`document.getElementById('ctx-menu')?.classList.add('hidden')`);

    await pressKey('Delete', 'Delete', 46);
    const deletePrompt = await evaluate(`({
      visible: !document.getElementById('confirm-modal')?.classList.contains('hidden'),
      title: document.getElementById('confirm-title')?.textContent || '',
    })`);
    assert.equal(deletePrompt.visible, true, 'Delete must open one confirmation for highlighted files');
    assert.match(deletePrompt.title, /2 selected items/);
    await evaluate(`document.getElementById('confirm-ok')?.click()`);
    await wait(100);
    const deleteCall = await evaluate(`window.__pitechMutationCalls.find((call) => call.url === '/api/fs/delete-batch') || null`);
    assert.equal(deleteCall?.body?.paths?.length, 2, 'highlighted files must be submitted as one grouped delete');

    await evaluate(`window.__pitechMutationCalls.length = 0; document.activeElement?.blur()`);
    await pressKey('z', 'KeyZ', 90, 2);
    await pressKey('y', 'KeyY', 89, 2);
    await pressKey('Z', 'KeyZ', 90, 10);
    const historyCalls = await evaluate(`window.__pitechMutationCalls.map((call) => call.url)`);
    assert.deepEqual(historyCalls, ['/api/history/undo', '/api/history/redo', '/api/history/redo']);

    await evaluate(`(() => {
      document.getElementById('notepad-btn')?.click();
      const input = document.getElementById('notepad-textarea');
      input.value = 'native';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      window.__pitechMutationCalls.length = 0;
    })()`);
    await send('Input.insertText', { text: ' edit' });
    await pressKey('z', 'KeyZ', 90, 2);
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), 'native', 'Ctrl+Z must remain native inside text editors');
    await pressKey('Z', 'KeyZ', 90, 10);
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), 'native edit', 'Ctrl+Shift+Z must remain native inside text editors');
    await pressKey('z', 'KeyZ', 90, 2);
    await pressKey('y', 'KeyY', 89, 2);
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), 'native edit', 'Ctrl+Y must remain native inside text editors');
    await evaluate(`document.getElementById('notepad-textarea').setSelectionRange(0, 6)`);
    await pressKey('Delete', 'Delete', 46);
    assert.equal(await evaluate(`document.getElementById('notepad-textarea').value`), ' edit', 'Delete must remain native inside text editors');
    assert.deepEqual(await evaluate(`window.__pitechMutationCalls.map((call) => call.url)`), [], 'native text shortcuts and Delete must not call workspace history');

    await evaluate(`(() => {
      const editable = document.createElement('div');
      editable.id = 'browser-contenteditable';
      editable.contentEditable = 'plaintext-only';
      editable.textContent = 'editable';
      document.body.append(editable);
      editable.focus();
      window.__pitechMutationCalls.length = 0;
    })()`);
    await pressKey('z', 'KeyZ', 90, 2);
    await pressKey('Z', 'KeyZ', 90, 10);
    await pressKey('Delete', 'Delete', 46);
    assert.deepEqual(await evaluate(`window.__pitechMutationCalls.map((call) => call.url)`), [], 'inherited and plaintext-only contenteditable controls must keep native history and Delete');
    await evaluate(`document.getElementById('browser-contenteditable')?.remove()`);

    const spellMenu = await evaluate(`(() => {
      const input = document.getElementById('notepad-textarea');
      input.value = 'mispelled example';
      input.spellcheck = true;
      input.focus();
      input.setSelectionRange(0, 9);
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      return document.getElementById('ctx-menu')?.textContent || '';
    })()`);
    assert.match(spellMenu, /Spellcheck/);
    const nativeSpellcheck = await evaluate(`(() => {
      const input = document.getElementById('notepad-textarea');
      [...document.querySelectorAll('#ctx-menu .ctx-item')].find((item) => item.textContent.trim() === 'Spellcheck')?.click();
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
      return { allowed: input.dispatchEvent(event), enabled: input.spellcheck };
    })()`);
    assert.equal(nativeSpellcheck.enabled, true);
    assert.equal(nativeSpellcheck.allowed, true, 'native spellcheck should be released only after choosing Spellcheck');

    const opened = await evaluate(`(() => {
      const row = [...document.querySelectorAll('#file-tree > .tree-item > .tree-row')]
        .find((item) => item.querySelector('.tree-name')?.textContent === 'extensions');
      row?.click();
      return !!row;
    })()`);
    assert.equal(opened, true, 'Pi agent root must expose extensions');
    await wait(250);
    const extension = await evaluate(`(() => {
      const row = [...document.querySelectorAll('#file-tree .tree-row.file')]
        .find((item) => item.querySelector('.tree-name')?.textContent === 'pi-webui.ts');
      row?.click();
      return !!row;
    })()`);
    assert.equal(extension, true, 'Pi extension must be reachable in the explorer');
    await wait(250);
    assert.equal(await evaluate(`document.querySelector('#session-body .file-view')?.textContent.includes('registerPiWebui')`), true);
    await evaluate(`document.querySelector('#session-body button')?.click()`);
    assert.equal(await evaluate(`!!document.querySelector('#session-body textarea.file-edit')`), true, 'Pi files must be editable in-browser');
    assert.deepEqual(browser.jsErrors, [], `browser errors: ${browser.jsErrors.join('\n')}`);
    console.log('PiTech fix browser checks passed');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

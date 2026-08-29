// PiTech by Haxnstuff
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  emptyConversationMeta,
  createFolder,
  renameFolder,
  deleteFolder,
  moveConversation,
  renameConversation,
  decorateConversations,
  serializeConversationMeta,
} = require('../conversation-meta');

test('conversation metadata keeps Pi files flat while organizing and pinning display rows', () => {
  const sessions = [
    { path: 'C:\\Users\\jluka\\.pi\\agent\\conversations\\one.jsonl', title: 'Generated one' },
    { path: 'C:\\Users\\jluka\\.pi\\agent\\conversations\\two.jsonl', title: 'Generated two' },
  ];
  let meta = emptyConversationMeta();
  meta = createFolder(meta, 'Research');
  meta = moveConversation(meta, sessions[0].path, 'Research');
  meta = renameConversation(meta, sessions[0].path, 'Readable title');

  const rows = decorateConversations(sessions, meta, [sessions[1].path]);
  assert.deepEqual(rows.map((row) => row.path), [sessions[1].path, sessions[0].path]);
  assert.deepEqual(rows.map((row) => row.title), ['Generated two', 'Readable title']);
  assert.deepEqual(rows.map((row) => row.folder), [null, 'Research']);
  assert.deepEqual(rows.map((row) => row.pinned), [true, false]);
});

test('clearing a conversation name restores the generated title', () => {
  const path = 'C:\\Users\\jluka\\.pi\\agent\\conversations\\one.jsonl';
  let meta = renameConversation(emptyConversationMeta(), path, 'Readable title');
  meta = renameConversation(meta, path, null);
  assert.deepEqual(meta.names, {});
});

test('conversation folders can be renamed and deleted without losing their conversations', () => {
  const path = 'C:\\Users\\jluka\\.pi\\agent\\conversations\\one.jsonl';
  let meta = moveConversation(createFolder(emptyConversationMeta(), 'Research'), path, 'Research');
  meta = renameFolder(meta, 'Research', 'Reference');
  assert.equal(meta.folders[0].name, 'Reference');
  assert.equal(decorateConversations([{ path, title: 'One' }], meta, [])[0].folder, 'Reference');
  meta = deleteFolder(meta, 'Reference');
  assert.equal(meta.folders.length, 0);
  assert.equal(decorateConversations([{ path, title: 'One' }], meta, [])[0].folder, null);
});

test('conversation metadata serializes into the existing pins state shape', () => {
  let meta = createFolder(emptyConversationMeta(), 'Reference');
  meta = renameConversation(meta, 'C:\\one.jsonl', 'One');
  assert.deepEqual(serializeConversationMeta(meta), {
    conversationFolders: [{ name: 'Reference', paths: [] }],
    conversationNames: { 'C:\\one.jsonl': 'One' },
  });
});

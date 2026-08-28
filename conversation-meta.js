// PiTech by Haxnstuff
'use strict';

const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);

function emptyConversationMeta() {
  return { folders: [], names: {} };
}

function normalizeConversationMeta(value) {
  const source = value && typeof value === 'object' ? value : {};
  const names = {};
  for (const [key, value] of Object.entries(source.names || {})) {
    const title = clean(value, 160);
    if (key && title) names[key] = title;
  }
  const folders = [];
  const seen = new Set();
  for (const item of Array.isArray(source.folders) ? source.folders : []) {
    const name = clean(item?.name, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    folders.push({
      name,
      paths: [...new Set((Array.isArray(item?.paths) ? item.paths : []).filter((path) => typeof path === 'string' && path))],
    });
  }
  return { folders, names };
}

function createFolder(meta, name) {
  const next = normalizeConversationMeta(meta);
  const folder = clean(name, 80);
  if (!folder) throw new Error('folder name is required');
  if (next.folders.some((item) => item.name.toLowerCase() === folder.toLowerCase())) {
    throw new Error('folder already exists');
  }
  next.folders.push({ name: folder, paths: [] });
  return next;
}

function renameFolder(meta, oldName, newName) {
  const next = normalizeConversationMeta(meta);
  const oldKey = clean(oldName, 80).toLowerCase();
  const folder = clean(newName, 80);
  const found = next.folders.find((item) => item.name.toLowerCase() === oldKey);
  if (!found) throw new Error('folder not found');
  if (!folder) throw new Error('folder name is required');
  if (next.folders.some((item) => item !== found && item.name.toLowerCase() === folder.toLowerCase())) {
    throw new Error('folder already exists');
  }
  found.name = folder;
  return next;
}

function deleteFolder(meta, name) {
  const next = normalizeConversationMeta(meta);
  const key = clean(name, 80).toLowerCase();
  next.folders = next.folders.filter((item) => item.name.toLowerCase() !== key);
  return next;
}

function moveConversation(meta, conversationPath, folderName) {
  const next = normalizeConversationMeta(meta);
  if (!conversationPath) throw new Error('conversation path is required');
  for (const folder of next.folders) folder.paths = folder.paths.filter((item) => item !== conversationPath);
  const folder = clean(folderName, 80);
  if (folder) {
    const target = next.folders.find((item) => item.name.toLowerCase() === folder.toLowerCase());
    if (!target) throw new Error('folder not found');
    target.paths.push(conversationPath);
  }
  return next;
}

function renameConversation(meta, conversationPath, title) {
  const next = normalizeConversationMeta(meta);
  if (!conversationPath) throw new Error('conversation path is required');
  if (title === null) {
    delete next.names[conversationPath];
    return next;
  }
  const name = clean(title, 160);
  if (!name) throw new Error('conversation title is required');
  next.names[conversationPath] = name;
  return next;
}

function decorateConversations(sessions, meta, pinned) {
  const normalized = normalizeConversationMeta(meta);
  const folderByPath = new Map();
  for (const folder of normalized.folders) for (const conversationPath of folder.paths) folderByPath.set(conversationPath, folder.name);
  const pinnedSet = new Set(Array.isArray(pinned) ? pinned : []);
  return sessions.map((session) => ({
    ...session,
    title: normalized.names[session.path] || session.title,
    folder: folderByPath.get(session.path) || null,
    pinned: pinnedSet.has(session.path),
  })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.mtime || 0) - (a.mtime || 0));
}

function serializeConversationMeta(meta) {
  const normalized = normalizeConversationMeta(meta);
  return {
    conversationFolders: normalized.folders,
    conversationNames: normalized.names,
  };
}

module.exports = {
  emptyConversationMeta,
  normalizeConversationMeta,
  createFolder,
  renameFolder,
  deleteFolder,
  moveConversation,
  renameConversation,
  decorateConversations,
  serializeConversationMeta,
};

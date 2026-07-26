const { createHash, randomUUID } = require('crypto');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function createSourceHash(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function normalizeRemoteId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    return fallback;
  }

  return String(value);
}

function normalizeListItems(item = {}) {
  const listItems = item.items || item.listItems || item.listContent;
  if (!Array.isArray(listItems)) {
    return null;
  }

  return listItems
    .map((listItem) => {
      const text = normalizeText(listItem.text || listItem.name || listItem.content).trim();
      if (!text) {
        return null;
      }

      return `${listItem.checked || listItem.isChecked ? '[x]' : '[ ]'} ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeBody(item = {}) {
  const listBody = normalizeListItems(item);
  if (listBody) {
    return listBody;
  }

  const directBody = item.text ?? item.content ?? item.body;
  const body = normalizeText(directBody, '');
  if (body) {
    return body;
  }

  return '';
}

function normalizeColor(value) {
  if (typeof value !== 'string') {
    return '#fff59d';
  }

  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '#fff59d';
}

function toKeepMetadata(item = {}, sourceHash) {
  const remoteId = normalizeRemoteId(item.id);

  return {
    id: remoteId,
    type: 'note',
    accountEmail: item.accountEmail || null,
    url: item.url || null,
    source: 'google-keep-export',
    sourceHash,
    importedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    lastRemoteEditedAt: item.lastRemoteEditedAt || null,
    lastRemoteHash: item.lastRemoteHash || null,
    lastLocalSyncedHash: item.lastLocalSyncedHash || null,
    localRevision: item.localRevision ?? 0,
    remoteRevision: item.remoteRevision ?? null,
    dirtyFields: [],
    syncState: 'synced',
    lastError: null
  };
}

function normalizeKeepNotes(items = []) {
  return items.map((item) => {
    const remoteId = normalizeRemoteId(item.id);
    const title = normalizeText(item.title ?? item.name, 'Imported note') || 'Imported note';
    const body = normalizeBody(item);
    const color = normalizeColor(item.color);
    const createdAt = item.createdAt || item.created || null;
    const updatedAt = item.updatedAt || item.updated || item.lastEdited || createdAt || null;
    const sourceHash = createSourceHash({
      remoteId,
      title,
      body,
      color,
      createdAt,
      updatedAt,
      pinned: Boolean(item.pinned),
      archived: Boolean(item.archived),
      trashed: Boolean(item.trashed)
    });

    return {
      id: item.localId || (remoteId ? randomUUID() : `keep-import-${sourceHash.slice(0, 32)}`),
      title,
      body,
      x: item.x ?? 140,
      y: item.y ?? 140,
      width: item.width ?? 240,
      height: item.height ?? 220,
      color,
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: updatedAt || new Date().toISOString(),
      importedFromKeep: true,
      keep: toKeepMetadata(item, sourceHash),
      keepFields: {
        pinned: Boolean(item.pinned),
        archived: Boolean(item.archived),
        trashed: Boolean(item.trashed)
      }
    };
  });
}

function mergeKeepNotes(existingNotes = [], remoteNotes = []) {
  const merged = [...existingNotes];

  remoteNotes.forEach((normalized) => {
    const remoteId = normalized.keep?.id;
    const hasRemoteId = typeof remoteId === 'string' && remoteId.trim().length > 0;
    const existingIndex = hasRemoteId
      ? merged.findIndex((note) => note.keep?.id === remoteId)
      : -1;

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        title: normalized.title,
        body: normalized.body,
        color: normalized.color,
        updatedAt: normalized.updatedAt,
        importedFromKeep: true,
        keep: {
          ...merged[existingIndex].keep,
          ...normalized.keep,
          lastSyncedAt: new Date().toISOString()
        },
        keepFields: {
          ...merged[existingIndex].keepFields,
          ...normalized.keepFields
        }
      };
      return;
    }

    const sourceHash = normalized.keep?.sourceHash;
    const sourceIndex = !hasRemoteId && sourceHash
      ? merged.findIndex((note) => note.keep?.sourceHash === sourceHash)
      : -1;

    if (sourceIndex >= 0) {
      merged[sourceIndex] = {
        ...merged[sourceIndex],
        title: normalized.title,
        body: normalized.body,
        color: normalized.color,
        updatedAt: normalized.updatedAt,
        importedFromKeep: true,
        keep: {
          ...merged[sourceIndex].keep,
          ...normalized.keep,
          lastSyncedAt: new Date().toISOString()
        },
        keepFields: {
          ...merged[sourceIndex].keepFields,
          ...normalized.keepFields
        }
      };
      return;
    }

    const fallbackIndex = merged.findIndex((note) => note.id === normalized.id);
    if (fallbackIndex >= 0) {
      merged[fallbackIndex] = {
        ...merged[fallbackIndex],
        title: normalized.title,
        body: normalized.body,
        color: normalized.color,
        updatedAt: normalized.updatedAt,
        importedFromKeep: true,
        keep: {
          ...merged[fallbackIndex].keep,
          ...normalized.keep,
          lastSyncedAt: new Date().toISOString()
        },
        keepFields: {
          ...merged[fallbackIndex].keepFields,
          ...normalized.keepFields
        }
      };
      return;
    }

    merged.push(normalized);
  });

  return merged;
}

async function syncKeepNotes(noteStore, options = {}) {
  const { keepApi } = options;

  if (!keepApi) {
    return [];
  }

  const notes = await keepApi.getAllNotes();
  const normalized = normalizeKeepNotes(notes);
  const existing = noteStore.loadNotes();
  const merged = mergeKeepNotes(existing, normalized);
  noteStore.saveNotes(merged);
  return merged;
}

module.exports = {
  normalizeKeepNotes,
  syncKeepNotes,
  mergeKeepNotes
};

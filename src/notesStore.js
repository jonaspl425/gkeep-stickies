const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const TITLE_LIMIT = 200;
const BODY_LIMIT = 20000;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 160;
const MAX_WINDOW_VALUE = 10000;
const DEFAULT_COLOR = '#ffffff';

function sanitizeText(value, fallback = '', limit = BODY_LIMIT) {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    return fallback;
  }

  return String(value).slice(0, limit);
}

function sanitizeId(value, fallback = randomUUID()) {
  const id = sanitizeText(value, '', 200).trim();
  return id || fallback;
}

function sanitizeNumber(value, fallback, min = 0, max = MAX_WINDOW_VALUE) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function sanitizeColor(value, fallback = DEFAULT_COLOR) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

function sanitizeDate(value, fallback = new Date().toISOString()) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function sanitizeKeepMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null,
    type: sanitizeText(value.type, 'note', 40),
    accountEmail: typeof value.accountEmail === 'string' && value.accountEmail.trim() ? value.accountEmail.trim() : null,
    url: typeof value.url === 'string' && value.url.trim() ? value.url.trim() : null,
    source: sanitizeText(value.source, 'google-keep-export', 80),
    sourceHash: typeof value.sourceHash === 'string' && value.sourceHash.trim() ? value.sourceHash.trim() : null,
    importedAt: sanitizeDate(value.importedAt),
    lastSyncedAt: sanitizeDate(value.lastSyncedAt),
    lastRemoteEditedAt: typeof value.lastRemoteEditedAt === 'string' ? sanitizeDate(value.lastRemoteEditedAt) : null,
    lastRemoteHash: typeof value.lastRemoteHash === 'string' && value.lastRemoteHash.trim() ? value.lastRemoteHash.trim() : null,
    lastLocalSyncedHash: typeof value.lastLocalSyncedHash === 'string' && value.lastLocalSyncedHash.trim() ? value.lastLocalSyncedHash.trim() : null,
    localRevision: sanitizeNumber(value.localRevision, 0, 0, Number.MAX_SAFE_INTEGER),
    remoteRevision: Number.isFinite(value.remoteRevision) ? sanitizeNumber(value.remoteRevision, 0, 0, Number.MAX_SAFE_INTEGER) : null,
    dirtyFields: Array.isArray(value.dirtyFields)
      ? value.dirtyFields.filter((field) => typeof field === 'string').slice(0, 20)
      : [],
    syncState: sanitizeText(value.syncState, 'synced', 40),
    lastError: value.lastError === null || value.lastError === undefined ? null : sanitizeText(value.lastError, null, 500)
  };
}

function createDefaultKeepMetadata(existing = {}) {
  const now = new Date().toISOString();
  return {
    id: null,
    type: 'note',
    accountEmail: null,
    url: null,
    source: 'local',
    sourceHash: null,
    importedAt: now,
    lastSyncedAt: now,
    lastRemoteEditedAt: null,
    lastRemoteHash: null,
    lastLocalSyncedHash: null,
    localRevision: 0,
    remoteRevision: null,
    dirtyFields: [],
    syncState: 'dirty',
    lastError: null,
    ...existing
  };
}

function sanitizeKeepFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const keepFields = {
    pinned: Boolean(value.pinned),
    archived: Boolean(value.archived),
    trashed: Boolean(value.trashed)
  };

  if (Array.isArray(value.labels)) {
    keepFields.labels = value.labels
      .filter((label) => label && typeof label === 'object')
      .slice(0, 100)
      .map((label) => ({
        id: sanitizeText(label.id, '', 200),
        name: sanitizeText(label.name, '', 200)
      }))
      .filter((label) => label.id || label.name);
  }

  return keepFields;
}

function sanitizeNoteRecord(input = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const note = {
    id: sanitizeId(input.id),
    title: sanitizeText(input.title, '', TITLE_LIMIT),
    body: sanitizeText(input.body, '', BODY_LIMIT),
    x: sanitizeNumber(input.x, 140),
    y: sanitizeNumber(input.y, 140),
    width: sanitizeNumber(input.width, 240, MIN_WIDTH),
    height: sanitizeNumber(input.height, 220, MIN_HEIGHT),
    color: sanitizeColor(input.color),
    positionLocked: Boolean(input.positionLocked),
    createdAt: sanitizeDate(input.createdAt, now),
    updatedAt: sanitizeDate(input.updatedAt, now),
    importedFromKeep: Boolean(input.importedFromKeep)
  };

  const keep = sanitizeKeepMetadata(input.keep);
  if (keep) {
    note.keep = keep;
  }

  const keepFields = sanitizeKeepFields(input.keepFields);
  if (keepFields) {
    note.keepFields = keepFields;
  }

  return note;
}

function createNoteStore(storagePath = path.join(__dirname, '..', 'data', 'notes.json'), options = {}) {
  const migrateFrom = typeof options.migrateFrom === 'string' ? options.migrateFrom : null;

  function migrateLegacyStorage() {
    if (!migrateFrom || fs.existsSync(storagePath)) {
      return;
    }

    const sourcePath = path.resolve(migrateFrom);
    const targetPath = path.resolve(storagePath);
    if (sourcePath !== targetPath && fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  function ensureStorageDir() {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  }

  function ensureStorageFile() {
    ensureStorageDir();
    migrateLegacyStorage();
    const exists = fs.existsSync(storagePath);
    if (!exists) {
      fs.writeFileSync(storagePath, '[]', 'utf8');
    }
    return exists;
  }

  function createCorruptStoragePath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${storagePath}.corrupt.${timestamp}.${randomUUID()}`;
  }

  function recoverCorruptStorage() {
    const corruptPath = createCorruptStoragePath();
    fs.renameSync(storagePath, corruptPath);
    fs.writeFileSync(storagePath, '[]', 'utf8');
    return corruptPath;
  }

  function readNotes() {
    ensureStorageFile();
    const raw = fs.readFileSync(storagePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      recoverCorruptStorage();
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((note) => note && typeof note === 'object' && !Array.isArray(note))
      .map((note) => sanitizeNoteRecord(note));
  }

  function writeNotes(notes) {
    ensureStorageDir();
    const tempPath = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
    const sanitizedNotes = Array.isArray(notes)
      ? notes
        .filter((note) => note && typeof note === 'object' && !Array.isArray(note))
        .map((note) => sanitizeNoteRecord(note))
      : [];

    try {
      fs.writeFileSync(tempPath, JSON.stringify(sanitizedNotes, null, 2), 'utf8');
      fs.renameSync(tempPath, storagePath);
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }

    return sanitizedNotes;
  }

  function createDefaultNotes() {
    return [
      {
        id: randomUUID(),
        title: 'Welcome',
        body: 'Drag this note around and keep it on top of other apps.',
        x: 120,
        y: 120,
        width: 240,
        height: 220,
        color: '#ffe082',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importedFromKeep: false
      },
      {
        id: randomUUID(),
        title: 'Keep export/import',
        body: 'Use Import Keep JSON in the main window to bring in notes from a Google Keep export.',
        x: 420,
        y: 140,
        width: 240,
        height: 220,
        color: '#c8e6c9',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importedFromKeep: true
      }
    ];
  }

  function loadNotes({ seedDefaults = false } = {}) {
    const hadExistingFile = ensureStorageFile();
    const notes = readNotes();
    if (notes.length > 0) {
      return notes;
    }
    if (seedDefaults && !hadExistingFile) {
      return writeNotes(createDefaultNotes());
    }
    return [];
  }

  function resetNotes() {
    if (fs.existsSync(storagePath)) {
      fs.unlinkSync(storagePath);
    }
    ensureStorageFile();
    return writeNotes([]);
  }

  function saveNotes(notes) {
    return writeNotes(notes);
  }

  function createBackup(reason = 'manual', metadata = {}) {
    ensureStorageFile();
    const backupDir = path.join(path.dirname(storagePath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const backupPath = path.join(backupDir, `notes-${reason}-${stamp}.json`);
    const metadataPath = `${backupPath}.meta.json`;
    fs.copyFileSync(storagePath, backupPath);
    fs.writeFileSync(metadataPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      reason,
      notesCount: readNotes().length,
      ...metadata
    }, null, 2), 'utf8');

    return { backupPath, metadataPath };
  }

  function createNote(input = {}) {
    const notes = readNotes();
    const now = new Date().toISOString();
    const note = sanitizeNoteRecord({
      id: input.id || randomUUID(),
      title: input.title ?? '',
      body: input.body || '',
      x: input.x ?? 140,
      y: input.y ?? 140,
      width: input.width ?? 240,
      height: input.height ?? 220,
      color: input.color || DEFAULT_COLOR,
      positionLocked: Boolean(input.positionLocked),
      createdAt: input.createdAt || now,
      updatedAt: now,
      importedFromKeep: Boolean(input.importedFromKeep),
      keep: input.keep,
      keepFields: input.keepFields
    }, { now });
    notes.push(note);
    writeNotes(notes);
    return note;
  }

  function updateNote(updated) {
    const notes = readNotes();
    const index = notes.findIndex((note) => note.id === updated.id);
    if (index === -1) {
      throw new Error(`Note ${updated.id} not found`);
    }

    notes[index] = sanitizeNoteRecord({
      ...notes[index],
      ...updated,
      id: notes[index].id,
      updatedAt: new Date().toISOString()
    });
    writeNotes(notes);
    return notes[index];
  }

  function patchNote(id, patch = {}) {
    const notes = readNotes();
    const index = notes.findIndex((note) => note.id === id);
    if (index === -1) {
      throw new Error(`Note ${id} not found`);
    }

    const allowedFields = ['title', 'body', 'x', 'y', 'width', 'height', 'color', 'positionLocked'];
    const sanitizedPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => allowedFields.includes(key))
    );

    notes[index] = sanitizeNoteRecord({
      ...notes[index],
      ...sanitizedPatch,
      updatedAt: new Date().toISOString()
    });
    writeNotes(notes);
    return notes[index];
  }

  function markNoteDirty(id, fields = []) {
    const notes = readNotes();
    const index = notes.findIndex((note) => note.id === id);
    if (index === -1) {
      throw new Error(`Note ${id} not found`);
    }

    const existingKeep = createDefaultKeepMetadata(notes[index].keep || {});
    const dirtyFields = Array.from(new Set([
      ...(existingKeep.dirtyFields || []),
      ...fields.filter((field) => typeof field === 'string')
    ]));

    notes[index] = sanitizeNoteRecord({
      ...notes[index],
      keep: {
        ...existingKeep,
        dirtyFields,
        syncState: dirtyFields.length ? 'dirty' : existingKeep.syncState,
        localRevision: (existingKeep.localRevision || 0) + 1
      }
    });
    writeNotes(notes);
    return notes[index];
  }

  function markNoteSynced(id, keepPatch = {}, keepFieldsPatch = {}, options = {}) {
    const notes = readNotes();
    const index = notes.findIndex((note) => note.id === id);
    if (index === -1) {
      throw new Error(`Note ${id} not found`);
    }

    const now = new Date().toISOString();
    const existingKeep = createDefaultKeepMetadata(notes[index].keep || {});
    const expectedLocalRevision = Number.isFinite(options.expectedLocalRevision)
      ? options.expectedLocalRevision
      : null;
    const hasNewerLocalChanges = expectedLocalRevision !== null && existingKeep.localRevision > expectedLocalRevision;
    const dirtyFields = hasNewerLocalChanges ? existingKeep.dirtyFields : [];

    notes[index] = sanitizeNoteRecord({
      ...notes[index],
      keep: {
        ...existingKeep,
        ...keepPatch,
        lastSyncedAt: now,
        dirtyFields,
        syncState: dirtyFields.length ? 'dirty' : 'synced',
        lastError: null
      },
      keepFields: {
        ...(notes[index].keepFields || {}),
        ...keepFieldsPatch
      }
    });
    writeNotes(notes);
    return notes[index];
  }

  function deleteNote(id) {
    const notes = readNotes().filter((note) => note.id !== id);
    writeNotes(notes);
    return notes;
  }

  function reorderNotes(orderedIds = []) {
    const notes = readNotes();
    const requestedIds = Array.isArray(orderedIds)
      ? orderedIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    const uniqueIds = Array.from(new Set(requestedIds));
    const uniqueIdSet = new Set(uniqueIds);
    const notesById = new Map(notes.map((note) => [note.id, note]));
    const reordered = uniqueIds
      .filter((id) => notesById.has(id))
      .map((id) => notesById.get(id));
    const remaining = notes.filter((note) => !uniqueIdSet.has(note.id));

    return writeNotes([...reordered, ...remaining]);
  }

  return {
    loadNotes,
    saveNotes,
    createBackup,
    createNote,
    updateNote,
    patchNote,
    markNoteDirty,
    markNoteSynced,
    reorderNotes,
    deleteNote,
    resetNotes
  };
}

module.exports = {
  createNoteStore
};

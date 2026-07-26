const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const { createHash } = require('crypto');
const { createNoteStore } = require('./notesStore');
const { syncKeepNotes } = require('./keepSync');
const { createCredentialStore } = require('./credentialStore');
const { createKeepBridgeManager } = require('./keepBridgeManager');

const projectRoot = path.join(__dirname, '..');
const noteStore = createNoteStore();
let mainWindow;
const stickyWindows = new Map();
let credentialStore;
let keepBridge;
let pendingOnboarding = null;
let keepSyncState = {
  connected: false,
  email: null,
  status: 'Import a Google Keep export JSON file to merge notes.',
  lastSyncedAt: null,
  error: null
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Sticky Notes',
    backgroundColor: '#f6f0d8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function closeStickyWindow(id) {
  const window = stickyWindows.get(id);
  stickyWindows.delete(id);
  if (window && !window.isDestroyed()) {
    window.removeAllListeners('closed');
    window.destroy();
  }
}

function destroyAllStickyWindows() {
  Array.from(stickyWindows.entries()).forEach(([id, window]) => {
    stickyWindows.delete(id);
    if (window && !window.isDestroyed()) {
      window.removeAllListeners('closed');
      window.destroy();
    }
  });

  BrowserWindow.getAllWindows().forEach((window) => {
    if (window !== mainWindow && !window.isDestroyed()) {
      window.destroy();
    }
  });
}

function ensureStickyWindow(note) {
  const existing = stickyWindows.get(note.id);
  if (existing) {
    if (existing.isDestroyed()) {
      stickyWindows.delete(note.id);
    } else {
      existing.webContents.send('note:data', note);
      return existing;
    }
  }

  const window = new BrowserWindow({
    width: note.width ?? 240,
    height: note.height ?? 220,
    x: note.x ?? 140,
    y: note.y ?? 140,
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    acceptFirstMouse: true,
    backgroundColor: '#f6f0d8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadFile(path.join(__dirname, 'note.html'), {
    query: { noteId: note.id }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-finish-load', () => {
    window.webContents.send('note:data', note);
  });
  window.on('closed', () => {
    if (stickyWindows.get(note.id) === window) {
      stickyWindows.delete(note.id);
    }
  });

  stickyWindows.set(note.id, window);
  return window;
}

function refreshMainWindow(notes) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notes:changed', notes);
  }
}

function broadcastKeepStatus() {
  const payload = { ...keepSyncState };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('keep:status-changed', payload);
  }
}

function syncNoteWindow(note) {
  const window = ensureStickyWindow(note);
  window.webContents.send('note:data', note);
}

function focusNoteWindow(note) {
  const window = ensureStickyWindow(note);
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
    window.webContents.send('note:data', note);
  }
  return note;
}

function syncAllNoteWindows(notes) {
  notes.forEach((note) => ensureStickyWindow(note));
}

function closeMissingStickyWindows(notes) {
  const liveIds = new Set(notes.map((note) => note.id));
  Array.from(stickyWindows.entries()).forEach(([id, window]) => {
    if (!liveIds.has(id) && window && !window.isDestroyed()) {
      closeStickyWindow(id);
    }
  });
}

function getCredentialStore() {
  if (!credentialStore) {
    credentialStore = createCredentialStore(app, safeStorage);
  }
  return credentialStore;
}

function getKeepBridge() {
  if (!keepBridge) {
    keepBridge = createKeepBridgeManager({
      projectRoot,
      scriptPath: path.join(__dirname, 'keep_bridge', 'server.py')
    });
  }
  return keepBridge;
}

function setKeepStatus(patch) {
  keepSyncState = {
    ...keepSyncState,
    ...patch
  };
  broadcastKeepStatus();
  return keepSyncState;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOnboardingSettings(value = {}) {
  return {
    pullRemote: value.pullRemote !== false,
    uploadLocal: value.uploadLocal !== false,
    trashRemoteOnLocalDelete: value.trashRemoteOnLocalDelete !== false,
    includeArchived: Boolean(value.includeArchived),
    includeTrashed: Boolean(value.includeTrashed)
  };
}

function filterRemoteNotes(notes, settings = {}) {
  return notes.filter((note) => {
    if (!settings.includeArchived && note.archived) {
      return false;
    }
    if (!settings.includeTrashed && note.trashed) {
      return false;
    }
    return true;
  });
}

function createPreviewHash(preview) {
  return createHash('sha256')
    .update(JSON.stringify(preview))
    .digest('hex');
}

function hasKeepId(note) {
  return typeof note.keep?.id === 'string' && note.keep.id.trim().length > 0;
}

function createOnboardingPreview({ localNotes, remoteNotes, settings, email }) {
  const remoteActiveNotes = settings.pullRemote ? filterRemoteNotes(remoteNotes, settings) : [];
  const localToUpload = settings.uploadLocal
    ? localNotes.filter((note) => !hasKeepId(note))
    : [];
  const preview = {
    email,
    remoteCount: remoteNotes.length,
    localCount: localNotes.length,
    createLocalCount: remoteActiveNotes.length,
    createRemoteCount: localToUpload.length,
    skippedArchivedCount: settings.includeArchived ? 0 : remoteNotes.filter((note) => note.archived).length,
    skippedTrashedCount: settings.includeTrashed ? 0 : remoteNotes.filter((note) => note.trashed).length,
    destructiveActionCount: 0,
    settings
  };

  return {
    ...preview,
    previewHash: createPreviewHash(preview)
  };
}

async function authenticateKeepBridge({ email, masterToken }) {
  const bridge = getKeepBridge();
  await bridge.request('bridge.ping', {});
  await bridge.request('bridge.version', {});
  return bridge.request('auth.configure', { email, masterToken }, 60000);
}

function syncRelevantFieldsFromPatch(patch = {}) {
  return Object.keys(patch).filter((field) => ['title', 'body', 'color'].includes(field));
}

async function pullRemoteKeepNotes({ email, settings }) {
  const bridge = getKeepBridge();
  const result = await bridge.request('sync.fullPull', {}, 90000);
  return filterRemoteNotes(result.notes || [], settings).map((note) => ({
    ...note,
    accountEmail: email
  }));
}

async function mergeRemoteKeepNotes({ email, settings }) {
  const remoteNotes = await pullRemoteKeepNotes({ email, settings });
  const noteList = await syncKeepNotes(noteStore, {
    keepApi: {
      getAllNotes: async () => remoteNotes
    }
  });
  closeMissingStickyWindows(noteList);
  refreshMainWindow(noteList);
  return noteList;
}

async function createRemoteFromLocal(note, email) {
  const bridge = getKeepBridge();
  const result = await bridge.request('notes.createText', {
    title: note.title || '',
    text: note.body || '',
    color: note.color,
    pinned: Boolean(note.keepFields?.pinned),
    archived: Boolean(note.keepFields?.archived)
  }, 90000);
  const remote = result.note || {};
  return noteStore.markNoteSynced(note.id, {
    id: remote.id,
    accountEmail: email,
    source: 'google-keep',
    importedAt: note.keep?.importedAt || new Date().toISOString(),
    lastRemoteEditedAt: remote.updatedAt || remote.lastRemoteEditedAt || null
  }, {
    pinned: Boolean(remote.pinned),
    archived: Boolean(remote.archived),
    trashed: Boolean(remote.trashed)
  });
}

async function updateRemoteFromLocal(note) {
  const bridge = getKeepBridge();
  const result = await bridge.request('notes.updateText', {
    keepId: note.keep.id,
    patch: {
      title: note.title || '',
      body: note.body || '',
      color: note.color,
      pinned: Boolean(note.keepFields?.pinned),
      archived: Boolean(note.keepFields?.archived)
    }
  }, 90000);
  const remote = result.note || {};
  return noteStore.markNoteSynced(note.id, {
    id: remote.id || note.keep.id,
    accountEmail: note.keep.accountEmail,
    source: note.keep.source || 'google-keep',
    lastRemoteEditedAt: remote.updatedAt || remote.lastRemoteEditedAt || null
  }, {
    pinned: Boolean(remote.pinned),
    archived: Boolean(remote.archived),
    trashed: Boolean(remote.trashed)
  });
}

async function pushLocalChanges({ email, settings }) {
  const notes = noteStore.loadNotes({ seedDefaults: false });

  for (const note of notes) {
    if (!hasKeepId(note)) {
      if (settings.uploadLocal) {
        await createRemoteFromLocal(note, email);
      }
      continue;
    }

    if (Array.isArray(note.keep?.dirtyFields) && note.keep.dirtyFields.length > 0) {
      await updateRemoteFromLocal(note);
    }
  }
}

async function syncKeepAccount() {
  const credentials = getCredentialStore().load();
  if (!credentials) {
    throw new Error('Connect Google Keep before syncing.');
  }

  const email = normalizeEmail(credentials.email);
  const settings = normalizeOnboardingSettings(credentials.settings);
  setKeepStatus({ connected: true, email, status: 'Authenticating Google Keep...', error: null });
  await authenticateKeepBridge({ email, masterToken: credentials.masterToken });
  setKeepStatus({ connected: true, email, status: 'Pushing local changes...', error: null });
  await pushLocalChanges({ email, settings });
  setKeepStatus({ connected: true, email, status: 'Pulling Google Keep notes...', error: null });
  const notes = await mergeRemoteKeepNotes({ email, settings });
  setKeepStatus({
    connected: true,
    email,
    status: 'Synced',
    lastSyncedAt: new Date().toISOString(),
    error: null
  });
  return notes;
}

async function trashRemoteKeepNote(note) {
  const credentials = getCredentialStore().load();
  if (!credentials || !hasKeepId(note)) {
    return false;
  }

  const settings = normalizeOnboardingSettings(credentials.settings);
  if (!settings.trashRemoteOnLocalDelete) {
    return false;
  }

  const email = normalizeEmail(credentials.email);
  await authenticateKeepBridge({ email, masterToken: credentials.masterToken });
  await getKeepBridge().request('notes.trash', { keepId: note.keep.id }, 90000);
  return true;
}

app.whenReady().then(() => {
  createMainWindow();
  const storedCredentialStatus = getCredentialStore().getStatus();
  if (storedCredentialStatus) {
    keepSyncState = {
      connected: true,
      email: storedCredentialStatus.email,
      status: 'Connected. Click Sync now to update Google Keep.',
      lastSyncedAt: keepSyncState.lastSyncedAt,
      error: null
    };
  }
  let notes = noteStore.loadNotes({ seedDefaults: true });
  const hasPlaceholderNotes = notes.some((note) => (
    note.title === 'Welcome' ||
    note.title === 'Google Keep import' ||
    note.title === 'Keep export/import'
  ));
  if (hasPlaceholderNotes) {
    noteStore.resetNotes();
    notes = [];
  }
  destroyAllStickyWindows();
  syncAllNoteWindows(notes);
  refreshMainWindow(notes);
  broadcastKeepStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    refreshMainWindow(noteStore.loadNotes({ seedDefaults: false }));
  } else {
    createMainWindow();
  }
});

app.on('before-quit', () => {
  destroyAllStickyWindows();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('notes:load', () => noteStore.loadNotes({ seedDefaults: false }));

ipcMain.handle('notes:get-one', (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  return noteStore.loadNotes({ seedDefaults: false }).find((note) => note.id === id) || null;
});

ipcMain.handle('notes:create', (_event, payload = {}) => {
  const note = noteStore.createNote(payload);
  syncNoteWindow(note);
  const notes = noteStore.loadNotes();
  closeMissingStickyWindows(notes);
  refreshMainWindow(notes);
  return note;
});

ipcMain.handle('notes:update', (_event, note = {}) => {
  if (typeof note.id !== 'string' || note.id.length === 0) {
    return null;
  }

  let updated = noteStore.updateNote(note);
  if (keepSyncState.connected) {
    updated = noteStore.markNoteDirty(updated.id, ['title', 'body', 'color']);
  }
  syncNoteWindow(updated);
  const notes = noteStore.loadNotes();
  refreshMainWindow(notes);
  return updated;
});

ipcMain.handle('notes:patch', (_event, payload = {}) => {
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return null;
  }

  let updated = noteStore.patchNote(payload.id, payload.patch || {});
  const dirtyFields = syncRelevantFieldsFromPatch(payload.patch || {});
  if (keepSyncState.connected && dirtyFields.length > 0) {
    updated = noteStore.markNoteDirty(updated.id, dirtyFields);
  }
  syncNoteWindow(updated);
  const notes = noteStore.loadNotes();
  refreshMainWindow(notes);
  return updated;
});

ipcMain.handle('notes:show', (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  const note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  if (!note) {
    return null;
  }

  return focusNoteWindow(note);
});

ipcMain.handle('notes:delete', async (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }

  const note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  if (note && keepSyncState.connected) {
    await trashRemoteKeepNote(note);
  }

  noteStore.deleteNote(id);
  closeStickyWindow(id);
  const notes = noteStore.loadNotes();
  closeMissingStickyWindows(notes);
  refreshMainWindow(notes);
  return true;
});

ipcMain.handle('notes:clear', () => {
  noteStore.resetNotes();
  destroyAllStickyWindows();
  refreshMainWindow([]);
  return true;
});

ipcMain.handle('window:close-current', (_event) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed() && window !== mainWindow) {
    window.destroy();
  }
  return true;
});

ipcMain.handle('notes:import', async () => {
  const { dialog } = require('electron');
  const fs = require('fs');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import notes from a JSON file',
    filters: [{ name: 'JSON files', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) {
    return [];
  }

  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  const importedNotes = Array.isArray(parsed) ? parsed : parsed.notes || [];

  importedNotes.forEach((item) => {
    const note = noteStore.createNote({
      title: item.title || 'Imported note',
      body: item.body || item.content || '',
      x: item.x ?? 140,
      y: item.y ?? 140,
      color: item.color || '#fff59d',
      importedFromKeep: true
    });
    syncNoteWindow(note);
  });

  const notes = noteStore.loadNotes();
  closeMissingStickyWindows(notes);
  refreshMainWindow(notes);
  return notes;
});

async function syncKeepFromSelection() {
  const fs = require('fs');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import notes from a Google Keep export JSON file',
    filters: [{ name: 'JSON files', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) {
    return [];
  }

  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  const importedNotes = Array.isArray(parsed) ? parsed : parsed.notes || [];
  const notes = syncKeepNotes(noteStore, { keepApi: { getAllNotes: async () => importedNotes } });
  const noteList = await notes;
  noteList.forEach((note) => syncNoteWindow(note));
  closeMissingStickyWindows(noteList);
  refreshMainWindow(noteList);
  keepSyncState = {
    ...keepSyncState,
    status: 'Imported selected Keep export',
    lastSyncedAt: new Date().toISOString(),
    error: null
  };
  broadcastKeepStatus();
  return noteList;
}

ipcMain.handle('notes:sync-keep', async () => {
  try {
    return await syncKeepFromSelection();
  } catch (error) {
    keepSyncState = {
      ...keepSyncState,
      status: 'Import failed',
      error: error.message
    };
    broadcastKeepStatus();
    throw new Error(`Google Keep import failed: ${error.message}`);
  }
});

ipcMain.handle('keep:onboarding-preview', async (_event, payload = {}) => {
  const email = normalizeEmail(payload.email);
  const masterToken = typeof payload.masterToken === 'string' ? payload.masterToken.trim() : '';
  const settings = normalizeOnboardingSettings(payload.settings || {});

  if (!email || !email.includes('@')) {
    throw new Error('Enter a valid Google account email.');
  }
  if (!masterToken) {
    throw new Error('Enter a Google Keep master token.');
  }

  setKeepStatus({ connected: false, email, status: 'Testing Google Keep connection...', error: null });
  await authenticateKeepBridge({ email, masterToken });
  const remoteNotes = await pullRemoteKeepNotes({ email, settings: { ...settings, includeArchived: true, includeTrashed: true } });
  const localNotes = noteStore.loadNotes({ seedDefaults: false });
  const preview = createOnboardingPreview({ localNotes, remoteNotes, settings, email });

  pendingOnboarding = {
    email,
    masterToken,
    settings,
    remoteNotes,
    previewHash: preview.previewHash
  };

  setKeepStatus({ connected: false, email, status: 'First sync preview ready.', error: null });
  return preview;
});

ipcMain.handle('keep:onboarding-apply', async (_event, payload = {}) => {
  if (!pendingOnboarding) {
    throw new Error('Create a Google Keep sync preview before applying onboarding.');
  }
  if (payload.previewHash !== pendingOnboarding.previewHash) {
    throw new Error('The first sync preview is stale. Create a new preview before applying.');
  }

  const { email, masterToken, settings } = pendingOnboarding;
  setKeepStatus({ connected: false, email, status: 'Creating local backup...', error: null });
  const backup = noteStore.createBackup('before-keep-sync', { accountEmail: email });
  getCredentialStore().save({ email, masterToken, settings });
  setKeepStatus({ connected: true, email, status: 'Applying first sync...', error: null });
  await authenticateKeepBridge({ email, masterToken });
  await pushLocalChanges({ email, settings });
  const notes = settings.pullRemote
    ? await mergeRemoteKeepNotes({ email, settings })
    : noteStore.loadNotes({ seedDefaults: false });

  keepSyncState = {
    connected: true,
    email,
    status: 'Connected and synced',
    lastSyncedAt: new Date().toISOString(),
    error: null,
    backupPath: backup.backupPath
  };
  pendingOnboarding = null;
  broadcastKeepStatus();
  refreshMainWindow(notes);
  return { status: keepSyncState, backup, notes };
});

ipcMain.handle('keep:disconnect', () => {
  getCredentialStore().clear();
  if (keepBridge) {
    keepBridge.stop();
    keepBridge = null;
  }
  pendingOnboarding = null;
  keepSyncState = {
    connected: false,
    email: null,
    status: 'Local-only mode.',
    lastSyncedAt: keepSyncState.lastSyncedAt,
    error: null
  };
  broadcastKeepStatus();
  return keepSyncState;
});

ipcMain.handle('keep:status', () => keepSyncState);

ipcMain.handle('keep:sync-now', async () => {
  try {
    return await syncKeepAccount();
  } catch (error) {
    setKeepStatus({
      status: 'Sync failed',
      error: error.message
    });
    throw error;
  }
});

ipcMain.handle('notes:open-keep', () => {
  shell.openExternal('https://keep.google.com');
  return true;
});

ipcMain.on('window:move-live', (_event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (!window || window.isDestroyed()) {
    return;
  }

  const x = Number.isFinite(payload.x) ? Math.max(0, payload.x) : undefined;
  const y = Number.isFinite(payload.y) ? Math.max(0, payload.y) : undefined;
  if (x !== undefined && y !== undefined) {
    window.setPosition(x, y);
  }
});

ipcMain.handle('window:move', (_event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    const x = Number.isFinite(payload.x) ? Math.max(0, payload.x) : undefined;
    const y = Number.isFinite(payload.y) ? Math.max(0, payload.y) : undefined;
    const persistPosition = payload.persist !== false;
    const storedNote = persistPosition && payload?.id
      ? noteStore.loadNotes({ seedDefaults: false }).find((note) => note.id === payload.id)
      : null;
    const positionLocked = Boolean(storedNote?.positionLocked);

    if ((!persistPosition || !positionLocked) && x !== undefined && y !== undefined) {
      window.setPosition(x, y);
    } else if (positionLocked && Number.isFinite(storedNote.x) && Number.isFinite(storedNote.y)) {
      window.setPosition(storedNote.x, storedNote.y);
    }

    if (persistPosition && payload?.id && !positionLocked) {
      try {
        noteStore.patchNote(payload.id, {
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {})
        });
      } catch (error) {
        if (!/not found/i.test(error.message)) {
          throw error;
        }
      }
    }

    if (persistPosition) {
      const notes = noteStore.loadNotes();
      refreshMainWindow(notes);
    }
  }
  return payload;
});

ipcMain.handle('window:set-bounds', (_event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    const storedNote = payload?.id
      ? noteStore.loadNotes({ seedDefaults: false }).find((note) => note.id === payload.id)
      : null;
    const positionLocked = Boolean(storedNote?.positionLocked);
    const bounds = {};
    if (!positionLocked && Number.isFinite(payload.x)) bounds.x = Math.max(0, payload.x);
    if (!positionLocked && Number.isFinite(payload.y)) bounds.y = Math.max(0, payload.y);
    if (Number.isFinite(payload.width)) bounds.width = Math.max(180, payload.width);
    if (Number.isFinite(payload.height)) bounds.height = Math.max(160, payload.height);

    if (Object.keys(bounds).length > 0) {
      window.setBounds(bounds);
    }

    if (payload?.id) {
      try {
        const updated = noteStore.patchNote(payload.id, {
          ...(!positionLocked && Number.isFinite(payload.x) ? { x: Math.max(0, payload.x) } : {}),
          ...(!positionLocked && Number.isFinite(payload.y) ? { y: Math.max(0, payload.y) } : {}),
          ...(Number.isFinite(payload.width) ? { width: Math.max(180, payload.width) } : {}),
          ...(Number.isFinite(payload.height) ? { height: Math.max(160, payload.height) } : {})
        });
        const notes = noteStore.loadNotes();
        refreshMainWindow(notes);
        return updated;
      } catch (error) {
        if (!/not found/i.test(error.message)) {
          throw error;
        }
      }
    }

    const notes = noteStore.loadNotes();
    refreshMainWindow(notes);
  }
  return payload;
});

ipcMain.handle('window:set-interactive', (_event, interactive) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    window.setIgnoreMouseEvents(!interactive, { forward: true });
    if (interactive) {
      window.focus();
    }
  }
  return interactive;
});

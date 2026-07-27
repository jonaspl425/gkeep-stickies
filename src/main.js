const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, screen } = require('electron');
const path = require('path');
const { createHash } = require('crypto');
const { createNoteStore } = require('./notesStore');
const { syncKeepNotes } = require('./keepSync');
const { createCredentialStore } = require('./credentialStore');
const { createKeepBridgeManager } = require('./keepBridgeManager');

const projectRoot = path.join(__dirname, '..');
let mainWindow;
const floatingNoteWindows = new Map();
let noteStore;
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
const KEEP_AUTO_PUSH_DEBOUNCE_MS = 750;
const WINDOW_MOVE_PERSIST_DEBOUNCE_MS = 160;
const WINDOW_LIVE_DRAG_INTERVAL_MS = 8;
const NOTE_BOTTOM_HIDE_THRESHOLD_PX = 72;
const NOTE_EDGE_MARGIN_PX = 16;
let keepAutoPushTimer = null;
let keepAutoPushInFlight = null;
let keepAutoPushQueued = false;
const liveWindowDrags = new Map();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Persistent Notes',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    showMainWindow();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    showMainWindow();
  });
  setTimeout(() => {
    showMainWindow();
  }, 1200);
  mainWindow.on('closed', () => {
    hideAllFloatingNoteWindows();
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 900);
}

function closeFloatingNoteWindow(id) {
  const window = floatingNoteWindows.get(id);
  floatingNoteWindows.delete(id);
  if (window && !window.isDestroyed()) {
    window.removeAllListeners('closed');
    window.destroy();
  }
}

function hideFloatingNoteWindow(id) {
  const window = floatingNoteWindows.get(id);
  if (!window || window.isDestroyed()) {
    floatingNoteWindows.delete(id);
    return false;
  }

  window.hide();
  return true;
}

function hideAllFloatingNoteWindows() {
  Array.from(floatingNoteWindows.keys()).forEach((id) => {
    hideFloatingNoteWindow(id);
  });
}

function stopLiveWindowDrag(webContentsId) {
  const session = liveWindowDrags.get(webContentsId);
  if (!session) {
    return false;
  }

  clearInterval(session.timer);
  liveWindowDrags.delete(webContentsId);
  return true;
}

function stopLiveWindowDragForWindow(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  stopLiveWindowDrag(window.webContents.id);
}

function persistFloatingNoteWindowPosition(id, window) {
  if (!noteStore || !window || window.isDestroyed()) {
    return;
  }

  const note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  if (!note || note.positionLocked) {
    return;
  }

  const [x, y] = window.getPosition();
  const updated = noteStore.patchNote(id, { x, y });
  const notes = noteStore.loadNotes();
  refreshMainWindow(notes);
  if (!window.isDestroyed()) {
    window.webContents.send('note:data', updated);
  }
}

function getSafeVisibleBounds(window) {
  const bounds = window.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  return {
    x: Math.min(
      Math.max(bounds.x, workArea.x),
      Math.max(workArea.x, workArea.x + workArea.width - bounds.width)
    ),
    y: Math.min(
      Math.max(bounds.y, workArea.y),
      Math.max(workArea.y, workArea.y + workArea.height - bounds.height - NOTE_EDGE_MARGIN_PX)
    ),
    width: bounds.width,
    height: bounds.height
  };
}

function shouldHideWindowBelowThreshold(window) {
  const bounds = window.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const noteCenterY = bounds.y + (bounds.height / 2);
  const hideLineY = workArea.y + workArea.height - NOTE_BOTTOM_HIDE_THRESHOLD_PX;
  return noteCenterY >= hideLineY;
}

function hideFloatingNoteWindowIfBelowThreshold(id, window) {
  if (!noteStore || !window || window.isDestroyed() || !window.isVisible()) {
    return false;
  }

  const note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  if (!note || note.positionLocked || !shouldHideWindowBelowThreshold(window)) {
    return false;
  }

  const safeBounds = getSafeVisibleBounds(window);
  const updated = noteStore.patchNote(id, {
    x: safeBounds.x,
    y: safeBounds.y,
    width: safeBounds.width,
    height: safeBounds.height
  });
  window.setBounds(safeBounds);
  refreshMainWindow(noteStore.loadNotes());
  window.webContents.send('note:data', updated);
  hideFloatingNoteWindow(id);
  return true;
}

function destroyAllFloatingNoteWindows() {
  Array.from(floatingNoteWindows.entries()).forEach(([id, window]) => {
    floatingNoteWindows.delete(id);
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

function ensureFloatingNoteWindow(note) {
  const existing = floatingNoteWindows.get(note.id);
  if (existing) {
    if (existing.isDestroyed()) {
      floatingNoteWindows.delete(note.id);
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
  let movePersistTimer = null;
  window.on('move', () => {
    if (movePersistTimer) {
      clearTimeout(movePersistTimer);
    }
    movePersistTimer = setTimeout(() => {
      movePersistTimer = null;
      if (hideFloatingNoteWindowIfBelowThreshold(note.id, window)) {
        return;
      }
      persistFloatingNoteWindowPosition(note.id, window);
    }, WINDOW_MOVE_PERSIST_DEBOUNCE_MS);
  });
  window.on('closed', () => {
    stopLiveWindowDragForWindow(window);
    if (movePersistTimer) {
      clearTimeout(movePersistTimer);
      movePersistTimer = null;
    }
    if (floatingNoteWindows.get(note.id) === window) {
      floatingNoteWindows.delete(note.id);
    }
  });

  floatingNoteWindows.set(note.id, window);
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
  const window = ensureFloatingNoteWindow(note);
  window.webContents.send('note:data', note);
}

function createPackagedNoteStore() {
  const userDataPath = path.join(app.getPath('userData'), 'notes.json');
  const legacyProjectPath = path.join(projectRoot, 'data', 'notes.json');
  return createNoteStore(userDataPath, { migrateFrom: legacyProjectPath });
}

function focusNoteWindow(note) {
  const window = ensureFloatingNoteWindow(note);
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
    window.webContents.send('note:data', note);
  }
  return note;
}

function closeMissingFloatingNoteWindows(notes) {
  const liveIds = new Set(notes.map((note) => note.id));
  Array.from(floatingNoteWindows.entries()).forEach(([id, window]) => {
    if (!liveIds.has(id) && window && !window.isDestroyed()) {
      closeFloatingNoteWindow(id);
    }
  });
}

function refreshOpenFloatingNoteWindows(notes) {
  notes.forEach((note) => {
    const window = floatingNoteWindows.get(note.id);
    if (window && !window.isDestroyed()) {
      window.webContents.send('note:data', note);
    }
  });
}

function getCredentialStore() {
  if (!credentialStore) {
    const legacyCredentialPath = path.join(app.getPath('appData'), 'sticky-notes-desktop', 'keep-credentials.json');
    credentialStore = createCredentialStore(app, safeStorage, { migrateFrom: legacyCredentialPath });
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

function hasSyncableLocalContent(note) {
  return Boolean(String(note.title || '').trim() || String(note.body || '').trim());
}

function createOnboardingPreview({ localNotes, remoteNotes, settings, email }) {
  const remoteActiveNotes = settings.pullRemote ? filterRemoteNotes(remoteNotes, settings) : [];
  const localToUpload = settings.uploadLocal
    ? localNotes.filter((note) => !hasKeepId(note) && hasSyncableLocalContent(note))
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
  closeMissingFloatingNoteWindows(noteList);
  refreshMainWindow(noteList);
  return noteList;
}

async function createRemoteFromLocal(note, email) {
  const bridge = getKeepBridge();
  const expectedLocalRevision = Number.isFinite(note.keep?.localRevision) ? note.keep.localRevision : 0;
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
  }, { expectedLocalRevision });
}

async function updateRemoteFromLocal(note) {
  const bridge = getKeepBridge();
  const expectedLocalRevision = Number.isFinite(note.keep?.localRevision) ? note.keep.localRevision : 0;
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
  }, { expectedLocalRevision });
}

async function pushLocalChanges({ email, settings }) {
  const notes = noteStore.loadNotes({ seedDefaults: false });
  const result = {
    created: 0,
    updated: 0,
    skippedUploadDisabled: 0
  };

  for (const note of notes) {
    if (!hasKeepId(note)) {
      if (settings.uploadLocal && hasSyncableLocalContent(note)) {
        await createRemoteFromLocal(note, email);
        result.created += 1;
      } else if (!settings.uploadLocal && hasSyncableLocalContent(note)) {
        result.skippedUploadDisabled += 1;
      }
      continue;
    }

    if (Array.isArray(note.keep?.dirtyFields) && note.keep.dirtyFields.length > 0) {
      await updateRemoteFromLocal(note);
      result.updated += 1;
    }
  }

  return result;
}

function scheduleKeepAutoPush() {
  if (!keepSyncState.connected) {
    return;
  }

  setKeepStatus({
    connected: true,
    status: keepAutoPushInFlight ? 'Saving current edit after this sync...' : 'Edit saved locally. Syncing to Google Keep...',
    error: null
  });

  if (keepAutoPushTimer) {
    clearTimeout(keepAutoPushTimer);
  }

  keepAutoPushTimer = setTimeout(() => {
    keepAutoPushTimer = null;
    runKeepAutoPush();
  }, KEEP_AUTO_PUSH_DEBOUNCE_MS);
}

function clearKeepAutoPushTimer() {
  if (keepAutoPushTimer) {
    clearTimeout(keepAutoPushTimer);
    keepAutoPushTimer = null;
  }
  keepAutoPushQueued = false;
}

function runKeepAutoPush() {
  if (keepAutoPushInFlight) {
    keepAutoPushQueued = true;
    return keepAutoPushInFlight;
  }

  keepAutoPushInFlight = (async () => {
    try {
      const credentials = getCredentialStore().load();
      if (!credentials || !keepSyncState.connected) {
        return;
      }

      const email = normalizeEmail(credentials.email);
      const settings = normalizeOnboardingSettings(credentials.settings);
      setKeepStatus({ connected: true, email, status: 'Saving changes to Google Keep...', error: null });
      await authenticateKeepBridge({ email, masterToken: credentials.masterToken });
      const pushResult = await pushLocalChanges({ email, settings });

      const notes = noteStore.loadNotes({ seedDefaults: false });
      refreshOpenFloatingNoteWindows(notes);
      refreshMainWindow(notes);
      const status = pushResult.skippedUploadDisabled > 0 && pushResult.created === 0 && pushResult.updated === 0
        ? 'Local note saved. Enable local uploads to create it in Google Keep.'
        : 'Saved to Google Keep';
      setKeepStatus({
        connected: true,
        email,
        status,
        lastSyncedAt: new Date().toISOString(),
        error: null
      });
    } catch (error) {
      if (keepSyncState.connected) {
        setKeepStatus({
          status: 'Google Keep save failed',
          error: error.message
        });
      }
    } finally {
      keepAutoPushInFlight = null;
      if (keepAutoPushQueued) {
        keepAutoPushQueued = false;
        scheduleKeepAutoPush();
      }
    }
  })();

  return keepAutoPushInFlight;
}

async function syncKeepAccount() {
  clearKeepAutoPushTimer();
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

function trashRemoteKeepNoteInBackground(note) {
  if (!note || !keepSyncState.connected) {
    return;
  }

  trashRemoteKeepNote(note).catch((error) => {
    setKeepStatus({
      status: 'Local note deleted. Google Keep delete failed.',
      error: error.message
    });
  });
}

app.whenReady().then(() => {
  noteStore = createPackagedNoteStore();
  createMainWindow();
  const storedCredentialStatus = getCredentialStore().getStatus();
  if (storedCredentialStatus) {
    keepSyncState = {
      connected: true,
      email: storedCredentialStatus.email,
      status: 'Connected. Local edits sync to Google Keep.',
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
    showMainWindow();
    refreshMainWindow(noteStore.loadNotes({ seedDefaults: false }));
  } else {
    createMainWindow();
  }
});

app.on('before-quit', () => {
  destroyAllFloatingNoteWindows();
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
  closeMissingFloatingNoteWindows(notes);
  refreshMainWindow(notes);
  if (hasSyncableLocalContent(note)) {
    scheduleKeepAutoPush();
  }
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
  scheduleKeepAutoPush();
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
  if (dirtyFields.length > 0) {
    scheduleKeepAutoPush();
  }
  return updated;
});

ipcMain.handle('notes:reorder', (_event, orderedIds = []) => {
  const notes = noteStore.reorderNotes(orderedIds);
  refreshMainWindow(notes);
  return notes;
});

ipcMain.handle('notes:show', (_event, payload = {}) => {
  const request = typeof payload === 'string' ? { id: payload } : payload;
  const id = request?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  let note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  if (!note) {
    return null;
  }

  if (!note.positionLocked) {
    const patch = {};
    if (Number.isFinite(request.x)) patch.x = Math.max(0, request.x);
    if (Number.isFinite(request.y)) patch.y = Math.max(0, request.y);
    if (Object.keys(patch).length > 0) {
      note = noteStore.patchNote(id, patch);
      refreshMainWindow(noteStore.loadNotes());
    }
  }

  return focusNoteWindow(note);
});

ipcMain.handle('notes:hide', (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }

  return hideFloatingNoteWindow(id);
});

ipcMain.handle('notes:delete', async (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }

  const note = noteStore.loadNotes({ seedDefaults: false }).find((item) => item.id === id);
  noteStore.deleteNote(id);
  closeFloatingNoteWindow(id);
  const notes = noteStore.loadNotes();
  closeMissingFloatingNoteWindows(notes);
  refreshMainWindow(notes);
  trashRemoteKeepNoteInBackground(note);
  return true;
});

ipcMain.handle('notes:clear', () => {
  hideAllFloatingNoteWindows();
  const notes = noteStore.loadNotes({ seedDefaults: false });
  refreshMainWindow(notes);
  return notes;
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
      title: item.title ?? item.name ?? '',
      body: item.body || item.content || '',
      x: item.x ?? 140,
      y: item.y ?? 140,
      color: item.color || '#fff59d',
      importedFromKeep: true
    });
    syncNoteWindow(note);
  });

  const notes = noteStore.loadNotes();
  closeMissingFloatingNoteWindows(notes);
  refreshMainWindow(notes);
  scheduleKeepAutoPush();
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
  closeMissingFloatingNoteWindows(noteList);
  refreshMainWindow(noteList);
  keepSyncState = {
    ...keepSyncState,
    status: 'Imported the selected Keep export',
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
    throw new Error('Create a Google Keep sync preview before applying the first sync.');
  }
  if (payload.previewHash !== pendingOnboarding.previewHash) {
    throw new Error('The first sync preview is stale. Create a new preview before applying it.');
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
  clearKeepAutoPushTimer();
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

  const storedNote = payload?.id
    ? noteStore.loadNotes({ seedDefaults: false }).find((note) => note.id === payload.id)
    : null;
  if (storedNote?.positionLocked) {
    return;
  }

  const x = Number.isFinite(payload.x) ? Math.max(0, payload.x) : undefined;
  const y = Number.isFinite(payload.y) ? Math.max(0, payload.y) : undefined;
  if (x !== undefined && y !== undefined) {
    window.setPosition(x, y);
  }
});

ipcMain.on('window:drag-live-start', (_event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (!window || window.isDestroyed()) {
    return;
  }

  const storedNote = payload?.id
    ? noteStore.loadNotes({ seedDefaults: false }).find((note) => note.id === payload.id)
    : null;
  if (storedNote?.positionLocked) {
    return;
  }

  const startScreenX = Number.isFinite(payload.startScreenX) ? payload.startScreenX : undefined;
  const startScreenY = Number.isFinite(payload.startScreenY) ? payload.startScreenY : undefined;
  const startX = Number.isFinite(payload.startX) ? payload.startX : undefined;
  const startY = Number.isFinite(payload.startY) ? payload.startY : undefined;
  if (startScreenX === undefined || startScreenY === undefined || startX === undefined || startY === undefined) {
    return;
  }

  const webContentsId = _event.sender.id;
  stopLiveWindowDrag(webContentsId);
  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      stopLiveWindowDrag(webContentsId);
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    window.setPosition(
      Math.max(0, Math.round(startX + cursor.x - startScreenX)),
      Math.max(0, Math.round(startY + cursor.y - startScreenY))
    );
  }, WINDOW_LIVE_DRAG_INTERVAL_MS);

  liveWindowDrags.set(webContentsId, { timer });
});

ipcMain.on('window:drag-live-stop', (_event) => {
  stopLiveWindowDrag(_event.sender.id);
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

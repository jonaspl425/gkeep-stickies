const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { createNoteStore } = require('./notesStore');
const { syncKeepNotes } = require('./keepSync');

const noteStore = createNoteStore();
let mainWindow;
const stickyWindows = new Map();
const liveDragWindows = new Map();
let keepSyncState = {
  connected: false,
  email: null,
  status: 'Not connected',
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

app.whenReady().then(() => {
  createMainWindow();
  let notes = noteStore.loadNotes({ seedDefaults: true });
  const hasPlaceholderNotes = notes.some((note) => note.title === 'Welcome' || note.title === 'Google Keep import');
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

ipcMain.handle('notes:create', (_event, payload) => {
  const note = noteStore.createNote(payload);
  syncNoteWindow(note);
  const notes = noteStore.loadNotes();
  closeMissingStickyWindows(notes);
  refreshMainWindow(notes);
  return note;
});

ipcMain.handle('notes:update', (_event, note) => {
  const updated = noteStore.updateNote(note);
  syncNoteWindow(updated);
  const notes = noteStore.loadNotes();
  refreshMainWindow(notes);
  return updated;
});

ipcMain.handle('notes:patch', (_event, payload) => {
  const updated = noteStore.patchNote(payload.id, payload.patch || {});
  syncNoteWindow(updated);
  const notes = noteStore.loadNotes();
  refreshMainWindow(notes);
  return updated;
});

ipcMain.handle('notes:delete', (_event, id) => {
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
    title: 'Import notes from a Google Keep export',
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
    title: 'Select a Google Keep export JSON file',
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
    status: 'Synced from selected Keep export',
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
      status: 'Sync failed',
      error: error.message
    };
    broadcastKeepStatus();
    throw new Error(`Google Keep sync failed: ${error.message}`);
  }
});

ipcMain.handle('keep:connect', async () => {
  try {
    const emailResult = await dialog.showInputBox({
      title: 'Connect Google Keep',
      message: 'Enter your Google account email',
      validateInput: (value) => (value.trim() ? '' : 'Email is required')
    });

    if (emailResult.canceled || !emailResult.value.trim()) {
      return keepSyncState;
    }

    const tokenResult = await dialog.showInputBox({
      title: 'Connect Google Keep',
      message: 'Enter a Google Keep master token',
      inputType: 'password',
      validateInput: (value) => (value.trim() ? '' : 'Master token is required')
    });

    if (tokenResult.canceled || !tokenResult.value.trim()) {
      return keepSyncState;
    }

    keepSyncState = {
      connected: true,
      email: emailResult.value.trim(),
      status: 'Connected',
      lastSyncedAt: keepSyncState.lastSyncedAt,
      error: null
    };
    broadcastKeepStatus();
    return keepSyncState;
  } catch (error) {
    keepSyncState = {
      ...keepSyncState,
      status: 'Connection failed',
      error: error.message
    };
    broadcastKeepStatus();
    throw error;
  }
});

ipcMain.handle('keep:disconnect', () => {
  keepSyncState = {
    connected: false,
    email: null,
    status: 'Disconnected',
    lastSyncedAt: keepSyncState.lastSyncedAt,
    error: null
  };
  broadcastKeepStatus();
  return keepSyncState;
});

ipcMain.handle('keep:status', () => keepSyncState);

ipcMain.handle('keep:sync-now', async () => {
  if (!keepSyncState.connected) {
    throw new Error('Connect Google Keep first.');
  }

  return syncKeepFromSelection();
});

ipcMain.handle('notes:open-keep', () => {
  shell.openExternal('https://keep.google.com');
  return true;
});

ipcMain.handle('window:move', (_event, payload) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    const x = Number.isFinite(payload.x) ? Math.max(0, payload.x) : undefined;
    const y = Number.isFinite(payload.y) ? Math.max(0, payload.y) : undefined;
    if (x !== undefined && y !== undefined) {
      window.setPosition(x, y);
    }

    if (payload?.id) {
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

    const notes = noteStore.loadNotes();
    refreshMainWindow(notes);
  }
  return payload;
});

ipcMain.handle('window:start-drag-live', (_event, payload) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    liveDragWindows.set(window, payload || {});
  }
  return payload;
});

ipcMain.handle('window:move-live', (_event, payload) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    const x = Number.isFinite(payload?.x) ? Math.max(0, payload.x) : undefined;
    const y = Number.isFinite(payload?.y) ? Math.max(0, payload.y) : undefined;
    if (x !== undefined && y !== undefined) {
      window.setPosition(x, y);
    }
  }
  return payload;
});

ipcMain.handle('window:stop-drag-live', (_event) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    liveDragWindows.delete(window);
  }
  return true;
});

ipcMain.handle('window:set-bounds', (_event, payload) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (window && !window.isDestroyed()) {
    const bounds = {};
    if (Number.isFinite(payload.x)) bounds.x = Math.max(0, payload.x);
    if (Number.isFinite(payload.y)) bounds.y = Math.max(0, payload.y);
    if (Number.isFinite(payload.width)) bounds.width = Math.max(180, payload.width);
    if (Number.isFinite(payload.height)) bounds.height = Math.max(160, payload.height);

    if (Object.keys(bounds).length > 0) {
      window.setBounds(bounds);
    }

    if (payload?.id) {
      try {
        const updated = noteStore.patchNote(payload.id, {
          ...(Number.isFinite(payload.x) ? { x: Math.max(0, payload.x) } : {}),
          ...(Number.isFinite(payload.y) ? { y: Math.max(0, payload.y) } : {}),
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

# Ghost Note Fix

Status: Implemented

The core fix is now present in the app: sticky note windows load with a `noteId` query parameter, the renderer can pull its note through `notes:get-one`, and missing notes close deterministically instead of remaining as unusable blank windows.

## Problem

The app can produce "ghost notes": sticky note windows that appear blank or transparent and cannot be dragged, resized, pinned, edited, or deleted.

The most likely failure mode is that a sticky note `BrowserWindow` is created and shown before its renderer has received the `note:data` IPC message. In `src/noteRenderer.js`, most note interactions depend on `currentNote` being set. If that IPC payload is missed or delayed, `currentNote` remains `null`, so the sticky window exists but cannot be manipulated.

## Former Fragile Flow

In `src/main.js`, `ensureStickyWindow(note)` creates a note window, loads `note.html`, and sends the note through IPC:

```js
window.loadFile(path.join(__dirname, 'note.html'));
window.once('ready-to-show', () => window.show());
window.webContents.on('did-finish-load', () => {
  window.webContents.send('note:data', note);
});
```

In `src/noteRenderer.js`, the renderer only becomes functional after receiving that pushed message:

```js
window.electronAPI.onNoteData((note) => {
  currentNote = note;
  titleInput.value = note.title || '';
  bodyInput.value = note.body || '';
  card.style.background = note.color || '#fff59d';
  card.style.cursor = 'grab';
});
```

If the message does not arrive, the renderer has no note ID, no backing state, and no way to recover.

## Implemented Fix

Sticky note initialization is now pull-based and deterministic. Each note window receives its note ID from the URL, then requests its own backing note from the main process on startup. `note:data` remains a live update channel, but initial hydration no longer depends on one pushed IPC event.

## Implemented Steps

### 1. Load `note.html` With A Note ID

`ensureStickyWindow(note)` in `src/main.js` loads the note window with:

```js
window.loadFile(path.join(__dirname, 'note.html'), {
  query: { noteId: note.id }
});
```

This gives each sticky renderer a stable identity even if an IPC event is missed.

### 2. Add A Single-Note Lookup Handler

`src/main.js` exposes:

```js
ipcMain.handle('notes:get-one', (_event, id) => {
  return noteStore.loadNotes().find((note) => note.id === id) || null;
});
```

Optional hardening:

```js
ipcMain.handle('notes:get-one', (_event, id) => {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  return noteStore.loadNotes().find((note) => note.id === id) || null;
});
```

### 3. Expose The Lookup In Preload

`src/preload.js` exposes:

```js
getNote: (id) => ipcRenderer.invoke('notes:get-one', id),
```

The exposed API should now include both the pull path and the existing update listener:

```js
contextBridge.exposeInMainWorld('electronAPI', {
  loadNotes: () => ipcRenderer.invoke('notes:load'),
  getNote: (id) => ipcRenderer.invoke('notes:get-one', id),
  clearNotes: () => ipcRenderer.invoke('notes:clear'),
  createNote: (payload) => ipcRenderer.invoke('notes:create', payload),
  updateNote: (note) => ipcRenderer.invoke('notes:update', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  importKeepNotes: () => ipcRenderer.invoke('notes:import'),
  syncKeepNotes: () => ipcRenderer.invoke('notes:sync-keep'),
  openKeep: () => ipcRenderer.invoke('notes:open-keep'),
  moveWindow: (payload) => ipcRenderer.invoke('window:move', payload),
  setWindowInteractive: (interactive) => ipcRenderer.invoke('window:set-interactive', interactive),
  onNoteData: (callback) => ipcRenderer.on('note:data', (_event, note) => callback(note)),
  onNotesChanged: (callback) => ipcRenderer.on('notes:changed', (_event, notes) => callback(notes))
});
```

### 4. Refactor Note Application Into A Shared Function

`src/noteRenderer.js` centralizes renderer hydration with:

```js
function applyNote(note) {
  currentNote = note;
  titleInput.value = note.title || '';
  bodyInput.value = note.body || '';
  card.style.background = note.color || '#fff59d';
  card.style.cursor = 'grab';
}
```

Then use it for live IPC updates:

```js
window.electronAPI.onNoteData((note) => {
  applyNote(note);
});
```

### 5. Hydrate The Note On Renderer Startup

`src/noteRenderer.js` hydrates on startup with:

```js
async function hydrateNote() {
  const noteId = new URLSearchParams(window.location.search).get('noteId');

  if (!noteId) {
    document.body.classList.add('missing-note');
    return;
  }

  const note = await window.electronAPI.getNote(noteId);

  if (!note) {
    document.body.classList.add('missing-note');
    return;
  }

  applyNote(note);
}

hydrateNote();
```

This makes every note window self-recovering after load.

### 6. Add A Safe Visual Default

`src/styles.css` ensures the sticky note is never visually transparent while waiting for state:

```css
.note-window .note-card {
  background: #fff59d;
}
```

Optionally add a missing-note state:

```css
.note-window.missing-note .note-card,
.missing-note .note-card {
  background: #f2f2f2;
  opacity: 1;
}
```

## Main-Process Cleanup

Status: Implemented.

If a note no longer exists in storage, the main process can proactively close the orphaned window:

```js
function closeMissingStickyWindows(notes) {
  const liveIds = new Set(notes.map((note) => note.id));

  for (const [id, window] of stickyWindows) {
    if (!liveIds.has(id) && !window.isDestroyed()) {
      window.close();
    }
  }
}
```

The app calls this after delete, import, sync, and app startup reconciliation. Clearing notes destroys all sticky windows directly.

## Regression Tests

Recommended tests:

1. Sticky window loads with a `noteId` query param.
2. `notes:get-one` returns the correct note.
3. `notes:get-one` returns `null` for a missing note.
4. `noteRenderer` can hydrate from `getNote()` without receiving `note:data`.
5. A missing note enters a deterministic missing state instead of creating a transparent ghost.
6. Deleting or clearing notes closes orphaned sticky windows.

Current automated coverage directly exercises the store lookup portion. Renderer and BrowserWindow lifecycle coverage should still be added with an Electron-aware test harness.

## Result

After this fix, a sticky note window no longer depends on a single pushed IPC event for initial state. If the renderer starts late, reloads, or misses `note:data`, it can still recover by reading its `noteId` from the URL and asking the main process for the canonical note.

This should eliminate transparent, non-manipulable ghost notes and make note-window lifecycle bugs easier to diagnose.

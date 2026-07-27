const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadNotes: () => ipcRenderer.invoke('notes:load'),
  getNote: (id) => ipcRenderer.invoke('notes:get-one', id),
  clearNotes: () => ipcRenderer.invoke('notes:clear'),
  createNote: (payload) => ipcRenderer.invoke('notes:create', payload),
  updateNote: (note) => ipcRenderer.invoke('notes:update', note),
  patchNote: (id, patch) => ipcRenderer.invoke('notes:patch', { id, patch }),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  importKeepNotes: () => ipcRenderer.invoke('notes:import'),
  syncKeepNotes: () => ipcRenderer.invoke('notes:sync-keep'),
  connectKeep: () => ipcRenderer.invoke('keep:connect'),
  disconnectKeep: () => ipcRenderer.invoke('keep:disconnect'),
  getKeepStatus: () => ipcRenderer.invoke('keep:status'),
  syncKeepNow: () => ipcRenderer.invoke('keep:sync-now'),
  openKeep: () => ipcRenderer.invoke('notes:open-keep'),
  moveWindow: (payload) => ipcRenderer.invoke('window:move', payload),
  startWindowDragLive: (payload) => ipcRenderer.invoke('window:start-drag-live', payload),
  moveWindowLive: (payload) => ipcRenderer.invoke('window:move-live', payload),
  stopWindowDragLive: () => ipcRenderer.invoke('window:stop-drag-live'),
  setWindowBounds: (payload) => ipcRenderer.invoke('window:set-bounds', payload),
  closeCurrentWindow: () => ipcRenderer.invoke('window:close-current'),
  setWindowInteractive: (interactive) => ipcRenderer.invoke('window:set-interactive', interactive),
  onNoteData: (callback) => ipcRenderer.on('note:data', (_event, note) => callback(note)),
  onNotesChanged: (callback) => ipcRenderer.on('notes:changed', (_event, notes) => callback(notes)),
  onKeepStatusChanged: (callback) => ipcRenderer.on('keep:status-changed', (_event, status) => callback(status))
});

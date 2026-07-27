const noteList = document.getElementById('notes-list');
const newNoteButton = document.getElementById('new-note');
const importButton = document.getElementById('import-notes');
const syncKeepButton = document.getElementById('sync-keep');
const connectKeepButton = document.getElementById('connect-keep');
const disconnectKeepButton = document.getElementById('disconnect-keep');
const clearButton = document.getElementById('clear-notes');
const openKeepButton = document.getElementById('open-keep');
const keepStatusPill = document.getElementById('keep-status-pill');
const keepStatusText = document.getElementById('keep-status-text');

let notes = [];

async function refreshNotes() {
  notes = await window.electronAPI.loadNotes();
  renderNotes();
}

function renderNotes() {
  noteList.innerHTML = '';

  notes.forEach((note) => {
    const card = document.createElement('article');
    card.className = 'note-card list-card';
    card.style.background = note.color || '#fff59d';
    card.innerHTML = `
      <div class="note-toolbar">
        <strong>${escapeHtml(note.title || 'Untitled')}</strong>
        <button class="icon-btn" data-action="delete" data-id="${note.id}">✕</button>
      </div>
      <p>${escapeHtml(note.body || '')}</p>
      <small>${formatNoteDate(note.updatedAt || note.createdAt)}</small>
    `;

    card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await window.electronAPI.deleteNote(note.id);
      await refreshNotes();
    });

    card.addEventListener('click', async () => {
      await window.electronAPI.patchNote(note.id, { title: note.title || 'Untitled', body: note.body || '' });
    });

    noteList.appendChild(card);
  });
}

newNoteButton.addEventListener('click', async () => {
  await window.electronAPI.createNote({ title: 'New note', body: '' });
  await refreshNotes();
});

importButton.addEventListener('click', async () => {
  await window.electronAPI.importKeepNotes();
  await refreshNotes();
});

clearButton.addEventListener('click', async () => {
  notes = [];
  renderNotes();
  await window.electronAPI.clearNotes();
  await refreshNotes();
});

syncKeepButton.addEventListener('click', async () => {
  try {
    await window.electronAPI.syncKeepNow();
    await refreshNotes();
  } catch (error) {
    window.alert(error.message || 'Could not sync Google Keep notes.');
  }
});

connectKeepButton.addEventListener('click', async () => {
  try {
    await window.electronAPI.connectKeep();
    await refreshKeepStatus();
  } catch (error) {
    window.alert(error.message || 'Could not connect to Google Keep.');
  }
});

disconnectKeepButton.addEventListener('click', async () => {
  try {
    await window.electronAPI.disconnectKeep();
    await refreshKeepStatus();
  } catch (error) {
    window.alert(error.message || 'Could not disconnect Google Keep.');
  }
});

openKeepButton.addEventListener('click', async () => {
  await window.electronAPI.openKeep();
});

window.electronAPI.onNotesChanged((_notes) => {
  notes = _notes;
  renderNotes();
});

async function refreshKeepStatus() {
  const status = await window.electronAPI.getKeepStatus();
  updateKeepStatus(status);
}

function updateKeepStatus(status = {}) {
  const connected = Boolean(status.connected);
  keepStatusPill.textContent = connected ? 'Connected' : 'Not connected';
  keepStatusPill.className = `keep-status-pill ${connected ? 'connected' : 'disconnected'}`;
  const detail = connected
    ? `${status.email || 'Google Keep'} • ${status.status || 'Ready'}`
    : status.status || 'Connect Google Keep to enable sync controls.';
  keepStatusText.textContent = detail;
}

window.electronAPI.onKeepStatusChanged((status) => {
  updateKeepStatus(status);
});

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNoteDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

refreshNotes();
refreshKeepStatus();

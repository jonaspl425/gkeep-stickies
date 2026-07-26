const noteList = document.getElementById('notes-list');
const newNoteButton = document.getElementById('new-note');
const importButton = document.getElementById('import-notes');
const syncKeepButton = document.getElementById('sync-keep');
const accountSyncButton = document.getElementById('account-sync');
const connectKeepButton = document.getElementById('connect-keep');
const disconnectKeepButton = document.getElementById('disconnect-keep');
const clearButton = document.getElementById('clear-notes');
const openKeepButton = document.getElementById('open-keep');
const keepStatusPill = document.getElementById('keep-status-pill');
const keepStatusText = document.getElementById('keep-status-text');
const onboardingModal = document.getElementById('keep-onboarding');
const closeOnboardingButton = document.getElementById('close-onboarding');
const onboardingStatus = document.getElementById('keep-onboarding-status');
const previewKeepSyncButton = document.getElementById('preview-keep-sync');
const applyKeepSyncButton = document.getElementById('apply-keep-sync');
const previewPanel = document.getElementById('keep-preview');
const acceptRiskInput = document.getElementById('accept-risk');
const acceptBackupInput = document.getElementById('accept-backup');
const keepEmailInput = document.getElementById('keep-email');
const keepTokenInput = document.getElementById('keep-token');
const scopePullInput = document.getElementById('scope-pull');
const scopeUploadInput = document.getElementById('scope-upload');
const scopeTrashInput = document.getElementById('scope-trash');
const scopeArchivedInput = document.getElementById('scope-archived');
const scopeTrashedInput = document.getElementById('scope-trashed');
const formatter = window.noteFormatting;

let notes = [];
let pendingPreview = null;

async function refreshNotes() {
  notes = await window.electronAPI.loadNotes();
  renderNotes();
}

function renderNotes() {
  noteList.innerHTML = '';

  notes.forEach((note) => {
    const card = document.createElement('article');
    card.className = `note-card list-card${note.positionLocked ? ' position-locked' : ''}`;
    card.style.background = formatter.getNoteColor(note.color);
    card.innerHTML = `
      <button class="icon-btn note-card-delete" data-action="delete" data-id="${escapeHtml(note.id)}" aria-label="Delete note" title="Delete note">&times;</button>
      ${note.positionLocked ? '<span class="note-lock-badge" title="Position locked">&#128204;</span>' : ''}
      <div class="note-content">
        <h2 class="note-title">${formatter.escapeHtml(formatter.formatTitle(note.title))}</h2>
        <div class="note-body-display">${formatter.renderNoteBodyHtml(note.body || '', { emptyText: '' })}</div>
      </div>
      <small>${formatNoteDate(note.updatedAt || note.createdAt)}</small>
    `;

    card.querySelector('[data-action="delete"]').addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.electronAPI.deleteNote(note.id);
      await refreshNotes();
    });

    card.querySelectorAll('details').forEach((details) => {
      details.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    });

    card.addEventListener('click', async () => {
      await window.electronAPI.showNote(note.id);
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
    await window.electronAPI.syncKeepNotes();
    await refreshNotes();
  } catch (error) {
    window.alert(error.message || 'Could not import Google Keep notes.');
  }
});

accountSyncButton.addEventListener('click', async () => {
  try {
    await window.electronAPI.syncKeepNow();
    await refreshNotes();
    await refreshKeepStatus();
  } catch (error) {
    window.alert(error.message || 'Could not sync Google Keep.');
  }
});

connectKeepButton.addEventListener('click', () => {
  pendingPreview = null;
  applyKeepSyncButton.disabled = true;
  previewPanel.classList.add('hidden');
  onboardingStatus.textContent = 'Review the safety notes, then test your account connection.';
  onboardingModal.classList.remove('hidden');
});

disconnectKeepButton.addEventListener('click', async () => {
  try {
    await window.electronAPI.disconnectKeep();
    await refreshKeepStatus();
  } catch (error) {
    window.alert(error.message || 'Could not disconnect Google Keep.');
  }
});

closeOnboardingButton.addEventListener('click', () => {
  onboardingModal.classList.add('hidden');
});

previewKeepSyncButton.addEventListener('click', async () => {
  if (!acceptRiskInput.checked || !acceptBackupInput.checked) {
    window.alert('Accept the unofficial sync and backup confirmations before continuing.');
    return;
  }

  previewKeepSyncButton.disabled = true;
  applyKeepSyncButton.disabled = true;
  onboardingStatus.textContent = 'Testing connection and scanning Google Keep...';

  try {
    pendingPreview = await window.electronAPI.connectKeep({
      email: keepEmailInput.value,
      masterToken: keepTokenInput.value,
      settings: getScopeSettings()
    });
    renderPreview(pendingPreview);
    onboardingStatus.textContent = 'Preview ready. Review the counts, then start the first sync.';
    applyKeepSyncButton.disabled = false;
  } catch (error) {
    pendingPreview = null;
    previewPanel.classList.add('hidden');
    onboardingStatus.textContent = error.message || 'Could not create Google Keep preview.';
    window.alert(onboardingStatus.textContent);
  } finally {
    previewKeepSyncButton.disabled = false;
  }
});

applyKeepSyncButton.addEventListener('click', async () => {
  if (!pendingPreview) {
    return;
  }

  applyKeepSyncButton.disabled = true;
  previewKeepSyncButton.disabled = true;
  onboardingStatus.textContent = 'Creating backup and applying the first sync...';

  try {
    await window.electronAPI.applyKeepOnboarding({ previewHash: pendingPreview.previewHash });
    keepTokenInput.value = '';
    onboardingModal.classList.add('hidden');
    await refreshNotes();
    await refreshKeepStatus();
  } catch (error) {
    onboardingStatus.textContent = error.message || 'Could not apply first sync.';
    window.alert(onboardingStatus.textContent);
  } finally {
    previewKeepSyncButton.disabled = false;
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
  keepStatusPill.textContent = connected ? 'Connected' : 'Local only';
  keepStatusPill.className = `keep-status-pill ${connected ? 'connected' : 'disconnected'}`;
  const detail = connected
    ? `${status.email || 'Google Keep'} - ${status.status || 'Ready'}`
    : status.status || 'Connect Google Keep or import a Keep export JSON file.';
  keepStatusText.textContent = detail;
}

window.electronAPI.onKeepStatusChanged((status) => {
  updateKeepStatus(status);
});

function getScopeSettings() {
  return {
    pullRemote: scopePullInput.checked,
    uploadLocal: scopeUploadInput.checked,
    trashRemoteOnLocalDelete: scopeTrashInput.checked,
    includeArchived: scopeArchivedInput.checked,
    includeTrashed: scopeTrashedInput.checked
  };
}

function renderPreview(preview) {
  document.getElementById('preview-remote').textContent = preview.remoteCount;
  document.getElementById('preview-local').textContent = preview.localCount;
  document.getElementById('preview-create-local').textContent = preview.createLocalCount;
  document.getElementById('preview-create-remote').textContent = preview.createRemoteCount;
  document.getElementById('preview-archived').textContent = preview.skippedArchivedCount;
  document.getElementById('preview-trashed').textContent = preview.skippedTrashedCount;
  previewPanel.classList.remove('hidden');
}

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

const noteList = document.getElementById('notes-list');
const newNoteButton = document.getElementById('new-note');
const importButton = document.getElementById('import-notes');
const pinnedNotesSection = document.getElementById('pinned-notes-section');
const pinnedNoteList = document.getElementById('pinned-notes-list');
const syncKeepButton = document.getElementById('sync-keep');
const accountSyncButton = document.getElementById('account-sync');
const connectKeepButton = document.getElementById('connect-keep');
const disconnectKeepButton = document.getElementById('disconnect-keep');
const clearButton = document.getElementById('clear-notes');
const openKeepButton = document.getElementById('open-keep');
const keepStatusPill = document.getElementById('keep-status-pill');
const keepStatusText = document.getElementById('keep-status-text');
const keepAccountEmail = document.getElementById('keep-account-email');
const settingsToggleButton = document.getElementById('settings-toggle');
const settingsMenu = document.getElementById('settings-menu');
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
const PIN_ICON_HTML = `
  <svg class="pin-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M9 4h6" />
    <path d="M10 4l1 7-4 4v2h10v-2l-4-4 1-7" />
    <path d="M12 17v4" />
  </svg>
`;
const OPEN_FLOATING_ICON_HTML = `
  <svg class="open-floating-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
  </svg>
`;
const DASHBOARD_DRAG_OUT_THRESHOLD_PX = 18;
const DASHBOARD_REORDER_THRESHOLD_PX = 6;

let notes = [];
let pendingPreview = null;
let draggedNoteId = null;
let dashboardReorderCandidate = null;
let dashboardDragOut = null;
let suppressDashboardClickUntil = 0;

function closeSettingsMenu() {
  settingsMenu.classList.add('hidden');
  settingsToggleButton.setAttribute('aria-expanded', 'false');
}

function toggleSettingsMenu() {
  const isHidden = settingsMenu.classList.toggle('hidden');
  settingsToggleButton.setAttribute('aria-expanded', String(!isHidden));
}

async function refreshNotes() {
  notes = await window.electronAPI.loadNotes();
  renderNotes();
}

function getNoteCards() {
  return Array.from(document.querySelectorAll('.list-card[data-note-id]'));
}

function getOrderedNoteCards() {
  return [
    ...Array.from(pinnedNoteList.querySelectorAll('.list-card[data-note-id]')),
    ...Array.from(noteList.querySelectorAll('.list-card[data-note-id]'))
  ];
}

function getDraggedCard() {
  return getNoteCards().find((card) => card.dataset.noteId === draggedNoteId) || null;
}

function clearNoteDragState() {
  draggedNoteId = null;
  dashboardReorderCandidate = null;
  getNoteCards().forEach((card) => {
    card.classList.remove('dragging', 'drag-over');
  });
}

function shouldInsertBefore(event, targetCard) {
  const rect = targetCard.getBoundingClientRect();
  const verticalOffset = event.clientY - (rect.top + rect.height / 2);
  if (Math.abs(verticalOffset) > rect.height / 4) {
    return verticalOffset < 0;
  }

  return event.clientX < rect.left + rect.width / 2;
}

function moveDraggedCard(targetCard, event) {
  const draggedCard = getDraggedCard();
  if (!draggedCard || draggedCard === targetCard) {
    return;
  }

  const insertBefore = shouldInsertBefore(event, targetCard) ? targetCard : targetCard.nextSibling;
  if (insertBefore === draggedCard || insertBefore === draggedCard.nextSibling) {
    return;
  }

  targetCard.parentElement.insertBefore(draggedCard, insertBefore);
}

async function persistNoteOrderFromDom() {
  const orderedIds = getOrderedNoteCards().map((card) => card.dataset.noteId);
  if (!orderedIds.length) {
    return;
  }

  notes = await window.electronAPI.reorderNotes(orderedIds);
  renderNotes();
}

function handleNoteDragOver(event) {
  if (!draggedNoteId) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  moveDraggedCard(event.currentTarget, event);
}

async function handleNoteDrop(event) {
  if (!draggedNoteId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  try {
    await persistNoteOrderFromDom();
  } finally {
    clearNoteDragState();
  }
}

function isDashboardFieldFocused() {
  return Boolean(document.activeElement?.closest?.('.dashboard-note-editor'));
}

function isDashboardCardInteractiveTarget(target) {
  return Boolean(target?.closest?.([
    'input',
    'textarea',
    'button',
    'a',
    'details',
    'summary'
  ].join(',')));
}

function isDashboardDragTarget(target) {
  return !target?.closest?.([
    'input',
    'textarea',
    'button',
    'a',
    'details',
    'summary'
  ].join(','));
}

function patchDashboardNote(id, patch) {
  notes = notes.map((note) => note.id === id
    ? { ...note, ...patch, updatedAt: new Date().toISOString() }
    : note);

  window.electronAPI.patchNote(id, patch).catch((error) => {
    console.error('Could not save dashboard edit:', error);
  });
}

function getFloatingNotePosition(event) {
  return {
    x: Math.max(0, Math.round(event.screenX - 120)),
    y: Math.max(0, Math.round(event.screenY - 36))
  };
}

async function openFloatingNote(id, event) {
  const position = event ? getFloatingNotePosition(event) : {};
  await window.electronAPI.showNote(id, position);
}

function startDashboardDragOut(id, event) {
  if (
    event.button !== 0 ||
    draggedNoteId ||
    !isDashboardDragTarget(event.target)
  ) {
    return;
  }

  dashboardDragOut = {
    id,
    startClientX: event.clientX,
    startClientY: event.clientY,
    opened: false
  };
}

function startDashboardReorderCandidate(id, card, event) {
  if (
    event.button !== 0 ||
    draggedNoteId ||
    !isDashboardDragTarget(event.target)
  ) {
    return;
  }

  dashboardReorderCandidate = {
    id,
    card,
    startClientX: event.clientX,
    startClientY: event.clientY
  };
}

function maybeStartDashboardReorder(event) {
  if (!dashboardReorderCandidate || draggedNoteId || dashboardDragOut?.opened) {
    return;
  }

  const distance = Math.hypot(
    event.clientX - dashboardReorderCandidate.startClientX,
    event.clientY - dashboardReorderCandidate.startClientY
  );
  if (distance < DASHBOARD_REORDER_THRESHOLD_PX) {
    return;
  }

  draggedNoteId = dashboardReorderCandidate.id;
  dashboardReorderCandidate.card.classList.add('dragging');
  suppressDashboardClickUntil = Date.now() + 250;
  event.preventDefault();
}

function updateDashboardReorder(event) {
  if (!draggedNoteId) {
    return;
  }

  const targetCard = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest?.('.list-card[data-note-id]');
  const draggedCard = getDraggedCard();
  if (targetCard && draggedCard && targetCard.dataset.dashboardPinned === draggedCard.dataset.dashboardPinned) {
    moveDraggedCard(targetCard, event);
  }
  event.preventDefault();
}

function maybeOpenDraggedOutNote(event) {
  if (!dashboardDragOut || dashboardDragOut.opened || draggedNoteId) {
    return;
  }

  const distance = Math.hypot(
    event.clientX - dashboardDragOut.startClientX,
    event.clientY - dashboardDragOut.startClientY
  );
  if (distance < DASHBOARD_DRAG_OUT_THRESHOLD_PX) {
    return;
  }

  clearNoteDragState();
  dashboardDragOut.opened = true;
  suppressDashboardClickUntil = Date.now() + 250;
  openFloatingNote(dashboardDragOut.id, event).catch((error) => {
    console.error('Could not pop out note:', error);
  });
}

function renderNotes() {
  pinnedNoteList.innerHTML = '';
  noteList.innerHTML = '';

  const pinnedNotes = notes.filter((note) => note.dashboardPinned);
  const unpinnedNotes = notes.filter((note) => !note.dashboardPinned);
  pinnedNotesSection.classList.toggle('hidden', pinnedNotes.length === 0);

  function renderDashboardNote(note, container) {
    const card = document.createElement('article');
    card.className = `note-card list-card${note.positionLocked ? ' position-locked' : ''}${note.dashboardPinned ? ' dashboard-pinned' : ''}`;
    card.dataset.noteId = note.id;
    card.dataset.dashboardPinned = String(Boolean(note.dashboardPinned));
    card.style.background = formatter.getNoteColor(note.color);
    const pinActionLabel = note.dashboardPinned ? 'Unpin note from top row' : 'Pin note to top row';
    card.innerHTML = `
      <button class="icon-btn note-drag-handle" data-action="reorder" data-id="${escapeHtml(note.id)}" aria-label="Move note" title="Drag to reorder note">
        <span aria-hidden="true">&#8942;&#8942;</span>
      </button>
      <button class="icon-btn note-dashboard-pin" data-action="dashboard-pin" data-id="${escapeHtml(note.id)}" aria-label="${pinActionLabel}" title="${pinActionLabel}" aria-pressed="${note.dashboardPinned ? 'true' : 'false'}">${PIN_ICON_HTML}</button>
      <button class="icon-btn note-open-window" data-action="open-window" data-id="${escapeHtml(note.id)}" aria-label="Open floating note" title="Open floating note">${OPEN_FLOATING_ICON_HTML}</button>
      <button class="icon-btn note-card-hide" data-action="hide" data-id="${escapeHtml(note.id)}" aria-label="Hide floating note" title="Hide floating note">&times;</button>
      ${note.positionLocked ? `<span class="note-lock-badge" title="Position locked">${PIN_ICON_HTML}</span>` : ''}
      <div class="dashboard-note-editor">
        <input class="dashboard-title-input" aria-label="Note title" placeholder="Title" value="${escapeHtml(note.title || '')}" />
        <div class="dashboard-body-preview" tabindex="0" role="button" aria-label="Edit note body">
          ${formatter.renderNoteBodyHtml(note.body || '', { emptyText: '' })}
        </div>
        <textarea class="dashboard-body-input hidden" aria-label="Note body" placeholder="Write something...">${escapeHtml(note.body || '')}</textarea>
      </div>
      <small>${formatNoteDate(note.updatedAt || note.createdAt)}</small>
    `;

    const dragHandle = card.querySelector('[data-action="reorder"]');
    dragHandle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    dragHandle.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      startDashboardReorderCandidate(note.id, card, event);
    });

    card.querySelector('[data-action="hide"]').addEventListener('click', (event) => {
      event.stopPropagation();
      window.electronAPI.hideNote(note.id);
    });

    card.querySelector('[data-action="dashboard-pin"]').addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await window.electronAPI.patchNote(note.id, { dashboardPinned: !note.dashboardPinned });
        await refreshNotes();
      } catch (error) {
        window.alert(error.message || 'Could not update pinned note.');
      }
    });

    card.querySelector('[data-action="open-window"]').addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await openFloatingNote(note.id, event);
      } catch (error) {
        window.alert(error.message || 'Could not open floating note.');
      }
    });

    const titleInput = card.querySelector('.dashboard-title-input');
    const bodyInput = card.querySelector('.dashboard-body-input');
    const bodyPreview = card.querySelector('.dashboard-body-preview');
    let dashboardChecklistDragIndex = null;

    function renderDashboardBodyPreview() {
      bodyPreview.innerHTML = formatter.renderNoteBodyHtml(bodyInput.value, { emptyText: '' });
    }

    function toggleDashboardChecklistItem(event) {
      const checkbox = event.target.closest('.checklist-box[data-checklist-index]');
      if (!checkbox) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      const index = Number.parseInt(checkbox.dataset.checklistIndex, 10);
      const nextBody = formatter.toggleChecklistItem(bodyInput.value, index);
      if (nextBody === null) {
        return true;
      }

      bodyInput.value = nextBody;
      patchDashboardNote(note.id, { body: nextBody });
      renderDashboardBodyPreview();
      return true;
    }

    function getDashboardChecklistDragIndex(target) {
      const handle = target.closest?.('.checklist-drag-handle[data-checklist-index]');
      if (!handle) {
        return null;
      }

      const index = Number.parseInt(handle.dataset.checklistIndex, 10);
      return Number.isInteger(index) ? index : null;
    }

    function getDashboardChecklistDropIndex(target) {
      const item = target.closest?.('.checklist-item');
      const handle = item?.querySelector?.('[data-checklist-index]');
      if (!handle) {
        return null;
      }

      const index = Number.parseInt(handle.dataset.checklistIndex, 10);
      return Number.isInteger(index) ? index : null;
    }

    function reorderDashboardChecklistItem(fromIndex, toIndex) {
      const nextBody = formatter.reorderChecklistItem(bodyInput.value, fromIndex, toIndex);
      if (nextBody === null) {
        return false;
      }

      bodyInput.value = nextBody;
      patchDashboardNote(note.id, { body: nextBody });
      renderDashboardBodyPreview();
      return true;
    }

    function showDashboardBodyEditor() {
      bodyPreview.classList.add('hidden');
      bodyInput.classList.remove('hidden');
      bodyInput.focus();
      bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
    }

    function showDashboardBodyPreview() {
      bodyInput.classList.add('hidden');
      bodyPreview.classList.remove('hidden');
      renderDashboardBodyPreview();
    }

    titleInput.addEventListener('input', () => {
      patchDashboardNote(note.id, { title: titleInput.value });
    });

    bodyInput.addEventListener('input', () => {
      patchDashboardNote(note.id, { body: bodyInput.value });
    });

    bodyInput.addEventListener('blur', showDashboardBodyPreview);

    bodyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        bodyInput.blur();
      }
    });

    bodyPreview.addEventListener('click', (event) => {
      if (Date.now() < suppressDashboardClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.target.closest('.checklist-drag-handle')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (toggleDashboardChecklistItem(event)) {
        return;
      }

      if (event.target.closest('summary')) {
        return;
      }

      event.stopPropagation();
      showDashboardBodyEditor();
    });

    bodyPreview.addEventListener('dragstart', (event) => {
      const index = getDashboardChecklistDragIndex(event.target);
      if (index === null) {
        return;
      }

      dashboardChecklistDragIndex = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      event.stopPropagation();
    });

    bodyPreview.addEventListener('dragover', (event) => {
      if (dashboardChecklistDragIndex === null || getDashboardChecklistDropIndex(event.target) === null) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });

    bodyPreview.addEventListener('drop', (event) => {
      const toIndex = getDashboardChecklistDropIndex(event.target);
      if (dashboardChecklistDragIndex === null || toIndex === null) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      reorderDashboardChecklistItem(dashboardChecklistDragIndex, toIndex);
      dashboardChecklistDragIndex = null;
    });

    bodyPreview.addEventListener('dragend', () => {
      dashboardChecklistDragIndex = null;
    });

    bodyPreview.addEventListener('keydown', (event) => {
      if (event.target.closest('.checklist-box, .checklist-drag-handle')) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showDashboardBodyEditor();
      }
    });

    card.addEventListener('mousedown', (event) => {
      startDashboardReorderCandidate(note.id, card, event);
      startDashboardDragOut(note.id, event);
    });

    card.addEventListener('click', (event) => {
      if (Date.now() < suppressDashboardClickUntil || isDashboardCardInteractiveTarget(event.target)) {
        return;
      }

      showDashboardBodyEditor();
    });

    container.appendChild(card);
  }

  pinnedNotes.forEach((note) => renderDashboardNote(note, pinnedNoteList));
  unpinnedNotes.forEach((note) => renderDashboardNote(note, noteList));
}

newNoteButton.addEventListener('click', async () => {
  await window.electronAPI.createNote({ title: '', body: '' });
  await refreshNotes();
});

importButton.addEventListener('click', async () => {
  await window.electronAPI.importKeepNotes();
  await refreshNotes();
});

clearButton.addEventListener('click', async () => {
  await window.electronAPI.clearNotes();
  await refreshNotes();
});

settingsToggleButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleSettingsMenu();
});

settingsMenu.addEventListener('click', (event) => {
  if (event.target.closest('button')) {
    closeSettingsMenu();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.settings-menu-shell')) {
    closeSettingsMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSettingsMenu();
  }
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
    onboardingStatus.textContent = '';
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
  if (!isDashboardFieldFocused()) {
    renderNotes();
  }
});

async function refreshKeepStatus() {
  const status = await window.electronAPI.getKeepStatus();
  updateKeepStatus(status);
}

function updateKeepStatus(status = {}) {
  const connected = Boolean(status.connected);
  const syncState = getSyncState(status);
  keepStatusPill.textContent = syncState.label;
  keepStatusPill.className = `keep-status-pill ${syncState.className}`;
  keepAccountEmail.textContent = connected ? status.email || 'Google Keep' : 'Not connected';
  const detail = status.status || (connected
    ? 'Ready'
    : 'Connect Google Keep or import a Keep export JSON file.');
  keepStatusText.textContent = detail;
}

function getSyncState(status = {}) {
  const message = String(status.status || '').toLowerCase();
  if (status.error || /failed|error|invalid|timed out/.test(message)) {
    return { label: 'Problem', className: 'sync-state-problem' };
  }

  if (!status.connected) {
    return { label: 'Local only', className: 'sync-state-neutral' };
  }

  if (/edit saved locally|saving|syncing|pushing|pulling|authenticating|applying|testing|preview/.test(message)) {
    return { label: 'Unsaved changes', className: 'sync-state-unsaved' };
  }

  return { label: 'Synced', className: 'sync-state-synced' };
}

window.electronAPI.onKeepStatusChanged((status) => {
  updateKeepStatus(status);
});

function bindDashboardDropZone(container) {
  container.addEventListener('dragover', (event) => {
    if (draggedNoteId) {
      event.preventDefault();
    }
  });

  container.addEventListener('drop', async (event) => {
    if (!draggedNoteId) {
      return;
    }

    event.preventDefault();
    try {
      await persistNoteOrderFromDom();
    } finally {
      clearNoteDragState();
    }
  });
}

bindDashboardDropZone(pinnedNoteList);
bindDashboardDropZone(noteList);

document.addEventListener('mousemove', (event) => {
  maybeStartDashboardReorder(event);
  updateDashboardReorder(event);
  maybeOpenDraggedOutNote(event);
});

document.addEventListener('mouseup', async () => {
  if (draggedNoteId) {
    try {
      await persistNoteOrderFromDom();
    } finally {
      clearNoteDragState();
    }
  } else {
    dashboardReorderCandidate = null;
  }

  dashboardDragOut = null;
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

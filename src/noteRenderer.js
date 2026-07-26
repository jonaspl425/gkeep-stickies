const titleInput = document.getElementById('note-title');
const bodyInput = document.getElementById('note-body');
const bodyPreview = document.getElementById('note-body-preview');
const hideButton = document.getElementById('hide-btn');
const pinButton = document.getElementById('pin-btn');
const colorButton = document.getElementById('color-btn');
const colorPalette = document.getElementById('color-palette');
const currentColorSwatch = document.getElementById('current-color-swatch');
const resizeHandle = document.getElementById('resize-handle');
const card = document.getElementById('note-card');
const formatter = window.noteFormatting;
const WINDOW_DRAG_THRESHOLD_PX = 4;

let currentNote = null;
let resizing = false;
let resizeStart = { x: 0, y: 0, width: 0, height: 0 };
let windowDrag = null;
let suppressPreviewClickUntil = 0;

function isBodyEditing() {
  return !bodyInput.classList.contains('hidden');
}

function renderBodyPreview() {
  const body = isBodyEditing() ? bodyInput.value : currentNote?.body || '';
  bodyPreview.innerHTML = formatter.renderNoteBodyHtml(body);
}

function updateLockState() {
  const locked = Boolean(currentNote?.positionLocked);
  card.classList.toggle('position-locked', locked);
  pinButton.classList.toggle('active', locked);
  pinButton.setAttribute('aria-pressed', String(locked));
  pinButton.setAttribute('aria-label', locked ? 'Unlock note position' : 'Lock note position');
  pinButton.title = locked ? 'Unlock note position' : 'Lock note position';
  card.style.cursor = locked ? 'default' : 'grab';
}

function updateColorControls(color) {
  const noteColor = formatter.getNoteColor(color);
  const selected = formatter.NOTE_COLORS.find((item) => item.value === noteColor);

  card.style.background = noteColor;
  currentColorSwatch.style.background = noteColor;
  colorButton.title = selected ? `Color: ${selected.name}` : 'Choose note color';

  colorPalette.querySelectorAll('.color-swatch').forEach((button) => {
    button.classList.toggle('selected', button.dataset.color === noteColor);
    button.setAttribute('aria-selected', String(button.dataset.color === noteColor));
  });
}

function applyNote(note) {
  const editingBody = isBodyEditing() || document.activeElement === bodyInput;
  const editingTitle = document.activeElement === titleInput;

  currentNote = {
    ...note,
    title: editingTitle ? titleInput.value : note.title || '',
    body: editingBody ? bodyInput.value : note.body || ''
  };

  if (!editingTitle) {
    titleInput.value = note.title || '';
  }

  if (!editingBody) {
    bodyInput.value = note.body || '';
    renderBodyPreview();
  }

  updateColorControls(note.color);
  updateLockState();
}

function patchCurrentNote(patch) {
  if (!currentNote) {
    return;
  }

  currentNote = { ...currentNote, ...patch };
  window.electronAPI.patchNote(currentNote.id, patch);
}

function isWindowDragTarget(target) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  if (!element) {
    return false;
  }

  return !element.closest([
    'input',
    'textarea',
    'button',
    'a',
    'summary',
    '.color-palette',
    '.resize-handle'
  ].join(','));
}

function getCurrentWindowPosition() {
  const x = Number.isFinite(window.screenX) ? window.screenX : currentNote?.x;
  const y = Number.isFinite(window.screenY) ? window.screenY : currentNote?.y;

  return {
    x: Number.isFinite(x) ? x : 140,
    y: Number.isFinite(y) ? y : 140
  };
}

function getDraggedWindowPosition(event, drag = windowDrag) {
  return {
    x: Math.round(drag.startX + (event.screenX - drag.startScreenX)),
    y: Math.round(drag.startY + (event.screenY - drag.startScreenY))
  };
}

function startWindowDrag(event) {
  if (
    event.button !== 0 ||
    resizing ||
    !currentNote ||
    currentNote.positionLocked ||
    !isWindowDragTarget(event.target)
  ) {
    return;
  }

  const position = getCurrentWindowPosition();
  windowDrag = {
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startX: position.x,
    startY: position.y,
    moved: false
  };
}

function updateWindowDrag(event) {
  if (!windowDrag || !currentNote) {
    return;
  }

  const dx = event.screenX - windowDrag.startScreenX;
  const dy = event.screenY - windowDrag.startScreenY;
  if (!windowDrag.moved && Math.hypot(dx, dy) < WINDOW_DRAG_THRESHOLD_PX) {
    return;
  }

  windowDrag.moved = true;
  const position = getDraggedWindowPosition(event);
  currentNote = { ...currentNote, ...position };
  window.electronAPI.moveWindowLive({ id: currentNote.id, ...position });
  event.preventDefault();
}

async function finishWindowDrag(event) {
  if (!windowDrag) {
    return;
  }

  const drag = windowDrag;
  windowDrag = null;
  if (!drag.moved || !currentNote) {
    return;
  }

  const position = getDraggedWindowPosition(event, drag);
  suppressPreviewClickUntil = Date.now() + 250;
  currentNote = { ...currentNote, ...position };
  await window.electronAPI.moveWindow({ id: currentNote.id, ...position });
}

function showBodyEditor() {
  if (isBodyEditing()) {
    return;
  }

  bodyPreview.classList.add('hidden');
  bodyInput.classList.remove('hidden');
  bodyInput.value = currentNote?.body || '';
  bodyInput.focus();
  bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
}

function showBodyPreview() {
  if (!isBodyEditing()) {
    return;
  }

  bodyInput.classList.add('hidden');
  bodyPreview.classList.remove('hidden');
  renderBodyPreview();
}

function closeColorPalette() {
  colorPalette.classList.add('hidden');
  colorButton.setAttribute('aria-expanded', 'false');
}

function toggleColorPalette() {
  const isHidden = colorPalette.classList.toggle('hidden');
  colorButton.setAttribute('aria-expanded', String(!isHidden));
}

function buildColorPalette() {
  colorPalette.innerHTML = '';

  formatter.NOTE_COLORS.forEach((color) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'color-swatch';
    button.dataset.color = color.value;
    button.style.background = color.value;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-label', color.name);
    button.title = color.name;

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!currentNote) {
        return;
      }

      currentNote = { ...currentNote, color: color.value };
      updateColorControls(color.value);
      closeColorPalette();
      await window.electronAPI.patchNote(currentNote.id, { color: color.value });
    });

    colorPalette.appendChild(button);
  });
}

window.electronAPI.onNoteData((note) => {
  applyNote(note);
});

async function hydrateNote() {
  const noteId = new URLSearchParams(window.location.search).get('noteId');
  if (!noteId) {
    document.body.classList.add('missing-note');
    await window.electronAPI.closeCurrentWindow();
    return;
  }

  const note = await window.electronAPI.getNote(noteId);
  if (!note) {
    document.body.classList.add('missing-note');
    await window.electronAPI.closeCurrentWindow();
    return;
  }

  applyNote(note);
}

titleInput.addEventListener('input', () => {
  patchCurrentNote({ title: titleInput.value });
});

bodyInput.addEventListener('input', () => {
  patchCurrentNote({ body: bodyInput.value });
});

bodyInput.addEventListener('blur', showBodyPreview);

bodyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    bodyInput.blur();
  }
});

bodyPreview.addEventListener('click', (event) => {
  if (Date.now() < suppressPreviewClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (event.target.closest('summary')) {
    return;
  }

  showBodyEditor();
});

bodyPreview.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showBodyEditor();
  }
});

hideButton.addEventListener('click', () => {
  if (currentNote) {
    window.electronAPI.hideNote(currentNote.id);
  }
});

pinButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  if (!currentNote) {
    return;
  }

  const positionLocked = !currentNote.positionLocked;
  currentNote = { ...currentNote, positionLocked };
  updateLockState();
  await window.electronAPI.patchNote(currentNote.id, { positionLocked });
});

colorButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleColorPalette();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#color-palette') && !event.target.closest('#color-btn')) {
    closeColorPalette();
  }
});

resizeHandle.addEventListener('mousedown', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!currentNote) {
    return;
  }

  resizing = true;
  resizeStart = {
    x: event.clientX,
    y: event.clientY,
    width: currentNote.width || card.offsetWidth,
    height: currentNote.height || card.offsetHeight
  };
});

card.addEventListener('mousedown', startWindowDrag);

document.addEventListener('mousemove', (event) => {
  updateWindowDrag(event);

  if (!resizing || !currentNote) {
    return;
  }

  const nextWidth = Math.max(180, resizeStart.width + (event.clientX - resizeStart.x));
  const nextHeight = Math.max(160, resizeStart.height + (event.clientY - resizeStart.y));
  currentNote = { ...currentNote, width: nextWidth, height: nextHeight };
  window.electronAPI.setWindowBounds({ id: currentNote.id, width: nextWidth, height: nextHeight });
});

document.addEventListener('mouseup', (event) => {
  finishWindowDrag(event).catch((error) => {
    console.error('Failed to persist note position:', error);
  });
  resizing = false;
});

buildColorPalette();
hydrateNote();

const titleInput = document.getElementById('note-title');
const bodyInput = document.getElementById('note-body');
const bodyPreview = document.getElementById('note-body-preview');
const deleteButton = document.getElementById('delete-btn');
const pinButton = document.getElementById('pin-btn');
const colorButton = document.getElementById('color-btn');
const colorPalette = document.getElementById('color-palette');
const currentColorSwatch = document.getElementById('current-color-swatch');
const resizeHandle = document.getElementById('resize-handle');
const card = document.getElementById('note-card');
const formatter = window.noteFormatting;

let currentNote = null;
let dragging = false;
let dragStart = { x: 0, y: 0 };
let latestDragPosition = null;
let dragFrame = null;

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

function isInteractiveTarget(target) {
  return Boolean(target.closest('input, textarea, button, .note-body-preview, .color-palette, .resize-handle, summary'));
}

function flushDragPosition() {
  dragFrame = null;
  if (!dragging || !currentNote || currentNote.positionLocked || !latestDragPosition) {
    return;
  }

  currentNote = {
    ...currentNote,
    x: latestDragPosition.x,
    y: latestDragPosition.y
  };
  window.electronAPI.moveWindowLive({
    id: currentNote.id,
    x: latestDragPosition.x,
    y: latestDragPosition.y
  });
}

function scheduleDragPosition(x, y) {
  latestDragPosition = { x, y };
  if (dragFrame !== null) {
    return;
  }

  dragFrame = window.requestAnimationFrame(flushDragPosition);
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

deleteButton.addEventListener('click', async () => {
  if (currentNote) {
    await window.electronAPI.deleteNote(currentNote.id);
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

card.addEventListener('mousedown', (event) => {
  if (currentNote?.positionLocked || isInteractiveTarget(event.target)) {
    return;
  }

  event.preventDefault();
  dragging = true;
  dragStart = {
    x: event.clientX,
    y: event.clientY
  };
  card.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (event) => {
  if (!dragging || !currentNote || currentNote.positionLocked) {
    return;
  }

  const nextX = Math.max(0, event.screenX - dragStart.x);
  const nextY = Math.max(0, event.screenY - dragStart.y);
  scheduleDragPosition(nextX, nextY);
});

document.addEventListener('mouseup', async () => {
  const wasDragging = dragging;
  const finalPosition = latestDragPosition;
  dragging = false;
  latestDragPosition = null;
  if (dragFrame !== null) {
    window.cancelAnimationFrame(dragFrame);
    dragFrame = null;
  }

  if (wasDragging && currentNote && !currentNote.positionLocked && finalPosition) {
    currentNote = { ...currentNote, x: finalPosition.x, y: finalPosition.y };
    window.electronAPI.moveWindowLive({
      id: currentNote.id,
      x: finalPosition.x,
      y: finalPosition.y
    });
    await window.electronAPI.moveWindow({
      id: currentNote.id,
      x: finalPosition.x,
      y: finalPosition.y,
      persist: true
    });
  }

  updateLockState();
});

let resizing = false;
let resizeStart = { x: 0, y: 0, width: 0, height: 0 };

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

document.addEventListener('mousemove', (event) => {
  if (!resizing || !currentNote) {
    return;
  }

  const nextWidth = Math.max(180, resizeStart.width + (event.clientX - resizeStart.x));
  const nextHeight = Math.max(160, resizeStart.height + (event.clientY - resizeStart.y));
  currentNote = { ...currentNote, width: nextWidth, height: nextHeight };
  window.electronAPI.setWindowBounds({ id: currentNote.id, x: currentNote.x, y: currentNote.y, width: nextWidth, height: nextHeight });
});

document.addEventListener('mouseup', () => {
  resizing = false;
});

buildColorPalette();
hydrateNote();

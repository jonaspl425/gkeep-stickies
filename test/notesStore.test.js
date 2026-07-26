const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNoteStore } = require('../src/notesStore');

test('reset notes remains empty after load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));

  assert.equal(store.loadNotes({ seedDefaults: true }).length, 2);

  store.resetNotes();

  assert.deepEqual(store.loadNotes(), []);
  assert.deepEqual(store.loadNotes({ seedDefaults: false }), []);
});

test('load notes recovers corrupt JSON into a quarantined file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const storagePath = path.join(dir, 'notes.json');
  fs.writeFileSync(storagePath, '{', 'utf8');

  const store = createNoteStore(storagePath);
  const notes = store.loadNotes();
  const files = fs.readdirSync(dir);

  assert.deepEqual(notes, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')), []);
  assert.equal(files.filter((file) => file.startsWith('notes.json.corrupt.')).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, files.find((file) => file.startsWith('notes.json.corrupt.'))), 'utf8'), '{');
});

test('save notes writes valid JSON without leaving temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const storagePath = path.join(dir, 'notes.json');
  const store = createNoteStore(storagePath);

  store.saveNotes([{ id: 'note-1', title: 'Saved', body: 'Body' }]);

  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const files = fs.readdirSync(dir);

  assert.equal(saved[0].id, 'note-1');
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
});

test('create note sanitizes unsafe fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({
    title: 't'.repeat(250),
    body: 'b'.repeat(20050),
    x: -25,
    y: 'off-screen',
    width: 10,
    height: 10,
    color: 'url(javascript:alert(1))',
    positionLocked: 1,
    keep: {
      id: 123,
      sourceHash: 'source-hash',
      dirtyFields: ['title', 7]
    },
    keepFields: {
      pinned: 1,
      labels: [{ id: 'label-1', name: 'Important' }]
    }
  });

  assert.equal(note.title.length, 200);
  assert.equal(note.body.length, 20000);
  assert.equal(note.x, 0);
  assert.equal(note.y, 140);
  assert.equal(note.width, 180);
  assert.equal(note.height, 160);
  assert.equal(note.color, '#fff59d');
  assert.equal(note.positionLocked, true);
  assert.equal(note.keep.id, null);
  assert.equal(note.keep.sourceHash, 'source-hash');
  assert.deepEqual(note.keep.dirtyFields, ['title']);
  assert.equal(note.keepFields.pinned, true);
  assert.deepEqual(note.keepFields.labels, [{ id: 'label-1', name: 'Important' }]);
});

test('save notes drops non-note values and sanitizes records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const storagePath = path.join(dir, 'notes.json');
  const store = createNoteStore(storagePath);

  store.saveNotes([
    null,
    'bad',
    {
      id: '',
      title: { bad: true },
      body: false,
      color: '#ABCDEF',
      x: 12,
      y: 34,
      width: 999999,
      height: Number.NaN,
      unknown: 'drop me'
    }
  ]);

  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'));

  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, 'New note');
  assert.equal(saved[0].body, 'false');
  assert.equal(saved[0].color, '#abcdef');
  assert.equal(saved[0].x, 12);
  assert.equal(saved[0].y, 34);
  assert.equal(saved[0].width, 10000);
  assert.equal(saved[0].height, 220);
  assert.equal(Object.hasOwn(saved[0], 'unknown'), false);
});

test('patch note persists position lock state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({ title: 'Lock me' });

  const updated = store.patchNote(note.id, { positionLocked: true });

  assert.equal(updated.positionLocked, true);
  assert.equal(store.loadNotes()[0].positionLocked, true);
});

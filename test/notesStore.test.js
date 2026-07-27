const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNoteStore } = require('../src/notesStore');

test('reset notes remains empty after load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));

  assert.equal(store.loadNotes({ seedDefaults: true }).length, 2);

  store.resetNotes();

  assert.deepEqual(store.loadNotes(), []);
  assert.deepEqual(store.loadNotes({ seedDefaults: false }), []);
});

test('load notes recovers corrupt JSON into a quarantined file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
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

test('load notes migrates an existing legacy notes file once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const legacyPath = path.join(dir, 'legacy-notes.json');
  const storagePath = path.join(dir, 'notes.json');
  fs.writeFileSync(legacyPath, JSON.stringify([{ id: 'legacy-1', title: 'Legacy note' }]), 'utf8');

  const store = createNoteStore(storagePath, { migrateFrom: legacyPath });
  const notes = store.loadNotes();

  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 'legacy-1');
  assert.equal(notes[0].title, 'Legacy note');
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8'))[0].id, 'legacy-1');
});

test('save notes writes valid JSON without leaving temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const storagePath = path.join(dir, 'notes.json');
  const store = createNoteStore(storagePath);

  store.saveNotes([{ id: 'note-1', title: 'Saved', body: 'Body' }]);

  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const files = fs.readdirSync(dir);

  assert.equal(saved[0].id, 'note-1');
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
});

test('create note sanitizes unsafe fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
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
  assert.equal(note.color, '#ffffff');
  assert.equal(note.positionLocked, true);
  assert.equal(note.keep.id, null);
  assert.equal(note.keep.sourceHash, 'source-hash');
  assert.deepEqual(note.keep.dirtyFields, ['title']);
  assert.equal(note.keepFields.pinned, true);
  assert.deepEqual(note.keepFields.labels, [{ id: 'label-1', name: 'Important' }]);
});

test('create note treats false-like strings as false booleans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({
    positionLocked: 'false',
    dashboardPinned: '0',
    keepFields: {
      pinned: 'false',
      archived: '0',
      trashed: 'false'
    }
  });

  assert.equal(note.positionLocked, false);
  assert.equal(note.dashboardPinned, false);
  assert.equal(note.keepFields.pinned, false);
  assert.equal(note.keepFields.archived, false);
  assert.equal(note.keepFields.trashed, false);
});

test('save notes drops non-note values and sanitizes records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
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
  assert.equal(saved[0].title, '');
  assert.equal(saved[0].body, 'false');
  assert.equal(saved[0].color, '#abcdef');
  assert.equal(saved[0].x, 12);
  assert.equal(saved[0].y, 34);
  assert.equal(saved[0].width, 10000);
  assert.equal(saved[0].height, 220);
  assert.equal(Object.hasOwn(saved[0], 'unknown'), false);
});

test('patch note persists position lock state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({ title: 'Lock me' });

  const updated = store.patchNote(note.id, { positionLocked: true });

  assert.equal(updated.positionLocked, true);
  assert.equal(store.loadNotes()[0].positionLocked, true);
});

test('patch note persists dashboard pinned state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({ title: 'Pin me' });

  const updated = store.patchNote(note.id, { dashboardPinned: true });

  assert.equal(updated.dashboardPinned, true);
  assert.equal(store.loadNotes()[0].dashboardPinned, true);
});

test('create note preserves a blank title', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({ body: 'Body without a title' });

  assert.equal(note.title, '');
  assert.equal(store.loadNotes()[0].title, '');
});

test('mark synced keeps newer dirty edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const note = store.createNote({ title: 'Draft', body: 'One' });
  const firstDirty = store.markNoteDirty(note.id, ['body']);
  store.patchNote(note.id, { body: 'Two' });
  store.markNoteDirty(note.id, ['body']);

  const synced = store.markNoteSynced(note.id, {
    id: 'keep-1',
    accountEmail: 'person@example.com'
  }, {}, { expectedLocalRevision: firstDirty.keep.localRevision });

  assert.equal(synced.keep.id, 'keep-1');
  assert.equal(synced.keep.syncState, 'dirty');
  assert.deepEqual(synced.keep.dirtyFields, ['body']);
});

test('reorder notes persists requested order and keeps unmentioned notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-notes-store-'));
  const store = createNoteStore(path.join(dir, 'notes.json'));
  const first = store.createNote({ title: 'First' });
  const second = store.createNote({ title: 'Second' });
  const third = store.createNote({ title: 'Third' });

  const reordered = store.reorderNotes([third.id, first.id, 'missing-note', third.id]);

  assert.deepEqual(reordered.map((note) => note.id), [third.id, first.id, second.id]);
  assert.deepEqual(store.loadNotes().map((note) => note.id), [third.id, first.id, second.id]);
});

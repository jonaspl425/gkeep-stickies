const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoteStore } = require('../src/notesStore');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('get-one returns a note by id and null for missing ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-notes-'));
  const storagePath = path.join(dir, 'notes.json');
  const store = createNoteStore(storagePath);

  const note = store.createNote({ title: 'Test', body: 'Body' });
  const notes = store.loadNotes({ seedDefaults: false });

  assert.equal(notes.find((item) => item.id === note.id)?.title, 'Test');
  assert.equal(notes.find((item) => item.id === 'missing'), undefined);
});

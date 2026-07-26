const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKeepNotes, syncKeepNotes, mergeKeepNotes } = require('../src/keepSync');

test('normalizes Keep note payloads into app notes', () => {
  const input = [
    {
      title: 'Weekly plan',
      text: 'Ship the release',
      color: '#ffe082'
    },
    {
      title: 'Empty note'
    },
    {
      text: 'No title'
    }
  ];

  const result = normalizeKeepNotes(input);

  assert.equal(result.length, 3);
  assert.equal(result[0].title, 'Weekly plan');
  assert.equal(result[0].body, 'Ship the release');
  assert.equal(result[0].importedFromKeep, true);
  assert.equal(result[1].title, 'Empty note');
  assert.equal(result[1].body, '');
  assert.equal(result[2].title, '');
  assert.equal(result[2].body, 'No title');
});

test('syncKeepNotes merges remote Keep notes into existing local notes without duplicating them', async () => {
  const saved = [];
  const existing = [
    {
      id: 'local-note-1',
      title: 'Old title',
      body: 'old body',
      x: 12,
      y: 34,
      width: 240,
      height: 220,
      color: '#fff59d',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      importedFromKeep: false,
      keep: {
        id: 'keep-remote-1',
        syncState: 'synced',
        lastRemoteHash: 'old-hash'
      }
    }
  ];

  const noteStore = {
    loadNotes: () => existing,
    saveNotes: (notes) => {
      saved.push(notes);
      return notes;
    }
  };

  const result = await syncKeepNotes(noteStore, {
    keepApi: {
      getAllNotes: async () => [
        {
          id: 'keep-remote-1',
          title: 'Updated title',
          text: 'updated body',
          color: '#ffe082',
          pinned: true,
          archived: false,
          trashed: false
        }
      ]
    }
  });

  assert.equal(result.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].title, 'Updated title');
  assert.equal(saved[0][0].body, 'updated body');
  assert.equal(saved[0][0].x, 12);
  assert.equal(saved[0][0].keep.id, 'keep-remote-1');
  assert.equal(saved[0][0].keepFields.pinned, true);
  assert.equal(saved[0][0].importedFromKeep, true);
});

test('mergeKeepNotes does not match unrelated notes by missing remote id', () => {
  const existing = [
    {
      id: 'local-note-without-remote-id',
      title: 'Existing local note',
      body: 'keep me',
      color: '#fff59d',
      keep: {
        id: null
      }
    }
  ];

  const remote = normalizeKeepNotes([
    { title: 'Imported A', text: 'alpha' },
    { title: 'Imported B', text: 'beta' }
  ]);

  const result = mergeKeepNotes(existing, remote);

  assert.equal(result.length, 3);
  assert.equal(result[0].title, 'Existing local note');
  assert.equal(result[1].title, 'Imported A');
  assert.equal(result[2].title, 'Imported B');
});

test('syncKeepNotes is idempotent for Keep export notes without remote ids', async () => {
  let currentNotes = [];
  const noteStore = {
    loadNotes: () => currentNotes,
    saveNotes: (notes) => {
      currentNotes = notes;
      return notes;
    }
  };
  const keepApi = {
    getAllNotes: async () => [
      {
        title: 'No remote id',
        text: 'Same content each import',
        color: '#FFE082',
        createdAt: '2026-07-26T12:00:00.000Z',
        updatedAt: '2026-07-26T12:30:00.000Z'
      }
    ]
  };

  const first = await syncKeepNotes(noteStore, { keepApi });
  const second = await syncKeepNotes(noteStore, { keepApi });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].keep.source, 'google-keep-export');
  assert.equal(typeof second[0].keep.sourceHash, 'string');
});

test('normalizes checklist-style Keep export items into multiline bodies', () => {
  const result = normalizeKeepNotes([
    {
      title: 'Groceries',
      text: 'Flat fallback should not hide checklist state',
      items: [
        { text: 'Milk', checked: true },
        { text: 'Eggs', checked: false }
      ],
      archived: true,
      trashed: true
    }
  ]);

  assert.equal(result[0].title, 'Groceries');
  assert.equal(result[0].body, '[ ] Eggs\n[x] Milk');
  assert.equal(result[0].keepFields.archived, true);
  assert.equal(result[0].keepFields.trashed, true);
});

test('normalizes checklist items into website display order', () => {
  const result = normalizeKeepNotes([
    {
      title: 'Groceries',
      items: [
        { text: 'Done second', checked: true, sortValue: '2' },
        { text: 'Open second', checked: false, sortValue: '2' },
        { text: 'Open first', checked: false, sortValue: '1' },
        { text: 'Done first', checked: true, sortValue: '1' }
      ]
    }
  ]);

  assert.equal(result[0].body, '[ ] Open first\n[ ] Open second\n[x] Done first\n[x] Done second');
});

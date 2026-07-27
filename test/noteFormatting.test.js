const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTitle,
  parseChecklist,
  renderNoteBodyHtml,
  reorderChecklistItem,
  toggleChecklistItem
} = require('../src/noteFormatting');

test('keeps blank titles blank', () => {
  assert.equal(formatTitle(''), '');
  assert.equal(formatTitle('   '), '');
});

test('renders active checklist items above a collapsed completed summary', () => {
  const html = renderNoteBodyHtml('\u2611 Done\n\u2610 Todo\n[x] Old\n[ ] New');

  assert.ok(html.includes('<details class="completed-checklist">'));
  assert.ok(html.includes('class="checklist-box" data-checklist-index="0"'));
  assert.ok(html.includes('aria-checked="false"'));
  assert.ok(html.includes('aria-checked="true"'));
  assert.ok(html.includes('2 completed items'));
  assert.ok(html.indexOf('Todo') < html.indexOf('2 completed items'));
  assert.ok(html.indexOf('New') < html.indexOf('2 completed items'));
  assert.ok(html.indexOf('Todo') < html.indexOf('New'));
  assert.ok(html.indexOf('2 completed items') < html.indexOf('Old'));
});

test('toggles checklist items and keeps checked items at the bottom', () => {
  assert.equal(
    toggleChecklistItem('[ ] First\n[ ] Second\n[x] Done', 0),
    '[ ] Second\n[x] Done\n[x] First'
  );

  assert.equal(
    toggleChecklistItem('[ ] First\n[x] Done\n[x] Old', 1),
    '[ ] Done\n[ ] First\n[x] Old'
  );
});

test('reorders checklist items by display order', () => {
  assert.equal(
    reorderChecklistItem('[ ] Do laundry\n[ ] Do dishwasher\n[x] Done already', 1, 0),
    '[ ] Do dishwasher\n[ ] Do laundry\n[x] Done already'
  );

  assert.equal(
    reorderChecklistItem('[ ] First\n[ ] Second\n[ ] Third', 0, 2),
    '[ ] Second\n[ ] Third\n[ ] First'
  );
});

test('keeps completed checklist items in the completed group when reordering', () => {
  assert.equal(reorderChecklistItem('[ ] Active\n[x] First done\n[x] Second done', 1, 0), null);
  assert.equal(
    reorderChecklistItem('[ ] Active\n[x] First done\n[x] Second done', 2, 1),
    '[ ] Active\n[x] Second done\n[x] First done'
  );
});

test('does not treat mixed regular text as a checklist', () => {
  assert.equal(parseChecklist('Heading\n\u2610 Item'), null);
});

test('renders small rich-text markup while escaping unsafe html', () => {
  const html = renderNoteBodyHtml('This is **bold** and <b>also bold</b>\n<script>alert(1)</script>');

  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<b>also bold</b>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

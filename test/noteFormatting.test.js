const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseChecklist,
  renderNoteBodyHtml
} = require('../src/noteFormatting');

test('renders active checklist items above a collapsed completed summary', () => {
  const html = renderNoteBodyHtml('\u2611 Done\n\u2610 Todo\n[x] Old\n[ ] New');

  assert.ok(html.includes('<details class="completed-checklist">'));
  assert.ok(html.includes('2 completed items'));
  assert.ok(html.indexOf('Todo') < html.indexOf('2 completed items'));
  assert.ok(html.indexOf('New') < html.indexOf('2 completed items'));
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

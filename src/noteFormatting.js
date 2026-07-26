(function exposeNoteFormatting(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.noteFormatting = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function createNoteFormatting() {
  const DEFAULT_COLOR = '#ffffff';
  const NOTE_COLORS = [
    { name: 'White', value: '#ffffff' },
    { name: 'Yellow', value: '#fff59d' },
    { name: 'Coral', value: '#f28b82' },
    { name: 'Orange', value: '#fbbc04' },
    { name: 'Amber', value: '#ffe082' },
    { name: 'Green', value: '#ccff90' },
    { name: 'Mint', value: '#a7ffeb' },
    { name: 'Blue', value: '#cbf0f8' },
    { name: 'Indigo', value: '#aecbfa' },
    { name: 'Purple', value: '#d7aefb' },
    { name: 'Pink', value: '#fdcfe8' },
    { name: 'Gray', value: '#e8eaed' }
  ];

  function normalizeText(value = '') {
    return String(value ?? '').replace(/\r\n?/g, '\n');
  }

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getNoteColor(value, fallback = DEFAULT_COLOR) {
    if (typeof value !== 'string') {
      return fallback;
    }

    const color = value.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
  }

  function formatTitle(value = '') {
    const title = normalizeText(value).trim();
    return title;
  }

  function restoreAllowedTags(html) {
    return html
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/&lt;(\/?)(b|strong|i|em|u|s|strike|del|mark)&gt;/gi, '<$1$2>');
  }

  function renderInlineMarkup(value = '') {
    let html = restoreAllowedTags(escapeHtml(value));

    html = html
      .replace(/\*\*([^*\n](?:[\s\S]*?[^*\n])?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n](?:[\s\S]*?[^_\n])?)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n](?:[\s\S]*?[^~\n])?)~~/g, '<s>$1</s>')
      .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
      .replace(/_([^_\n]+?)_/g, '<em>$1</em>');

    return html;
  }

  function parseChecklistLine(line) {
    const match = String(line).match(/^\s*(?:[-*]\s*)?(?:\[( |x|X)\]|(\u2610|\u2611|\u2612))\s*(.*)$/);
    if (!match) {
      return null;
    }

    const marker = match[1] || match[2];
    const completed = marker === 'x' || marker === 'X' || marker === '\u2611' || marker === '\u2612';
    return {
      completed,
      text: match[3] || ''
    };
  }

  function parseChecklist(value = '') {
    const lines = normalizeText(value).split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
      return null;
    }

    const parsedItems = nonEmptyLines.map(parseChecklistLine);
    if (parsedItems.some((item) => !item)) {
      return null;
    }

    const items = parsedItems
      .map((item) => ({ ...item, text: item.text.trim() }))
      .filter((item) => item.text.length > 0);

    if (items.length === 0) {
      return null;
    }

    return {
      active: items.filter((item) => !item.completed),
      completed: items.filter((item) => item.completed)
    };
  }

  function renderChecklistItem(item, completed = false) {
    const stateClass = completed ? ' completed' : '';
    const checkmark = completed ? '&#10003;' : '';
    return [
      `<div class="checklist-item${stateClass}">`,
      `<span class="checklist-box" aria-hidden="true">${checkmark}</span>`,
      `<span class="checklist-text">${renderInlineMarkup(item.text)}</span>`,
      '</div>'
    ].join('');
  }

  function pluralizeItem(count) {
    return count === 1 ? 'item' : 'items';
  }

  function renderChecklistHtml(checklist) {
    const activeHtml = checklist.active
      .map((item) => renderChecklistItem(item, false))
      .join('');
    const completedHtml = checklist.completed
      .map((item) => renderChecklistItem(item, true))
      .join('');
    const completedCount = checklist.completed.length;
    const completedGroup = completedCount > 0
      ? [
        '<details class="completed-checklist">',
        `<summary>${completedCount} completed ${pluralizeItem(completedCount)}</summary>`,
        completedHtml,
        '</details>'
      ].join('')
      : '';

    return `<div class="checklist-display">${activeHtml}${completedGroup}</div>`;
  }

  function renderRichTextHtml(value = '', options = {}) {
    const text = normalizeText(value);
    if (!text.trim()) {
      const emptyText = options.emptyText === undefined ? 'Write something...' : options.emptyText;
      return `<div class="rich-text-display empty-note-body">${escapeHtml(emptyText)}</div>`;
    }

    return `<div class="rich-text-display">${renderInlineMarkup(text).replace(/\n/g, '<br>')}</div>`;
  }

  function renderNoteBodyHtml(value = '', options = {}) {
    const checklist = parseChecklist(value);
    if (checklist) {
      return renderChecklistHtml(checklist);
    }

    return renderRichTextHtml(value, options);
  }

  return {
    DEFAULT_COLOR,
    NOTE_COLORS,
    escapeHtml,
    formatTitle,
    getNoteColor,
    parseChecklist,
    renderInlineMarkup,
    renderNoteBodyHtml
  };
});

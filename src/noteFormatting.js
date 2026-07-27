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

  function createChecklistItems(value = '') {
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

    return items.length > 0 ? items : null;
  }

  function parseChecklist(value = '') {
    const items = createChecklistItems(value);
    if (!items) {
      return null;
    }

    return {
      active: items.filter((item) => !item.completed),
      completed: items.filter((item) => item.completed)
    };
  }

  function serializeChecklistItems(items = []) {
    return [
      ...items.filter((item) => !item.completed),
      ...items.filter((item) => item.completed)
    ]
      .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text}`)
      .join('\n');
  }

  function toggleChecklistItem(value = '', displayIndex) {
    const items = createChecklistItems(value);
    if (!items || !Number.isInteger(displayIndex)) {
      return null;
    }

    const sortedItems = [
      ...items.filter((item) => !item.completed),
      ...items.filter((item) => item.completed)
    ];
    if (displayIndex < 0 || displayIndex >= sortedItems.length) {
      return null;
    }

    const toggledItem = {
      ...sortedItems[displayIndex],
      completed: !sortedItems[displayIndex].completed
    };
    const remainingItems = sortedItems.filter((_item, index) => index !== displayIndex);
    const nextItems = toggledItem.completed
      ? [...remainingItems, toggledItem]
      : [toggledItem, ...remainingItems];

    return serializeChecklistItems(nextItems);
  }

  function reorderChecklistItem(value = '', fromDisplayIndex, toDisplayIndex) {
    const items = createChecklistItems(value);
    if (!items || !Number.isInteger(fromDisplayIndex) || !Number.isInteger(toDisplayIndex)) {
      return null;
    }

    const sortedItems = [
      ...items.filter((item) => !item.completed),
      ...items.filter((item) => item.completed)
    ];
    if (
      fromDisplayIndex < 0 ||
      fromDisplayIndex >= sortedItems.length ||
      toDisplayIndex < 0 ||
      toDisplayIndex >= sortedItems.length ||
      fromDisplayIndex === toDisplayIndex
    ) {
      return null;
    }

    const movingItem = sortedItems[fromDisplayIndex];
    const targetItem = sortedItems[toDisplayIndex];
    if (movingItem.completed !== targetItem.completed) {
      return null;
    }

    const nextItems = [...sortedItems];
    const [removed] = nextItems.splice(fromDisplayIndex, 1);
    const adjustedToIndex = toDisplayIndex;
    nextItems.splice(adjustedToIndex, 0, removed);
    return serializeChecklistItems(nextItems);
  }

  function renderChecklistItem(item, completed = false, displayIndex = 0) {
    const stateClass = completed ? ' completed' : '';
    const checkmark = completed ? '&#10003;' : '';
    return [
      `<div class="checklist-item${stateClass}">`,
      '<button type="button" ',
      `class="checklist-drag-handle" data-checklist-index="${displayIndex}" `,
      'draggable="true" aria-label="Drag checklist item" title="Drag checklist item">',
      '&#8942;',
      '</button>',
      '<button type="button" ',
      `class="checklist-box" data-checklist-index="${displayIndex}" `,
      `aria-checked="${completed ? 'true' : 'false'}" `,
      `aria-label="${completed ? 'Mark incomplete' : 'Mark complete'}">`,
      checkmark,
      '</button>',
      `<span class="checklist-text">${renderInlineMarkup(item.text)}</span>`,
      '</div>'
    ].join('');
  }

  function pluralizeItem(count) {
    return count === 1 ? 'item' : 'items';
  }

  function renderChecklistHtml(checklist) {
    let displayIndex = 0;
    const activeHtml = checklist.active
      .map((item) => renderChecklistItem(item, false, displayIndex++))
      .join('');
    const completedHtml = checklist.completed
      .map((item) => renderChecklistItem(item, true, displayIndex++))
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
    renderNoteBodyHtml,
    reorderChecklistItem,
    toggleChecklistItem
  };
});

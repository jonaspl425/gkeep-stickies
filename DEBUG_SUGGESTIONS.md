# Persistent Notes Debug Suggestions

Generated: 2026-07-26

Updated: 2026-07-26

## Current Status

Several findings in this historical debug pass have since been implemented or partially implemented:

- Resize now uses `window:set-bounds` and persists width/height.
- Text and appearance edits use `notes:patch` from renderer paths.
- Clear-notes behavior now remains empty after reload.
- Dashboard card actions now separate editing from opening floating notes instead of mutating note content on ordinary clicks.
- Storage now recovers corrupt JSON by quarantining the bad file and writes through a temporary file before rename.
- Storage now sanitizes persisted note records, clamps window bounds, caps text fields, and restricts colors to hex values.
- Google Keep export notes without remote IDs now receive stable source hashes, making repeated imports idempotent for unchanged ID-less notes.
- Google Keep account sync MVP is implemented with encrypted credential storage, a Python `gkeepapi` bridge, backup-backed onboarding, read-only preview, manual sync, local upload, remote pull, dirty linked-note updates, and remote trash on local delete when enabled.
- `.gitignore` now excludes `node_modules/` and local runtime note data.

Remaining work includes broader Electron-level IPC tests, richer Keep export fixtures, schema-versioned migrations, conflict resolution, and advanced Keep field mapping.

## Scope

This document captures a technical debug pass over the local `persistent-notes-desktop` repository. The project is a small Electron application with:

- Main process orchestration in `src/main.js`.
- A secure preload bridge in `src/preload.js`.
- Main-window renderer behavior in `src/renderer.js`.
- Floating-note renderer behavior in `src/noteRenderer.js`.
- JSON-backed persistence in `src/notesStore.js`.
- Google Keep import normalization in `src/keepSync.js`.

The repository now has committed first-party source files. Local runtime data, dependency folders, generated package outputs, and credential files are ignored by `.gitignore`.

## Verification Baseline

Commands run:

```powershell
node --check src\main.js
node --check src\keepSync.js
node --check src\notesStore.js
node --check src\renderer.js
node --check src\noteRenderer.js
npm ls --depth=0
npm test
```

Results:

- Static syntax checks passed for all first-party JavaScript files.
- `npm ls --depth=0` reports `electron@35.7.5`.
- `npm test` passes outside the Codex filesystem sandbox:

```text
tests 21
pass 21
fail 0
```

The initial in-sandbox `npm test` failed with `spawn EPERM` from Node's test runner. Treat that as an execution-environment artifact unless it reproduces in a normal shell.

## Runtime Topology

### Main Process

`src/main.js` owns the persistent `noteStore`, `mainWindow`, and a `Map<string, BrowserWindow>` called `floatingNoteWindows`.

Key contracts:

- `notes:load` returns `noteStore.loadNotes()`.
- `notes:create` persists a new note, opens or updates its floating window, and broadcasts `notes:changed`.
- `notes:update` accepts a renderer-provided note object and merges it into the stored note.
- `notes:delete` removes a stored note and closes the associated floating window.
- `notes:clear` resets the store and closes all floating windows.
- `notes:import` reads a selected JSON file and creates one local note per imported item.
- `notes:sync-keep` reads a selected JSON file, normalizes it through `syncKeepNotes`, and opens windows for all merged notes.
- `window:move` moves a floating note window and persists only `x` and `y`.
- `window:set-bounds` resizes or moves a floating note window and persists `x`, `y`, `width`, and `height`.
- `notes:show` focuses an existing floating note window without mutating note content.

### Renderer Surface

The dashboard renderer (`src/renderer.js`) renders cards, creates notes, deletes notes, imports JSON, opens Google Keep, and reacts to `notes:changed`.

The floating note renderer (`src/noteRenderer.js`) hydrates by `noteId`, receives `note:data`, writes title/body through `notes:patch`, implements drag with `window:move`, and resizes through `window:set-bounds`.

### Persistence

`src/notesStore.js` synchronously reads and writes `data/notes.json`. It now quarantines corrupt JSON, writes through a temp file before rename, and sanitizes core note fields before persistence.

## High-Priority Debug Findings

### 1. Floating Note Resize IPC Is Functionally Incomplete

Status: Resolved in the current code through `window:set-bounds`.

Evidence:

- `src/noteRenderer.js:109-112` computes `nextWidth` and `nextHeight`, updates `currentNote`, and calls `window.electronAPI.moveWindow({ id, x, y, width, height })`.
- `src/main.js:218-228` handles `window:move`, but only calls `window.setPosition(payload.x, payload.y)` and persists only `{ id, x, y }`.

Expected behavior:

- Dragging the resize handle should resize the Electron `BrowserWindow`.
- Width and height should persist to `data/notes.json`.
- Relaunching the app should restore the resized dimensions.

Likely actual behavior:

- The renderer local state changes, but the native window size does not change.
- Stored note dimensions remain unchanged.
- A restart restores the previous size.

Suggested remediation:

- Replace `window:move` with a more accurate `window:set-bounds` contract, or extend the existing handler to process size fields.
- Validate numeric bounds in the main process, not only in the renderer.
- Use `BrowserWindow#setBounds` for atomic position/size application when width or height is present.

Recommended main-process shape:

```js
ipcMain.handle('window:set-bounds', (_event, payload) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (!window || window.isDestroyed()) return payload;

  const patch = {
    id: payload.id,
    x: Number.isFinite(payload.x) ? Math.max(0, payload.x) : undefined,
    y: Number.isFinite(payload.y) ? Math.max(0, payload.y) : undefined,
    width: Number.isFinite(payload.width) ? Math.max(180, payload.width) : undefined,
    height: Number.isFinite(payload.height) ? Math.max(160, payload.height) : undefined
  };

  window.setBounds(Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => key !== 'id' && value !== undefined)
  ));

  const updated = noteStore.updateNote(patch);
  refreshMainWindow(noteStore.loadNotes());
  return updated;
});
```

Test probes:

- Unit-test the IPC handler using a fake `BrowserWindow.fromWebContents`.
- Add an integration test for note bounds persistence after a resize payload.
- Manually verify: create note, resize, close app, relaunch, confirm width/height are restored.

### 2. Whole-Object Renderer Updates Can Clobber Concurrent State

Status: Partially resolved. Renderer edit paths now use `notes:patch`, but the legacy `notes:update` surface still exists.

Evidence:

- `src/noteRenderer.js:21-31` constructs `updated = { ...currentNote, title, body }` and sends the entire object through `notes:update`.
- `src/noteRenderer.js:34-35` calls `persistCurrent` on every `input` event.
- `src/noteRenderer.js:31` does not await the `updateNote` promise and does not consume the canonical updated note returned by the main process.
- `src/main.js:120-125` accepts the renderer-provided object and merges it over stored state.
- `src/notesStore.js:97-109` applies `{ ...notes[index], ...updated, updatedAt }`.

Failure mode:

Any renderer event using a stale `currentNote` snapshot can overwrite fields modified by another event path. For example:

- User drags the note, updating `x`/`y` through `window:move`.
- User types immediately afterward.
- `persistCurrent` sends a full stale note object with older `x`/`y`.
- `notes:update` merges the stale coordinates over the store.

Similar races can occur between title/body input, pin color toggles, future resize updates, and external sync broadcasts.

Suggested remediation:

- Introduce a field-level patch IPC (`notes:patch`) instead of whole-object mutation from renderers.
- Whitelist mutable fields per channel:
  - Text edit path: `title`, `body`.
  - Bounds path: `x`, `y`, `width`, `height`.
  - Appearance path: `color`.
- Await writes in `persistCurrent`, update `currentNote` from the returned canonical note, and debounce high-frequency text input.
- Consider an optimistic `revision` or monotonic `updatedAt` check if multiple windows may edit the same note.

Recommended renderer shape:

```js
const persistText = debounce(async () => {
  if (!currentNote) return;
  currentNote = await window.electronAPI.patchNote(currentNote.id, {
    title: titleInput.value,
    body: bodyInput.value
  });
}, 150);
```

Test probes:

- Start with a note `{ x: 400, y: 400, title: 'A' }`.
- Simulate a stale text update with `{ x: 100, y: 100, title: 'B' }`.
- Assert the store preserves current coordinates when only text fields are intended to change.

### 3. Clearing Notes Is Undermined By Default-Note Seeding

Status: Resolved. `loadNotes({ seedDefaults: false })` is used for normal loads, and tests cover clear/reset behavior.

Evidence:

- `src/notesStore.js:61-67` calls `createDefaultNotes()` whenever storage exists and contains an empty array.
- `src/main.js:88-93` detects placeholder notes on startup and resets notes to `[]`.
- `src/renderer.js:11` calls `loadNotes()` during `refreshNotes()`.
- `src/renderer.js:52-55` calls `clearNotes()` and then immediately calls `refreshNotes()`.

Failure mode:

`notes:clear` writes `[]`, but the renderer then calls `notes:load`, which treats an empty store as first-run state and writes the default notes again. This also interacts strangely with startup: the main process resets placeholders, but the renderer can re-seed them as soon as it loads.

Suggested remediation:

- Separate "read the store" from "seed first-run defaults".
- Only seed defaults during an explicit first-run initialization path, not every time the array is empty.
- Persist a metadata marker if the app must distinguish first run from an intentional empty note set.

Recommended store contract:

```js
function loadNotes({ seedDefaults = false } = {}) {
  const notes = readNotes();
  if (notes.length > 0) return notes;
  return seedDefaults ? writeNotes(createDefaultNotes()) : notes;
}
```

Then call `loadNotes({ seedDefaults: true })` only from the app initialization path if welcome notes are still desired.

Test probes:

- `resetNotes(); loadNotes();` should return `[]`.
- Startup with no storage file may seed defaults if desired.
- `notes:clear` followed by `notes:load` should remain empty.

### 4. Dashboard Card Click Mutates Notes Without User-Visible Intent

Status: Resolved. Card clicks now call `notes:show`.

Evidence:

- `src/renderer.js:36-39` adds a click handler to every card that calls `updateNote(updated)` with only defaulted title/body values.

Failure mode:

Clicking a card updates `updatedAt` even when the user has not changed note content. This creates false modification history and can trigger `syncNoteWindow(updated)`, which may steal focus or alter floating-window state depending on future behavior.

Suggested remediation:

- Replace the card click mutation with a dedicated `notes:show` or `notes:focus` IPC.
- If the intent is to open or focus the floating note window, do that explicitly in the main process without mutating the note.
- If the intent is to normalize empty fields, perform schema normalization during load/import, not on click.

Test probes:

- Capture `updatedAt`, click the card, assert `updatedAt` is unchanged.
- Assert a card click focuses or opens the floating note window via a separate IPC contract.

## Medium-Priority Debug Findings

### 5. Storage Writes Are Not Atomic And Parse Failures Are Fatal

Status: Partially resolved. Corrupt JSON recovery, temp-file writes, and core note field sanitization are implemented; schema-versioned migrations remain open.

Evidence:

- `src/notesStore.js:16-18` reads and parses `data/notes.json` directly.
- `src/notesStore.js:24-27` overwrites the file in place with `fs.writeFileSync`.

Failure modes:

- Power loss or process crash during write can leave a truncated JSON file.
- Any malformed JSON throws through `loadNotes`, potentially breaking startup or IPC calls.
- No schema validation prevents malformed note records from reaching BrowserWindow creation.

Suggested remediation:

- Write to `notes.json.tmp`, `fsync` if necessary, then rename atomically.
- On parse failure, move the corrupt file to `notes.json.corrupt.<timestamp>` and recover to `[]`.
- Validate each note record before use. At minimum enforce:
  - `id`: non-empty string.
  - `title`/`body`: strings.
  - `x`, `y`, `width`, `height`: finite numbers inside sane bounds.
  - `color`: CSS-safe allowlist or conservative hex pattern.

Test probes:

- Write `{` to `data/notes.json`, then call `loadNotes()`. The app should recover predictably.
- Write a note with `width: -999`, then launch. The main process should clamp or reject it.

### 6. Keep Sync Is Append-Only And Non-Idempotent

Status: Partially resolved. Imports with stable remote IDs merge, missing remote IDs no longer match each other accidentally, and unchanged ID-less exports now use source hashes for idempotent repeat imports. Conflict handling for local edits remains open.

Evidence:

- `src/keepSync.js:5` assigns a fresh `randomUUID()` to every normalized imported note.
- `src/keepSync.js:29-31` merges as `[...existing, ...normalized]` without deduplication.
- `src/main.js:166-177` import path also creates new notes without deduplication.

Failure mode:

Importing or syncing the same Google Keep export twice creates duplicate local notes. Because imported notes get fresh IDs, there is no stable key for reconciliation.

Suggested remediation:

- Preserve a source identity field such as `source: 'google-keep'` and `sourceId`.
- If the export has no stable ID, compute a content hash from normalized title/body/created timestamp.
- Upsert by `sourceId` or hash rather than append.
- Keep local edits safe by separating source metadata from editable fields.

Test probes:

- Sync the same two-note fixture twice and assert local note count remains two.
- Sync a modified Keep note and assert the reconciliation policy is explicit: update local body, keep local body, or create conflict.

### 7. Keep Export Shape Support Is Narrow

Status: Partially resolved. Checklist-style notes now normalize to multiline bodies; more real Takeout fixtures are still needed.

Evidence:

- `src/keepSync.js:6-8` maps `title`, `name`, `text`, `content`, and `body`.
- `src/main.js:166-167` accepts either a top-level array or `parsed.notes`.

Risk:

Real Keep/Takeout exports may contain richer fields such as list items, labels, archived/trashed state, attachments, timestamps, or non-hex color representations. Current normalization silently drops any unrecognized structure.

Suggested remediation:

- Add fixture-driven tests for the exact export formats the app claims to support.
- Log or surface unsupported fields during import.
- Decide whether list notes should become multiline bodies.

Test probes:

- Import fixtures for plain text notes, checklist notes, archived notes, trashed notes, empty title notes, and color variants.
- Assert unsupported fields are either intentionally ignored or preserved in metadata.

### 8. IPC Surface Should Validate Untrusted Renderer Payloads

Status: Partially resolved. Bounds, patch fields, and several empty-ID cases are constrained, and store persistence sanitizes records. Electron-level IPC contract tests remain open.

Evidence:

- `src/preload.js:4-15` exposes a compact API, which is good.
- `src/main.js:112-240` trusts payload values for create/update/delete/move operations.

Risk:

Even with `contextIsolation: true` and `nodeIntegration: false`, renderer-originated payloads should be treated as untrusted. A compromised renderer can ask the main process to create huge notes, move windows off-screen, write arbitrary malformed values to JSON, or invoke external navigation.

Suggested remediation:

- Add validation at each `ipcMain.handle` boundary.
- Clamp coordinates and dimensions.
- Enforce maximum title/body lengths.
- Reject unknown note fields in update/patch operations.
- For `openExternal`, keep a fixed URL or validate against an allowlist.

Test probes:

- Try `updateNote({ id, width: Number.NaN })`.
- Try `createNote({ body: 'x'.repeat(10_000_000) })`.
- Try `moveWindow({ id, x: -100000, y: -100000 })`.

## Repo Hygiene And Debuggability

### 9. `node_modules/` Is Untracked But Not Ignored

Status: Resolved. `.gitignore` now excludes dependencies and runtime note data.

Evidence:

- `git status --short --ignored` shows `?? node_modules/`.
- No first-party `.gitignore` was found.

Impact:

Future commits can accidentally include dependency artifacts and Electron binaries. This will make diffs noisy and slow, and can obscure actual application changes during debugging.

Suggested remediation:

Create a `.gitignore` containing at least:

```gitignore
node_modules/
npm-debug.log*
.DS_Store
dist/
out/
coverage/
```

Decide whether `data/notes.json` is sample data or local runtime data. If runtime-local, ignore it and commit a fixture under `test/fixtures/` instead.

### 10. Minimal Test Coverage Leaves Most Runtime Contracts Untested

Status: Partially resolved. Store recovery, sanitization, clear behavior, Keep normalization, checklist export handling, and missing-ID merge behavior are covered. IPC and renderer behavior remain mostly untested.

Current test coverage:

- `test/keepSync.test.js` covers normalization, remote-ID merging, and missing-ID merge safety.
- `test/notesStore.test.js` covers reset behavior, corrupt JSON recovery, temp-file write behavior, and note sanitization.
- `test/ghostNoteFix.test.js` covers store lookup behavior related to the ghost-note fix.

Suggested test expansion:

- `notesStore`:
  - Empty file behavior.
  - Clear semantics.
  - Corrupt JSON recovery.
  - Update of missing ID.
  - Atomic write strategy.
- `keepSync`:
  - Idempotent sync.
  - Checklist/list export fixture.
  - Stable source identity.
- IPC contract tests:
  - Bounds validation.
  - Patch field allowlist.
  - Delete missing note policy.
- Renderer behavior:
  - `escapeHtml` protection for card rendering.
  - Card click does not mutate note state.
  - Debounced text persistence preserves concurrent bounds changes.

## Instrumentation Recommendations

Add structured, low-volume debug logs around IPC handlers and persistence:

```js
function debug(event, fields = {}) {
  if (process.env.STICKY_NOTES_DEBUG !== '1') return;
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...fields
  }));
}
```

Suggested events:

- `notes.load.start` and `notes.load.ok` with note count.
- `notes.write.ok` with byte length and note count.
- `notes.write.error` with error code.
- `ipc.notes.patch` with note ID and allowed fields, not full body text.
- `ipc.window.bounds` with clamped bounds.
- `keep.import.normalized` with input count, output count, duplicate count.

Avoid logging full note bodies by default. Notes are user content.

## Manual Reproduction Matrix

### Clear Notes

1. Start the app.
2. Click `Clear notes`.
3. Observe whether notes disappear.
4. Restart the app.
5. Expected after fix: no default notes reappear unless explicitly requested.

### Resize Persistence

1. Create a new note.
2. Drag the resize handle.
3. Inspect `data/notes.json`.
4. Restart.
5. Expected after fix: `width` and `height` change and are restored.

### Stale Update Race

1. Create a note.
2. Drag it to a new position.
3. Immediately type in the title/body.
4. Inspect `data/notes.json`.
5. Expected after fix: text changes do not revert `x`/`y`.

### Duplicate Import

1. Create a two-note Keep fixture.
2. Import it.
3. Import it again.
4. Expected after fix: no duplicate notes unless the conflict policy intentionally creates them.

### Corrupt Store

1. Stop the app.
2. Replace `data/notes.json` with malformed JSON.
3. Start the app.
4. Expected after fix: app recovers, preserves corrupt file for diagnostics, and shows an actionable error or empty state.

## Suggested Debug Fix Order

1. Add IPC contract tests for `notes:show`, `notes:patch`, `window:move`, and `window:set-bounds`.
2. Add renderer behavior tests for card clicks and text persistence.
3. Add schema-versioned migrations before changing the persisted note format again.
4. Expand Keep export fixtures for labels, archived-note visibility rules, trashed-note recovery behavior, and color variants.
5. Continue with full Google Keep sync only after onboarding, backups, credential storage, and conflict handling are implemented.

This order prioritizes state correctness first. Once persistence and mutation semantics are deterministic, UI-level debugging becomes much less noisy.

# Sticky Notes Repo Proofreading Review

Generated: 2026-07-26

Implemented: 2026-07-26

## Implementation Status

The changes from this review have been applied to the current draft app:

- Google Keep UI copy now separates JSON export/import from account sync.
- The unsupported `dialog.showInputBox` path has been removed from the active flow.
- Keep merge logic no longer matches unrelated notes by missing remote IDs.
- Dashboard card clicks now focus/open sticky notes through `notes:show` instead of mutating title/body.
- Icon-only note buttons now have accessible labels and titles.
- `notesStore` now quarantines corrupt JSON and writes through a temporary file before rename.
- `notesStore` now sanitizes persisted note records, clamps window bounds, caps text fields, and restricts note colors to hex values.
- Google Keep export notes without remote IDs now get stable `sourceHash` metadata so repeated imports update instead of duplicating the same note.
- Keep export coverage now includes checklist-style notes and ID-less repeated imports.
- Google Keep account sync MVP is implemented with a Python `gkeepapi` bridge, encrypted credential storage, backup-backed onboarding preview/apply, manual sync, local upload, remote pull, dirty linked-note updates, and remote trash on local delete when enabled.
- `DEBUG_SUGGESTIONS.md` and `ghost note fix.md` now include current implementation status.

Remaining deeper product work is conflict resolution, richer field mapping, and broader Electron-level test coverage.

## Scope

This review covers the full first-party repository, excluding generated or dependency directories such as `node_modules/`. It includes:

- Application source under `src/`.
- Tests under `test/`.
- Project metadata in `package.json` and `.gitignore`.
- Planning and debug documents.

The original copy was generally clean. The main issue was truth-in-labeling: earlier user-facing labels and planning documents implied finished Google Keep account sync before the guarded sync MVP existed.

## Verification

Commands run:

```powershell
node --check src\main.js
node --check src\preload.js
node --check src\renderer.js
node --check src\noteRenderer.js
node --check src\notesStore.js
node --check src\keepSync.js
npm test
npm ls --depth=0
```

Results:

- JavaScript syntax checks passed.
- `npm test` passed outside the filesystem sandbox: 21 tests, 21 passing.
- Local bridge smoke test passed: Python 3.12.13 and `gkeepapi 0.17.1`.
- `npm ls --depth=0` reports `electron@35.7.5`.
- The in-sandbox `npm test` run failed with `spawn EPERM`, which appears to be a sandbox execution artifact.

## Necessary Changes

### 1. Fix the Connect Keep flow

Status: Implemented for the current app. The active UI no longer exposes the broken credential prompt; the main-process fallback now shows an informational message about future sync instead of calling `dialog.showInputBox`.

Files:

- `src/main.js`

Earlier issue:

`src/main.js` called `dialog.showInputBox` in the `keep:connect` handler, but Electron 35 does not expose `dialog.showInputBox`. This made the earlier "Connect Keep" path fail at runtime.

Recommended change:

- Replace the dialog calls with a real renderer-based onboarding or credential-entry UI.
- Keep credential handling in the main process after submission.
- Do not return the master token to the renderer.

### 2. Align Google Keep labels with current behavior

Status: Implemented.

Files:

- `src/index.html`
- `src/renderer.js`
- `src/main.js`
- `package.json`

Issue:

Earlier UI copy used labels such as "Connect Keep", "Sync Keep", and "Persistent desktop notes for your Google Keep workflow." At that point, the flow only asked the user to select a Google Keep export JSON file.

Recommended change:

- Rename the controls to make the export-file workflow explicit.
- Suggested labels:
  - `Import Keep JSON`
  - `Import from Keep export`
  - `Open Google Keep`
- Reserve `Connect Google Keep` and `Sync now` for the guarded onboarding and bridge-backed account sync flow.

### 3. Fix Keep merge behavior when remote IDs are missing

Status: Implemented with regression coverage. ID-less Keep export notes now get stable source hashes for repeat imports.

Files:

- `src/keepSync.js`
- `test/keepSync.test.js`

Issue:

`mergeKeepNotes` matches by `note.keep?.id`. If imported notes lack remote IDs, multiple notes can share `null` as the remote ID and accidentally overwrite each other.

Recommended change:

- Only match by remote ID when the remote ID is present and non-empty.
- For missing remote IDs, fall back to local ID or a stable content/source hash.
- Add a regression test for two imported notes with missing remote IDs.

### 4. Stop card clicks from mutating note content

Status: Implemented.

Files:

- `src/renderer.js`
- `src/main.js`
- `src/preload.js`

Issue:

Clicking a dashboard card calls `patchNote` with defaulted title/body values. This changes `updatedAt` even when the user did not edit anything.

Recommended change:

- Add a separate focus/open IPC such as `notes:show` or `notes:focus`.
- Use card click only to focus or open the sticky window.
- Leave note content and `updatedAt` unchanged unless the user edits the note.

### 5. Update stale debug documentation

Status: Implemented.

Files:

- `DEBUG_SUGGESTIONS.md`

Issue:

The document still lists some findings as open even though the code now appears to include partial or complete fixes, including:

- Pull-based sticky note hydration.
- `notes:get-one`.
- `window:set-bounds`.
- `notes:patch`.
- `.gitignore`.
- Clear-notes behavior.

It also listed an old verification baseline of 1 passing test, while the repo currently has 7 passing tests.

Recommended change:

- Add a status marker to each finding: `Resolved`, `Partially resolved`, or `Still open`.
- Update the verification baseline to the current test count.
- Keep the file as historical debug context, or replace it with a current engineering review.

### 6. Mark the ghost-note plan as implemented

Status: Implemented.

Files:

- `ghost note fix.md`
- `test/ghostNoteFix.test.js`

Issue:

The ghost-note document is written as a proposed fix, but the app already implements the main pieces:

- `noteId` query parameter.
- `notes:get-one`.
- `getNote` in preload.
- `hydrateNote` in `noteRenderer`.
- `missing-note` CSS state.

Recommended change:

- Rename the document heading or status to show it is implemented.
- Add an implementation summary.
- Expand tests beyond store lookup so the hydration contract is better covered.

### 7. Add accessible labels for icon-only buttons

Status: Implemented.

Files:

- `src/note.html`
- `src/renderer.js`

Issue:

The pin and delete buttons are icon-only. The glyphs are valid Unicode in the files, but they need accessible names.

Recommended change:

- Add `aria-label` and `title` attributes.
- Suggested labels:
  - `Pin note`
  - `Delete note`

### 8. Harden persistence before deeper sync work

Status: Implemented for corrupt JSON recovery, temp-file writes, and core note record sanitization. Schema-versioned migrations remain future hardening work.

Files:

- `src/notesStore.js`
- `test/notesStore.test.js`

Issue:

The store reads JSON directly and writes directly to `data/notes.json`. Malformed JSON can break load paths, and an interrupted write can leave a corrupt file.

Recommended change:

- Add corrupt-file recovery.
- Write to a temporary file and rename atomically.
- Add tests for corrupt JSON and interrupted or failed writes.

## Documentation Consistency Notes

### Google Keep plan

Files:

- `GOOGLE_KEEP_SYNC_PLAN.md`
- `GOOGLE_KEEP_SYNC_ONBOARDING.md`

The planning docs are strong and appropriately cautious. Keep them clearly marked as draft future work until the bridge, credential storage, onboarding, preview, and conflict handling are implemented.

Recommended wording rule:

- Use "will" or "planned" in docs for future sync behavior.
- Use current-tense claims only for behavior that exists in code today.

### Product description

Files:

- `package.json`
- `src/index.html`

Original wording overemphasized Google Keep. The current local-first description is:

```text
Persistent desktop sticky notes with local storage and Google Keep export/import.
```

## Suggested Fix Order

1. Add renderer and Electron IPC tests for onboarding, note focusing, card clicks, window bounds, and bridge errors.
2. Add field-level conflict detection and resolution before enabling automatic background sync.
3. Add schema-versioned migrations before changing the persisted note format again.
4. Expand Keep coverage for labels, archived-note visibility rules, trashed-note recovery behavior, and color variants.

## Residual Risks

- Google Keep account sync includes automatic background push, but it is not yet a fully conflict-resolving sync engine.
- ID-less Google Keep exports now have source hashes, but the conflict policy for edited local copies of imported notes is still basic.
- Storage has corrupt-file recovery, temp-file writes, and core field sanitization, but no schema-versioned migration system yet.
- The current test suite still does not cover most Electron IPC or renderer behavior.

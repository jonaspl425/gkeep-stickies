# Improvements Since the Initial Draft

This document summarizes the major features, fixes, and breakthroughs added since the initial raw draft commit.

## Packaging and Launching

- Added Electron Builder packaging for Windows.
- Built both installer and portable app outputs.
- Added package metadata, including `author: jonaspl`.
- Included local Python Google Keep bridge dependencies in packaged builds.
- Added a local launcher that starts without a visible terminal: `launch-persistent-notes.vbs`.
- Added `npm run start:detached` for development launches without leaving a visible terminal window open.
- Documented packaged and detached launch options in `README.md`.

## Dashboard-First App Lifecycle

- Changed startup behavior so the app opens to the dashboard only.
- Stopped automatically reopening every saved floating note window on launch.
- Made closing the dashboard hide all open floating notes instead of leaving them floating.
- Kept notes available from the dashboard list so they can be opened intentionally.
- Changed floating-note `x` behavior from delete to hide.
- Made hide use a faster fire-and-forget IPC path.

## Floating Note Window Behavior

- Replaced laggy renderer-driven mouse tracking with native Electron window dragging.
- Persisted note position from the main process after movement settles.
- Prevented resize from sending stale `x/y` values that could snap a moved note back.
- Added bottom-edge hide behavior for notes dragged below the screen threshold.
- Preserved position lock behavior so locked notes do not move unexpectedly.
- Replaced the realistic pushpin emoji with a plain black outline pin icon.

## Note List and Dashboard UX

- Added a draggable reorder handle to dashboard note cards.
- Persisted manual note order in the note store.
- Made note-card `x` hide the floating note instead of deleting it.
- Added support for blank note titles without forcing placeholder text into saved notes.
- Added a cleaner toolbar/settings-menu style in the dashboard.

## Sync Status UX

- Added a top-bar `Sync status` label.
- Added colored sync indicators:
  - Green for synced.
  - Yellow for unsaved local changes or sync in progress.
  - Red for sync problems.
  - Gray for local-only / not connected.
- Added accessible status updates with `role="status"` and `aria-live="polite"`.
- Updated status copy to show when edits are saved locally and queued for Google Keep sync.

## Automatic Google Keep Sync

- Added automatic background push after local edits.
- Shortened the auto-sync debounce to make edits sync quickly without firing on every keystroke.
- Added queueing so edits made during an in-flight sync are pushed afterward.
- The manual `Sync now` action now clears pending auto-sync work first to avoid duplicate pushes.
- Added safeguards so blank local notes are not uploaded to Google Keep.
- Kept newer local dirty edits dirty when an older in-flight sync completes.
- Moved remote delete/trash into a background flow so local deletion stays responsive.

## Google Keep Checklist Handling

- Improved Keep checklist normalization.
- Sorted unchecked checklist items above completed items.
- Preserved common Keep/list ordering fields when available.
- Rendered completed checklist items at the bottom behind a completed-items summary.
- Preserved the same checklist ordering in floating note previews and dashboard cards.
- Added bridge serialization for list item order metadata when exposed by `gkeepapi`.

## Storage and Safety

- Moved packaged note storage to Electron `userData`.
- Added one-time migration from the old project-local `data/notes.json`.
- Kept local data and credentials out of source control.
- Maintained encrypted credential storage through Electron `safeStorage`.
- Kept generated package outputs under ignored `dist/`.

## Tests and Validation

- Expanded unit coverage for:
  - Note-store migration.
  - Note reordering.
  - Checklist display ordering.
  - Blank title preservation.
  - Dirty-edit preservation during sync.
- Repeatedly verified with `npm test`.
- Rebuilt Windows artifacts after major user-facing changes.

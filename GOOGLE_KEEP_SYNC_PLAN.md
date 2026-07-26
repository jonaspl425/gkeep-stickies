# Google Keep Sync Technical Plan

Date: 2026-07-26

Status: MVP implementation started. The app now includes a guarded Google Keep account sync path using `gkeepapi`, with backup-backed onboarding, encrypted credential storage, a Python JSON-RPC bridge, manual sync, local upload, remote pull, dirty linked-note updates, and remote trash on local delete when enabled. The broader conflict engine, advanced field mapping, and automatic/background sync remain planned hardening work.

Related document: `GOOGLE_KEEP_SYNC_ONBOARDING.md`

## 1. Objective

Build a two-way sync layer between this Electron sticky notes app and a Google Keep account using `gkeepapi`, an unofficial Python client for Google Keep's private mobile API.

The integration should support, where `gkeepapi` exposes stable behavior:

- Create Google Keep notes from local sticky notes.
- Import Google Keep notes into local sticky note windows.
- Edit note title and body in either direction.
- Delete, trash, and untrash notes.
- Sync pin, archive, color, labels, and list note content.
- Preserve local-only UI state such as sticky window position, size, and local selection state.
- Detect conflicts rather than silently overwriting data.
- Fail closed and preserve local data when Google Keep, `gkeepapi`, auth, or network behavior changes.
- Gate first-time connection behind a backup-backed onboarding flow with a read-only first-sync preview.

## 2. Verified External Facts

These assumptions were checked on 2026-07-26 and should be rechecked before implementation.

### 2.1 Official Google Keep API

Source: https://developers.google.com/workspace/keep/api/guides

Google's official Keep API is documented as an enterprise/Workspace-oriented API used by administrators to manage Keep content, including creating, listing, deleting, downloading note attachments, and mutating note permissions.

Source: https://developers.google.com/workspace/keep/api/reference/rest

The official REST reference exposes:

- `v1.notes.create`
- `v1.notes.delete`
- `v1.notes.get`
- `v1.notes.list`
- `v1.notes.permissions.batchCreate`
- `v1.notes.permissions.batchDelete`
- `v1.media.download`

As of this verification date, the official API does not expose a note update or patch method for arbitrary existing note content. That is why this plan uses `gkeepapi` for two-way editing.

### 2.2 gkeepapi

Sources:

- https://github.com/kiwiz/gkeepapi
- https://pypi.org/project/gkeepapi/0.17.1/
- https://gkeepapi.readthedocs.io/en/latest/

Verified facts:

- `gkeepapi` is an unofficial client and is not supported or endorsed by Google.
- Latest verified PyPI package in this review: `gkeepapi==0.17.1`, released 2026-01-05.
- Package requires Python `>=3.10`.
- The library authenticates with `Keep.authenticate(email, master_token)`.
- The deprecated `Keep.login(username, password)` path is discouraged and should not be used.
- The master token has broad account access and must be treated like a password.
- `gkeepapi` uses `Keep.sync()` to pull and push changes.
- The client automatically pulls notes after authentication.
- Local note changes must be followed by `Keep.sync()` to update Google Keep.
- `Keep.dump()` and `Keep.restore()` support caching local Keep state.
- `Keep.createNote()` and `Keep.createList()` support text notes and list notes.
- `Keep.get()`, `Keep.all()`, and `Keep.find()` support retrieval/search.
- Top-level note fields include `id`, `title`, `text`, `color`, `archived`, `pinned`, `labels`, `collaborators`, `blobs`, `drawings`, `images`, `audio`, and read-only timestamps.
- Text note content can be updated by assigning `gnote.title`, `gnote.text`, `gnote.color`, `gnote.archived`, and `gnote.pinned`.
- List items can be added, edited, checked, unchecked, deleted, sorted, indented, and dedented.
- Notes can be `delete()` / `undelete()` or `trash()` / `untrash()`.
- Labels can be created, found, edited, deleted, added to notes, and removed from notes.
- Collaborators can be added and removed through exposed collaborator APIs.
- Media links can be fetched for existing blobs, but images/drawings/audio should be treated as read-mostly unless explicitly verified in code.
- Reminders and some blob details are listed by the project as incomplete or unstable areas.
- Known issue: `Keep.get()` can fail for newly created list item IDs until those list items are synced.
- Known issue class: Google can change Keep data formats, producing `ParseException`.

## 3. Current Project Baseline

Current app shape:

- Electron main process: `src/main.js`
- Renderer UI: `src/renderer.js`
- Sticky window renderer: `src/noteRenderer.js`
- Local persistence: `src/notesStore.js`
- Existing import-style Keep code: `src/keepSync.js`
- Data file: `data/notes.json`

Current behavior:

- Notes are local JSON records.
- A sticky note can be created, patched, deleted, moved, and resized.
- There is a JSON import-style Keep flow, but no durable Google Keep identity, no two-way sync, no auth, no remote conflict detection, and no remote mutation path.

## 4. Non-Negotiable Safety Rules

1. Never store a Google password.
2. Never store a `gkeepapi` master token in `data/notes.json`.
3. Never log the master token, OAuth token, cookies, auth headers, raw bridge payloads containing secrets, or full notes by default.
4. Never delete or overwrite local notes as the first response to an error.
5. Prefer trash over hard delete.
6. Before the first remote mutation, create a timestamped backup of `data/notes.json`.
7. Treat `gkeepapi` as an unstable adapter boundary.
8. Sync must be serial per Google account.
9. Renderer code must not talk to Python or Google Keep directly.
10. Unknown bridge/API errors must put sync into degraded mode, not crash the app or erase local data.
11. First-time remote mutation must be impossible until onboarding completes risk acceptance, account confirmation, local backup, read-only scan, preview, and final confirmation.

## 5. Target Architecture

```text
Electron renderer windows
  -> preload IPC
  -> Electron main process
  -> notesStore
  -> sync queue / conflict engine
  -> KeepBridgeManager
  -> long-lived Python JSON-RPC bridge
  -> gkeepapi.Keep
  -> Google Keep private mobile API
```

### 5.1 Components

#### Renderer

Responsibilities:

- Show sync status.
- Let the user connect/disconnect Google Keep.
- Let the user manually trigger "Sync now".
- Show per-note conflict state.
- Offer conflict resolution actions.
- Never handle credentials beyond forwarding user input once through preload IPC.

#### Preload IPC

Add safe APIs:

```js
connectKeep: (payload) => ipcRenderer.invoke('keep:connect', payload),
disconnectKeep: () => ipcRenderer.invoke('keep:disconnect'),
getKeepStatus: () => ipcRenderer.invoke('keep:status'),
syncKeepNow: () => ipcRenderer.invoke('keep:sync-now'),
resolveKeepConflict: (payload) => ipcRenderer.invoke('keep:resolve-conflict', payload),
onKeepStatusChanged: (callback) => ipcRenderer.on('keep:status-changed', callback)
```

#### Electron Main

Responsibilities:

- Own local note writes.
- Own sync queue state.
- Launch and supervise the Python bridge.
- Serialize all Keep operations.
- Merge remote updates into local notes.
- Broadcast resulting state to renderer and note windows.

#### Python Bridge

Responsibilities:

- Import and own `gkeepapi`.
- Keep one authenticated `gkeepapi.Keep()` instance per connected account.
- Expose a small JSON-RPC protocol over stdin/stdout.
- Map Python exceptions into stable machine-readable error codes.
- Persist and restore `gkeepapi` cache state only when Electron explicitly requests it.
- Never print secrets.

#### Local Store

Responsibilities:

- Store notes.
- Store sync metadata on notes.
- Store tombstones for deleted synced notes.
- Write atomically.
- Support migrations.

#### Credential Store

Responsibilities:

- Store email and master token separately from note content.
- Prefer OS-backed secret storage.
- Encrypt at rest if using Electron `safeStorage`.
- Delete all auth material on disconnect.

## 6. Runtime and Dependency Strategy

### 6.1 Python Runtime

Options:

1. Use bundled Python from the app installer.
2. Detect system Python `>=3.10`.
3. Use a local virtual environment managed during development and packaged at release.

Recommended development path:

- Add `requirements.txt` with `gkeepapi==0.17.1`.
- Add a setup script to create `.venv` inside the project.
- In development, launch `.venv/Scripts/python.exe` on Windows.

Recommended release path:

- Bundle a known Python runtime and installed wheel dependencies with the Electron app.
- Pin `gkeepapi` to a reviewed version.
- Make upgrades explicit and tested.

### 6.2 Node Dependencies

Optional but recommended:

- `keytar` for OS secret storage.
- If avoiding native dependency friction, use Electron `safeStorage` plus a file under the app userData directory.

Do not add a direct JavaScript Google Keep dependency unless it becomes the selected adapter. This plan assumes `gkeepapi`.

## 7. Data Model

### 7.1 Local Note Record

Extend notes from the current local shape to:

```js
{
  id: "local uuid",
  title: "Title",
  body: "Plain text body",
  color: "#fff59d",
  x: 140,
  y: 140,
  width: 240,
  height: 220,
  createdAt: "2026-07-26T15:00:00.000Z",
  updatedAt: "2026-07-26T15:00:00.000Z",

  keep: {
    id: "remote-node-id-or-null",
    type: "note",
    accountEmail: "user@gmail.com",
    url: "https://keep.google.com/#NOTE/...",
    importedAt: "2026-07-26T15:00:00.000Z",
    lastSyncedAt: "2026-07-26T15:00:00.000Z",
    lastRemoteEditedAt: "2026-07-26T15:00:00.000Z",
    lastRemoteHash: "sha256",
    lastLocalSyncedHash: "sha256",
    localRevision: 7,
    remoteRevision: null,
    dirtyFields: ["title", "body"],
    syncState: "synced",
    lastError: null
  },

  keepFields: {
    pinned: false,
    archived: false,
    trashed: false,
    labels: [
      { "id": "remote-label-id", "name": "todo" }
    ],
    collaborators: [],
    media: []
  }
}
```

### 7.2 Local List Note Record

If list support is implemented:

```js
{
  id: "local uuid",
  title: "Shopping",
  body: "",
  keep: {
    id: "remote-node-id",
    type: "list",
    syncState: "dirty"
  },
  listItems: [
    {
      id: "local-list-item-id",
      keepId: "remote-list-item-id-or-null",
      text: "Milk",
      checked: false,
      sort: 1000,
      parentKeepId: null,
      deletedAt: null
    }
  ]
}
```

### 7.3 Tombstones

Add a tombstone store so local deletes can be pushed later:

```js
{
  id: "local uuid",
  keepId: "remote-node-id",
  accountEmail: "user@gmail.com",
  deletedAt: "2026-07-26T15:00:00.000Z",
  deleteMode: "trash",
  pushedAt: null,
  lastError: null
}
```

### 7.4 Canonical Hashes

Compute hashes from sync-relevant content only. Exclude local UI fields like `x`, `y`, `width`, and `height`.

Canonical fields for text notes:

```js
{
  type,
  title,
  body,
  color,
  pinned,
  archived,
  trashed,
  labels: sortedLabelNames
}
```

Canonical fields for list notes:

```js
{
  type,
  title,
  color,
  pinned,
  archived,
  trashed,
  labels: sortedLabelNames,
  listItems: sortedOrOrderedItems
}
```

Use stable JSON stringification and SHA-256.

## 8. Bridge Protocol

Use newline-delimited JSON-RPC-like messages over stdin/stdout.

### 8.1 Request

```json
{
  "id": "uuid",
  "method": "notes.update",
  "params": {
    "keepId": "abc",
    "patch": {
      "title": "New title",
      "text": "New body"
    }
  }
}
```

### 8.2 Success Response

```json
{
  "id": "uuid",
  "ok": true,
  "result": {
    "note": {}
  }
}
```

### 8.3 Error Response

```json
{
  "id": "uuid",
  "ok": false,
  "error": {
    "code": "AUTH_INVALID",
    "message": "Authentication failed",
    "retryable": false,
    "category": "auth"
  }
}
```

### 8.4 Required Bridge Methods

```text
bridge.ping
bridge.version
auth.configure
auth.status
auth.disconnect
sync.restoreState
sync.dumpState
sync.fullPull
sync.flush
notes.get
notes.createText
notes.createList
notes.updateText
notes.updateList
notes.trash
notes.untrash
notes.delete
notes.setPinned
notes.setArchived
notes.setColor
labels.list
labels.create
labels.rename
labels.delete
labels.addToNote
labels.removeFromNote
collaborators.add
collaborators.remove
media.getLink
```

### 8.5 Error Code Taxonomy

```text
AUTH_NOT_CONFIGURED
AUTH_INVALID
AUTH_TOKEN_REVOKED
AUTH_BROWSER_CHALLENGE
AUTH_CAPTCHA_REQUIRED
AUTH_DEVICE_MANAGEMENT_REQUIRED
AUTH_RATE_LIMITED

NETWORK_OFFLINE
NETWORK_TIMEOUT
NETWORK_TLS
NETWORK_PROXY
NETWORK_DNS

REMOTE_NOT_FOUND
REMOTE_DELETED
REMOTE_PERMISSION_DENIED
REMOTE_PARSE_ERROR
REMOTE_SCHEMA_CHANGED
REMOTE_RATE_LIMITED
REMOTE_CONFLICT

BRIDGE_START_FAILED
BRIDGE_CRASHED
BRIDGE_PROTOCOL_ERROR
BRIDGE_TIMEOUT
BRIDGE_VERSION_MISMATCH

LOCAL_STORE_READ_FAILED
LOCAL_STORE_WRITE_FAILED
LOCAL_STORE_CORRUPT
LOCAL_STORE_MIGRATION_FAILED
LOCAL_BACKUP_FAILED

SYNC_LOCKED
SYNC_CONFLICT
SYNC_RETRY_EXHAUSTED
SYNC_UNSUPPORTED_FEATURE

UNKNOWN
```

## 9. Python Bridge Design

### 9.1 Process Lifecycle

Electron main should:

1. Start the bridge lazily when sync is first needed.
2. Send `bridge.ping`.
3. Send `bridge.version`.
4. Restore cached Keep state if available.
5. Configure auth.
6. Run a full pull.
7. Keep the process warm while the app is open.
8. Kill the process on app quit.

Restart policy:

- Restart after unexpected crash.
- Use exponential backoff: 1s, 2s, 5s, 15s, 60s.
- After 5 crashes in 5 minutes, disable automatic restarts and surface `BRIDGE_CRASHED`.

### 9.2 Python Bridge Skeleton

```python
import json
import sys
import traceback
import gkeepapi

class KeepBridge:
    def __init__(self):
        self.keep = None
        self.email = None

    def configure(self, email, master_token, state=None):
        self.keep = gkeepapi.Keep()
        if state:
            self.keep.restore(state)
        self.keep.authenticate(email, master_token)
        self.email = email
        return {"authenticated": True}

    def full_pull(self):
        self.keep.sync()
        return {"notes": [serialize_note(note) for note in self.keep.all()]}

    def update_text(self, keep_id, patch):
        note = self.keep.get(keep_id)
        if "title" in patch:
            note.title = patch["title"]
        if "text" in patch:
            note.text = patch["text"]
        if "color" in patch:
            note.color = map_color(patch["color"])
        if "pinned" in patch:
            note.pinned = patch["pinned"]
        if "archived" in patch:
            note.archived = patch["archived"]
        self.keep.sync()
        return {"note": serialize_note(note), "state": self.keep.dump()}
```

The real bridge must add strict validation, exception mapping, redaction, and timeouts.

## 10. Sync Engine

### 10.1 Sync State Machine

Per note:

```text
unlinked
  -> linking
  -> synced
  -> dirty
  -> syncing
  -> synced

dirty + remote changed
  -> conflict

syncing + retryable error
  -> dirty/error

syncing + fatal error
  -> error

deleted locally
  -> tombstoned
  -> delete-syncing
  -> delete-synced
```

Global sync:

```text
disabled
  -> disconnected
  -> connecting
  -> connected
  -> syncing
  -> idle
  -> degraded
  -> disconnected
```

### 10.2 Full Pull

Run when:

- App starts and auth exists.
- User clicks "Sync now".
- Bridge restarts.
- A remote parse/schema warning occurs and recovery is possible.
- A periodic timer fires.

Algorithm:

1. Acquire global sync lock.
2. Start bridge if needed.
3. Authenticate if needed.
4. Call `sync.fullPull`.
5. Normalize remote notes.
6. Load local notes and tombstones.
7. Match by `keep.id`.
8. Apply reconciliation rules.
9. Save local notes atomically.
10. Save bridge state atomically.
11. Refresh sticky windows and main window.
12. Release lock.

### 10.3 Push Local Changes

Run when:

- A local note is edited and debounce expires.
- A local note is created.
- A local note is deleted.
- User clicks "Sync now".
- App is about to quit.

Algorithm:

1. Acquire global sync lock.
2. Load dirty notes and pending tombstones.
3. For each tombstone, push trash/delete first.
4. For each dirty unlinked note, create remote note.
5. For each dirty linked note, fetch remote snapshot.
6. If remote changed since last sync, mark conflict.
7. Otherwise apply patch through bridge.
8. Call bridge `sync.flush`.
9. Update hashes and clear dirty fields.
10. Save local store and bridge state atomically.

### 10.4 Live Editing Debounce

Current sticky windows patch local notes on every input event. For Keep sync:

- Keep immediate local save.
- Do not call Google Keep on every keystroke.
- Debounce per note for 1500-3000 ms.
- Coalesce dirty fields.
- Flush on window blur, app idle, manual sync, and app quit.

### 10.5 Conflict Detection

Use three values:

- `baseHash`: local snapshot at last successful sync.
- `localHash`: current local sync-relevant hash.
- `remoteHash`: current remote sync-relevant hash.

Rules:

```text
localHash == baseHash and remoteHash == baseHash:
  no-op

localHash != baseHash and remoteHash == baseHash:
  push local

localHash == baseHash and remoteHash != baseHash:
  pull remote

localHash != baseHash and remoteHash != baseHash:
  if changed fields are disjoint:
    field-level merge
  else:
    conflict
```

### 10.6 Conflict Resolution

UI actions:

- Keep local version.
- Keep Google Keep version.
- Duplicate both.
- Manual merge.

Implementation behavior:

- Keep local: overwrite remote through bridge, update base hash.
- Keep remote: overwrite local, update sticky window.
- Duplicate both: create a new local note and a new remote note as needed.
- Manual merge: create an edit screen with local and remote values; push merged result.

## 11. Feature Mapping

### 11.1 Text Notes

Remote to local:

- `gnote.id` -> `note.keep.id`
- `gnote.title` -> `note.title`
- `gnote.text` -> `note.body`
- `gnote.color` -> local hex color mapping
- `gnote.pinned` -> `note.keepFields.pinned`
- `gnote.archived` -> `note.keepFields.archived`
- `gnote.labels` -> `note.keepFields.labels`
- `gnote.timestamps.updated` -> `note.keep.lastRemoteEditedAt`

Local to remote:

- `note.title` -> `gnote.title`
- `note.body` -> `gnote.text`
- local hex color -> `gnote.color`
- `keepFields.pinned` -> `gnote.pinned`
- `keepFields.archived` -> `gnote.archived`

### 11.2 List Notes

Represent Keep list notes as either:

1. Native list notes in local UI, preferred.
2. Plain text fallback, only if list UI is deferred.

Native list behavior:

- Preserve item IDs.
- Preserve checked state.
- Preserve sort order.
- Support one level of nesting because `gkeepapi` exposes indent/dedent and Keep supports limited nesting.
- After creating new list items, sync before assuming remote IDs are fetchable.

### 11.3 Labels

Support:

- List labels.
- Create labels.
- Rename labels.
- Delete labels.
- Add/remove labels on notes.

Risk:

- Label APIs are documented by `gkeepapi` as somewhat unwieldy and subject to change.

Mitigation:

- Put all label logic behind bridge methods.
- Keep labels optional for the initial sync MVP.

### 11.4 Collaborators

Support:

- Add collaborator email.
- Remove collaborator email.
- Show collaborators.

Risk:

- Account permissions and Google policies may reject collaborator mutations.

Mitigation:

- Treat collaborator sync as an advanced operation with explicit user action.

### 11.5 Media

Support initially:

- Show existing remote media metadata.
- Fetch media links using `Keep.getMediaLink()`.

Do not promise initially:

- Uploading images.
- Editing drawings.
- Editing audio.
- Preserving all blob internals.

### 11.6 Reminders

Defer.

Reason:

- `gkeepapi` project documentation lists reminders as incomplete/todo.

## 12. UI Plan

### 12.1 First-Run Onboarding

Implement the first-time Google Keep connection as a mandatory safety flow. The detailed screen-by-screen specification lives in `GOOGLE_KEEP_SYNC_ONBOARDING.md`.

Required flow:

```text
Risk disclosure
  -> sync scope selection
  -> email/master token entry
  -> account confirmation
  -> local backup
  -> read-only remote scan
  -> first-sync preview
  -> explicit apply
  -> success summary
```

Required gate:

- No remote create, update, trash, untrash, delete, label mutation, collaborator mutation, or media request with side effects may run before onboarding has completed.

Required user guarantees:

- User can cancel at every step and continue local-only.
- Backup failure blocks the first remote mutation.
- First-sync preview must show local notes to upload, remote notes to import, likely duplicates, conflicts, skipped notes, and destructive actions.
- The app must not ask for a Google password.
- The master token may be submitted once to the main process but must never be returned to the renderer.

### 12.2 Main Window

Add:

- Google Keep connection status.
- "Connect Google Keep".
- "Sync now".
- "Disconnect".
- Last sync time.
- Count of dirty notes.
- Count of conflicts.
- Count of sync errors.

The "Connect Google Keep" action should open onboarding when setup is incomplete. It should open sync settings when onboarding has already completed.

### 12.3 Note Window

Add small unobtrusive status:

- Synced
- Syncing
- Offline changes pending
- Conflict
- Error

Do not interrupt typing with modal dialogs.

### 12.4 Conflict View

Add a conflict resolution panel:

- Local value.
- Google Keep value.
- Last synced value if available.
- Resolution buttons.

## 13. Security and Privacy Plan

### 13.1 Secret Handling

Preferred:

- Store master token in OS credential store with `keytar`.

Fallback:

- Store encrypted token under Electron `app.getPath('userData')` using Electron `safeStorage`.

Never:

- Store token in `data/notes.json`.
- Store token in git.
- Store token in logs.
- Send token to renderer after initial submission.

### 13.2 Token Input

The app should ask for:

- Google account email.
- Master token.

The app should not ask for:

- Google password.

Token generation can be documented separately using `gpsoauth`, but the first implementation should avoid automating password-based token generation inside the app.

Token input must happen through onboarding or reauth only:

- The renderer may pass the token to the main process once.
- The main process validates the token through the bridge.
- On successful account confirmation, the main process stores the token in the credential store.
- On cancellation before confirmation, the app must ask whether to forget any pending credential material.
- No IPC response may include the token.

### 13.3 Logs

Create a redaction helper:

```js
function redact(value) {
  return String(value)
    .replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED_TOKEN]');
}
```

Log:

- Error codes.
- Retry count.
- Note IDs only when needed.
- Operation type.

Do not log:

- Full note text by default.
- Tokens.
- Auth headers.
- Raw bridge request bodies.

### 13.4 Backups

Before first mutation after connecting Keep:

- Copy `data/notes.json` to `data/backups/notes-before-keep-sync-YYYYMMDD-HHMMSS.json`.
- Copy bridge state if any.
- Record the backup path in onboarding state.
- Block first sync if backup creation fails.

Before migration:

- Copy current local store.

Before mass delete/trash:

- Require explicit confirmation.
- Create backup.

## 14. Implementation Phases

### Phase 0: Design Lock

Deliverables:

- This plan.
- `GOOGLE_KEEP_SYNC_ONBOARDING.md`.
- `requirements.txt` with pinned `gkeepapi`.
- Decision on `keytar` vs `safeStorage`.
- Decision on whether list UI ships in MVP.

Exit criteria:

- A disposable Google account exists for testing.
- Manual backup of real Keep notes exists if testing real data.

### Phase 1: Local Schema and Migrations

Tasks:

- Add schema version to local data.
- Add `keep` metadata.
- Add `keepFields`.
- Add tombstones.
- Add atomic write helper.
- Add local backups.
- Add hash canonicalization.

Tests:

- Old notes migrate without losing fields.
- Corrupt data is detected and does not get overwritten.
- Backup is created before migration.

### Phase 2: Python Bridge

Tasks:

- Add `requirements.txt`.
- Create `src/keep_bridge/server.py`.
- Implement JSON-RPC loop.
- Implement `bridge.ping`, `bridge.version`.
- Implement auth configure/status/disconnect.
- Implement full pull serialization.
- Implement create/update/trash/delete.
- Implement error mapping.

Tests:

- Unit tests with fake `gkeepapi`.
- Protocol tests for malformed JSON.
- Timeout tests.
- Secret redaction tests.

### Phase 3: Bridge Manager in Electron

Tasks:

- Add `KeepBridgeManager`.
- Launch Python.
- Track request IDs.
- Enforce per-request timeout.
- Restart bridge on crash.
- Kill bridge on app quit.
- Hide bridge details from renderer.

Tests:

- Bridge crash recovery.
- Bridge timeout.
- Multiple concurrent app requests serialize correctly.

### Phase 4: Sync Engine

Tasks:

- Add sync lock.
- Add dirty tracking in `notesStore`.
- Add full pull.
- Add push queue.
- Add tombstone push.
- Add conflict detection.
- Add retry/backoff.
- Add offline mode.

Tests:

- Local create creates remote.
- Remote create creates local.
- Local edit pushes remote.
- Remote edit pulls local.
- Simultaneous edit creates conflict.
- Delete while offline pushes later.

### Phase 5: Onboarding Safety Flow

Tasks:

- Add onboarding state model.
- Add onboarding IPC handlers.
- Add first-run risk disclosure.
- Add sync scope selection.
- Add email/master token entry.
- Add account confirmation.
- Add backup creation step.
- Add read-only remote scan.
- Add first-sync preview.
- Add explicit apply step.
- Add cancellation and reauth flows.

Tests:

- No remote mutation can occur before onboarding completion.
- Cancel before credentials stores nothing.
- Cancel after credential test can forget pending credential material.
- Backup failure blocks first sync.
- Scan failure preserves local-only mode.
- Preview conflicts block apply.
- Apply failure requires full pull before retry.

### Phase 6: UI and Conflict Handling

Tasks:

- Add connect/disconnect controls.
- Add sync status.
- Add manual sync.
- Add conflict UI.
- Add note-level status.

Tests:

- User can connect.
- User can disconnect.
- Conflicts can be resolved.
- Sync failures are visible but non-destructive.

### Phase 7: Advanced Fields

Tasks:

- Pin/archive/color.
- Labels.
- Lists.
- Collaborators.
- Media read links.

Tests:

- Each field maps round-trip.
- Unsupported values degrade gracefully.

### Phase 8: Hardening

Tasks:

- Full onboarding failure matrix.
- Integration test with disposable Google account.
- Long-running edit test.
- Network drop test.
- Token revoked test.
- API parse error simulation.
- Large note set test.
- Installer/runtime packaging test.

Exit criteria:

- No data loss in wargame tests.
- Unknown bridge failures do not crash the app.
- User can disable sync and keep local notes.

## 15. Wargame: Failure Modes and Responses

This section aims to cover every known and foreseeable error class. It cannot guarantee every possible future Google/private-API behavior, so unknowns must route to conservative containment: stop remote mutation, preserve local data, surface error, and require user action or a later retry.

### 15.1 Authentication Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| No token configured | `AUTH_NOT_CONFIGURED` | Sync cannot start | Show disconnected state. Keep local notes editable. | Start without credentials. |
| Invalid master token | `Keep.authenticate` failure | Sync cannot start | Show auth error. Do not retry aggressively. | Use bogus token. |
| Token revoked | Auth works previously, later fails | Sync stops | Mark disconnected. Keep dirty local queue. Ask reconnect. | Delete stored token or mock revoked response. |
| Google browser challenge | `NeedsBrowser` or mapped exception | Sync stops | Surface "Google requires browser verification." Do not ask for password. | Mock exception. |
| Captcha required | `CaptchaRequired` | Sync stops | Surface actionable error. Avoid repeated login attempts. | Mock exception. |
| Bad authentication | `BadAuthentication` | Sync stops | Clear active session but preserve token until user decides. | Mock exception. |
| Device management required | `DeviceManagementRequiredOrSyncDisabled` | Workspace account cannot sync | Surface admin/device policy message. | Mock exception. |
| Wrong Google account | Remote notes not expected | Data may merge with wrong account | Show account email before first sync. Require confirmation before first mutation. | Connect disposable account and verify prompt. |
| Token leaked to logs | Log scanner finds token-like strings | Severe security incident | Redact logs. Rotate token. Add regression test. | Unit test logger. |
| Multiple auth attempts trigger Google risk controls | Repeated auth failures | Account lock/challenge risk | Exponential backoff. Stop after threshold. | Mock repeated auth failure. |

### 15.2 Python Runtime and Packaging Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Python not installed | Spawn `ENOENT` | Sync unavailable | Show setup error. App remains local. | Rename configured python path. |
| Python version too old | `bridge.version` reports `<3.10` | Bridge unsupported | Show runtime requirement. | Run with old/fake Python. |
| `gkeepapi` missing | ImportError | Bridge fails | Show dependency setup message. | Empty venv. |
| Wrong `gkeepapi` version | Version mismatch | API behavior unknown | Block sync unless user enables experimental mode. | Mock version. |
| Bridge crashes on startup | Process exits before ping | Sync unavailable | Retry with backoff. Preserve local queue. | Exit bridge immediately. |
| Bridge crashes mid-sync | Process exit | In-flight operation ambiguous | Mark sync unknown. Run full pull before next push. | Kill bridge during sync. |
| Bridge writes malformed JSON | Parse failure | Protocol broken | Stop bridge. Mark degraded. | Fake malformed stdout. |
| Bridge hangs | Request timeout | Sync stalls | Kill bridge. Restart. Full pull before mutation. | Sleep beyond timeout. |
| stdout polluted by logs | JSON parse failure | Protocol broken | Send logs to stderr only. Add parser guard. | Print random stdout. |

### 15.3 Network Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Offline | DNS/socket error | Remote unavailable | Keep local edits dirty. Retry later. | Disable network or mock. |
| Timeout | Request timeout | Unknown remote state | Do not assume mutation failed. Full pull before retry. | Mock timeout after update. |
| TLS/cert error | TLS exception | Remote unavailable | Surface network/security error. Do not bypass TLS. | Mock TLS failure. |
| Proxy required | Connection failure | Remote unavailable | Surface proxy/network issue. | Run behind blocked network. |
| Google rate limit | Rate limit response/exception | Sync delayed | Backoff with jitter. Preserve queue. | Mock rate limit. |
| Partial network failure after mutation | Timeout after write | Duplicate risk | Use idempotency strategy and full pull before creating another remote note. | Mock create success then timeout. |

### 15.4 Google Keep / gkeepapi API Drift

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| ParseException from changed payload | `REMOTE_PARSE_ERROR` | Cannot read remote safely | Stop mutation. Save raw error only if redacted and explicitly debug-enabled. | Mock ParseException. |
| Unknown note type | Serializer cannot map | Partial sync | Preserve remote as unsupported metadata. Do not delete. | Fake node type. |
| Unknown color enum | Mapping fails | Visual mismatch | Map to default color and preserve raw value. | Fake color. |
| Label API changes | Label call fails | Label sync broken | Disable label sync only. Continue note text sync. | Mock label exception. |
| Collaborator API changes | Collaborator call fails | Sharing sync broken | Disable collaborator sync only. | Mock collaborator exception. |
| Media schema changes | Media serialization fails | Attachments not shown | Drop media from local display, keep note content. | Fake blob shape. |
| `Keep.get()` fails for newly synced list item | Known issue | List item mapping delayed | After list mutation, full pull before relying on item IDs. | Create list item then fetch. |
| `Keep.sync()` semantics change | Unexpected changed/unchanged state | Data loss risk | Canary tests with disposable account before upgrades. Pin package. | Run version upgrade test. |

### 15.5 Local Store Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| `notes.json` missing | File not found | Empty state possible | Create empty file only after checking backups. | Delete file in test dir. |
| `notes.json` corrupt JSON | JSON parse error | Cannot load notes | Do not overwrite. Move to quarantine copy. Ask restore. | Write invalid JSON. |
| Disk full | Write error | Cannot persist sync | Stop sync. Keep in-memory warning. | Mock write failure. |
| Permission denied | Write error | Cannot persist sync | Stop sync. Surface local storage error. | Make test file read-only. |
| Migration fails | Exception | Data at risk | Restore backup. Keep app local. | Force migration throw. |
| Atomic write interrupted | Temp file remains | Possible stale file | Use write-temp, fsync where feasible, rename. Recover newest valid file. | Kill during write. |
| Backup creation fails | Copy error | Unsafe to mutate remote | Block first remote mutation. | Mock backup failure. |

### 15.6 Sync Logic Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Duplicate local notes for same Keep ID | Store invariant check | Confusing UI, overwrite risk | Merge or mark conflict before sync. | Seed duplicates. |
| Duplicate remote creates after timeout | Same content and no remote ID | Remote duplicates | Full pull after ambiguous create; match by local origin marker if possible. | Timeout after create. |
| Local edit lost during pull | Revision mismatch | Data loss | Compare `localRevision` before save. Retry merge. | Edit while full pull saves. |
| Remote edit lost during push | Remote hash changed | Data loss | Fetch before push. Conflict if changed. | Simultaneous remote edit. |
| Delete wins incorrectly | Tombstone vs remote edit conflict | Data loss | If remote changed after base, conflict instead of delete. | Remote edit then local delete. |
| Dirty fields not tracked | Missing patch | Unsynced local changes | Use hash fallback to detect dirty content. | Direct store mutation. |
| Infinite sync loop | Same note always dirty | Battery/network drain | Store last error, backoff, compare hashes after push. | Mock remote normalizes fields. |
| Concurrent syncs | Lock contention | Race conditions | Single global sync lock per account. | Trigger manual and debounce sync together. |
| App quits mid-sync | Process killed | Ambiguous remote state | On next start, full pull before push. | Quit during sync. |

### 15.7 Conflict Scenarios

| Scenario | Expected State | Resolution |
|---|---|---|
| Local title edit, remote body edit | Auto merge if base hashes prove disjoint fields | Push merged note. |
| Local body edit, remote body edit | `conflict` | Ask user. |
| Local note deleted, remote unchanged | Tombstone push | Trash remote. |
| Local note deleted, remote edited | `conflict` | Ask user: delete, keep remote, duplicate. |
| Remote note deleted, local unchanged | Pull delete/trash state | Close or hide local note. |
| Remote note deleted, local edited | `conflict` | Ask user. |
| Local create, remote similar note exists | No automatic merge unless origin metadata matches | Create remote or ask user if duplicate detector is enabled. |
| Remote creates note with same title | New local note | Do not merge by title alone. |

### 15.8 Destructive Operation Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| User deletes local note while offline | Tombstone queued | Remote still exists | Show pending deletion. Push later. | Offline delete. |
| Hard delete requested accidentally | User action | Irreversible remote loss | Default to trash. Require explicit setting for hard delete. | UI test. |
| Remote hard delete fails permission | Permission error | Remote remains | Keep tombstone error. Show retry/remove options. | Mock permission denied. |
| Bulk delete would affect many notes | Count threshold | Large data loss risk | Require typed confirmation and backup. | Select many notes. |
| Trash/untrash race | Remote state changes | Wrong visibility | Full pull after operation. | Mock remote changes. |

### 15.9 UI/UX Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Sync modal interrupts typing | UX review | Lost focus/frustration | Use passive status indicators. | Manual QA. |
| Conflict UI too vague | User cannot decide | Wrong resolution | Show local/remote timestamps and values. | Conflict QA. |
| "Synced" shown before durable local save | State mismatch | False confidence | Show synced only after local store write succeeds. | Mock write failure after sync. |
| User disconnects during sync | State transition | Ambiguous operation | Let current operation finish or cancel safely, then full pull disabled. | Disconnect mid-sync. |
| Main window closed while sync running | Window gone | No status visible | Main process continues safely. | Close main window. |

### 15.10 Security Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Token stored in git-tracked path | File scan | Severe | Move to userData secret store. Add `.gitignore` guard. | Secret scan. |
| Token sent to renderer | IPC audit | Severe | Renderer sends token once only. Main never returns it. | IPC test. |
| Note content in crash logs | Log audit | Privacy leak | Redact or disable content logs by default. | Crash bridge. |
| Malicious bridge payload | Unexpected fields | Local corruption | Validate bridge output schema. | Fuzz bridge response. |
| Compromised dependency | Supply-chain risk | Severe | Pin version, hash, review changelog, optionally vendor. | Dependency audit. |

### 15.11 Data Scale Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| Thousands of Keep notes | Slow full pull | UI lag | Run sync off renderer. Paginate/stream internally if needed. | Synthetic large set. |
| Very large note body | Field length issue | Push fails | Enforce local warnings and remote limits where known. | Large body. |
| Many rapid edits | Queue growth | Lag | Coalesce by note and field. | Hold key input. |
| Huge labels/collaborators sets | Slow serialization | Lag | Lazy load advanced metadata. | Synthetic metadata. |

### 15.12 Unsupported Feature Failures

| Feature | Risk | Behavior |
|---|---|---|
| Reminders | Incomplete in `gkeepapi` docs | Preserve remote metadata if visible. Do not edit initially. |
| Drawings | Blob internals unstable | Show read-only metadata/link if possible. |
| Images | Upload/edit not guaranteed | Read-only initially. |
| Audio | Upload/edit not guaranteed | Read-only initially. |
| Rich formatting | Local app is plain text | Preserve only text fields unless richer model is implemented. |
| Keep-specific suggestions/categories | Unstable | Ignore unless explicitly supported later. |

### 15.13 Onboarding Failures

| Failure | Detection | Impact | Response | Test |
|---|---|---|---|---|
| User cancels before credential entry | Onboarding exit | No sync setup | Stay local-only. Store no credential. | Cancel on risk/scope screen. |
| User cancels after credential test | Pending credential exists | Secret may linger | Ask whether to forget pending credential. Default to forget. | Cancel after auth success. |
| User confirms wrong account | Account email mismatch noticed later | Wrong-account merge risk | Require account confirmation before backup/preview. Disconnect preserves local notes. | Connect disposable wrong account. |
| Backup fails | Backup step error | Unsafe first mutation | Block scan/apply. Offer retry/local-only. | Mock backup write error. |
| Backup created but preview cancelled | Onboarding cancelled | Harmless extra backup | Preserve backup, perform no remote mutation. | Cancel at preview. |
| Read-only scan mutates remote accidentally | Unexpected remote change during scan | Severe trust/data risk | Treat as bug. Bridge scan methods must call only pull/read paths. Add contract test. | Fake bridge asserts no mutation methods called. |
| Preview becomes stale before apply | Preview hash mismatch or local revision changed | Wrong operation plan | Regenerate preview. Do not apply stale plan. | Edit note during preview. |
| Preview misses likely duplicate | Duplicate appears after sync | Remote clutter | Do not auto-delete. Offer cleanup. Improve duplicate detector. | Similar local/remote notes. |
| Conflict exists but apply enabled | UI validation bug | Overwrite risk | Main process must reject apply with unresolved conflicts. | Force conflicted preview. |
| Apply times out after remote create | Ambiguous remote state | Duplicate risk | Full pull before retry. Do not replay creates blindly. | Mock create success then timeout. |
| App quits during onboarding apply | Interrupted first sync | Partial sync | On next launch, enter recovery/resume state and full pull first. | Kill app during apply. |
| Reauth treated as brand-new onboarding | Existing links ignored | Duplicate risk | Reauth must use existing `keep.id` links and dirty queue. | Expire token, reconnect. |

## 16. Recovery Runbooks

### 16.1 Bridge Crashes Repeatedly

1. Stop automatic bridge restart after threshold.
2. Set global sync state to `degraded`.
3. Keep local app fully editable.
4. Preserve dirty queue.
5. Show "Google Keep sync paused: bridge crashed."
6. Offer "Retry" and "Disconnect".
7. On retry, run full pull before push.

### 16.2 Auth Stops Working

1. Stop remote sync.
2. Preserve local edits as dirty.
3. Clear active in-memory auth session.
4. Do not delete stored token automatically unless user disconnects.
5. Ask user to reconnect with a new master token.
6. After reconnect, full pull before pushing dirty notes.

### 16.3 Remote Parse Error

1. Stop remote mutations immediately.
2. Save redacted error metadata.
3. Mark sync degraded.
4. Keep local notes editable.
5. Tell user the private Keep API shape may have changed.
6. Require package update or bridge fix before resuming.

### 16.4 Local Store Corruption

1. Do not write over corrupt file.
2. Copy corrupt file to `data/recovery/`.
3. Load latest valid backup if available.
4. Disable remote mutation until user confirms restored data.
5. Run full pull only after local store is valid.

### 16.5 Accidental Remote Deletes

1. Stop sync.
2. Preserve local backups.
3. If notes were trashed, attempt `untrash()`.
4. If notes were hard-deleted, restore from local backup by creating replacement remote notes.
5. Log operation IDs and affected `keepId`s.
6. Add regression test for the root cause.

### 16.6 Duplicate Remote Notes

1. Full pull.
2. Group duplicates by local origin marker, if present.
3. If no origin marker, group by title/body/time proximity but do not auto-delete.
4. Offer user a duplicate cleanup UI.
5. Default cleanup action should trash duplicates, not hard delete.

## 17. Testing Matrix

### 17.1 Unit Tests

- Data migration.
- Hash canonicalization.
- Conflict detection.
- Tombstone creation.
- Dirty field tracking.
- Bridge protocol parsing.
- Bridge error mapping.
- Secret redaction.

### 17.2 Integration Tests with Fake Bridge

- Full pull creates local notes.
- Push creates remote notes.
- Push edits remote notes.
- Delete creates tombstone then bridge delete/trash.
- Bridge timeout.
- Bridge crash.
- Malformed bridge response.
- Conflict resolution.

### 17.3 Disposable Google Account Tests

Use a dedicated test Google account, not the user's primary account.

Test cases:

- Connect.
- Pull empty account.
- Create local text note, verify in Keep web.
- Edit local note, verify in Keep web.
- Edit Keep web note, verify local sticky note.
- Delete local note, verify Keep trash behavior.
- Create Keep web note, verify local sticky note appears.
- Pin/archive/color changes.
- Labels.
- Lists.
- Offline edits and later reconnect.
- App restart with cached state.

### 17.4 Regression Tests Before Upgrading gkeepapi

- Run all fake bridge tests.
- Run disposable account smoke test.
- Run parse/serialization sample corpus.
- Verify token handling did not change.
- Verify no new dependency is unexpectedly introduced.

### 17.5 Onboarding Tests

- Risk disclosure must be accepted before continuing.
- Token field must never echo into logs or IPC responses.
- Invalid token keeps the app local-only.
- Account confirmation is required before backup/scan/apply.
- Backup path is recorded in onboarding state.
- Backup failure blocks first remote mutation.
- Read-only scan performs no create/update/delete/trash methods.
- Preview shows create-local, create-remote, duplicate, skip, conflict, and destructive operation counts.
- Preview hash mismatch blocks apply.
- Unresolved conflicts block apply in both renderer and main process.
- Apply timeout after remote create triggers full pull before retry.
- Cancellation at every step leaves the app usable locally.
- Reauth flow uses existing `keep.id` links and does not duplicate linked notes.

## 18. Observability

Track:

- Global sync state.
- Onboarding state and last completed onboarding step.
- Last successful sync time.
- Last failed sync time.
- Dirty note count.
- Conflict count.
- Tombstone count.
- Bridge restart count.
- Last error code.
- gkeepapi version.
- Python version.

Do not track by default:

- Full note text.
- Token material.
- Collaborator emails in diagnostic exports without user approval.

## 19. Upgrade Policy

Because this depends on an unofficial private API:

1. Pin `gkeepapi`.
2. Read changelog before upgrade.
3. Test with disposable account.
4. Keep old bridge compatible for rollback.
5. Never auto-upgrade `gkeepapi` silently.

## 20. Acceptance Criteria

Minimum acceptable implementation:

- User can connect Keep with email/master token through onboarding.
- Onboarding requires risk acceptance, account confirmation, local backup, read-only scan, first-sync preview, and explicit apply before first remote mutation.
- Local notes are backed up before first remote mutation, and backup failure blocks first sync.
- Remote text notes pull into local sticky notes.
- Local text notes push to Google Keep.
- Edits sync both ways.
- Deletes default to trash.
- Conflicting same-field edits are detected and not overwritten.
- Unresolved first-sync conflicts block onboarding apply.
- Offline edits are queued.
- Bridge/auth/network failures do not crash the app.
- Secrets are not stored in `notes.json`.
- Tests cover bridge, migration, sync, conflicts, onboarding cancellation, onboarding preview, backup failure, and ambiguous apply failure.

Advanced acceptance:

- Lists round-trip.
- Labels round-trip.
- Pin/archive/color round-trip.
- Collaborators can be managed.
- Media links are readable.
- Large note sets remain responsive.

## 21. Open Decisions

1. Use `keytar` or Electron `safeStorage` for token storage?
2. Should list-note support ship in the first implementation or the second?
3. Should hard delete ever be exposed, or only trash?
4. Should remote archived notes appear as sticky windows by default?
5. Should Google Keep labels map to local filters/tags in the UI?
6. Should conflict resolution be per note or batch-capable?
7. Should bridge state live in project `data/` during development but app `userData` in production?
8. Should onboarding allow upload-only or pull-only modes in MVP, or expose those after first sync?
9. Should the first-sync preview include note body snippets, or only titles and metadata for privacy?

## 22. Recommended MVP Scope

Build first:

- First-run onboarding safety flow.
- Auth storage.
- Python bridge.
- Full pull.
- Create/edit/trash text notes.
- Dirty queue.
- Hash-based conflict detection.
- Manual sync.
- Basic status UI.
- Backups.
- First-sync preview.

Defer:

- Lists.
- Labels.
- Collaborators.
- Media.
- Reminders.
- Hard delete.

Reason:

The first risk to retire is not feature breadth. It is proving that the private API, bridge lifecycle, auth storage, and conflict model can preserve data under failure.

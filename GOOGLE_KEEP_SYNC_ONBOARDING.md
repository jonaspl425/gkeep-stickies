# Google Keep Sync Onboarding Specification

Date: 2026-07-26

Related plan: `GOOGLE_KEEP_SYNC_PLAN.md`

Status: MVP implemented in the desktop app. The current flow covers risk confirmation, scope settings, email/master-token entry, read-only scan preview, backup before first remote mutation, explicit first-sync apply, and local-only cancellation. Advanced duplicate review and conflict-resolution screens remain planned.

## 1. Purpose

The Google Keep sync feature needs onboarding because it uses `gkeepapi`, an unofficial client for Google Keep's private mobile API. The onboarding flow is not a tour. It is a safety gate that prevents accidental credential exposure, wrong-account sync, duplicate note creation, unintended remote edits, and irreversible deletes.

Primary goals:

- Make the user explicitly choose to connect Google Keep.
- Explain the unofficial integration risk in plain language.
- Collect only the minimum required credential material.
- Store secrets outside note data.
- Create a local backup before remote mutation.
- Preview first-sync consequences before applying them.
- Default to conservative sync behavior.
- Leave the app usable as local-only if onboarding fails or is cancelled.

Non-goals:

- Do not ask for the Google account password.
- Do not automate risky password-based login.
- Do not make remote changes during credential entry.
- Do not silently upload, edit, trash, or delete notes during the first connection.
- Do not turn onboarding into a multi-page feature tour.

## 2. Onboarding Trigger Rules

Show onboarding when:

- User clicks "Connect Google Keep" for the first time.
- No valid Keep credential exists.
- The stored account email changed.
- The stored token was revoked and the user chooses reconnect.
- A previous onboarding attempt did not complete.

Do not show onboarding when:

- User only opens the app locally.
- User has already connected and sync is healthy.
- User clicks "Sync now" while already connected.

Show a shortened reauth flow when:

- Token is invalid.
- Google requires browser verification.
- Device policy blocks sync.
- Bridge state is lost but credentials still exist.

## 3. Flow Summary

```text
Start
  -> Risk disclosure
  -> Sync scope selection
  -> Credential entry
  -> Local backup
  -> Read-only remote scan
  -> First sync preview
  -> User confirmation
  -> Apply first sync
  -> Success summary
```

Exit paths:

```text
Cancel before credentials
  -> stay local-only

Cancel after credentials but before confirmation
  -> ask whether to remove saved credential

Backup failure
  -> block first sync

Auth failure
  -> stay local-only, show retry/disconnect

Preview conflict
  -> require user resolution or skip conflicted notes

Bridge/API failure
  -> stay local-only, preserve backup and dirty queue
```

## 4. Required Screens

### 4.1 Screen 1: Connect Google Keep

Purpose:

- Tell the user what this integration is.
- Make the unofficial status explicit.
- Set expectations before credentials are entered.

Required UI:

- Title: `Connect Google Keep`
- Body copy:

```text
Sticky Notes can sync with Google Keep using an unofficial Google Keep client.

This is not a Google-supported integration. It may stop working if Google changes Keep. The app will create a local backup before making any remote changes, and you will preview the first sync before it runs.
```

Required confirmations:

- Checkbox: `I understand this uses an unofficial Google Keep sync path.`
- Checkbox: `Create a local backup before the first remote change.`

Primary action:

- `Continue`

Secondary action:

- `Keep using local notes`

Validation:

- Continue disabled until both checkboxes are checked.

Technical effects:

- No credential storage.
- No bridge launch required.
- No remote calls.

### 4.2 Screen 2: Choose Sync Scope

Purpose:

- Let the user decide what the integration may touch.
- Default to safe behavior.

Required options:

```text
Sync direction
[x] Pull Google Keep notes into Sticky Notes
[x] Upload local Sticky Notes to Google Keep

Deletion behavior
(*) Move remote notes to trash when deleted locally
( ) Never delete or trash remote notes automatically
( ) Allow hard delete after explicit confirmation

Conflict behavior
(*) Ask me before overwriting either side
( ) Prefer Sticky Notes
( ) Prefer Google Keep

Remote visibility
[x] Import active notes
[ ] Import archived notes
[ ] Import trashed notes as hidden/local-only recovery notes
```

Recommended defaults:

- Pull enabled.
- Upload enabled.
- Trash instead of hard delete.
- Ask on conflicts.
- Active notes only.

Technical effects:

- Save selected preferences locally as onboarding draft state.
- Do not start sync yet.

### 4.3 Screen 3: Credentials

Purpose:

- Collect the account email and `gkeepapi` master token.
- Avoid asking for the Google password.

Required fields:

- Google account email.
- Master token.

Required copy:

```text
Enter the Google account email and master token used by gkeepapi.

Do not enter your Google password here. The master token is sensitive and should be treated like a password. It will be stored in the operating system credential store or encrypted app storage, not in your notes file.
```

Optional help link:

- `How to get a gkeepapi master token`
- Link target should point to local documentation or the gkeepapi docs.
- The app should not run password-based token generation internally.

Validation:

- Email must be syntactically valid.
- Token must be non-empty.
- Token must not be echoed in logs.
- Token field must use password input behavior.

Primary action:

- `Test connection`

Secondary action:

- `Back`

Technical effects:

- Bridge may be launched for auth test.
- Token may be held in memory during test.
- Credentials should be stored only after successful authentication.
- Renderer must not receive token back from main.

Failure states:

- Invalid token.
- Google requires browser verification.
- Captcha required.
- Device management required.
- Network unavailable.
- Python bridge unavailable.

### 4.4 Screen 4: Account Confirmation

Purpose:

- Prevent syncing the wrong Google account.

Required UI:

```text
Connected account
user@example.com

Only continue if this is the Google Keep account you want to sync with these desktop sticky notes.
```

Required confirmation:

- Checkbox: `This is the correct Google Keep account.`

Primary action:

- `Continue`

Secondary action:

- `Use a different account`

Technical effects:

- Store account email only after confirmation.
- Store credential only after confirmation, or store as pending and delete on cancellation.

### 4.5 Screen 5: Local Backup

Purpose:

- Create a known restore point before any remote mutation.

Required UI:

```text
Creating backup

Before the first sync changes Google Keep, Sticky Notes will back up your local notes.
```

Backup path format:

```text
data/backups/notes-before-keep-sync-YYYYMMDD-HHMMSS.json
```

Backup metadata:

```json
{
  "createdAt": "2026-07-26T15:00:00.000Z",
  "reason": "before-first-google-keep-sync",
  "accountEmail": "user@example.com",
  "notesCount": 12,
  "appVersion": "1.0.0"
}
```

Primary action:

- Automatically continue after backup succeeds.

Failure behavior:

- Block first sync.
- Show backup error.
- Offer retry.
- Offer local-only exit.
- Do not perform remote scan that could later be confused with a completed sync.

### 4.6 Screen 6: Read-Only Remote Scan

Purpose:

- Pull remote note metadata and content without mutating remote notes.
- Build a first sync preview.

Required UI:

```text
Scanning Google Keep

Sticky Notes is reading your Keep notes to prepare a first-sync preview. No Google Keep notes are being changed yet.
```

Technical effects:

- Call bridge full pull.
- Serialize remote notes.
- Save bridge cache only if auth is confirmed.
- Do not create, update, trash, untrash, or delete anything remotely.

Failure behavior:

- If scan fails, stop onboarding in a recoverable state.
- Preserve local backup.
- Preserve no remote mutation invariant.

### 4.7 Screen 7: First Sync Preview

Purpose:

- Show exactly what the first sync will do.
- Require explicit confirmation before remote mutation.

Required summary:

```text
Google Keep notes found: 42
Local sticky notes found: 5
New sticky notes to create from Keep: 42
Local notes to upload to Keep: 5
Likely duplicates: 2
Conflicts: 0
Remote notes to trash/delete: 0
```

Required sections:

- `Will create local sticky notes`
- `Will upload local notes to Google Keep`
- `Possible duplicates`
- `Needs review`
- `Will not sync yet`

Preview row fields:

- Note title.
- Source: Google Keep or Sticky Notes.
- Action: create local, create remote, link, skip, conflict.
- Last edited time if known.
- Reason.

Required controls:

- Per-note include/exclude checkbox.
- "Skip all duplicates" action.
- "Review conflicts" action when conflicts exist.

Primary action:

- `Start first sync`

Secondary actions:

- `Back`
- `Cancel setup`

Validation:

- `Start first sync` disabled if unresolved conflicts exist.
- `Start first sync` disabled if backup is missing.
- `Start first sync` disabled if account is unconfirmed.

### 4.8 Screen 8: Apply First Sync

Purpose:

- Execute the previewed operations.

Required UI:

```text
Syncing Google Keep

Keep this window open while the first sync finishes. Local notes remain saved if the sync is interrupted.
```

Progress states:

- Preparing changes.
- Creating local notes.
- Uploading local notes.
- Linking notes.
- Saving sync state.
- Refreshing sticky windows.

Technical effects:

- Acquire global sync lock.
- Revalidate current local revision before applying preview.
- Run remote mutation operations.
- Save local notes atomically.
- Save bridge state atomically.
- Broadcast note/window changes.

Failure behavior:

- Stop on ambiguous remote mutation failure.
- Run full pull before retrying creates.
- Show partial completion summary.
- Never rerun creates blindly after timeout.

### 4.9 Screen 9: Success Summary

Purpose:

- Tell user sync is active and where controls live.

Required UI:

```text
Google Keep sync is connected

Synced account: user@example.com
Last sync: July 26, 2026, 11:45 AM
Local backup: data/backups/notes-before-keep-sync-20260726-114500.json
```

Required controls:

- `Open sync settings`
- `Done`

Optional:

- `Open Google Keep`

Technical effects:

- Set `keepOnboarding.completedAt`.
- Set global sync state to connected/idle.

## 5. Short Reauth Flow

Use this when onboarding already completed but credentials no longer work.

Screens:

1. Reconnect Google Keep.
2. Credential entry.
3. Account confirmation.
4. Read-only remote scan.
5. Resume sync summary.

Differences from first onboarding:

- Do not recreate all local notes from remote.
- Do not upload all local notes.
- Use existing `keep.id` links.
- Run full pull before pushing queued local changes.
- Show dirty queue count before resuming.

## 6. State Model

Add app-level onboarding state:

```js
{
  keepOnboarding: {
    version: 1,
    status: "not_started",
    startedAt: null,
    completedAt: null,
    accountEmail: null,
    acceptedUnofficialRiskAt: null,
    acceptedBackupRequirementAt: null,
    confirmedAccountAt: null,
    backupPath: null,
    firstPreviewHash: null,
    lastStep: "risk",
    lastError: null
  }
}
```

Allowed statuses:

```text
not_started
in_progress
cancelled
completed
failed
reauth_required
```

Allowed steps:

```text
risk
scope
credentials
account
backup
scan
preview
apply
success
```

## 7. IPC and Main Process Requirements

Add IPC handlers:

```js
ipcMain.handle('keep:onboarding-status', ...)
ipcMain.handle('keep:onboarding-start', ...)
ipcMain.handle('keep:onboarding-save-scope', ...)
ipcMain.handle('keep:onboarding-test-auth', ...)
ipcMain.handle('keep:onboarding-confirm-account', ...)
ipcMain.handle('keep:onboarding-create-backup', ...)
ipcMain.handle('keep:onboarding-scan', ...)
ipcMain.handle('keep:onboarding-preview', ...)
ipcMain.handle('keep:onboarding-apply', ...)
ipcMain.handle('keep:onboarding-cancel', ...)
```

Security requirements:

- Only `keep:onboarding-test-auth` receives the master token.
- No IPC response may include the token.
- Main process owns credential storage.
- Renderer sees only credential status.

## 8. First Sync Preview Algorithm

Inputs:

- Local notes.
- Remote Keep notes.
- Tombstones.
- Sync scope preferences.
- Existing `keep.id` links.

Algorithm:

1. Build map of local notes by `keep.id`.
2. Build map of remote notes by remote ID.
3. For linked notes:
   - If local and remote both changed from base, mark conflict.
   - If only remote changed, plan local update.
   - If only local changed, plan remote update.
   - If neither changed, plan no-op.
4. For unlinked remote notes:
   - Plan create local note if included by scope.
5. For unlinked local notes:
   - Plan create remote note if upload is enabled.
6. Detect likely duplicates by title/body similarity and edit time proximity.
7. Do not merge by title alone.
8. Generate preview hash from planned operations.
9. Require same preview hash before applying.

Operation types:

```text
create_local
create_remote
update_local
update_remote
link_existing
trash_remote
skip
conflict
no_op
```

## 9. Duplicate Detection

Duplicate detection is advisory only.

Signals:

- Same normalized title.
- Same normalized body/text.
- Local created time near remote created time.
- Same color/pin/archive state.
- Prior import flag.

Rules:

- Never auto-link duplicates by title alone.
- Never auto-delete duplicates.
- Default likely duplicates to skipped until user reviews.

## 10. Error Handling During Onboarding

### 10.1 Auth Error

User message:

```text
Could not connect to Google Keep with that token.
Your local notes were not changed.
```

Actions:

- Retry.
- Back.
- Keep using local notes.

Technical behavior:

- Clear in-memory token.
- Do not store failed token.
- Stop bridge if not needed.

### 10.2 Backup Error

User message:

```text
Sticky Notes could not create a backup, so first sync is blocked.
Fix the storage issue or choose local-only mode.
```

Actions:

- Retry backup.
- Open backup folder if available.
- Keep using local notes.

Technical behavior:

- No remote mutations.

### 10.3 Scan Error

User message:

```text
Sticky Notes could not read Google Keep right now.
No Google Keep notes were changed.
```

Actions:

- Retry scan.
- Disconnect.
- Keep using local notes.

Technical behavior:

- Preserve credential only if account was confirmed.
- Preserve backup.

### 10.4 Apply Error

User message:

```text
First sync stopped before it fully completed.
Local notes are still saved. Sticky Notes will scan Google Keep before retrying so it does not create duplicates blindly.
```

Actions:

- Retry safely.
- View partial sync details.
- Pause sync.

Technical behavior:

- Mark global sync as degraded.
- Full pull before retry.
- Do not replay create operations without remote reconciliation.

## 11. Onboarding Copy Guidelines

Use direct language:

- `unofficial`
- `backup`
- `preview`
- `trash instead of delete`
- `wrong account`
- `conflict`

Avoid:

- "Seamless"
- "Guaranteed"
- "Official"
- "Safe forever"
- "Google-approved"

Never imply:

- Google endorses this integration.
- The app can recover hard-deleted Keep notes without backups.
- The private API will remain stable.

## 12. Settings After Onboarding

Sync settings should include:

- Connected account email.
- Last sync time.
- Sync direction.
- Deletion behavior.
- Conflict behavior.
- Import archived notes toggle.
- Import trashed notes toggle.
- Disconnect Google Keep.
- Create backup now.
- Open backups folder.
- Export diagnostic report.

Disconnect behavior:

- Stop sync.
- Clear credential.
- Keep local notes.
- Ask whether to remove bridge cache.
- Do not delete local notes imported from Keep unless user explicitly chooses cleanup.

## 13. Testing Checklist

### 13.1 Happy Path

- User accepts risk.
- User selects default scope.
- User enters valid email/token.
- Account confirmation appears.
- Backup is created.
- Remote scan succeeds.
- Preview shows expected counts.
- First sync succeeds.
- Onboarding completed flag is saved.

### 13.2 Cancellation

- Cancel at risk screen leaves no credential.
- Cancel after credential test asks whether to forget credential.
- Cancel after backup preserves backup but does not mutate remote.
- Cancel at preview does not mutate remote.

### 13.3 Failure Tests

- Invalid token.
- Empty token.
- Wrong email syntax.
- Bridge missing.
- Python too old.
- `gkeepapi` missing.
- Network offline.
- Backup write failure.
- Corrupt local notes file.
- Remote scan parse error.
- First sync timeout after remote create.
- App quit during apply.

### 13.4 Security Tests

- Token never appears in renderer after submission.
- Token never appears in logs.
- Token never appears in `data/notes.json`.
- Disconnect removes stored credential.
- Diagnostic export redacts account-sensitive fields unless user opts in.

### 13.5 Preview Accuracy Tests

- Empty local, remote has notes.
- Local has notes, empty remote.
- Local and remote both have unrelated notes.
- Existing linked note unchanged.
- Existing linked note changed locally.
- Existing linked note changed remotely.
- Existing linked note changed both ways.
- Likely duplicate.
- Local tombstone exists.

## 14. Acceptance Criteria

Onboarding is acceptable when:

- No remote mutation can occur before risk acceptance, account confirmation, backup success, scan success, and preview confirmation.
- User can exit at every step and keep using local notes.
- Credential handling is main-process only after entry.
- The first sync preview accurately explains planned changes.
- Backup failure blocks remote mutation.
- Apply failure preserves local notes and requires full pull before retry.
- Reauth uses existing note links and does not behave like a brand-new first sync.
- Tests cover happy path, cancellation, auth failure, backup failure, scan failure, and ambiguous apply failure.

## 15. Recommended MVP Onboarding

For the first implementation, ship only:

- Risk disclosure.
- Scope defaults.
- Email/master token entry.
- Account confirmation.
- Local backup.
- Read-only scan.
- First sync preview.
- First sync apply.
- Success summary.

Defer:

- In-app master token generation.
- Advanced duplicate cleanup UI.
- Batch conflict merge UI.
- Media-specific onboarding.
- Collaborator-specific onboarding.

Reason:

The onboarding MVP should protect against the highest-risk mistakes: wrong account, unsafe credential handling, no backup, unpreviewed first sync, and accidental remote deletion.

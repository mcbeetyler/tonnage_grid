# Google Sheets feed — one-time setup (~10 minutes)

The feed replaces your three daily copy-pastes. A small script in **your own
Google account** reads the ECSA grid, North Atlantic sheet and Cargo book
every 30 minutes and pushes them to the dashboard, which applies them through
the exact same logic as a manual paste (manual pastes and edits keep working —
your inline edits still win until a fresher feed row arrives).

**It is read-only and invisible to the sheet owners**: nothing is installed in
their files, nothing is written to them, and the access used is your own —
the same as you opening the sheets in a browser tab.

## Steps

1. Go to **script.google.com** → **New project**. Name it anything
   (e.g. "sheet backup") — it lives in your Drive, not in their sheets.

2. Delete the placeholder code and paste in the contents of
   **apps-script.gs** from this repo.

3. Click the gear icon (Project Settings) → **Script Properties** → add two
   properties: `APP_URL` (your dashboard's URL, no trailing slash) and
   `APP_PASSWORD` (the password you type when the dashboard asks).
   They live outside the code, so re-pasting a newer script never wipes them.

4. In the toolbar, select the function **syncAll** and click **Run** once.
   Google will ask for permission — it will say the script wants to *view
   your spreadsheets* and *connect to an external service*. Approve. If the
   run finishes without errors, all three feeds just landed.

5. Select the function **setupTrigger** and click **Run** once.
   That installs the every-30-minutes schedule. Done — you never need to
   open this again.

## Optional: true fresh reads from the Feeds button

By default the Feeds button applies the last payload the script POSTED
(up to 30 minutes old). To make a click trigger a fresh sheet READ:

1. Script editor → **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
2. Copy the long `/exec` URL. It's effectively a secret — don't share it.
3. In the dashboard, click the Feeds badge — it asks for the URL once.
   (Right-click the badge to change it later.)

From then on: click = script re-reads all four sheets → dashboard applies
the fresh payloads, usually within 15–30 seconds.

## Checking it works

Open the dashboard: next to the sync badge there's now a **Feeds** badge
showing the age of the oldest feed (e.g. `Feeds: 12m`). Hover it for a
per-source summary; click it to pull immediately.

## If it breaks

- You get an **email** when a run fails (tab renamed, your access revoked,
  dashboard down). The dashboard just keeps showing the last good data.
- To pause it: script.google.com → your project → Triggers (clock icon) →
  delete the trigger.
- If a sheet's tab is renamed or replaced, its `gid` stays the same, so the
  feed usually survives reorganisation. If the owner deletes and recreates a
  tab, update the `gid` in CONFIG (it's the number after `gid=` in the URL
  when you have that tab open).

## Security note

The script contains your dashboard password. That's fine while the script
stays in your private Drive — don't share the project. If you ever want it
tighter, we can switch the endpoint to a dedicated secret instead.

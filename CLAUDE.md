# Rules for Claude (drive-sync)

The parent folder's `CLAUDE.md` applies too (permission twice, no push or publish without approval, no commits unless asked, muted headless Chrome).

## What this is

`@arpitpatel/drive-sync`: Google Drive storage for the owner's sites, extracted from Taalmel's `src/drive/`. Design: `specs/16-11-drive-sync-package.md`. Plan: `plans/16-11-drive-sync-package-plan.md`. Remote: `git@github.com:Arpitpatel1771/drive-sync.git`, branch `main`.

## Hard rules

- **Never break existing users' data.** Taalmel's stored sync state must keep working: the `taalmel-sync` IndexedDB layout, the `taalmelKind` / `taalmelId` appProperties, folder ids, meta keys and in-flight upload sessions (exact list in the plan's Global Constraints). Any change to stored formats needs a migration and a test that reads the old format.
- **`npm publish` only after the owner approves that specific publish.** Every published version is permanent.
- **The public API changes on purpose only**, with a semver bump that matches the change (breaking change = major once past 1.0, minor before) and a README update.
- **No secrets in the package.** Google IDs come from each site at runtime; never commit `.env` files or keys.
- **Each site stays on its own.** Nothing in the package may let one site read another site's files or local data.

## Working on it

- Tests: `npx vitest run`; types: `npx tsc --noEmit`; build: `npm run build`.
- A change that affects Taalmel is checked in Taalmel too (its full test suite and its Drive browser checks against the dev fake).

# Trade Journal Desktop — local-first starter

This project wraps the approved V40 HTML journal in an Electron desktop window.

## Current implementation
- Opens the V40 journal in a desktop app window.
- Persists journal keys (`tj_trades_v1`, `tj_setups_v1`, `tj_poi_options_v1`) to an app-owned local JSON file through a narrow Electron preload bridge.
- Attempts a one-time migration from existing browser localStorage values the first time each key is read.
- Writes data atomically and creates rolling automatic local snapshots at most once per 10 minutes when a prior data file exists (up to 30 snapshots).
- Does not upload trades or screenshots.
- Uses the bundled interface unless a trusted HTTPS live UI URL is configured.
- Adds desktop-only Export Backup and Restore controls in the app header. Backup files contain the journal storage keys and remain wherever the user chooses to save them. Restore validates the file and creates a pre-restore local snapshot before replacing journal data.
- Includes a GitHub Pages deployment workflow for publishing interface updates and a SHA-256 manifest. Hosting is not configured until the project is pushed to a GitHub repository and Pages is enabled.

## Where data is stored
Electron stores the data at `app.getPath('userData')/journal-data.json`. On Windows this is normally under the current user's AppData/Roaming folder for Trade Journal. Automatic snapshots are stored in a `backups` subfolder. Do not delete this folder if you want to keep the journal data.

## Live UI updates
The updater requires a real trusted HTTPS host and a local `update-config.json` in Electron's user-data directory. It verifies that the manifest and UI share the configured trusted origin and checks the downloaded HTML with SHA-256 before using it. It retains the previous UI file and prompts before reloading the downloaded interface. Trades and screenshots are stored separately. SHA-256 verifies integrity against the manifest but is not a cryptographic signature; signed manifests should be added before production use.

See `deployment/README.md` for the GitHub Pages setup and publishing instructions.

## Build on Windows
1. Install Node.js LTS.
2. Extract this project folder.
3. Open a terminal in the folder and run `npm install`.
4. Run `npm start` to test the desktop wrapper.
5. Run `npm run dist:win` to create a Windows installer in `dist/`.

## Next steps
1. Create a GitHub repository and push this project to `main`.
2. Enable GitHub Pages with GitHub Actions.
3. Configure `update-config.json` in the installed app using the actual Pages URL.
4. Test storage, export/restore, and live UI updates on Windows with non-critical test data before using the journal for real trades.
5. Add signed manifest verification and test rollback before relying on online updates.

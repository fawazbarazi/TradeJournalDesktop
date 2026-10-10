# Publish live UI updates with GitHub Pages

This repository is prepared to publish the single-file journal UI and its SHA-256 manifest through GitHub Pages. This does **not** publish anything until you create a GitHub repository, push this project to its `main` branch, and enable Pages using **GitHub Actions** as the build/deployment source.

## One-time setup

1. Create a **private or public GitHub repository** for this project. Note: GitHub Pages availability and access restrictions differ by plan; a public repository is the simplest path for a public Pages site. Do not commit trade data, backups, API keys, or private screenshots.
2. Upload/push the project contents to the repository's `main` branch.
3. Open **Settings → Pages** and select **GitHub Actions** as the deployment source.
4. Open the **Actions** tab and run **Deploy Trade Journal UI updates**, or push a commit changing `app/index.html` or `deployment/version.txt`.
5. Wait for the workflow to complete. It publishes `index.html` and `ui-update-manifest.json` to the repository's Pages URL.

## Configure the installed desktop app

After deployment, determine the actual Pages URLs from the workflow log. Create `update-config.json` in the app's Electron user-data folder (normally `%APPDATA%/Trade Journal/update-config.json` on Windows):

```json
{
  "manifestUrl": "https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY/ui-update-manifest.json",
  "trustedOrigin": "https://YOUR-GITHUB-USERNAME.github.io"
}
```

For a user-site repository named `YOUR-GITHUB-USERNAME.github.io`, omit `YOUR-REPOSITORY` from the URLs. Restart the app and choose **Check Updates**.

## Publish a new interface version

1. Edit and test `app/index.html`.
2. Increment `deployment/version.txt` to a higher `major.minor.patch` version, e.g. `1.0.2`.
3. Commit and push to `main`.
4. Wait for the deployment workflow to finish, then use **Check Updates** in the app.

The workflow computes SHA-256 for the exact published HTML and generates the manifest automatically. The updater rejects versions that are not higher than the locally applied version.

## Security and privacy notes

- The updater requires HTTPS and verifies the downloaded HTML hash against the manifest, but **SHA-256 alone is not a digital signature**. A compromised repository or deployment account could publish a malicious manifest and matching HTML. Add a signed manifest verified against a public key embedded in the app before treating this as production-hardened.
- A GitHub Pages site is public by default. It contains only the UI and update manifest; do not put trade data or screenshots in the published site.
- Trades and screenshots are intended to remain in the local app data store. The update workflow publishes only `app/index.html` and a generated manifest.
- The app must have a configured `update-config.json` before online updates work. Until then it uses its bundled UI.

# Git Workflow

## Project

- Hub card: `Concert Audio System`
- Public landing URL: `https://cas.rexcorp.dynv6.net/`
- Local source: `C:\Users\user\Desktop\REX_PROJECTS\concert-audio-system`
- VPS Git remote: `vps` -> `/srv/git/concert-audio-system.git`
- Branch: `main`
- GitHub remote: `origin` -> `https://github.com/IliaBebebe/Concert-Audio-System.git`

## Rules

- Do not commit `.env`, release artifacts, installers, `node_modules`, Electron caches, logs, local music, or temporary files.
- The hosted public landing has its own deployment repository: `C:\Users\user\Desktop\REX_PROJECTS\cas-landing`.
- Use this repository for the full desktop app source and release work.

## Local Checks

```powershell
npm install
npm run build
```

Use the project `package.json` scripts for release builds.

## Stable Download Link

Windows installers are built as `Concert-Audio-System-Setup.exe`. Upload that
file to every GitHub release without renaming it. The public landing points to
`/releases/latest/download/Concert-Audio-System-Setup.exe`, which GitHub
automatically resolves to the asset in the latest release.

## Deploy

For source backup to the VPS Git remote:

```powershell
git status --short
git add .
git commit -m "Update Concert Audio System"
git push vps
```

For the public landing, update the separate `cas-landing` project and deploy it to `/var/www/cas/public`.

## Desktop releases

- Feature release 1.4.0 (YouTube search and local imports) is maintained on `codex/online-music`. Its tagged source is `f301119`; all four packages were built by native release CI before publication. The hosted landing is deployed from its own `codex/online-music` branch.

- Desktop fixes for the 1.3 series are maintained on `codex/release-1.3`; `main` is preserved separately.
- Synchronize `package.json`, `package-lock.json`, the visible app version, and `docs/releases/vX.Y.Z.md` before tagging.
- A pushed `v*` tag runs tests and native Windows/macOS/Linux builds. The workflow creates a **draft** only after all build jobs succeed and all four packages are present.
- Inspect the tagged commit, successful CI jobs and the four uploaded draft assets. Publish the verified draft with `gh release edit vX.Y.Z --draft=false --latest --verify-tag`.
- Verify all four tagged download URLs and the corresponding `/releases/latest/download/` URLs after publication. The public landing reads the latest release automatically; filenames must remain synchronized.

- CAS 1.6.0 is published from `codex/release-1.6.0`, tagged source `8e1b778`.
  All native builds and all four public downloads were verified; see
  `docs/QUALITY_1_6.md`. The landing production branch is also
  `codex/release-1.6.0` in its separate repository. Preserve the separately
  maintained `main` branch; its README links to the stable tagged app source.

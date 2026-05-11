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

## Deploy

For source backup to the VPS Git remote:

```powershell
git status --short
git add .
git commit -m "Update Concert Audio System"
git push vps
```

For the public landing, update the separate `cas-landing` project and deploy it to `/var/www/cas/public`.

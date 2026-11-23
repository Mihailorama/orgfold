# Team wiki (Docmost or AppFlowy)

The team's own wiki and docs, an alternative to Notion or Confluence. Component `wiki` in
config/components.json, one of (Stack page, or `pnpm run infra -- add wiki`):

- **install**: [Docmost](https://github.com/docmost/docmost) Community edition (AGPL-3.0 core, run
  unmodified, free) on the company's server. Spaces, pages with a rich editor, real-time
  co-editing, comments, page history, Markdown and Notion import, full-text search. The rest of
  this page is about it.
- **connect**: the [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) you already run, AppFlowy
  Cloud or your licensed self-host. You give its address (`WIKI_PUBLIC_URL`); the console's Stack
  page links to it and checks that it answers. Nothing else is wired: no sign-in with the app, no
  data exchange. We never install AppFlowy: its server is now
  [AppFlowy-SelfHost-Commercial](https://github.com/AppFlowy-IO/AppFlowy-SelfHost-Commercial)
  under its own commercial license (the open-source AppFlowy-Cloud server is archived), and its
  free self-hosted tier has one user seat, so a team needs a paid AppFlowy licence or plan
  (checked 2026-11-23). Its data lives with that AppFlowy, outside our backups.
- **skip**: no wiki.

Tracker: ORGFOLD-121.

## Where it runs and where its data lives

- Site: `WIKI_PUBLIC_URL` (default `https://docs.<your domain>`), through Caddy
  (`deploy/sites/docmost.caddy`).
- Pages, users, spaces: role and database `docmost` on the stack's Postgres (the `docmost-db`
  one-shot creates them), so the backups cover them (docs/backups.md).
- Attachments and images: the stack's S3 (the `s3` component, installed or connected), in the bucket
  `DOCMOST_S3_BUCKET` (default `docmost`). Docmost creates it at start when it is missing; with a
  connected S3 whose key cannot create buckets, create it yourself. Files go through Docmost, so
  the bucket stays private. The backup overlay copies `docmost` with the app's buckets.
- Queues and live editing: the stack's Redis, db 5.
- Memory: limit 768 MiB. Measured on the demo server on 2026-11-23: about 430 MiB idle after
  setup, a page and an upload.

## Sign-in

Docmost keeps its own login (email and password). SSO (SAML, OIDC, LDAP) and two-factor are in its
paid Business edition ([pricing](https://docmost.com/pricing), checked 2026-11-23), so it is not
wired to the app's sign-in (docs/sso.md). The first visit asks for the workspace name and the
first admin account: open the site right after the install and create it before anyone else can.
Then invite people from Settings, Members. With `DOCMOST_SMTP_*` set Docmost mails the invitation;
without them, copy the invite link and send it yourself.

## Usage data

`DISABLE_TELEMETRY=true`: Docmost sends no usage data. Checked on the demo on 2026-11-23: its pages
loaded nothing from other hosts. Embeds someone puts into a page (a video, a diagram) load from
their own sites.

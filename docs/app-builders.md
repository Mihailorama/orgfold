# App builders

Agents that build and change the company's internal apps, the way Lovable or Bolt do, but on the
company's own server. Several builders are in the catalog side by side; the owner installs one or
more from the console's Stack page (Add) or with `pnpm run infra -- add <id>`, and each person
opens the one they like. Tracker: SAASSTARTER-104.

| Component   | What it is                                                                                                      | Where the code runs                      | Projects live               | RAM limit |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------- | --------- |
| `openhands` | [OpenHands](https://github.com/OpenHands/OpenHands) Agent Canvas (MIT): coding agents, a terminal and an editor | in its container on this server          | `openhands_projects` volume | 2 GiB     |
| `bolt`      | [bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (MIT): describe an app, watch it run                    | in the visitor's browser (WebContainers) | the visitor's browser       | 1 GiB     |

Measured on the demo server on 2026-11-17 right after start, before any work: OpenHands about
760 MiB, bolt.diy about 560 MiB. An agent at work needs more; the limits above leave room for it.

## Who can open them

Both run code an agent writes and have no login of their own, so both need the staff sign-in gate
(component `gate`, docs/sso.md): only operators with two-factor get through. They sit on their own
Docker network, `builders`, with Caddy and the gate: no route to Postgres, Redis, Temporal or the
API's own port. Through Caddy they reach only what is public anyway (the app, the vault's login),
the same as from the internet, but from a private address: never put private ranges into
`VAULT_ADMIN_IPS`. They can reach the internet (models, package registries).

OpenHands' agent runs commands in the same container that keeps its settings and model keys, so
code it writes or runs can read those keys. Give it a key with a spending limit, used for nothing
else.

OpenHands puts its session key into the page it serves; that is safe only because the gate is in
front. Never publish its port or take it out from behind the gate.

## Usage data and outside calls

OpenHands sends no usage data: compose.prod.yaml sets `AGENT_CANVAS_DISABLE_TELEMETRY` (the page)
and `DO_NOT_TRACK` (the agent server's kill switch, which its settings cannot undo). Checked on
the demo on 2026-11-17: no request to PostHog or openhands.dev from the browser. bolt.diy's page
loads StackBlitz's WebContainer runtime from stackblitz.com in the visitor's browser; that is how
it runs apps.

## Models

OpenHands lets you pick the agent itself: its own, or Claude Code, Codex, Gemini CLI, Pi or
OpenCode. Each builder asks for its model in its own settings (an API key of OpenAI, Anthropic, OpenRouter
and so on, or a local endpoint). The key stays in that tool: OpenHands keeps it in the
`openhands_state` volume, bolt.diy in the visitor's browser. They do not use the app's AI gateway,
so these calls are not in `ai_calls` or the app's spend limit.

## Licenses and terms

All images are MIT and run unmodified (docs/LICENSES.md). bolt.diy runs the apps it builds with
StackBlitz's WebContainer API, and StackBlitz says production use in a commercial, for-profit
setting, including for employees, needs its commercial license; prototypes do not
([webcontainers.io/enterprise](https://webcontainers.io/enterprise)). Use bolt.diy for prototypes,
or buy that license; OpenHands has no such term.

## Not in the catalog yet

- [Dyad](https://github.com/dyad-sh/dyad) (Apache-2.0 outside `src/pro`): a desktop app, nothing to
  run on the server. Install it on your own computer.
- [Open Lovable](https://github.com/firecrawl/open-lovable) (MIT): runs code in Vercel Sandbox or
  E2B, so the code leaves the server.
- [Appsmith](https://github.com/appsmithorg/appsmith) (Apache-2.0): low-code internal tools with its
  own login, not an agent.

Publishing an app a builder made onto this server (its own profile and site) is the next step of
SAASSTARTER-104.

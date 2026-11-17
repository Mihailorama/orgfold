# Test reports

Where the results of every test run go: which tests failed, since when, how often, with history
and trends, and who gets told. Two ready-made servers are in the catalog side by side; the owner
installs one or both from the console's Stack page (Add) or with `pnpm run infra -- add <id>`.
CI sends each run to whichever is set up. Tracker: SAASSTARTER-105.

| Component      | What it is                                                                                                                                                                   | Who opens it               | Alerts                                    | RAM in use / limit |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------- | ------------------ |
| `allure`       | [Allure Report](https://allurereport.org) 2 in [allure-docker-service](https://github.com/fescobar/allure-docker-service) (Apache-2.0): a report per run, history and trends | operators, behind the gate | from the CI run (a red build)             | 60 MiB / 768 MiB   |
| `reportportal` | [ReportPortal](https://reportportal.io) 26.0.7 (Apache-2.0): a results server with dashboards, failure triage by its analyzer, launches compared                             | its own users and roles    | email per project rule, set up at install | 3.1 GiB / 6.3 GiB  |

Memory measured on the demo server on 2026-11-17, idle after a few imports. Allure needs more
for a moment while it builds a report (Java). ReportPortal is 11 containers (its API, sign-in,
UI, jobs, analyzer, OpenSearch, RabbitMQ, its own Postgres, Traefik as its path router); pick it
for a team that triages failures every day, Allure for a light report.

## How results get there

Every test runner writes JUnit XML when `TEST_RESULTS_DIR` is set: the Vitest configs
(`apps/api`, `packages/db`), `apps/web/playwright.config.ts`, and pytest through
`PYTEST_ADDOPTS=--junitxml=...`. Nothing is added to the code: JUnit XML is built into all three,
and both servers read it. CI (`.github/workflows/ci.yml`, job `check`) sets both and then runs

```sh
node scripts/test-report.mjs            # reads $TEST_RESULTS_DIR, or ./test-results
```

It merges the files into one run, named after the CI run (`CI #42 main`), and sends it to each
server whose variables are set; with none set it does nothing. A server that is down does not
fail the build (`continue-on-error`). Any other CI (GitLab, a local run) calls the same script
with the same variables.

| Server       | Repository variables (Settings, Secrets and variables, Actions)                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Allure       | variable `ALLURE_URL` (`https://tests.<domain>`), secret `ALLURE_CI_PASSWORD` (from the deploy env); optional `ALLURE_PROJECT` |
| ReportPortal | variables `REPORTPORTAL_URL`, `REPORTPORTAL_PROJECT`; secret `REPORTPORTAL_API_KEY` (a user's API key: Profile, API keys)      |

Read `ALLURE_CI_PASSWORD` from the deploy env without printing it, straight into the secret:
`sops -d deploy/env/production.enc.env | grep '^ALLURE_CI_PASSWORD=' | cut -d= -f2- | gh secret set ALLURE_CI_PASSWORD`.
A ReportPortal you already run elsewhere needs only those three values: no install.

## Allure

`https://tests.<domain>` opens the latest report. The reports are behind the staff sign-in gate
(component `gate`, docs/sso.md); only four paths skip it, the ones CI uses to send results
(`login`, `send-results`, `generate-report`, `clean-results`), and they need the server's own
admin login (`ci` with `ALLURE_CI_PASSWORD`). Each run keeps its own report
(`/allure-docker-service/projects/<project>/reports/<n>/index.html`); the last 30 stay in the
trends. Separate projects (`ALLURE_PROJECT`, e.g. one per repository) keep separate histories.

Alerts: Allure has none of its own. The CI run fails when a test fails, and GitHub (or GitLab)
tells whoever it notifies about failed runs; the report link is in the step's log. If you need
rules ("mail the team when the nightly run fails"), use ReportPortal.

## ReportPortal

`https://reports.<domain>`, its own login. The first user is `superadmin` with
`REPORTPORTAL_ADMIN_PASSWORD` from the deploy env; change it in the profile, then create users and
projects for the team (each user also gets a personal project). The CI key is an API key of a user
who is a member of the project.

At install, `pnpm run infra` runs `deploy/setup/reportportal-setup.sh` on the server. It:

- puts ReportPortal's JUnit import plugin 1.1.2 in place. The 1.1.0 that ReportPortal 5.15.6
  installs rejects every import (`Unrecognized field "launchUuid"`); the jar is pinned by sha256.
  Remove that part once an upstream release ships a working plugin;
- creates the "Email Server" integration from the stack's `SMTP_URL` and `MAIL_FROM`
  (docs/email.md), so alerts can go out at once.

Alerts are per project: Project settings, Notifications, turn email on and add a rule (for
example: send when a launch has failures, to these addresses or the launch owner). Checked on the
demo on 2026-11-17: an imported run with a failed test sent "ReportPortal Notification: launch
'CI #8 demo' #1 finished" to the rule's address.

Failure triage: people mark each failure with a defect type ("product bug", "automation bug",
"system issue"); the analyzer (`rp-analyzer`, on OpenSearch) compares new failures with the marked
ones and suggests a type, so it helps only after some history is marked.

## Backups and updates

Neither is backed up (docs/backups.md "Not backed up"): CI rebuilds Allure's history, ReportPortal's
users, dashboards and triage decisions live in its own Postgres (`rp_postgres` volume).
ReportPortal's services and settings follow upstream's
[docker-compose.yml](https://github.com/reportportal/reportportal/blob/master/docker-compose.yml)
(26.0.7); on an update, compare that file with the `rp-*` services in compose.prod.yaml.

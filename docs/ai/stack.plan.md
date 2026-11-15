# AI system card: stack.plan

- Owner (team, contact): <deployer: platform administrator, contact>
- Role under the AI Act (provider / deployer) and reasoning: deployer of a general-purpose model
  for an internal administration tool.
- Risk class and reasoning: minimal. It drafts a change to the company's own software stack for
  an administrator; it makes no decision about a person and changes nothing by itself. The
  `/ai-transparency` page still lists it.
- Intended purpose and users: operators (docs/admin.md). Turn a request ("we need a CRM") into a
  plan of catalog actions (`config/components.json`: a component and one of its modes) and a reply.
- Out of scope / must not be used for: running anything, choosing secrets, acting on a team chat
  request (the team chat only links to the console).
- Contours and models: `stack.plan` in `config/ai-models.json`; selected by
  `AI_STACK_PLAN_PROVIDER` / `AI_STACK_PLAN_MODEL` (unset: off).
- Prompt template id and current version: `stack.plan/system` v1 (`prompts/`, pinned in
  `prompts/lock.json`).
- Input data and legal basis: the operator's request, the catalog and how each component runs now
  (`STACK_MODES`, no secrets). Basis: running the service.
- Output and where it is shown; how it is labeled: a reply and a list of actions on the Stack
  page under "Plan a change". Actions outside the catalog, with a mode it does not list, for
  `core`, or that change nothing are dropped before they are stored (worker/stack.py).
- Human oversight: an operator approves the plan with a sign-in of the last 10 minutes (email
  code and TOTP); `pnpm run infra -- apply <id>` on their machine checks it again (approved, same
  `STACK_MODES`, catalog actions only), shows the infrastructure plan and asks before it runs it
  once. The server never applies a plan itself.
- Known limitations and failure modes: a plan that does more or less than asked, a wrong memory
  figure in the reply, a missed dependency (infra's own validation refuses an install whose
  `requires` is not met). Unparsable output shows "No plan". Checked with unit tests (fake
  model) and the golden set `evals/stack.plan/` (judge `prompts/judge/stack.plan.v1.md`).
- Logging: one `ai_calls` row per call under `STACK_AI_ORG_ID` (`actor_id` = the operator); the
  approval is an `operator.stack_plan.approved` platform audit row; content in the
  `AI_CONTENT_BUCKET` S3 objects for `AI_CONTENT_RETENTION_DAYS`.
- How affected people can contest a result: not applicable (no person is affected); operators
  discard a plan by not approving it.
- DPIA / FRIA references, registration number if any: <deployer>
- Last reviewed (date, by): 2026-11-15, initial version with the feature

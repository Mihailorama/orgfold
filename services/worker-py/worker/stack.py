"""Stack console planning agent (docs/admin.md "Plan a change", Plane SAASSTARTER-98).

The operator writes a request on the Stack page; this turns it into a plan made only of catalog
actions (config/components.json: a component and one of its modes) plus a reply. It changes
nothing: the operator approves the plan with a recent sign-in and `pnpm run infra -- apply <id>`
on their machine runs it. The row (stack_plans) is the only state; the request text never goes
through workflow arguments.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import asyncpg
from temporalio import activity

from worker import prompts
from worker.activities import ModelChoice
from worker.ai import Gateway, Message
from worker.tracker import obj

PURPOSE = "stack.plan"
# prompts/stack.plan/system.v1.md. New prompt text = new file + bump the version here.
PLAN_PROMPT = ("stack.plan/system", 1)
MODES = ("install", "connect", "skip")


@dataclass(frozen=True)
class StackPlan:
    """Workflow input. Contract with apps/api/src/temporal.ts (id only, no content)."""

    planId: str


def load_catalog(path: Path) -> list[dict[str, Any]]:
    """The components an operator can change (available, not core), as the model sees them."""
    return [
        {
            "id": c["id"],
            "title": c.get("title", c["id"]),
            "description": c["description"],
            "modes": c["modes"],
            "ramMiB": obj(c.get("install")).get("ramMiB"),
            "requires": c.get("requires") or {},
        }
        for c in json.loads(path.read_text())["components"]
        if c.get("available") is not False and c["id"] != "core"
    ]


def parse_modes(raw: str) -> dict[str, str]:
    """STACK_MODES=postgres:install,smtp:connect,... (twin of parseModes in admin-stack.ts)."""
    pairs = (p.strip().split(":", 1) for p in raw.split(",") if ":" in p)
    return {i: m for i, m in pairs if i and m in MODES}


def plan_input(catalog: list[dict[str, Any]], modes: dict[str, str], request: str) -> str:
    """The user message; evals/stack.plan stores exactly this as `input`."""
    now = {c["id"]: modes.get(c["id"], "skip") for c in catalog}
    return (
        f"Catalog:\n{json.dumps(catalog, indent=1)}\n\n"
        f"How each component runs now:\n{json.dumps(now)}\n\n"
        f"Request:\n{request}"
    )


def parse_plan(
    text: str, catalog: list[dict[str, Any]], modes: dict[str, str]
) -> tuple[str, list[dict[str, str]]] | None:
    """(reply, actions) from the model's JSON, or None when it is not usable. Actions outside the
    catalog, with a mode it does not list, or that change nothing are dropped."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    try:
        get = obj(json.loads(match.group(0)) if match else None)
    except json.JSONDecodeError:
        return None
    reply = str(get.get("reply") or "").strip()[:2000]
    if not reply:
        return None
    by_id = {c["id"]: c for c in catalog}
    actions: list[dict[str, str]] = []
    raw: object = get.get("actions")
    for item in cast(list[Any], raw) if isinstance(raw, list) else []:
        a = obj(item)
        c, mode = by_id.get(str(a.get("component"))), str(a.get("mode"))
        if c is None or mode not in c["modes"] or modes.get(c["id"], "skip") == mode:
            continue
        if all(x["component"] != c["id"] for x in actions):
            actions.append({"component": c["id"], "mode": mode})
    return reply, actions


class StackActivities:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        ai: Gateway | None,
        model: ModelChoice | None,
        ai_org_id: str,
        catalog: list[dict[str, Any]],
    ) -> None:
        self.pool, self.ai, self.model, self.ai_org_id = pool, ai, model, ai_org_id
        self.catalog = catalog

    @activity.defn(name="stack_plan")
    async def plan(self, p: StackPlan) -> str:
        """Drafts the plan of a `drafting` row. Safe to retry: only a drafting row is written."""
        row = await self.pool.fetchrow(
            "select request, status, stack_version, created_by from stack_plans where id = $1",
            p.planId,
        )
        if row is None or row["status"] != "drafting":
            return row["status"] if row else "missing"
        if self.ai is None or self.model is None or not self.ai_org_id:
            how = "set AI_STACK_PLAN_PROVIDER, AI_STACK_PLAN_MODEL and STACK_AI_ORG_ID"
            await self._finish(p, "off", f"The planning agent is off: {how}.", [], None)
            return "off"
        modes = parse_modes(row["stack_version"])
        prompt = prompts.load(*PLAN_PROMPT)
        result = await self.ai.call_llm(
            PURPOSE,
            [
                Message("system", prompt.text),
                Message("user", plan_input(self.catalog, modes, row["request"])),
            ],
            model=self.model.model,
            provider=self.model.provider,
            org_id=self.ai_org_id,
            actor_id=row["created_by"],
            prompt_template_id=prompt.id,
            prompt_template_version=prompt.version,
            max_tokens=1500,
        )
        parsed = parse_plan(result.text, self.catalog, modes)
        if parsed is None:
            await self._finish(
                p, "failed", "Could not make a plan. Ask again in other words.", [], result.call_id
            )
            return "failed"
        reply, actions = parsed
        await self._finish(p, "ready", reply, actions, result.call_id)
        activity.logger.info("stack plan %s ready, %d action(s)", p.planId, len(actions))
        return "ready"

    @activity.defn(name="stack_plan_failed")
    async def failed(self, p: StackPlan) -> None:
        """The drafting gave up for good (spend limit, provider down): say so on the page."""
        await self._finish(p, "failed", "The planning agent failed. Try again later.", [], None)

    async def _finish(
        self, p: StackPlan, status: str, reply: str, actions: list[dict[str, str]], call: Any
    ) -> None:
        await self.pool.execute(
            "update stack_plans set status = $2, reply = $3, actions = $4::jsonb,"
            " ai_call_id = $5 where id = $1 and status = 'drafting'",
            p.planId,
            status,
            reply,
            json.dumps(actions),
            call,
        )

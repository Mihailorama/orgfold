"""Stack console planning agent (worker/stack.py)."""

import json
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

import asyncpg
import pytest

from tests.conftest import new_org
from worker import settings
from worker.activities import ModelChoice
from worker.ai import AllowedModel, Completion, Gateway, Message
from worker.s3 import S3
from worker.stack import StackActivities, StackPlan, load_catalog, parse_modes, parse_plan

CATALOG = load_catalog(settings.COMPONENTS_FILE)
MODES = "core:install,postgres:install,s3:install,smtp:connect,crm:skip,vault:install"


def test_parse_plan_keeps_only_catalog_actions_that_change_something():
    text = json.dumps(
        {
            "reply": "Plan.",
            "actions": [
                {"component": "crm", "mode": "install"},
                {"component": "crm", "mode": "install"},  # duplicate
                {"component": "core", "mode": "skip"},  # never the base
                {"component": "postgres", "mode": "connect"},
                {"component": "langfuse", "mode": "install"},  # not available yet
                {"component": "smtp", "mode": "skip"},  # not a mode smtp has
                {"component": "vault", "mode": "install"},  # already so
                {"component": "rm -rf", "mode": "install"},
            ],
        }
    )
    assert parse_plan(f"Sure:\n{text}", CATALOG, parse_modes(MODES)) == (
        "Plan.",
        [{"component": "crm", "mode": "install"}],
    )
    assert parse_plan("no json", CATALOG, {}) is None
    assert parse_plan('{"actions": []}', CATALOG, {}) is None  # no reply


def test_parse_modes():
    assert parse_modes("crm:install, vault:bogus,:skip,x") == {"crm": "install"}


@pytest.fixture(scope="session")
async def s3() -> AsyncIterator[S3]:
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    await s3.ensure_bucket()
    yield s3
    await s3.close()


async def new_plan(pool: asyncpg.Pool, request: str) -> tuple[str, str]:
    user = str(uuid.uuid4())
    await pool.execute(
        'insert into "user" (id, name, email, email_verified) values ($1, $1, $2, true)',
        user,
        f"{user}@example.com",
    )
    plan = await pool.fetchval(
        "insert into stack_plans (request, stack_version, created_by) values ($1, $2, $3)"
        " returning id::text",
        request,
        MODES,
        user,
    )
    return plan, user


async def test_plan_activity_writes_the_checked_plan_once(pool: asyncpg.Pool, s3: S3):
    seen: list[str] = []

    async def provider(
        model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
    ) -> Completion:
        seen.append(messages[1].content)
        answer = {
            "reply": "Installs the CRM.",
            "actions": [{"component": "crm", "mode": "install"}],
        }
        return Completion(json.dumps(answer), model, 100, 20)

    org = await new_org(pool)
    ai = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={("fake", "m"): AllowedModel(frozenset({"stack.plan"}), None, unmetered=True)},
        providers={"fake": provider},
        retention_days=30,
    )
    acts = StackActivities(
        pool=pool, ai=ai, model=ModelChoice("fake", "m"), ai_org_id=org, catalog=CATALOG
    )
    plan, user = await new_plan(pool, "We need a CRM")
    assert await acts.plan(StackPlan(plan)) == "ready"
    assert await acts.plan(StackPlan(plan)) == "ready"  # retry: no second call
    assert len(seen) == 1 and "We need a CRM" in seen[0] and '"crm": "skip"' in seen[0]
    row: Any = await pool.fetchrow("select * from stack_plans where id = $1", plan)
    assert (row["status"], row["reply"]) == ("ready", "Installs the CRM.")
    assert json.loads(row["actions"]) == [{"component": "crm", "mode": "install"}]
    assert row["ai_call_id"] is not None
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org)
        call = await conn.fetchrow("select purpose, actor_id from ai_calls where org_id = $1", org)
    assert call is not None and (call["purpose"], call["actor_id"]) == ("stack.plan", user)


async def test_plan_activity_without_an_org_uses_the_console_org(pool: asyncpg.Pool, s3: S3):
    async def provider(
        model: str, messages: Sequence[Message], max_tokens: int, _tools: object = ()
    ) -> Completion:
        return Completion('{"reply": "Nothing to change.", "actions": []}', model, 10, 5)

    ai = Gateway(
        pool=pool,
        s3=s3,
        contour="eu",
        registry={("fake", "m"): AllowedModel(frozenset({"stack.plan"}), None, unmetered=True)},
        providers={"fake": provider},
        retention_days=30,
    )
    for _ in range(2):  # made once, then reused
        acts = StackActivities(
            pool=pool, ai=ai, model=ModelChoice("fake", "m"), ai_org_id="", catalog=CATALOG
        )
        plan, _ = await new_plan(pool, "Anything to add?")
        assert await acts.plan(StackPlan(plan)) == "ready"
        assert acts.ai_org_id == "operator-console"
    assert (
        await pool.fetchval("select count(*) from organization where slug = 'operator-console'")
        == 1
    )


async def test_plan_activity_off_without_a_model(pool: asyncpg.Pool):
    acts = StackActivities(pool=pool, ai=None, model=None, ai_org_id="", catalog=CATALOG)
    plan, _ = await new_plan(pool, "We need a CRM")
    assert await acts.plan(StackPlan(plan)) == "off"
    row: Any = await pool.fetchrow("select status, reply from stack_plans where id = $1", plan)
    assert row["status"] == "off" and "pnpm run infra -- add llm" in row["reply"]
    await acts.failed(StackPlan(plan))  # only a drafting row changes
    assert await pool.fetchval("select status from stack_plans where id = $1", plan) == "off"

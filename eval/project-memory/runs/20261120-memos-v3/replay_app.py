import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg2
from fastapi import HTTPException
from psycopg2 import sql
from pydantic import BaseModel

from memos.project_memory import plugin

logical_time = datetime.fromisoformat(
    os.environ.get("REPLAY_INITIAL_AT", "2026-01-01T00:00:00+00:00")
)
schema = sql.Identifier(os.environ["PROJECT_MEMORY_POSTGRES_SCHEMA"])
advance_lock = threading.Lock()


class ClockStore(plugin.PostgresAddStore):
    @contextmanager
    def transaction(self, *, readonly=False):
        with super().transaction(readonly=readonly) as cursor:
            cursor.execute(sql.SQL("SET LOCAL search_path TO {}, pg_catalog, public").format(schema))
            yield cursor


class ClockRuntime(plugin.EpisodeAddRuntime):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs, clock=lambda: logical_time)

    def start(self):
        # /advance drives the same close and recovery operations deterministically.
        pass


with psycopg2.connect(os.environ["PROJECT_MEMORY_POSTGRES_DSN"]) as conn, conn.cursor() as cur:
    cur.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(schema))
    cur.execute(
        sql.SQL("CREATE TABLE IF NOT EXISTS {}.replay_clock (at timestamptz NOT NULL)").format(schema)
    )
    cur.execute(
        sql.SQL("INSERT INTO {}.replay_clock SELECT %s WHERE NOT EXISTS (SELECT 1 FROM {}.replay_clock)")
        .format(schema, schema), (logical_time,)
    )
    for function in ("now", "clock_timestamp"):
        cur.execute(
            sql.SQL("CREATE OR REPLACE FUNCTION {}.{}() RETURNS timestamptz LANGUAGE SQL STABLE "
                    "AS $$ SELECT at FROM {}.replay_clock $$")
            .format(schema, sql.Identifier(function), schema)
        )
    cur.execute(sql.SQL("SELECT at FROM {}.replay_clock").format(schema))
    logical_time = cur.fetchone()[0].astimezone(timezone.utc)

plugin.PostgresAddStore = ClockStore
plugin.EpisodeAddRuntime = ClockRuntime

from memos.api.server_api import app, plugin_manager


class Advance(BaseModel):
    at: datetime


def set_time(store, at):
    global logical_time
    with store.transaction() as cursor:
        cursor.execute("UPDATE replay_clock SET at = %s", (at,))
        cursor.execute("SELECT now() AS txn, clock_timestamp() AS wall")
        clocks = cursor.fetchone()
        if clocks["txn"] != at or clocks["wall"] != at:
            raise RuntimeError("Evaluation SQL clocks did not advance together")
    logical_time = at


def next_due(store, target):
    with store.transaction(readonly=True) as cursor:
        cursor.execute(
            """SELECT MIN(CASE WHEN state = 'open' THEN LEAST(idle_due_at, max_wait_due_at)
                               ELSE next_retry_at END) AS at
                 FROM episodes
                WHERE project_id = %s AND outcome = 'pending'
                  AND (CASE WHEN state = 'open' THEN LEAST(idle_due_at, max_wait_due_at)
                            ELSE next_retry_at END) <= %s""",
            (store.project_id, target),
        )
        return cursor.fetchone()["at"]


def settle(runtime):
    closed = 0
    while episode_ids := runtime.acceptance.close_due():
        closed += len(episode_ids)
        for episode_id in episode_ids:
            runtime._publish(episode_id)
    started = time.monotonic()
    while True:
        runtime.recover()
        with runtime.store.transaction(readonly=True) as cursor:
            cursor.execute(
                """SELECT id, stage FROM episodes WHERE project_id = %s AND outcome = 'pending'
                       AND state <> 'open' AND (next_retry_at IS NULL OR next_retry_at <= %s)""",
                (runtime.store.project_id, logical_time),
            )
            pending = cursor.fetchall()
        if not pending:
            return closed
        if time.monotonic() - started > 240:
            stages = sorted({row["stage"] for row in pending})
            raise HTTPException(status_code=504, detail=f"Unsettled stages at {logical_time}: {stages}")
        time.sleep(0.25)


@app.post("/advance", include_in_schema=False)
def advance(request: Advance):
    if request.at.tzinfo is None:
        raise HTTPException(status_code=422, detail="A timezone is required")
    target = request.at.astimezone(timezone.utc)
    with advance_lock:
        if target < logical_time:
            raise HTTPException(status_code=409, detail=f"Clock already at {logical_time.isoformat()}")
        runtime = plugin_manager.plugins["project_memory"]._require_runtime()
        closed = settle(runtime)
        while (due := next_due(runtime.store, target)) is not None:
            # If a Retry is scheduled for now, settle must leave it terminal or deferred.
            if due <= logical_time:
                raise HTTPException(status_code=500, detail="A due operation did not settle")
            set_time(runtime.store, due)
            closed += settle(runtime)
        if target > logical_time:
            set_time(runtime.store, target)
        counts = {}
        with runtime.store.transaction(readonly=True) as cursor:
            cursor.execute(
                "SELECT outcome, count(*) FROM episodes WHERE project_id = %s GROUP BY outcome",
                (runtime.store.project_id,),
            )
            counts.update((row["outcome"], row["count"]) for row in cursor.fetchall())
        return {"at": logical_time, "closed": closed, "outcomes": counts}

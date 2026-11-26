"""Read-only view of a MemOS v3 replay: Add jobs, Episodes, Topics and the model calls behind them.

    python inspect-memos.py --schema memos_v3_58100 jobs [--space S] [--trace-map run-dir] [--json]
    python inspect-memos.py --schema memos_v3_58100 episode <episode_id>
    python inspect-memos.py --schema memos_v3_58100 space <space_id>
    python inspect-memos.py calls <run-dir> --event <event_index> [--stage episode.extract] [--full]

`jobs --json` is what step-check.mjs reads after each event (stage, outcome, Task ids, Topic ids,
boundary judgment). Nothing here writes to the database.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from pathlib import Path


DSN = os.environ.get("MEMOS_V3_DSN", "postgresql://add_verify@127.0.0.1:55439/add_verify_step")


def connect(schema: str):
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(DSN)
    conn.set_session(readonly=True, autocommit=True)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SET search_path TO %s, public" % psycopg2.extensions.quote_ident(schema, cur))
    return cur


def jsonable(value):
    return json.loads(json.dumps(value, default=str, ensure_ascii=False))


def jobs(cur, space: str | None):
    cur.execute(
        """SELECT j.episode_id, j.space_id, j.conversation_key, j.user_id, j.task_ids, j.stage,
                  j.outcome, j.attempt, j.accept_time, j.close_due_time, j.next_retry_time,
                  j.topic_ids, j.error, j.update_time, j.domains,
                  j.organize_result->'boundary' AS boundary,
                  j.organize_result->'close' AS close,
                  j.organize_result->'staged' AS staged,
                  j.organize_result->'warnings' AS warnings,
                  j.organize_result->'last_error' AS last_error,
                  jsonb_array_length(j.drafts) AS drafts,
                  e.message_seq_start, e.message_seq_end, e.previous_episode_id, e.topic_id,
                  e.episode_summary, e.first_chat_time, e.last_chat_time
             FROM add_jobs j JOIN episodes e ON e.id = j.episode_id
            WHERE %s IS NULL OR j.space_id = %s
            ORDER BY j.accept_time, j.episode_id""",
        (space, space),
    )
    return jsonable(cur.fetchall())


def episode(cur, episode_id: str):
    cur.execute(
        """SELECT j.*, e.message_seq_start, e.message_seq_end, e.previous_episode_id, e.topic_id,
                  e.episode_summary, e.first_chat_time, e.last_chat_time
             FROM add_jobs j JOIN episodes e ON e.id = j.episode_id WHERE j.episode_id LIKE %s""",
        (episode_id + "%",),
    )
    rows = cur.fetchall()
    if len(rows) != 1:
        raise SystemExit(f"{len(rows)} Episodes match {episode_id}")
    row = rows[0]
    episode_id = row["episode_id"]
    cur.execute(
        """SELECT msg_seq, role, role_name, task_id, chat_time, content FROM messages
            WHERE conversation_key = %s AND msg_seq BETWEEN %s AND %s ORDER BY msg_seq""",
        (row["conversation_key"], row["message_seq_start"], row["message_seq_end"]),
    )
    messages = cur.fetchall()
    cur.execute(
        "SELECT event, at, stage, attempt, detail FROM add_episode_events WHERE episode_id = %s ORDER BY at, id",
        (episode_id,),
    )
    return jsonable({"job": row, "messages": messages, "events": cur.fetchall()})


def space_view(cur, space_id: str):
    cur.execute("SELECT id FROM spaces WHERE id LIKE %s", (space_id + "%",))
    found = cur.fetchall()
    if len(found) != 1:
        raise SystemExit(f"{len(found)} Spaces match {space_id}")
    space_id = found[0]["id"]
    cur.execute(
        """SELECT t.id, t.topic_name, t.topic_summary, t.topic_description, d.domain, t.version,
                  t.create_time, t.update_time, t.extra->'rank_time' AS rank_time
             FROM topics t LEFT JOIN domains d ON d.id = t.domain_id
            WHERE t.space_id = %s ORDER BY t.create_time, t.id""",
        (space_id,),
    )
    topics = cur.fetchall()
    cur.execute(
        """SELECT id, topic_id, entry_type, status, parent_decision_id, content, chat_time, user_ids,
                  extra, create_time, update_time
             FROM project_entries WHERE space_id = %s ORDER BY topic_id, create_time, id""",
        (space_id,),
    )
    entries = cur.fetchall()
    for topic in topics:
        topic["entries"] = [e for e in entries if e["topic_id"] == topic["id"]]
    cur.execute(
        "SELECT last_formation_time, formation_version FROM spaces WHERE id = %s", (space_id,)
    )
    return jsonable({"space": cur.fetchone(), "topics": topics})


def calls(run_dir: Path, event: int, stage: str | None, full: bool):
    path = run_dir / "usage" / "sut-trace.jsonl"
    rows = []
    for line in path.read_text().splitlines():
        record = json.loads(line)
        context = record.get("context") or {}
        if context.get("event_index") != event:
            continue
        if stage and record.get("stage") != stage:
            continue
        messages = (record.get("request") or {}).get("messages") or []
        rows.append({
            "at": record.get("at"),
            "stage": record.get("stage"),
            "step": context.get("step"),
            "latencyMs": record.get("latencyMs"),
            "messages": messages if full else [
                {"role": m.get("role"), "content": str(m.get("content"))[-1500:]} for m in messages
            ],
            "response": (record.get("response") or {}).get("content"),
        })
    return rows


def print_jobs(rows):
    for row in rows:
        boundary = row.get("boundary") or {}
        print(
            f"{row['episode_id'][:8]} {row['space_id'][:8]} {row['conversation_key'][-24:]:<24} "
            f"seq {row['message_seq_start']}-{row['message_seq_end']} {row['stage']:<14} {row['outcome']:<9} "
            f"topics={len(row['topic_ids'] or [])} drafts={row['drafts']} prev={(row['previous_episode_id'] or '-')[:8]} "
            f"starts={boundary.get('starts')} warn={row.get('warnings')}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--schema")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("jobs")
    p.add_argument("--space")
    p = sub.add_parser("episode")
    p.add_argument("episode_id")
    p = sub.add_parser("space")
    p.add_argument("space_id")
    p = sub.add_parser("calls")
    p.add_argument("run_dir", type=Path)
    p.add_argument("--event", type=int, required=True)
    p.add_argument("--stage")
    p.add_argument("--full", action="store_true")
    args = parser.parse_args()
    if args.command == "calls":
        out = calls(args.run_dir, args.event, args.stage, args.full)
    else:
        if not args.schema:
            parser.error("--schema is required")
        cur = connect(args.schema)
        if args.command == "jobs":
            out = jobs(cur, args.space)
            if not args.json:
                print_jobs(out)
                return
        elif args.command == "episode":
            out = episode(cur, args.episode_id)
        else:
            out = space_view(cur, args.space_id)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=None if args.json else 2)
    print()


if __name__ == "__main__":
    main()

"""Why a Trace's extracted drafts did not survive: finds the extract calls whose Episode carries the
Trace's member message, and for each draft prints the evidence checks of add_extraction._draft that
can be replayed offline (unwitnessed tokens against the quote, source_path, decision origin).

    PYTHONPATH=<MemOS>/src python triage-missing.py <run-dir> "<member message text>"
"""

from __future__ import annotations

import json
import sys

from pathlib import Path

from memos.project_memory.add_evidence import quote_ref, unwitnessed_tokens


def main() -> None:
    run_dir, text = Path(sys.argv[1]), sys.argv[2]
    for line in (run_dir / "usage" / "sut-trace.jsonl").read_text().splitlines():
        record = json.loads(line)
        if record.get("stage") != "extract":
            continue
        messages = (record.get("request") or {}).get("messages") or []
        payload = messages[-1].get("content") if messages else ""
        if text not in str(payload):
            continue
        try:
            inputs = json.loads(payload)
        except (TypeError, ValueError):
            inputs = {}
        rows = {m["id"]: m for m in inputs.get("episode", [])}
        response = (record.get("response") or {}).get("content") or ""
        print(f"== extract call at {record.get('at')} (event {(record.get('context') or {}).get('event_index')})")
        try:
            output = json.loads(response.strip().removeprefix("```json").removesuffix("```"))
        except ValueError:
            print("unparsable response:", response[:400])
            continue
        print("summary:", output.get("episode_summary"))
        for draft in output.get("drafts") or []:
            row = rows.get(draft.get("message_id"))
            field = draft.get("source_path", "/content")
            checks = []
            if row is None:
                checks.append("message_id not in episode")
            else:
                stored = {"message_id": row["id"], "role": row["role"], "content": row["content"]}
                if not quote_ref(stored, draft.get("quote"), field):
                    checks.append(f"quote not found at {field}")
                if draft.get("kind") == "decision" and (row["role"] != "user" or field != "/content"):
                    checks.append("decision not quoted from the member message")
            context = " ".join(c.get("quote", "") for c in draft.get("context") or [] if isinstance(c, dict))
            missing = unwitnessed_tokens(draft.get("content", ""), f"{draft.get('quote', '')}\n{context}")
            if missing:
                checks.append(f"unwitnessed {sorted(missing)}")
            print(f"- {draft.get('kind')} [{draft.get('origin')}] {draft.get('content')}")
            print(f"    quote={draft.get('quote')!r} context={bool(draft.get('context'))} -> {checks or 'passes offline checks'}")


if __name__ == "__main__":
    main()

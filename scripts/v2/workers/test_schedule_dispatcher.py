import json

import schedule_dispatcher as sd


class FakeConn:
    def __init__(self, due_rows):
        self.due_rows = due_rows
        self.closed = False

    def run(self, sql, **_kw):
        return self.due_rows if sql.startswith("UPDATE report_schedules") else []

    def close(self):
        self.closed = True


class FakeSqs:
    def __init__(self, fail_for=None):
        self.sent = []
        self.fail_for = set(fail_for or [])

    def send_message(self, QueueUrl, MessageBody):  # noqa: N803 — boto3 kwarg names
        body = json.loads(MessageBody)
        if body["payload"]["requested_by"] in self.fail_for:
            raise RuntimeError("sqs unavailable")
        self.sent.append(body)


def _wire(monkeypatch, due_rows, fail_for=None):
    conn = FakeConn(due_rows)
    inserted = []
    monkeypatch.setattr(sd.db, "connect", lambda: conn)
    monkeypatch.setattr(sd.db, "insert_job", lambda c, jid, t, p, **k: inserted.append((jid, t, p)))
    sqs = FakeSqs(fail_for)
    monkeypatch.setattr(sd, "_sqs", sqs)
    return conn, inserted, sqs


def test_enqueues_a_report_per_due_schedule(monkeypatch):
    rows = [("u1", "weekly", {"tier": "deep", "model": "opus"}), ("u2", "monthly", {"tier": "mid"})]
    conn, inserted, sqs = _wire(monkeypatch, rows)
    out = sd.lambda_handler({}, None)
    assert out == {"due": 2, "enqueued": 2, "failed": 0}
    assert [t for _, t, _ in inserted] == ["report", "report"]
    assert inserted[0][2]["tier"] == "deep" and inserted[0][2]["requested_by"] == "u1"
    assert inserted[0][2]["scheduled"] is True
    assert len(sqs.sent) == 2 and sqs.sent[0]["type"] == "report"
    assert conn.closed is True


def test_no_due_rows_enqueues_nothing(monkeypatch):
    _conn, inserted, sqs = _wire(monkeypatch, [])
    out = sd.lambda_handler({}, None)
    assert out == {"due": 0, "enqueued": 0, "failed": 0}
    assert inserted == [] and sqs.sent == []


def test_claim_sql_is_advance_first_enabled_only_returning():
    sql = sd._CLAIM_SQL
    assert "UPDATE report_schedules" in sql
    assert "enabled = true" in sql
    assert "next_run_at <= now()" in sql
    assert "RETURNING" in sql  # claim+advance in one statement → concurrent run claims 0 (no double-fire)


def test_per_row_failure_does_not_block_others(monkeypatch):
    rows = [("bad", "weekly", {}), ("good", "weekly", {})]
    _conn, _inserted, sqs = _wire(monkeypatch, rows, fail_for={"bad"})
    out = sd.lambda_handler({}, None)
    assert out["due"] == 2 and out["enqueued"] == 1 and out["failed"] == 1
    assert len(sqs.sent) == 1 and sqs.sent[0]["payload"]["requested_by"] == "good"

"""Tests for sg_rule_dispatcher.py — one job enqueued per enabled sg_flow_sources row, per-row
failure isolation (one source's enqueue failure must not block the others)."""
import json

import sg_rule_dispatcher as disp


class FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def run(self, sql, **kwargs):
        return self.rows

    def close(self):
        self.closed = True


class FakeSqs:
    def __init__(self, fail_on=None):
        self.sent = []
        self.fail_on = fail_on or set()

    def send_message(self, QueueUrl, MessageBody):
        body = json.loads(MessageBody)
        if body["payload"]["account_id"] in self.fail_on:
            raise RuntimeError("sqs down")
        self.sent.append(body)


def test_enqueues_one_job_per_enabled_source(monkeypatch):
    conn = FakeConn([("123456789012", "ap-northeast-2"), ("210987654321", "us-east-1")])
    monkeypatch.setattr(disp, "db", type("M", (), {"connect": staticmethod(lambda: conn),
                                                     "insert_job": staticmethod(lambda *a, **k: None)}))
    fake_sqs = FakeSqs()
    monkeypatch.setattr(disp, "_sqs", fake_sqs)
    result = disp.lambda_handler({}, None)
    assert len(result["enqueued"]) == 2
    assert len(result["failed"]) == 0
    assert conn.closed is True
    assert len(fake_sqs.sent) == 2
    assert all(m["type"] == "sg_rule_scan" for m in fake_sqs.sent)


def test_one_source_enqueue_failure_does_not_block_the_others(monkeypatch):
    conn = FakeConn([("123456789012", "ap-northeast-2"), ("210987654321", "us-east-1")])
    monkeypatch.setattr(disp, "db", type("M", (), {"connect": staticmethod(lambda: conn),
                                                     "insert_job": staticmethod(lambda *a, **k: None)}))
    fake_sqs = FakeSqs(fail_on={"123456789012"})
    monkeypatch.setattr(disp, "_sqs", fake_sqs)
    result = disp.lambda_handler({}, None)
    assert len(result["enqueued"]) == 1
    assert len(result["failed"]) == 1
    assert result["failed"][0]["account_id"] == "123456789012"
    assert conn.closed is True


def test_no_enabled_sources_is_a_no_op(monkeypatch):
    conn = FakeConn([])
    monkeypatch.setattr(disp, "db", type("M", (), {"connect": staticmethod(lambda: conn)}))
    fake_sqs = FakeSqs()
    monkeypatch.setattr(disp, "_sqs", fake_sqs)
    result = disp.lambda_handler({}, None)
    assert result == {"enqueued": [], "failed": []}
    assert conn.closed is True

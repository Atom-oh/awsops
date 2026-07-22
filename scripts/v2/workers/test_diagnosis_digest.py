"""diagnosis_digest.py — batches diagnosis_reports rows with notified_at IS NULL into ONE SNS
digest per run (replaces the prior one-email-per-completion path), then stamps notified_at."""


class FakeConn:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_digest_publishes_and_marks_notified_when_pending(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 1, "title": "리포트 A"}, {"id": 2, "title": "리포트 B"}],
    )
    published = {}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_digest",
        lambda topic, reports, region=None: published.update(topic=topic, reports=reports) or "mid-1",
    )
    marked = {}
    monkeypatch.setattr(
        diagnosis_digest.ddb, "mark_notified",
        lambda c, ids: marked.update(ids=ids) or len(ids),
    )
    monkeypatch.setenv("DIAGNOSIS_SNS_TOPIC_ARN", "arn:aws:sns:x:1:t")
    monkeypatch.setenv("APP_DOMAIN", "x.example")

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 2}
    assert published["topic"] == "arn:aws:sns:x:1:t"
    assert [r["title"] for r in published["reports"]] == ["리포트 A", "리포트 B"]
    assert published["reports"][0]["report_url"] == "https://x.example/ai-diagnosis?report=1"
    assert marked["ids"] == [1, 2]
    assert conn.closed


def test_digest_noop_when_nothing_pending(monkeypatch):
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(diagnosis_digest.ddb, "list_pending_notifications", lambda c: [])

    published = {"called": False}
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_digest",
        lambda *a, **kw: published.update(called=True),
    )
    marked = {"called": False}
    monkeypatch.setattr(
        diagnosis_digest.ddb, "mark_notified",
        lambda *a, **kw: marked.update(called=True),
    )

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 0}
    assert published["called"] is False  # no publish for an empty digest
    assert marked["called"] is False
    assert conn.closed


def test_digest_marks_notified_even_without_topic_configured(monkeypatch):
    """Flag-off / no topic still drains the backlog — a later flag-on shouldn't suddenly
    email a huge historical batch."""
    import diagnosis_digest

    conn = FakeConn()
    monkeypatch.setattr(diagnosis_digest.db, "connect", lambda: conn)
    monkeypatch.setattr(
        diagnosis_digest.ddb, "list_pending_notifications",
        lambda c: [{"id": 5, "title": "리포트 C"}],
    )
    publish_calls = []
    monkeypatch.setattr(
        diagnosis_digest.notify, "publish_digest",
        lambda *a, **kw: publish_calls.append((a, kw)),
    )
    marked = {}
    monkeypatch.setattr(
        diagnosis_digest.ddb, "mark_notified",
        lambda c, ids: marked.update(ids=ids),
    )
    monkeypatch.delenv("DIAGNOSIS_SNS_TOPIC_ARN", raising=False)

    out = diagnosis_digest.lambda_handler(None, None)

    assert out == {"digested": 1}
    assert publish_calls == []       # no topic → publish_digest never called
    assert marked["ids"] == [5]      # backlog still drained

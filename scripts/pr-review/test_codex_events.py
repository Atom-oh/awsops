"""JSONL transport tests; the existing nonce parser still owns review validity."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

PARSER = Path(__file__).with_name("codex_events.py")
START = {"type": "turn.started"}
DONE = {"type": "turn.completed", "usage": {
    "input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}}


def message(text):
    return {"type": "item.completed", "item": {
        "id": "reply", "type": "agent_message", "text": text}}


class CodexEvents(unittest.TestCase):
    def parse(self, events):
        text = "\n".join(json.dumps(event) for event in events) + "\n"
        return subprocess.run([sys.executable, str(PARSER)], input=text,
                              text=True, capture_output=True, timeout=3)

    def test_only_agent_messages_reach_nonce_parser(self):
        tool = {"type": "item.completed", "item": {
            "id": "tool", "type": "command_execution", "command": "cat runbook.md",
            "aggregated_output": "Monthly request limit reached\n"
                                 '{"type":"error","message":"insufficient credits"}',
            "exit_code": 0, "status": "completed"}}
        result = self.parse([START, tool, message("review frame"), DONE])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "review frame\n")
        self.assertEqual(result.stderr, "")

    def test_all_agent_messages_preserve_duplicate_frame_detection(self):
        result = self.parse([START, message("early frame"), message("final frame"), DONE])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "early frame\nfinal frame\n")

    def test_incomplete_malformed_and_failed_streams_never_emit_reports(self):
        for events in ([START, message("frame")], [START, DONE],
                       [START, message("frame"), {"type": "turn.failed",
                                                "error": {"message": "request failed"}}],
                       [START, message("frame"), DONE, "not an event"],
                       [START, message("frame"), DONE, message("late frame")],
                       [START, message("frame"), START, DONE]):
            with self.subTest(events=events):
                result = self.parse(events)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_error_event_is_diagnostic_even_with_complete_turn(self):
        result = self.parse([START, {"type": "error", "message":
                                    "[warn] failed to set model: Method not found"},
                             message("frame"), DONE])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("failed to set model", result.stderr)


if __name__ == "__main__":
    unittest.main()

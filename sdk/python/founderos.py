"""FounderOS analytics SDK — Python (server-side).

Buffers product events and flushes them in batches to the track-event edge
function. Authenticates with an ``fos_`` API key (issued in Integrations → API
Keys); the workspace is resolved from the key, so only ``project_id`` is needed.

Usage::

    from founderos import FounderOS

    fos = FounderOS(
        host="https://xxxx.supabase.co",
        project_id="<project-uuid>",
        api_key="fos_...",
    )
    fos.track("signup", distinct_id="user@example.com", properties={"plan": "pro"})
    fos.track("feature_used", distinct_id="user@example.com",
              properties={"feature": "export"})
    fos.flush()        # or rely on the background flusher
    fos.shutdown()     # flush + stop the worker (call on exit)

Only depends on the standard library (urllib), so it drops into any environment.
"""

from __future__ import annotations

import atexit
import json
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class FounderOS:
    def __init__(
        self,
        host: str,
        project_id: str,
        api_key: Optional[str] = None,
        workspace_id: Optional[str] = None,
        anon_key: Optional[str] = None,
        flush_interval: float = 5.0,
        batch_size: int = 20,
        max_queue: int = 10000,
        debug: bool = False,
    ) -> None:
        if not host or not project_id:
            raise ValueError("FounderOS: host and project_id are required")
        if not api_key and not (workspace_id and anon_key):
            raise ValueError(
                "FounderOS: provide api_key (server) or workspace_id + anon_key"
            )
        self.host = host.rstrip("/")
        self.project_id = project_id
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.anon_key = anon_key
        self.batch_size = batch_size
        self.max_queue = max_queue
        self.debug = debug
        self._distinct_id: Optional[str] = None

        self._queue: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        if flush_interval > 0:
            self._worker = threading.Thread(
                target=self._loop, args=(flush_interval,), daemon=True
            )
            self._worker.start()
        atexit.register(self.shutdown)

    # ── public API ──
    def identify(self, distinct_id: str, properties: Optional[Dict[str, Any]] = None) -> None:
        """Associate subsequent events with a user."""
        self._distinct_id = distinct_id
        if properties:
            self.track("$identify", distinct_id=distinct_id, properties=properties)

    def track(
        self,
        event_name: str,
        distinct_id: Optional[str] = None,
        properties: Optional[Dict[str, Any]] = None,
        occurred_at: Optional[str] = None,
    ) -> None:
        """Queue an event. Sent on the next flush (or immediately when full)."""
        event = {
            "event_name": event_name,
            "distinct_id": distinct_id or self._distinct_id,
            "properties": properties or {},
            "occurred_at": occurred_at or _now_iso(),
        }
        with self._lock:
            self._queue.append(event)
            over = len(self._queue) >= self.batch_size
            if len(self._queue) > self.max_queue:
                self._queue = self._queue[-self.max_queue:]
        if over:
            self.flush()

    def flush(self) -> None:
        """Send all queued events now."""
        with self._lock:
            if not self._queue:
                return
            batch = self._queue
            self._queue = []
        try:
            self._post("track-event", {
                "project_id": self.project_id,
                "workspace_id": self.workspace_id,
                "batch": batch,
            })
            self._log(f"flushed {len(batch)} events")
        except Exception as exc:  # re-queue so events aren't lost
            with self._lock:
                self._queue = (batch + self._queue)[: self.max_queue]
            self._log(f"flush failed, re-queued: {exc}")

    def shutdown(self) -> None:
        """Flush and stop the background worker. Idempotent."""
        if self._stop.is_set():
            return
        self._stop.set()
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=2.0)
        self.flush()

    # ── internals ──
    def _loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            self.flush()

    def _post(self, fn: str, body: Dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.anon_key:
            headers["apikey"] = self.anon_key
        req = urllib.request.Request(
            f"{self.host}/functions/v1/{fn}", data=data, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"{fn} {exc.code}: {detail}") from None

    def _log(self, msg: str) -> None:
        if self.debug:
            print(f"[founderos] {msg}")

#!/usr/bin/env python3
"""Hermes Pocket push watcher — approvals reach your phone when the app is closed.

The phone's websocket only gets session events while it owns the session
transport, so a *second* connection can't just listen in. Instead this
watcher polls the lossless replay ring (``session.events.since`` — the same
primitive the mobile client uses after a reconnect) and forwards interesting
events to your device via the Expo Push API.

Usage:
  ./scripts/hermes-push-watch.sh --push-token 'ExponentPushToken[xxxx]' [--replies]

  Get the token on the phone: Settings → "Get push token (for PC watcher)".
  Env fallbacks: HERMES_HOST, HERMES_PORT, HERMES_DASHBOARD_SESSION_TOKEN,
  HERMES_EXPO_PUSH_TOKEN (comma-separated for several devices).

First run seeds watermarks silently (no backlog spam). State lives in
~/.hermes/hermes-mobile-push.json.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
STATE_PATH = Path.home() / ".hermes" / "hermes-mobile-push.json"

WATCH_TYPES = {
    "approval.request": "Approval needed",
    "sudo.request": "Sudo requested",
    "secret.request": "Secret requested",
    "clarify.request": "Agent asks",
}
OPT_IN_TYPES = {
    "message.complete": "Agent replied",
    "background.complete": "Background task done",
}


def detect_python() -> str:
    candidates = [
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python",
        Path("/usr/bin/python3"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return sys.executable


def load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {"watermarks": {}, "epoch": None, "seen": []}


def save_state(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state))
    except Exception as exc:
        print(f"(warn) could not save state: {exc}", flush=True)


def expo_send(tokens: list[str], title: str, body: str, badge: int = 1) -> None:
    messages = [
        {
            "to": t,
            "sound": "default",
            # FCM defers normal-priority messages under Doze/OEM battery
            # savers — a knock must not wait for a maintenance window.
            "priority": "high",
            "title": title,
            "body": body[:300],
            "badge": badge,
            "channelId": "hermes-alerts",
            "data": {"screen": "chat"},
        }
        for t in tokens
    ]
    req = urllib.request.Request(
        EXPO_PUSH_URL,
        data=json.dumps(messages).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read().decode())
    except Exception as exc:
        print(f"(warn) push send failed: {exc}", flush=True)
        return
    for item in resp.get("data", []) if isinstance(resp, dict) else []:
        if item.get("status") != "ok":
            print(f"(warn) push rejected: {json.dumps(item)[:200]}", flush=True)


def summarize(ev: dict) -> str:
    p = ev.get("payload") if isinstance(ev.get("payload"), dict) else ev
    for k in ("command", "prompt", "question", "text"):
        v = p.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:200]
    return ev.get("type", "event")


class Gateway:
    def __init__(self, url: str):
        self.url = url
        self.ws = None
        self.next_id = 0

    async def connect(self):
        import websockets

        self.ws = await websockets.connect(self.url, max_size=32 * 1024 * 1024)
        # Drain spontaneous frames (gateway.ready etc.)
        asyncio.get_running_loop().call_later(0, lambda: None)

    async def close(self):
        try:
            if self.ws:
                await self.ws.close()
        except Exception:
            pass
        self.ws = None

    async def request(self, method: str, params: dict, timeout: float = 30.0):
        self.next_id += 1
        mid = f"w{self.next_id}"
        assert self.ws is not None
        await self.ws.send(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}))
        end = time.monotonic() + timeout
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("id") == mid:
                if msg.get("error"):
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result")
            if time.monotonic() > end:
                raise TimeoutError(method)


async def poll_once(gw: Gateway, state: dict, tokens: list[str], include_replies: bool, seed_only: bool) -> int:
    watched = {**WATCH_TYPES, **(OPT_IN_TYPES if include_replies else {})}
    try:
        res = await gw.request("session.list", {})
    except Exception as exc:
        print(f"(warn) session.list: {exc}", flush=True)
        return 0
    sessions = res.get("sessions", res.get("results", [])) if isinstance(res, dict) else []
    if not isinstance(sessions, list):
        return 0
    sessions = sessions[:30]
    marks: dict = state.setdefault("watermarks", {})
    seen: list = state.setdefault("seen", [])
    epoch = state.get("epoch")
    sent = 0
    for s in sessions:
        sid = s.get("id") if isinstance(s, dict) else None
        if not sid:
            continue
        try:
            r = await gw.request("session.events.since", {"session_id": sid, "last_seen": marks.get(sid, 0)})
        except Exception as exc:
            print(f"(warn) events.since {sid[:12]}: {exc}", flush=True)
            continue
        if not isinstance(r, dict):
            continue
        if epoch is None and isinstance(r.get("epoch"), str):
            epoch = r["epoch"]
            state["epoch"] = epoch
        elif isinstance(r.get("epoch"), str) and r["epoch"] != epoch:
            print(f"(info) gateway epoch changed — resetting watermarks", flush=True)
            marks.clear()
            state["epoch"] = r["epoch"]
            epoch = r["epoch"]
        events = r.get("events", [])
        if not isinstance(events, list):
            continue
        for ev in events:
            if not isinstance(ev, dict) or not ev.get("type"):
                continue
            seq = ev.get("seq")
            if isinstance(seq, (int, float)) and seq > 0:
                if seq <= marks.get(sid, 0):
                    continue
                marks[sid] = int(seq)
            else:
                h = f"{ev.get('type')}:{sid}:{json.dumps(ev.get('payload', {}), sort_keys=True)[:120]}"
                if h in seen:
                    continue
                seen.append(h)
                state["seen"] = seen[-500:]
            if isinstance(r.get("latest_seq"), (int, float)) and r["latest_seq"] > marks.get(sid, 0):
                pass
            if ev["type"] in watched and not seed_only:
                title = watched[ev["type"]]
                expo_send(tokens, f"Hermes: {title}", summarize(ev))
                print(f"push → {title}: {summarize(ev)[:100]}", flush=True)
                sent += 1
        if isinstance(r.get("latest_seq"), (int, float)) and r["latest_seq"] > marks.get(sid, 0):
            marks[sid] = int(r["latest_seq"])
    return sent


async def amain(args) -> int:
    tokens = [t.strip() for t in args.push_token.split(",") if t.strip()]
    if not tokens:
        print("error: no push token. Get it on the phone: Settings → Get push token.", file=sys.stderr)
        return 1
    if not args.token:
        print("error: no gateway token. Pass --token or set HERMES_DASHBOARD_SESSION_TOKEN.", file=sys.stderr)
        return 1
    scheme = "wss" if args.tls else "ws"
    url = f"{scheme}://{args.host}/api/ws?token={args.token}"
    state = load_state()
    seed_only = not args.reseed and not state.get("seeded")
    if seed_only:
        print("first run: seeding watermarks (no backlog pushes)…", flush=True)
    backoff = 5.0
    gw = Gateway(url)
    try:
        while True:
            try:
                await gw.connect()
                print(f"watching {args.host} (interval {args.interval}s, replies={'on' if args.replies else 'off'})", flush=True)
                backoff = 5.0
                if args.once:
                    await poll_once(gw, state, tokens, args.replies, seed_only)
                    state["seeded"] = True
                    save_state(state)
                    return 0
                while True:
                    n = await poll_once(gw, state, tokens, args.replies, seed_only)
                    seed_only = False
                    state["seeded"] = True
                    save_state(state)
                    if n:
                        print(f"sent {n} push(es)", flush=True)
                    await asyncio.sleep(args.interval)
            except (KeyboardInterrupt, asyncio.CancelledError):
                raise
            except Exception as exc:
                print(f"(warn) connection lost: {exc} — retry in {backoff:.0f}s", flush=True)
                save_state(state)
                await gw.close()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 120.0)
    finally:
        await gw.close()
        save_state(state)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Forward Hermes approvals to your phone via Expo Push.")
    ap.add_argument("--host", default=os.environ.get("HERMES_HOST", "127.0.0.1:9119"))
    ap.add_argument("--token", default=os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", os.environ.get("HERMES_TOKEN", "")))
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--push-token", default=os.environ.get("HERMES_EXPO_PUSH_TOKEN", ""),
                    help="Expo push token from the phone (comma-separated for several devices)")
    ap.add_argument("--interval", type=float, default=15.0, help="poll seconds (default 15)")
    ap.add_argument("--replies", action="store_true", help="also push on every agent reply (noisy)")
    ap.add_argument("--once", action="store_true", help="single poll then exit (dry-run with --push-token bogus)")
    ap.add_argument("--reseed", action="store_true", help="re-seed watermarks silently, then continue")
    args = ap.parse_args()
    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

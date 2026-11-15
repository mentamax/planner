#!/usr/bin/env python3
"""serve.py のテスト。Google のトークン発行は、このファイル内の模擬サーバーに差し替える。

    python3 test_server.py
"""
import http.client
import http.server
import json
import socket
import stat
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

import serve


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeGoogle(http.server.BaseHTTPRequestHandler):
    """トークン発行・取り消しの模擬。受け取った内容を calls に記録する。"""

    calls = []
    refresh_fails = False
    scope = " ".join(serve.SCOPES)

    def log_message(self, *args):
        pass

    def do_POST(self):
        form = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode()).items()}
        FakeGoogle.calls.append((self.path, form))
        status, body = 200, {}
        if self.path == "/token" and form.get("client_secret") != "s3cret":
            status, body = 401, {"error": "invalid_client"}
        elif self.path == "/token" and form.get("grant_type") == "authorization_code":
            if form.get("code") == "good-code":
                body = {"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600, "scope": FakeGoogle.scope}
            else:
                status, body = 400, {"error": "invalid_grant"}
        elif self.path == "/token" and form.get("grant_type") == "refresh_token":
            if FakeGoogle.refresh_fails or form.get("refresh_token") != "refresh-1":
                status, body = 400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
            else:
                n = sum(1 for p, f in FakeGoogle.calls if f.get("grant_type") == "refresh_token")
                body = {"access_token": f"access-refreshed-{n}", "expires_in": 3600}
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ServerTest(unittest.TestCase):
    def setUp(self):
        FakeGoogle.calls = []
        FakeGoogle.refresh_fails = False
        FakeGoogle.scope = " ".join(serve.SCOPES)
        self.google = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeGoogle)
        google_url = f"http://127.0.0.1:{self.google.server_address[1]}"
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "data"
        self.port = free_port()
        self.server = serve.create_server(self.port, self.data_dir, f"{google_url}/token", f"{google_url}/revoke")
        for s in (self.google, self.server):
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def tearDown(self):
        for s in (self.google, self.server):
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    # ---- 補助 ----

    def request(self, method, path, body=None, headers=None, app=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}"}
        if app:
            h["X-Planner"] = "1"
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, json.dumps(body) if body is not None else None, h)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw
        return res.status, data, res.getheader("Location")

    def configure(self):
        return self.request("POST", "/api/auth/config", {"clientId": "client-1", "clientSecret": "s3cret"})

    def login(self, code="good-code"):
        _, _, location = self.request("GET", "/api/auth/start", app=False)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)["state"][0]
        return self.request("GET", f"/api/auth/callback?code={code}&state={state}", app=False)

    # ---- テスト ----

    def test_static_files_and_blocked_paths(self):
        self.assertEqual(self.request("GET", "/", app=False)[0], 200)
        self.assertEqual(self.request("GET", "/js/main.js", app=False)[0], 200)
        for path in ("/serve.py", "/test_server.py", "/.gitignore", "/js/../serve.py", "/%2e%2e/%2e%2e/.config/planner/auth.json"):
            self.assertEqual(self.request("GET", path, app=False)[0], 404, path)

    def test_api_only_answers_this_app(self):
        self.assertEqual(self.request("GET", "/api/auth/status")[0], 200)
        self.assertEqual(self.request("GET", "/api/auth/status", app=False)[0], 403)  # 専用ヘッダーなし
        self.assertEqual(self.request("GET", "/api/auth/status", headers={"Host": "evil.example"})[0], 403)  # DNS リバインディング
        self.assertEqual(self.request("POST", "/api/auth/token", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/token", headers={"Origin": f"http://localhost:{self.port}"})[0], 401)

    def test_config_is_saved_privately_and_never_returned(self):
        status, data, _ = self.request("GET", "/api/auth/status")
        self.assertEqual((data["hasSecret"], data["connected"], data["clientId"]), (False, False, None))
        status, data, _ = self.configure()
        self.assertEqual((status, data["hasSecret"], data["connected"], data["clientId"]), (200, True, False, "client-1"))
        self.assertNotIn("s3cret", json.dumps(data))
        path = self.data_dir / "auth.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    def test_start_requires_secret_and_builds_google_url(self):
        self.assertEqual(self.request("GET", "/api/auth/start", app=False)[2], "/?auth_error=not_configured")
        self.configure()
        status, _, location = self.request("GET", "/api/auth/start", app=False)
        url = urllib.parse.urlsplit(location)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        self.assertEqual((status, f"{url.scheme}://{url.netloc}{url.path}"), (302, serve.AUTH_URL))
        self.assertEqual(q["client_id"], "client-1")
        self.assertEqual(q["redirect_uri"], f"http://localhost:{self.port}/api/auth/callback")
        self.assertEqual((q["response_type"], q["access_type"], q["prompt"]), ("code", "offline", "consent"))
        self.assertEqual(set(q["scope"].split()), set(serve.SCOPES))
        self.assertNotIn("s3cret", location)
        self.assertGreater(len(q["state"]), 20)

    def test_login_stores_refresh_token_and_serves_access_tokens(self):
        self.configure()
        self.assertEqual(self.login()[2], "/?auth=ok")
        path, form = FakeGoogle.calls[0]
        self.assertEqual((form["code"], form["client_id"], form["client_secret"]), ("good-code", "client-1", "s3cret"))
        self.assertEqual(form["redirect_uri"], f"http://localhost:{self.port}/api/auth/callback")
        self.assertTrue(self.request("GET", "/api/auth/status")[1]["connected"])

        status, data, _ = self.request("POST", "/api/auth/token")
        self.assertEqual((status, data["accessToken"]), (200, "access-1"))
        self.assertGreater(data["expiresIn"], 3000)
        self.assertEqual(len(FakeGoogle.calls), 1)  # まだ有効なので取り直さない

        # 期限が近づいたら、ユーザーの操作なしで取り直す
        self.server.auth.access = ("access-1", 0)
        self.assertEqual(self.request("POST", "/api/auth/token")[1]["accessToken"], "access-refreshed-1")
        self.assertEqual(FakeGoogle.calls[1][1]["refresh_token"], "refresh-1")

        # サーバーを再起動しても接続は続く
        self.server.auth.access = None
        self.assertEqual(self.request("POST", "/api/auth/token")[0], 200)

    def test_state_cannot_be_forged_or_reused(self):
        self.configure()
        self.assertEqual(self.request("GET", "/api/auth/callback?code=good-code&state=forged", app=False)[2], "/?auth_error=state")
        _, _, location = self.request("GET", "/api/auth/start", app=False)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)["state"][0]
        self.assertEqual(self.request("GET", f"/api/auth/callback?code=good-code&state={state}", app=False)[2], "/?auth=ok")
        self.assertEqual(self.request("GET", f"/api/auth/callback?code=good-code&state={state}", app=False)[2], "/?auth_error=state")

    def test_login_failures(self):
        self.configure()
        _, _, location = self.request("GET", "/api/auth/start", app=False)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)["state"][0]
        self.assertEqual(self.request("GET", f"/api/auth/callback?error=access_denied&state={state}", app=False)[2], "/?auth_error=denied")
        self.assertEqual(self.login("bad-code")[2], "/?auth_error=invalid_grant")
        FakeGoogle.scope = serve.SCOPES[0]  # ToDo リストの許可を外された
        self.assertEqual(self.login()[2], "/?auth_error=scope")
        self.assertFalse(self.request("GET", "/api/auth/status")[1]["connected"])

        self.request("POST", "/api/auth/config", {"clientId": "client-1", "clientSecret": "wrong"})
        self.assertEqual(self.login()[2], "/?auth_error=invalid_client")

    def test_expired_refresh_token_asks_to_reconnect(self):
        self.configure()
        self.login()
        self.server.auth.access = None
        FakeGoogle.refresh_fails = True
        status, data, _ = self.request("POST", "/api/auth/token")
        self.assertEqual((status, data["error"]), (401, "reauth"))
        status = self.request("GET", "/api/auth/status")[1]
        self.assertEqual((status["connected"], status["hasSecret"]), (False, True))  # シークレットは残す

    def test_disconnect_revokes_and_keeps_secret(self):
        self.configure()
        self.login()
        status = self.request("POST", "/api/auth/disconnect")[1]
        self.assertEqual((status["connected"], status["hasSecret"]), (False, True))
        self.assertEqual(FakeGoogle.calls[-1], ("/revoke", {"token": "refresh-1"}))
        self.assertEqual(self.request("POST", "/api/auth/token")[0], 401)

    def test_removing_secret_forgets_everything(self):
        self.configure()
        self.login()
        status = self.request("POST", "/api/auth/config", {"clientId": "client-1", "clientSecret": ""})[1]
        self.assertEqual((status["connected"], status["hasSecret"], status["clientId"]), (False, False, None))
        self.assertFalse((self.data_dir / "auth.json").exists())
        self.assertEqual(FakeGoogle.calls[-1][0], "/revoke")

    def test_changing_client_drops_old_connection(self):
        self.configure()
        self.login()
        status = self.request("POST", "/api/auth/config", {"clientId": "client-2", "clientSecret": "s3cret"})[1]
        self.assertEqual((status["connected"], status["clientId"]), (False, "client-2"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

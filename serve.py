#!/usr/bin/env python3
"""Planner のローカルサーバー。

    python3 serve.py [port]        → http://localhost:5173

アプリのファイルを配信するほかに、Google との接続を保つための小さな API を持つ。
クライアントシークレットと更新用トークンはこの Mac の中（既定では ~/.config/planner/auth.json、
自分だけが読める権限）に保存し、ブラウザには短時間だけ有効なアクセストークンしか渡さない。
"""
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "web"  # アプリ本体（このフォルダだけを配信する）
DEFAULT_DATA_DIR = Path.home() / ".config" / "planner"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
SCOPES = (
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/drive.appdata",  # メモの同期用（このアプリ専用の隠し領域だけ）
)
STATE_TTL = 600  # ログイン画面を開いてから戻ってくるまでの猶予（秒）


class AuthError(Exception):
    """code は画面側でメッセージに変換する短い識別子。"""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


class GoogleAuth:
    """OAuth の認可コード方式。更新用トークンをファイルに保管し、アクセストークンを発行する。"""

    def __init__(self, port, data_dir=DEFAULT_DATA_DIR, token_url=TOKEN_URL, revoke_url=REVOKE_URL):
        self.redirect_uri = f"http://localhost:{port}/api/auth/callback"
        self.path = Path(data_dir) / "auth.json"
        self.token_url = token_url
        self.revoke_url = revoke_url
        self.lock = threading.RLock()
        self.pending = {}  # state → 有効期限
        self.access = None  # (アクセストークン, 有効期限)

    # ---- 保存 ----

    def _load(self):
        try:
            data = json.loads(self.path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)

    # ---- 状態と設定 ----

    def status(self):
        """画面に返す状態。シークレットやトークンそのものは決して含めない。"""
        d = self._load()
        return {
            "backend": True,
            "hasSecret": bool(d.get("client_id") and d.get("client_secret")),
            "connected": bool(d.get("refresh_token")),
            "clientId": d.get("client_id") or None,
            "redirectUri": self.redirect_uri,
        }

    def configure(self, client_id, client_secret):
        """クライアント ID とシークレットを保存する。シークレットが空なら保存内容をすべて消す。"""
        with self.lock:
            d = self._load()
            if not client_id or not client_secret:
                self._revoke(d.get("refresh_token"))
                self.access = None
                try:
                    self.path.unlink()
                except OSError:
                    pass
                return
            if d.get("client_id") != client_id or d.get("client_secret") != client_secret:
                # 別のクライアントになったら、以前の接続は使えない
                d = {"client_id": client_id, "client_secret": client_secret}
                self.access = None
            self._save(d)

    # ---- ログイン ----

    def start_url(self):
        with self.lock:
            d = self._load()
            if not (d.get("client_id") and d.get("client_secret")):
                raise AuthError("not_configured")
            now = time.time()
            self.pending = {s: exp for s, exp in self.pending.items() if exp > now}
            state = secrets.token_urlsafe(24)
            self.pending[state] = now + STATE_TTL
        query = urllib.parse.urlencode(
            {
                "client_id": d["client_id"],
                "redirect_uri": self.redirect_uri,
                "response_type": "code",
                "scope": " ".join(SCOPES),
                "access_type": "offline",  # 更新用トークンを受け取る
                "prompt": "consent",  # 接続し直すたびに更新用トークンを必ず受け取る
                "state": state,
            }
        )
        return f"{AUTH_URL}?{query}"

    def finish(self, params):
        """Google から戻ってきたときの処理。成功すれば更新用トークンを保存する。"""
        with self.lock:
            state = params.get("state", "")
            expiry = self.pending.pop(state, 0)
            if expiry < time.time():
                raise AuthError("state")  # 身に覚えのない、または古いログイン
            if params.get("error"):
                raise AuthError("denied" if params["error"] == "access_denied" else "google", params["error"])
            if not params.get("code"):
                raise AuthError("google", "no code")
            d = self._load()
            tokens = self._post(
                self.token_url,
                {
                    "grant_type": "authorization_code",
                    "code": params["code"],
                    "client_id": d.get("client_id", ""),
                    "client_secret": d.get("client_secret", ""),
                    "redirect_uri": self.redirect_uri,
                },
            )
            if not set(SCOPES) <= set(str(tokens.get("scope", "")).split()):
                raise AuthError("scope")  # カレンダーか ToDo の許可が外されている
            if not tokens.get("refresh_token") or not tokens.get("access_token"):
                raise AuthError("no_refresh")
            d["refresh_token"] = tokens["refresh_token"]
            self._save(d)
            self._remember(tokens)

    def _remember(self, tokens):
        self.access = (tokens["access_token"], time.time() + float(tokens.get("expires_in", 3600)))

    # ---- アクセストークン ----

    def access_token(self):
        """(アクセストークン, 残り秒数) を返す。必要なら更新用トークンで取り直す。"""
        with self.lock:
            now = time.time()
            if self.access and self.access[1] - now > 120:
                return self.access[0], int(self.access[1] - now)
            d = self._load()
            if not d.get("refresh_token"):
                raise AuthError("reauth")
            try:
                tokens = self._post(
                    self.token_url,
                    {
                        "grant_type": "refresh_token",
                        "refresh_token": d["refresh_token"],
                        "client_id": d.get("client_id", ""),
                        "client_secret": d.get("client_secret", ""),
                    },
                )
            except AuthError as e:
                if e.code == "invalid_grant":
                    # 期限切れ・取り消し済み。もう使えないので捨てて、接続し直してもらう
                    d.pop("refresh_token", None)
                    self._save(d)
                    self.access = None
                    raise AuthError("reauth") from e
                raise
            if not tokens.get("access_token"):
                raise AuthError("google", "no access token")
            self._remember(tokens)
            return self.access[0], int(self.access[1] - time.time())

    def disconnect(self):
        """接続を解除する。Google 側の許可も取り消す（失敗しても手元の情報は消す）。"""
        with self.lock:
            d = self._load()
            self._revoke(d.pop("refresh_token", None))
            self.access = None
            if d:
                self._save(d)

    def _revoke(self, token):
        if not token:
            return
        try:
            self._post(self.revoke_url, {"token": token})
        except AuthError:
            pass

    @staticmethod
    def _post(url, params):
        req = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(params).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read() or b"{}")
            except ValueError:
                body = {}
            raise AuthError(str(body.get("error") or f"http_{e.code}"), str(body.get("error_description", ""))) from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise AuthError("network", str(e)) from e


def static_allowed(path):
    """アプリのファイルだけを配信する（隠しファイルやサーバーのコードは出さない）。"""
    parts = [p for p in urllib.parse.unquote(path).split("/") if p]
    return not any(p.startswith(".") or p == "__pycache__" or p.endswith(".py") for p in parts)


def make_handler(auth, port):
    allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
    allowed_origins = {f"http://{h}" for h in allowed_hosts}

    class Handler(http.server.SimpleHTTPRequestHandler):
        server_version = "Planner"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def end_headers(self):
            # 更新したファイルが古いキャッシュのまま読まれないようにする
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_request(self, code="-", size="-"):
            # ログイン直後の URL には認可コードが載るので、ログにはパスだけを残す
            path = urllib.parse.urlsplit(self.path).path
            self.log_message('"%s %s" %s', self.command, path, str(code))

        # ---- 振り分け ----

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path.startswith("/api/"):
                return self._api("GET", url)
            if not static_allowed(url.path):
                return self.send_error(404)
            return super().do_GET()

        def do_HEAD(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path.startswith("/api/") or not static_allowed(url.path):
                return self.send_error(404)
            return super().do_HEAD()

        def do_POST(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path.startswith("/api/"):
                return self._api("POST", url)
            return self.send_error(405)

        # ---- API ----

        def _api(self, method, url):
            # このサーバー宛ての、このアプリからの呼び出しだけを受け付ける
            # （別のサイトが localhost を叩いてトークンを引き出すのを防ぐ）
            if self.headers.get("Host") not in allowed_hosts:
                return self._json(403, {"error": "host"})
            origin = self.headers.get("Origin")
            if origin and origin not in allowed_origins:
                return self._json(403, {"error": "origin"})
            route = (method, url.path)

            # ログインの行き帰りはブラウザのページ移動なので、ヘッダーは付けられない
            if route == ("GET", "/api/auth/start"):
                try:
                    return self._redirect(auth.start_url())
                except AuthError as e:
                    return self._redirect(f"/?auth_error={urllib.parse.quote(e.code)}")
            if route == ("GET", "/api/auth/callback"):
                params = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
                try:
                    auth.finish(params)
                    return self._redirect("/?auth=ok")
                except AuthError as e:
                    return self._redirect(f"/?auth_error={urllib.parse.quote(e.code)}")

            if self.headers.get("X-Planner") != "1":
                return self._json(403, {"error": "header"})
            if route == ("GET", "/api/auth/status"):
                return self._json(200, auth.status())
            if route == ("POST", "/api/auth/config"):
                body = self._body()
                if body is None:
                    return self._json(400, {"error": "body"})
                auth.configure(str(body.get("clientId") or "").strip(), str(body.get("clientSecret") or "").strip())
                return self._json(200, auth.status())
            if route == ("POST", "/api/auth/token"):
                try:
                    token, ttl = auth.access_token()
                    return self._json(200, {"accessToken": token, "expiresIn": ttl})
                except AuthError as e:
                    return self._json(401 if e.code == "reauth" else 502, {"error": e.code, "detail": e.detail})
            if route == ("POST", "/api/auth/disconnect"):
                auth.disconnect()
                return self._json(200, auth.status())
            return self._json(404, {"error": "not_found"})

        def _body(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 65536:
                    return None
                data = json.loads(self.rfile.read(length))
                return data if isinstance(data, dict) else None
            except ValueError:
                return None

        def _json(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _redirect(self, location):
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return Handler


def create_server(port, data_dir=None, token_url=TOKEN_URL, revoke_url=REVOKE_URL):
    data_dir = data_dir or os.environ.get("PLANNER_DATA_DIR") or DEFAULT_DATA_DIR
    auth = GoogleAuth(port, data_dir, token_url, revoke_url)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(auth, port))
    server.auth = auth
    return server


if __name__ == "__main__":
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 5173))
    httpd = create_server(PORT)
    print(f"Planner: http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

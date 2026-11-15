// 同梱サーバー（serve.py）の認証 API を呼ぶ。
// サーバーが更新用トークンを保管するので、この方式で接続すると 1 時間ごとの再接続が要らなくなる。
// 別の静的サーバーでアプリを開いた場合は API が無いので、fetchStatus() が null を返す。

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Planner': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || `サーバーエラー (${res.status})`);
    err.code = data?.error || `http_${res.status}`;
    throw err;
  }
  return data;
}

/** { hasSecret, connected, clientId, redirectUri } または null（API なし） */
export async function fetchStatus() {
  // 同梱サーバーはこの Mac の中でしか動かない。インターネット上に置いた版では問い合わせない
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  try {
    const data = await call('/api/auth/status');
    return data?.backend ? data : null;
  } catch {
    return null;
  }
}

/** シークレットを保存する。clientSecret が空なら保存済みの情報をすべて消す */
export const saveConfig = (clientId, clientSecret) => call('/api/auth/config', { method: 'POST', body: { clientId, clientSecret } });

/** { accessToken, expiresIn }。接続し直しが必要なときは code === 'reauth' のエラー */
export const fetchToken = () => call('/api/auth/token', { method: 'POST' });

export const disconnect = () => call('/api/auth/disconnect', { method: 'POST' });

/** Google のログイン画面へ移動する URL（ページごと移動し、終わるとアプリに戻ってくる） */
export const START_URL = '/api/auth/start';

/** ログインから戻ってきたときに URL に付くエラーの説明 */
export const AUTH_ERRORS = {
  not_configured: 'クライアントシークレットが保存されていません',
  state: 'ログインの有効期限が切れました。もう一度接続してください',
  denied: 'アクセスが許可されませんでした',
  scope: 'カレンダーと ToDo リストの両方へのアクセスを許可してください',
  invalid_client: 'クライアント ID かクライアントシークレットが正しくありません',
  invalid_grant: 'ログインをやり直してください（認可コードが無効でした）',
  redirect_uri_mismatch: 'Google Cloud の「承認済みのリダイレクト URI」が登録されていません',
  no_refresh: 'Google から更新用トークンを受け取れませんでした。もう一度接続してください',
  network: 'Google に接続できませんでした（ネットワークを確認してください）',
};

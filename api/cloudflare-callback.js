const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const SITE = "https://channelpilot.indevs.in";
const REDIRECT = SITE + "/api/cloudflare-callback";

function sbHeaders(extra) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: k, "Content-Type": "application/json", ...(extra || {}) };
  if (k.startsWith("eyJ")) h.Authorization = "Bearer " + k;
  return h;
}

module.exports = async (req, res) => {
  const done = (result) => {
    res.statusCode = 302;
    res.setHeader("Location", SITE + "/generator.html?cf=" + result);
    res.end();
  };
  try {
    const SB = process.env.SUPABASE_URL.replace(/\/$/, "");
    const { code, state, error } = req.query || {};
    if (error || !code || !state) return done("error");

    // Validate and consume the one-time state
    const st = encodeURIComponent(state);
    const q = await fetch(`${SB}/rest/v1/cf_oauth_states?state=eq.${st}&select=user_id,created_at`, { headers: sbHeaders() });
    const rows = await q.json();
    if (!Array.isArray(rows) || !rows.length) return done("error");
    await fetch(`${SB}/rest/v1/cf_oauth_states?state=eq.${st}`, { method: "DELETE", headers: sbHeaders() });
    if (Date.now() - new Date(rows[0].created_at).getTime() > 15 * 60 * 1000) return done("error");
    const userId = rows[0].user_id;

    // Swap the code for tokens
    const id = process.env.CF_CLIENT_ID, secret = process.env.CF_CLIENT_SECRET;
    const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT };
    let t = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded",
                 Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64") },
      body: new URLSearchParams(form),
    });
    if (t.status === 401) {
      t = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, client_id: id, client_secret: secret }),
      });
    }
    if (!t.ok) return done("error");
    const tok = await t.json();
    if (!tok.access_token || !tok.refresh_token) return done("error");

    // Find the account the customer authorized
    const a = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: "Bearer " + tok.access_token },
    });
    const acc = await a.json();
    const accountId = acc && acc.result && acc.result[0] && acc.result[0].id;
    if (!a.ok || !accountId) return done("error");

    // Save the connection
    const s = await fetch(`${SB}/rest/v1/cloudflare_connections?on_conflict=user_id`, {
      method: "POST",
      headers: sbHeaders({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({ user_id: userId, account_id: accountId, refresh_token: tok.refresh_token,
                             needs_reconnect: false, connected_at: new Date().toISOString() }),
    });
    if (!s.ok) return done("error");
    return done("connected");
  } catch (e) {
    console.error(e);
    return done("error");
  }
};
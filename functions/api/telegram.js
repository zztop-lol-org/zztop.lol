// POST /api/telegram  — Telegram webhook for approve/reject.
// Fast-ack (answer the callback + 200 immediately) then do the slow getFile ->
// getxapi post inside waitUntil, so Telegram never retries and compounds races.
// Idempotency: guard status==pending, strip buttons on first tap.

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function tg(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
}
const answer = (env, cbId, text) => tg(env, "answerCallbackQuery", { callback_query_id: cbId, text });
const actionKb = (id) => ({ inline_keyboard: [[{ text: "🔁 Retry", callback_data: "ok:" + id }, { text: "❌ Cancel", callback_data: "no:" + id }]] });
const sendAction = (env, text, id) => tg(env, "sendMessage", { chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text: text, reply_markup: actionKb(id) });
const stripButtons = (env, chatId, msgId) => tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
const note = (env, text) => tg(env, "sendMessage", { chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text });

async function tgDownload(env, fileId) {
  const meta = await tg(env, "getFile", { file_id: fileId });
  if (!meta.ok) throw new Error("getFile failed");
  // NOTE: this URL embeds the bot token — never log it.
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("file download " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function getxapiCreate(env, text, mediaArr) {
  const payload = {
    auth_token: env.GETXAPI_AUTH_TOKEN,
    ct0: env.GETXAPI_CT0,
    twid: env.GETXAPI_TWID,
    text,
  };
  if (mediaArr) payload.media = mediaArr;
  if (env.GETXAPI_PROXY) payload.proxy = env.GETXAPI_PROXY;
  if (env.GETXAPI_COMMUNITY_ID) payload.community_id = env.GETXAPI_COMMUNITY_ID;
  let r;
  try {
    r = await fetch("https://api.getxapi.com/twitter/tweet/create", {
      method: "POST",
      headers: { authorization: `Bearer ${env.GETXAPI_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (netErr) { const e = new Error("network error reaching getxapi"); e.retryable = true; throw e; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 502) { const e = new Error("getxapi 502 — outcome unconfirmed"); e.unconfirmed = true; throw e; }
  if (!r.ok) {
    const e = new Error(`getxapi ${r.status}: ${j.error || "post failed"}`);
    if (r.status === 401) e.authDead = true;   // token expired -> re-login needed
    else e.retryable = true;                     // 429 / 423 / 5xx / throttle -> safe to retry
    throw e;
  }
  const id = j.id || j.tweet_id || (j.data && j.data.id) || null;
  const url = id && env.GETXAPI_HANDLE ? `https://x.com/${env.GETXAPI_HANDLE}/status/${id}` : null;
  return { id, url };
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
    return new Response("unauthorized", { status: 401 });

  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }
  const cq = update.callback_query;
  if (!cq || !cq.data) return json({ ok: true }); // ignore anything that isn't a button tap

  // admin allowlist: the PERSON who tapped, not just the chat
  const fromId = String(cq.from && cq.from.id);
  const allowed = (env.TELEGRAM_ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(fromId)) { waitUntil(answer(env, cq.id, "not authorized")); return json({ ok: true }); }

  const [action, id] = cq.data.split(":");
  const chatId = cq.message.chat.id, msgId = cq.message.message_id;

  waitUntil((async () => {
    await answer(env, cq.id, action === "ok" ? "posting…" : "rejecting…");
    const rec = JSON.parse((await env.TWEETS.get(`tw:${id}`)) || "null");
    if (!rec || rec.status !== "pending") return; // idempotency: already handled
    await stripButtons(env, chatId, msgId);

    if (action === "no") {
      rec.status = "rejected";
      await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 86400 });
      await tg(env, "sendMessage", { chat_id: chatId, reply_to_message_id: msgId, text: "❌ rejected" });
      return;
    }
    if (action !== "ok") return;

    rec.status = "posting";
    await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec));
    try {
      let mediaArr;
      if (rec.file_id) {
        const bytes = await tgDownload(env, rec.file_id);
        mediaArr = [{ data: bytesToB64(bytes), type: rec.mediaType }];
      }
      const res = await getxapiCreate(env, rec.text, mediaArr);
      rec.status = "posted"; rec.url = res.url;
      await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 86400 * 30 });
      await tg(env, "sendMessage", { chat_id: chatId, reply_to_message_id: msgId, text: "✅ posted" + (res.url ? " " + res.url : " (no url returned)") });
    } catch (e) {
      if (e.unconfirmed) {
        // 502: X may have posted — do NOT auto-offer retry
        rec.status = "unconfirmed";
        await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 86400 });
        await note(env, `⚠ unconfirmed (getxapi 502): the tweet MAY have posted. Check @${env.GETXAPI_HANDLE || "the account"} on X before retrying.`);
      } else {
        // retryable (429/throttle/network) or auth-dead: reset to pending, offer Retry / Cancel
        rec.status = "pending";
        await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 7 });
        const extra = e.authDead ? "\n(auth token may be expired — a re-login may be needed)" : "";
        await sendAction(env, `⚠ post failed: ${e.message}${extra}\n\nretry or cancel?`, id);
      }
    }
  })());

  return json({ ok: true });
}

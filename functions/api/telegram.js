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

const adminIds = (env) => (env.TELEGRAM_ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// --- /tweets report -------------------------------------------------------
// Admin-only CSV of posted tweets grouped by submitter address. Each call
// remembers when it ran, so the next one only reports what landed since.
const REPORT_CURSOR_KEY = "report:tweets_last_ts";

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function tgSendDoc(env, chatId, filename, content, caption) {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("caption", caption);
  fd.set("document", new Blob([content], { type: "text/csv" }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  return r.json();
}

async function sendTweetReport(env, chatId, all) {
  const now = Math.floor(Date.now() / 1000);
  const since = all ? 0 : parseInt((await env.TWEETS.get(REPORT_CURSOR_KEY)) || "0", 10);

  const rows = [];
  let cursor, done = false;
  while (!done) {
    const page = await env.TWEETS.list({ prefix: "tw:", cursor });
    for (const k of page.keys) {
      const rec = JSON.parse((await env.TWEETS.get(k.name)) || "null");
      if (!rec || rec.status !== "posted" || !rec.url) continue;
      if (rec.ts <= since) continue;
      rows.push(rec);
    }
    done = page.list_complete;
    cursor = page.cursor;
  }
  rows.sort((a, b) => a.ts - b.ts);

  const byAddr = new Map();
  for (const r of rows) {
    if (!byAddr.has(r.inj)) byAddr.set(r.inj, []);
    byAddr.get(r.inj).push(r.url);
  }

  const stamp = (t) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const window = all ? "all time" : since ? `since ${stamp(since)}` : "all time (first run)";

  if (!rows.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `no new posted tweets ${window}` });
  } else {
    const csv = ["addr,tweets", ...[...byAddr].map(([a, urls]) => `${a},${csvCell(urls.join(" "))}`)].join("\n");
    const name = `zztop-tweets-${new Date(now * 1000).toISOString().slice(0, 10)}.csv`;
    await tgSendDoc(env, chatId, name, csv, `${byAddr.size} address(es), ${rows.length} tweet(s) — ${window}`);
  }
  // only the cursored variant advances it, so `/tweets all` stays repeatable
  if (!all) await env.TWEETS.put(REPORT_CURSOR_KEY, String(now));
}

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
// detect the real MIME from magic bytes — Telegram converts GIFs to MP4, so the
// stored mediaType can be wrong; X's upload rejects a mismatched type.
function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";        // GIF8
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";        // \x89PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";                        // FFD8FF
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp"; // RIFF..WEBP
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";       // ....ftyp
  return null;
}

// upload image/gif/video and get a media_id. Videos go through getxapi's
// chunked INIT->APPEND->FINALIZE + processing wait server-side.
async function getxapiUpload(env, mediaData, mediaType) {
  const payload = { auth_token: env.GETXAPI_AUTH_TOKEN, ct0: env.GETXAPI_CT0, twid: env.GETXAPI_TWID, media_data: mediaData, media_type: mediaType };
  if (env.GETXAPI_PROXY) payload.proxy = env.GETXAPI_PROXY;
  let r;
  try {
    r = await fetch("https://api.getxapi.com/twitter/media/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${env.GETXAPI_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (netErr) { const e = new Error("network error uploading media"); e.retryable = true; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`media upload ${r.status}: ${j.error || "failed"}`); if (r.status === 401) e.authDead = true; else e.retryable = true; throw e; } // no tweet yet -> always safe to retry
  const mid = j.media_id || (j.data && j.data.media_id);
  if (!mid) { const e = new Error("no media_id returned"); e.retryable = true; throw e; }
  return mid;
}

// X rejects some media only at create time (too-short GIF, unrecognised type...).
// The post itself is still fine, so we retry without the attachment.
const MEDIA_REJECTED = /duration too short|media type unrecognized|invalid media|unsupported media|mediaid/i;

async function getxapiCreate(env, text, mediaIds) {
  const payload = {
    auth_token: env.GETXAPI_AUTH_TOKEN,
    ct0: env.GETXAPI_CT0,
    twid: env.GETXAPI_TWID,
    text,
  };
  if (mediaIds && mediaIds.length) payload.media_ids = mediaIds;
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


// --- /burnt ---------------------------------------------------------------
// Public. How much ZZTOP the buyback has taken out of supply, read from the
// chain rather than from any record we keep: total supply only ever falls, and
// the launch minted a round billion, so the difference is the burn.
const ZZTOP_DENOM = "factory/inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte/shroom_157_99c09d972f9c1f79";
const ZZTOP_INITIAL = 1000000000000000000000000000n; // 1,000,000,000 at 18 decimals
const ZZTOP_LCDS = [
  "https://sentry.lcd.injective.network",
  "https://injective-rest.publicnode.com",
  "https://injective-api.polkachu.com",
];

// Thousands separators and a fixed number of decimals, done in BigInt. An
// 18-decimal supply does not survive a float: 999,998,160.74 tokens is already
// past the point where Number starts rounding the ones column.
function formatUnits(wei, dp) {
  const unit = 10n ** 18n;
  const whole = (wei / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (dp <= 0) return whole;
  const frac = (wei % unit).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
}

// Percent to six places, kept as an integer scaled by a million so nothing is
// lost on the way. A burn too small to show at that precision reports as less
// than the smallest figure rather than as zero — "0.0%" would be a lie about
// something that did happen.
function formatPercent(part, whole) {
  if (whole === 0n || part === 0n) return "0.0";
  const scaled = (part * 100n * 1000000n) / whole;
  if (scaled === 0n) return "<0.000001";
  const s = scaled.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, ".0");
}

async function zztopSupply() {
  let lastErr;
  for (const base of ZZTOP_LCDS) {
    try {
      const r = await fetch(`${base}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(ZZTOP_DENOM)}`, {
        headers: { accept: "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const amount = j && j.amount && j.amount.amount;
      if (!amount) throw new Error("no amount in response");
      return BigInt(amount);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no endpoint answered");
}

async function sendBurnt(env, chatId) {
  let supply;
  try {
    supply = await zztopSupply();
  } catch {
    return tg(env, "sendMessage", { chat_id: chatId, text: "could not reach the chain just now — try again in a moment" });
  }

  const burned = ZZTOP_INITIAL > supply ? ZZTOP_INITIAL - supply : 0n;
  const text = [
    "🔥 <b>" + formatUnits(burned, 2) + " ZZTOP</b> burned",
    "",
    formatPercent(burned, ZZTOP_INITIAL) + "% of the 1,000,000,000 minted at launch",
    "<code>" + formatUnits(supply, 2) + "</code> still in supply",
    "",
    "<i>the buyback buys ZZTOP with INJ and burns every token it gets</i>",
  ].join("\n");

  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
    return new Response("unauthorized", { status: 401 });

  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }
  // /tweets [all] — admin-only CSV export. Silent for everyone else so the bot
  // gives nothing away to strangers who poke at it.
  const msg = update.message;
  if (msg && typeof msg.text === "string") {
    const [cmd, ...args] = msg.text.trim().split(/\s+/);
    if (cmd.split("@")[0] === "/burnt") {
      waitUntil(sendBurnt(env, msg.chat.id));
      return json({ ok: true });
    }
    if (cmd.split("@")[0] === "/tweets") {
      if (!adminIds(env).includes(String(msg.from && msg.from.id))) return json({ ok: true });
      waitUntil(sendTweetReport(env, msg.chat.id, args.some((a) => a.toLowerCase() === "all")));
      return json({ ok: true });
    }
  }

  const cq = update.callback_query;
  if (!cq || !cq.data) return json({ ok: true }); // ignore anything that isn't a button tap

  // admin allowlist: the PERSON who tapped, not just the chat
  const fromId = String(cq.from && cq.from.id);
  const allowed = adminIds(env);
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
      let mediaIds;
      if (rec.file_id) {
        const bytes = await tgDownload(env, rec.file_id);
        const mtype = sniffMime(bytes) || rec.mediaType; // real bytes win (Telegram may have transcoded)
        const mid = await getxapiUpload(env, bytesToB64(bytes), mtype);
        mediaIds = [mid];
      }
      let res, droppedMedia = null;
      try {
        res = await getxapiCreate(env, rec.text, mediaIds);
      } catch (e) {
        if (!mediaIds || !MEDIA_REJECTED.test(e.message || "")) throw e;
        droppedMedia = e.message;                       // post the words, lose the attachment
        res = await getxapiCreate(env, rec.text, undefined);
      }
      rec.status = "posted"; rec.url = res.url;
      if (droppedMedia) rec.mediaDropped = droppedMedia;
      await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 86400 * 30 });
      const okText = "✅ posted" + (res.url ? " " + res.url : " (no url returned)") +
        (droppedMedia ? "\n⚠ attachment dropped — X rejected it: " + droppedMedia : "");
      await tg(env, "sendMessage", { chat_id: chatId, reply_to_message_id: msgId, text: okText });
      // also send the confirmation to the community group, with the submitter as an injscan link
      if (env.TELEGRAM_ANNOUNCE_CHAT_ID) {
        const groupText = `${okText}\nby <a href="https://injscan.com/account/${rec.inj}">${rec.inj}</a>`;
        await tg(env, "sendMessage", { chat_id: env.TELEGRAM_ANNOUNCE_CHAT_ID, text: groupText, parse_mode: "HTML" });
      }
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

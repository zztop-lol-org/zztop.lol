// POST /api/submit
// Verify EIP-191 signature + timestamp freshness + ZZ balance, then push the
// tweet to the admin's Telegram for approval and store it pending in KV.
// Best-effort auth per product decision (2026-09-04): signed message is the fixed
// "zzzz confirming it's you\n<unix_ts>"; freshness is the only replay guard.
import { recoverEthAddress, ethToInj, zzBalanceRaw, meetsThreshold } from "../_lib/crypto.js";

const MSG_PREFIX = "zzzz confirming it's you";
const TS_WINDOW = 600;                 // 10 min freshness
const MAX_TEXT = 280;                   // loose; X uses weighted counting, handled on post
const MAX_MEDIA = 18 * 1024 * 1024;     // getFile hard-stops at 20MiB — stay under
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4" };
const RATE_PER_HOUR = 3;
const CTRL = /[​-‏‪-‮⁦-⁩]/; // zero-width / bidi

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// A submission that is nothing but a link to an X post is a repost, not a new
// tweet: approving it retweets the original instead of writing our own copy of
// it. With words around the link there is something of the submitter's worth
// keeping, so that becomes a quote.
const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?|i\/web\/status)\/(\d{5,25})(?:[/?#]\S*)?$/i;

function classify(text, hasMedia) {
  const words = text.trim().split(/\s+/);
  let srcId = null, link = null;
  for (const w of words) {
    const m = w.match(X_STATUS);
    if (m) { srcId = m[1]; link = w; break; }
  }
  if (!srcId) return { kind: "post" };
  // a retweet carries nothing of its own, so an attachment means they meant to post
  if (hasMedia) return { kind: "post" };
  const rest = words.filter((w) => w !== link).join(" ").trim();
  // the quoted tweet renders as its own card, so the bare url would just be noise
  return rest ? { kind: "quote", srcId, text: rest } : { kind: "repost", srcId };
}

// Best-effort look at what is being amplified. Without it the reviewer approves a
// bare url that says nothing about its contents, which is the one case where
// reading a submission before tapping matters most. Never blocks a submission.
async function xDetail(env, id) {
  try {
    const r = await fetch(`https://api.getxapi.com/twitter/tweet/detail?id=${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${env.GETXAPI_TOKEN}` } });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => ({}))).data;
    if (!d) return null;
    const url = d.url || `https://x.com/i/web/status/${id}`;
    return { url, author: (url.match(/\.com\/([A-Za-z0-9_]{1,15})\/status/) || [])[1] || null, text: d.text || "" };
  } catch { return null; }
}

function buildCaption(text, inj, eth) {
  const warn = CTRL.test(text) ? "⚠ contains hidden/bidi characters — read carefully\n\n" : "";
  return `${warn}${text}\n\n— from ${inj}\n${eth}`;
}

// Retweeting has no community_id — the endpoint takes none and X has no such
// action — so a repost lands on the main timeline while an ordinary post goes to
// the community. Say that on the card rather than let it surprise someone later.
function buildShareCaption(cls, meta, inj, eth, handle) {
  const own = handle && meta && meta.author && meta.author.toLowerCase() === String(handle).toLowerCase();
  const lines = [cls.kind === "repost" ? "🔁 REPOST → main timeline, not the community" : "💬 QUOTE"];
  if (own) lines.push("⚠ this is our own post");
  if (meta) lines.push("", `@${meta.author || "?"}: ${meta.text}`, meta.url);
  else lines.push("", "⚠ could not read that tweet — deleted, private, or a bad id",
                  `https://x.com/i/web/status/${cls.srcId}`);
  if (cls.kind === "quote") {
    if (CTRL.test(cls.text)) lines.push("", "⚠ our words contain hidden/bidi characters — read carefully");
    lines.push("", `our words: ${cls.text}`);
  }
  lines.push("", `— from ${inj}`, eth);
  return lines.join("\n");
}

async function tgSend(env, id, caption, bytes, type, ext, label) {
  const kb = { inline_keyboard: [[{ text: label || "✅ Post", callback_data: "ok:" + id }, { text: "❌ Reject", callback_data: "no:" + id }]] };
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  if (bytes) {
    const fd = new FormData();
    fd.set("chat_id", env.TELEGRAM_ADMIN_CHAT_ID);
    fd.set("caption", caption);
    fd.set("reply_markup", JSON.stringify(kb));
    fd.set("document", new Blob([bytes], { type }), `zz_${id}.${ext}`); // document preserves exact bytes
    const r = await fetch(`${base}/sendDocument`, { method: "POST", body: fd });
    const j = await r.json();
    if (!j.ok) throw new Error("tg sendDocument failed");
    // Telegram returns the file under document for images but video/animation/audio
    // for those types even when sent via sendDocument — grab whichever is present.
    const m = j.result;
    const media = m.document || m.video || m.animation || m.audio || (m.photo && m.photo[m.photo.length - 1]);
    return media ? media.file_id : null;
  } else {
    const r = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text: caption, reply_markup: kb }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error("tg sendMessage failed");
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const { address, signature, ts, text, media } = body || {};

  // 1) timestamp freshness (best-effort replay guard)
  const now = Math.floor(Date.now() / 1000);
  if (!ts || !Number.isFinite(Number(ts)) || Math.abs(now - Number(ts)) > TS_WINDOW)
    return json({ error: "stale or missing timestamp — reconnect and sign again" }, 400);

  // 2) signature -> address, must match claimed address
  const message = `${MSG_PREFIX}\n${ts}`;
  const recovered = recoverEthAddress(message, signature || "");
  if (!recovered || !address || recovered.toLowerCase() !== String(address).toLowerCase())
    return json({ error: "signature check failed" }, 401);
  const inj = ethToInj(recovered);

  // 3) text
  if (typeof text !== "string" || !text.trim()) return json({ error: "empty tweet" }, 400);
  if ([...text].length > MAX_TEXT) return json({ error: "tweet too long" }, 400);

  // 4) optional media (single image or video, base64)
  let bytes = null, mtype = null, ext = null;
  if (media && media.data) {
    mtype = media.type;
    ext = TYPES[mtype];
    if (!ext) return json({ error: "unsupported media type" }, 400);
    try { bytes = b64ToBytes(media.data); } catch { return json({ error: "bad media encoding" }, 400); }
    if (bytes.length > MAX_MEDIA) return json({ error: "media too large (max 18MB)" }, 400);
  }

  // 5) rate limit per inj address (best-effort KV counter)
  const rlKey = `rl:${inj}:${Math.floor(now / 3600)}`;
  const used = parseInt((await env.TWEETS.get(rlKey)) || "0", 10);
  if (used >= RATE_PER_HOUR) return json({ error: "rate limit: 3 tweets/hour per wallet" }, 429);

  // 6) ZZ balance — fail CLOSED on any RPC problem
  let raw;
  try { raw = await zzBalanceRaw(env.ZZ_LCD_URL, inj, env.ZZ_DENOM); }
  catch { return json({ error: "balance check unavailable, try again" }, 503); }
  if (!meetsThreshold(raw, env.ZZ_MIN_BALANCE, Number(env.ZZ_DECIMALS)))
    return json({ error: `you need at least ${env.ZZ_MIN_BALANCE} ZZ to post` }, 403);

  // 7) push to Telegram + store pending
  const cls = classify(text, !!bytes);
  const meta = cls.srcId ? await xDetail(env, cls.srcId) : null;
  const caption = cls.kind === "post"
    ? buildCaption(text, inj, recovered)
    : buildShareCaption(cls, meta, inj, recovered, env.GETXAPI_HANDLE);
  const label = cls.kind === "repost" ? "🔁 Repost" : cls.kind === "quote" ? "💬 Quote" : "✅ Post";

  const id = crypto.randomUUID();
  let fileId;
  try { fileId = await tgSend(env, id, caption, bytes, mtype, ext, label); }
  catch { return json({ error: "could not queue for review, try again" }, 502); }

  const rec = { id, text, file_id: fileId || null, mediaType: mtype, inj, eth: recovered, status: "pending", ts: now,
                kind: cls.kind, srcId: cls.srcId || null, srcUrl: (meta && meta.url) || null,
                shareText: cls.kind === "quote" ? cls.text : null };
  await env.TWEETS.put(`tw:${id}`, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 7 });
  await env.TWEETS.put(rlKey, String(used + 1), { expirationTtl: 3700 });

  return json({ ok: true, id, status: "pending" });
}

// GET /api/media/<record id> — streams a submission's attachment.
// Telegram file URLs embed the bot token and expire, so we resolve them here and
// hand back only the bytes. The response is cached at the edge so a busy page
// doesn't re-hit getFile for every viewer.
//
// Neither the stored mediaType nor Telegram's file_path extension can be trusted:
// Telegram transcodes GIFs to MP4 but still hands back a ".gif" path. Only the
// magic bytes are authoritative, so we sniff them (same check as the X upload).
// magic-byte sniff, mirrors sniffMime() in ../telegram.js
function sniffMime(b) {
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  return null;
}

const BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", mp4: "video/mp4", mov: "video/mp4",
};

// Bump when the response shape changes: the edge cache keys off this, so old
// entries (e.g. a GIF mistyped before the sniff existed) can never be served.
const CACHE_VERSION = "2";

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response("bad id", { status: 400 });

  const u = new URL(request.url);
  const cacheKey = new Request(`${u.origin}${u.pathname}?v=${CACHE_VERSION}`, request);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let rec;
  try { rec = JSON.parse((await env.TWEETS.get(`tw:${id}`)) || "null"); } catch { rec = null; }
  // only serve media for records the page is willing to show
  if (!rec || !rec.file_id || !["pending", "posting", "posted"].includes(rec.status))
    return new Response("not found", { status: 404 });

  const meta = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: rec.file_id }),
  }).then((r) => r.json()).catch(() => null);
  if (!meta || !meta.ok) return new Response("unavailable", { status: 502 });

  const path = meta.result.file_path || "";
  // NOTE: this URL embeds the bot token — never put it in a header or a redirect.
  const upstream = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!upstream.ok) return new Response("unavailable", { status: 502 });

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const ext = path.split(".").pop().toLowerCase();
  const res = new Response(bytes, {
    headers: {
      "content-type": sniffMime(bytes) || BY_EXT[ext] || rec.mediaType || "application/octet-stream",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

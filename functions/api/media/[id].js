// GET /api/media/<record id> — streams a submission's attachment.
// Telegram file URLs embed the bot token and expire, so we resolve them here and
// hand back only the bytes. The response is cached at the edge so a busy page
// doesn't re-hit getFile for every viewer.
//
// The stored mediaType can be wrong (Telegram transcodes GIF -> MP4), so the
// content type comes from the file_path extension Telegram actually returns.
const BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", mp4: "video/mp4", mov: "video/mp4",
};

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response("bad id", { status: 400 });

  const cache = caches.default;
  const hit = await cache.match(request);
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

  const ext = path.split(".").pop().toLowerCase();
  const res = new Response(upstream.body, {
    headers: {
      "content-type": BY_EXT[ext] || rec.mediaType || "application/octet-stream",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
  waitUntil(cache.put(request, res.clone()));
  return res;
}

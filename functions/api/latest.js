// GET /api/latest — public read model for /community/latest.
// Returns an explicit whitelist of fields, never the raw KV record: eth address
// and telegram file_id stay server-side. Media is addressed by record id and
// streamed through /api/media/<id> so the bot token is never exposed.
const QUEUED = new Set(["pending", "posting"]);

export async function onRequestGet({ env }) {
  const items = [];
  let cursor, done = false;
  while (!done) {
    const page = await env.TWEETS.list({ prefix: "tw:", cursor });
    for (const k of page.keys) {
      let rec;
      try { rec = JSON.parse((await env.TWEETS.get(k.name)) || "null"); } catch { continue; }
      if (!rec || !rec.id) continue;
      const queued = QUEUED.has(rec.status);
      if (!queued && rec.status !== "posted") continue; // hide rejected / failed / unconfirmed
      items.push({
        id: rec.id,
        state: queued ? "queued" : "sent",
        text: typeof rec.text === "string" ? rec.text : "",
        inj: rec.inj || null,
        ts: rec.ts || 0,
        url: (!queued && rec.url) || null,
        media: rec.file_id ? { kind: String(rec.mediaType || "").startsWith("video") ? "video" : "image" } : null,
      });
    }
    done = page.list_complete;
    cursor = page.cursor;
  }
  items.sort((a, b) => b.ts - a.ts);

  return new Response(
    JSON.stringify({
      queued: items.filter((i) => i.state === "queued"),
      sent: items.filter((i) => i.state === "sent"),
    }),
    { headers: { "content-type": "application/json", "cache-control": "public, max-age=30" } },
  );
}

// Classifying a submission into what it is actually asking for.
//
// Shared by /api/submit (which decides what the approval card should say) and
// /api/telegram (which decides what to do when it is approved). One copy on
// purpose: two drifting copies of this regex would mean the card describing one
// action while the button performs another.

// Matches a link to a single X post and nothing else. Anchored at both ends, so
// it is applied per whitespace-separated word rather than searched for inside
// prose.
export const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?|i\/web\/status)\/(\d{5,25})(?:[/?#]\S*)?$/i;

// A submission that is nothing but a link to an X post is a repost, not a new
// tweet: approving it retweets the original instead of writing our own copy of
// it. With words around the link there is something of the submitter's worth
// keeping, so that becomes a quote.
export function classify(text, hasMedia) {
  const words = String(text || "").trim().split(/\s+/);
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * vision-ocr — פרוקסי ל־Google Cloud Vision.
 *
 * הדפדפן שולח לכאן בקשת Vision רגילה, והפונקציה מוסיפה את מפתח ה־API
 * בצד השרת. כך המפתח הפרטי לעולם לא מגיע לקוד המקור הפומבי ב־GitHub Pages.
 *
 * סודות נדרשים (supabase secrets set ...):
 *   GOOGLE_VISION_API_KEY   מפתח API של Google Cloud עם Vision API מופעל
 *   SITE_ORIGIN             ה-origin המדויק של האתר, ללא / בסוף
 *
 * חוזה הבקשה זהה ל־images:annotate של Google, כפי שהלקוח שולח:
 *   { requests: [ { image:{content}, features:[{type,maxResults}], imageContext:{languageHints} } ] }
 */

const GOOGLE_VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const API_KEY = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
const ALLOWED_ORIGIN = Deno.env.get("SITE_ORIGIN") || "";

const MAX_REQUESTS = 4;              // הלקוח שולח עמוד אחד בכל קריאה
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const ALLOWED_FEATURES = new Set(["DOCUMENT_TEXT_DETECTION", "TEXT_DETECTION"]);

function cors(origin: string | null) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
const json = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors(origin) });

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (!ALLOWED_ORIGIN) return json(origin, { error: "site_origin_not_configured" }, 500);
  if (req.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return json(origin, { error: "origin_not_allowed" }, 403);
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") return json(origin, { error: "method_not_allowed" }, 405);
  if (origin !== ALLOWED_ORIGIN) return json(origin, { error: "origin_not_allowed" }, 403);
  if (!API_KEY) return json(origin, { error: "vision_key_not_configured" }, 500);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(origin, { error: "payload_too_large" }, 413);

  let body: { requests?: unknown };
  try { body = JSON.parse(raw); } catch { return json(origin, { error: "invalid_json" }, 400); }

  const requests = Array.isArray(body?.requests) ? body.requests : [];
  if (!requests.length) return json(origin, { error: "missing_requests" }, 400);
  if (requests.length > MAX_REQUESTS) return json(origin, { error: "too_many_requests" }, 400);

  // בונים מחדש כל בקשה במקום להעביר את מה שהגיע כמו שהוא,
  // כדי שלא ניתן יהיה להשתמש בפרוקסי לקריאות Vision אחרות על חשבון המפתח.
  const safeRequests = [];
  for (const item of requests) {
    const entry = item && typeof item === "object" ? item as Record<string, any> : {};
    const content = String(entry?.image?.content || "");
    if (!content || !/^[A-Za-z0-9+/=\s]+$/.test(content)) {
      return json(origin, { error: "invalid_image_content" }, 400);
    }
    const requested = String(entry?.features?.[0]?.type || "DOCUMENT_TEXT_DETECTION");
    const type = ALLOWED_FEATURES.has(requested) ? requested : "DOCUMENT_TEXT_DETECTION";
    safeRequests.push({
      image: { content },
      features: [{ type, maxResults: 1 }],
      imageContext: { languageHints: ["he", "en"] },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const upstream = await fetch(`${GOOGLE_VISION_URL}?key=${encodeURIComponent(API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: safeRequests }),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !payload) {
      // לא מחזירים את שגיאת Google כמות שהיא — היא עלולה להכיל פרטי חיוב ופרויקט.
      console.error("vision-ocr upstream failure", upstream.status, payload?.error?.message);
      return json(origin, { error: "vision_upstream_failed" }, 502);
    }
    return json(origin, { responses: Array.isArray(payload.responses) ? payload.responses : [] });
  } catch (error) {
    console.error("vision-ocr error", error);
    return json(origin, { error: "vision_request_failed" }, 502);
  } finally {
    clearTimeout(timeout);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SETUP_ORIGIN = Deno.env.get("SITE_ORIGIN") || "";

function base64Url(data: Uint8Array) {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hashesMatch(first: string, second: string) {
  const a = new TextEncoder().encode(first), b = new TextEncoder().encode(second);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function serviceRequest(path: string, init: RequestInit = {}) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("server_configuration_missing");
  const headers = new Headers(init.headers);
  headers.set("apikey", SERVICE_ROLE_KEY);
  headers.set("Authorization", `Bearer ${SERVICE_ROLE_KEY}`);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const raw = await response.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error("database_request_failed");
  return data;
}
async function privateConfig(name: string) {
  const value = await serviceRequest("/rest/v1/rpc/buytest_get_private_config", {
    method: "POST", body: JSON.stringify({ p_name: name }),
  });
  return typeof value === "string" ? value.trim() : "";
}
async function setPrivateConfig(name: string, value: string) {
  await serviceRequest("/rest/v1/rpc/buytest_set_private_config", {
    method: "POST", body: JSON.stringify({ p_name: name, p_value: value }),
  });
}
function securityHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}
function corsHeaders(req: Request, contentType = "application/json; charset=utf-8") {
  const headers = securityHeaders(contentType);
  const origin = req.headers.get("Origin") || "";
  if (origin === SETUP_ORIGIN) {
    return {
      ...headers,
      "Access-Control-Allow-Origin": SETUP_ORIGIN,
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    };
  }
  return headers;
}
function page() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>הגדרת Cardcom ל־BuyTest</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f7f8;color:#13272e;font-family:Arial,sans-serif;padding:18px}.card{max-width:520px;margin:26px auto;background:#fff;border:1px solid #d8e4e7;border-radius:22px;padding:24px;box-shadow:0 12px 38px #17333d17}h1{font-size:27px;margin:0 0 8px}p{color:#557079;line-height:1.6;margin:0 0 18px}.field{margin:13px 0}.field label{display:block;font-weight:800;margin-bottom:6px}.field input{width:100%;border:1px solid #bdcdd2;border-radius:12px;padding:13px;font-size:17px;background:#fff;color:#13272e}.ltr{direction:ltr;text-align:left}button{width:100%;border:0;border-radius:13px;padding:14px;background:#0fa87e;color:#fff;font-size:18px;font-weight:900;margin-top:12px}button:disabled{opacity:.6}.note{padding:12px;border-radius:12px;background:#edf8f4;color:#075e48;font-weight:700}.status{min-height:24px;font-weight:800;margin-top:14px}.error{color:#a32727}.success{color:#087356}small{display:block;color:#60717a;line-height:1.5;margin-top:12px}
  </style></head><body><main class="card"><h1>חיבור Cardcom ל־DriveCheck</h1><p>הפרטים נשלחים ישירות לכספת המוצפנת של השרת. הם אינם נשמרים בדפדפן ואינם מפעילים חיובים.</p><form id="f"><div class="field"><label for="terminal">מספר מסוף</label><input class="ltr" id="terminal" inputmode="numeric" placeholder="מספר המסוף שלך" required></div><div class="field"><label for="apiName">API Name</label><input class="ltr" id="apiName" autocomplete="off" required></div><div class="field"><label for="apiPassword">API Password</label><input class="ltr" id="apiPassword" type="password" autocomplete="new-password" required></div><div class="note">לאחר השמירה התשלום יישאר כבוי עד לבדיקת החיבור.</div><button id="save" type="submit">שמירה מאובטחת</button><div class="status" id="status" role="status"></div><small>זהו קישור חד־פעמי. לאחר שמירה מוצלחת לא ניתן להשתמש בו שוב.</small></form></main><script>
  const token=location.hash.slice(1);history.replaceState({},document.title,location.pathname);const f=document.getElementById('f'),status=document.getElementById('status'),save=document.getElementById('save');if(!token){status.textContent='הקישור חסר או אינו תקף.';status.className='status error';save.disabled=true}f.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;status.textContent='שומר בכספת המאובטחת...';status.className='status';try{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setupToken:token,terminalNumber:document.getElementById('terminal').value,apiName:document.getElementById('apiName').value,apiPassword:document.getElementById('apiPassword').value})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'save_failed');document.getElementById('apiName').value='';document.getElementById('apiPassword').value='';status.textContent='✓ הפרטים נשמרו בהצלחה. אפשר לסגור את הדף ולחזור לצ׳אט.';status.className='status success';f.querySelectorAll('input,button').forEach(x=>x.disabled=true)}catch(err){status.textContent=err.message==='invalid_setup_link'?'הקישור אינו תקף או שכבר נעשה בו שימוש.':'לא ניתן לשמור כרגע. לא בוצע שינוי ולא הופעל חיוב.';status.className='status error';save.disabled=false}});
  </script></body></html>`;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    if (origin !== SETUP_ORIGIN) return new Response(null, { status: 403, headers: securityHeaders("text/plain; charset=utf-8") });
    return new Response(null, { status: 204, headers: corsHeaders(req, "text/plain; charset=utf-8") });
  }
  if (req.method === "GET") return new Response(page(), { status: 200, headers: securityHeaders("text/html; charset=utf-8") });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: corsHeaders(req) });
  if (origin && origin !== SETUP_ORIGIN) return new Response(JSON.stringify({ ok: false, error: "origin_not_allowed" }), { status: 403, headers: corsHeaders(req) });
  try {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > 4096) return new Response(JSON.stringify({ ok: false, error: "request_too_large" }), { status: 413, headers: corsHeaders(req) });
    const body = await req.json() as Record<string, unknown>;
    const setupToken = String(body.setupToken || "");
    const terminalNumber = String(body.terminalNumber || "").replace(/\D/g, "");
    const apiName = String(body.apiName || "").trim();
    const apiPassword = String(body.apiPassword || "").trim();
    const expectedHash = await privateConfig("buytest_cardcom_setup_token_hash");
    if (setupToken.length < 40 || !expectedHash || !hashesMatch(await sha256(setupToken), expectedHash)) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_setup_link" }), { status: 403, headers: corsHeaders(req) });
    }
    if (!/^\d{3,12}$/.test(terminalNumber) || apiName.length < 5 || apiName.length > 200 || apiPassword.length < 8 || apiPassword.length > 500) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_configuration" }), { status: 400, headers: corsHeaders(req) });
    }
    await setPrivateConfig("cardcom_terminal_number", terminalNumber);
    await setPrivateConfig("cardcom_api_name", apiName);
    await setPrivateConfig("cardcom_api_password", apiPassword);
    await setPrivateConfig("cardcom_payments_enabled", "false");
    await setPrivateConfig("buytest_cardcom_setup_token_hash", await sha256(randomToken()));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders(req) });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "setup_failed" }), { status: 500, headers: corsHeaders(req) });
  }
});

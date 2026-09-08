import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ה-origin של האתר וכתובת ה-Webhook נקבעים בסודות הפרויקט, לא בקוד.
// supabase secrets set SITE_ORIGIN=https://<הדומיין-שלך>
const ALLOWED_ORIGIN = Deno.env.get("SITE_ORIGIN") || "";
const SITE_URL = Deno.env.get("SITE_URL") || `${ALLOWED_ORIGIN}/`;
const WEBHOOK_URL = `${Deno.env.get("SUPABASE_URL") || ""}/functions/v1/buytest-payment-webhook`;
const CARDCOM_API_URL = "https://secure.cardcom.solutions/api/v11";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PLANS = {
  premium: { amountAgorot: 4900, title: "בדיקה עצמית לפני המכון", scopes: ["premium"] },
  report: { amountAgorot: 3900, title: "פענוח אחרי המכון", scopes: ["premium", "report"] },
  bundle: { amountAgorot: 7900, title: "חבילת DriveCheck המלאה", scopes: ["premium", "report"] },
} as const;
type PlanKey = keyof typeof PLANS;
type CardcomConfig = { terminalNumber: number; apiName: string; enabled: boolean };
type StageProgress = { preInspectionCompleted: boolean; reportCompleted: boolean };

function responseHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}
function json(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}
function cleanPlate(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
function cleanPhone(value: unknown) {
  let phone = String(value ?? "").replace(/[^0-9+]/g, "");
  if (phone.startsWith("+972")) phone = "0" + phone.slice(4);
  else if (phone.startsWith("972")) phone = "0" + phone.slice(3);
  return phone.slice(0, 20);
}
function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function cleanEmail(value: unknown) { return cleanText(value, 50).toLowerCase(); }
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function isPlan(value: unknown): value is PlanKey {
  return Object.prototype.hasOwnProperty.call(PLANS, String(value));
}
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stageProgress(value: unknown): StageProgress {
  const progress = recordValue(recordValue(value).progress);
  return {
    preInspectionCompleted: progress.preInspectionCompleted === true,
    reportCompleted: progress.reportCompleted === true,
  };
}
function progressPayload(existing: unknown, progress: StageProgress, values: Record<string, unknown> = {}) {
  return { ...recordValue(existing), ...values, progress };
}
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
async function hashesMatch(first: string, second: string) {
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
async function cardcomConfig(): Promise<CardcomConfig> {
  const [terminalValue, apiName, enabledValue] = await Promise.all([
    privateConfig("cardcom_terminal_number"),
    privateConfig("cardcom_api_name"),
    privateConfig("cardcom_payments_enabled"),
  ]);
  const terminalNumber = Number(terminalValue);
  return {
    terminalNumber,
    apiName,
    enabled: Number.isInteger(terminalNumber) && terminalNumber > 0 && apiName.length > 0 && /^(1|true|yes|enabled)$/i.test(enabledValue),
  };
}
async function insertOrder(values: Record<string, unknown>) {
  const data = await serviceRequest("/rest/v1/buytest_orders", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(values),
  });
  return Array.isArray(data) ? data[0] : null;
}
async function updateOrder(id: string, values: Record<string, unknown>) {
  const data = await serviceRequest(`/rest/v1/buytest_orders?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(data) ? data[0] : null;
}
async function orderById(id: string) {
  const data = await serviceRequest(`/rest/v1/buytest_orders?id=eq.${encodeURIComponent(id)}&select=*`, { method: "GET" });
  return Array.isArray(data) ? data[0] : null;
}
async function cardcomRequest(path: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${CARDCOM_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: Record<string, unknown> = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error("cardcom_invalid_response"); }
    if (!response.ok) throw new Error("cardcom_http_error");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
function safePaymentUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !["secure.cardcom.solutions", "secure.cardcom.co.il"].includes(url.hostname)) return "";
    return url.toString();
  } catch { return ""; }
}
function compactProviderPayload(result: Record<string, unknown>, existing: unknown = {}) {
  const transaction = result.TranzactionInfo && typeof result.TranzactionInfo === "object"
    ? result.TranzactionInfo as Record<string, unknown> : {};
  const documentInfo = result.DocumentInfo && typeof result.DocumentInfo === "object"
    ? result.DocumentInfo as Record<string, unknown> : {};
  return {
    ...recordValue(existing),
    provider: "cardcom",
    lowProfileId: String(result.LowProfileId || ""),
    transactionId: String(result.TranzactionId || ""),
    responseCode: Number(result.ResponseCode),
    transactionResponseCode: Number(transaction.ResponseCode),
    amount: Number(transaction.Amount),
    coinId: Number(transaction.CoinId),
    documentNumber: documentInfo.DocumentNumber ?? null,
    documentType: documentInfo.DocumentType ?? null,
  };
}
function verifiedCardcomResult(order: Record<string, unknown>, result: Record<string, unknown>, config: CardcomConfig) {
  const transaction = result.TranzactionInfo && typeof result.TranzactionInfo === "object"
    ? result.TranzactionInfo as Record<string, unknown> : {};
  const expectedAmount = Number(order.amount_agorot) / 100;
  return Number(result.ResponseCode) === 0 &&
    String(result.ReturnValue || "") === String(order.id) &&
    String(result.LowProfileId || "").toLowerCase() === String(order.provider_transaction_id || "").toLowerCase() &&
    Number(result.TerminalNumber) === config.terminalNumber &&
    Number(transaction.ResponseCode) === 0 &&
    Math.abs(Number(transaction.Amount) - expectedAmount) < 0.001 &&
    Number(transaction.CoinId) === 1 &&
    !Boolean(transaction.IsRefund);
}
async function refreshCardcomOrder(order: Record<string, unknown>, config: CardcomConfig) {
  if (order.status === "paid" || !order.provider_transaction_id) return order;
  const result = await cardcomRequest("/LowProfile/GetLpResult", {
    TerminalNumber: config.terminalNumber,
    ApiName: config.apiName,
    LowProfileId: order.provider_transaction_id,
  });
  if (!verifiedCardcomResult(order, result, config)) return order;
  return await updateOrder(String(order.id), {
    status: "paid",
    paid_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    provider_payload: compactProviderPayload(result, order.provider_payload),
  }) || order;
}
async function signedEntitlement(order: Record<string, unknown>) {
  const signingKey = await privateConfig("buytest_entitlement_hmac_secret");
  if (!signingKey) throw new Error("entitlement_signing_unavailable");
  const plan = String(order.plan) as PlanKey;
  const progress = stageProgress(order.provider_payload);
  const scopes = plan === "bundle"
    ? ["premium", ...(progress.preInspectionCompleted ? ["report"] : [])]
    : [...PLANS[plan].scopes];
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    v: 1, oid: order.id, plate: order.plate, plan, scopes,
    exp: Math.floor(new Date(String(order.expires_at)).getTime() / 1000),
  })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifiedPriorOrder(body: Record<string, unknown>, plate: string) {
  const orderId = String(body.priorOrderId || "");
  const clientToken = String(body.priorClientSecret || "");
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || clientToken.length < 30) return null;
  const order = await orderById(orderId);
  if (!order || !(await hashesMatch(String(order.client_secret_hash || ""), await sha256(clientToken)))) return null;
  const expiresAt = new Date(String(order.expires_at)).getTime();
  if (String(order.status) !== "paid" || String(order.plate) !== plate || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return order;
}

async function createPayment(origin: string | null, body: Record<string, unknown>) {
  if (origin !== ALLOWED_ORIGIN) return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
  const planKey = String(body.plan || "");
  const plate = cleanPlate(body.plate);
  const customerName = cleanText(body.customerName, 50);
  const email = cleanEmail(body.email);
  const phone = cleanPhone(body.phone);
  if (!isPlan(planKey) || !/^\d{7,8}$/.test(plate) || !validEmail(email) || customerName.length < 2 || !/^05\d{8}$/.test(phone) || body.acceptedTerms !== true) {
    return json(origin, { ok: false, error: "invalid_payment_request" }, 400);
  }
  const plan = PLANS[planKey];
  let inheritedProgress: StageProgress = { preInspectionCompleted: false, reportCompleted: false };
  let priorOrderId = "";
  if (planKey === "report") {
    const priorOrder = await verifiedPriorOrder(body, plate);
    if (!priorOrder || !isPlan(priorOrder.plan)) return json(origin, { ok: false, error: "previous_stage_required" }, 409);
    const priorProgress = stageProgress(priorOrder.provider_payload);
    const priorScopes: readonly string[] = PLANS[priorOrder.plan as PlanKey].scopes;
    const allowed = planKey === "report"
      ? priorScopes.includes("premium") && priorProgress.preInspectionCompleted
      : priorScopes.includes("report") && priorProgress.reportCompleted;
    if (!allowed) return json(origin, { ok: false, error: "previous_stage_required" }, 409);
    inheritedProgress = priorProgress;
    priorOrderId = String(priorOrder.id);
  }
  const config = await cardcomConfig();
  if (!config.enabled) return json(origin, { ok: false, error: "payment_provider_transition", provider: "cardcom_pending" }, 503);
  const orderId = crypto.randomUUID();
  const clientSecret = randomToken();
  const order = await insertOrder({
    id: orderId,
    client_secret_hash: await sha256(clientSecret),
    plate,
    plan: planKey,
    amount_agorot: plan.amountAgorot,
    status: "pending",
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    provider_payload: { provider: "cardcom", stage: "creating", progress: inheritedProgress, priorOrderId: priorOrderId || null },
  });
  if (!order) throw new Error("order_creation_failed");
  const returnBase = `${SITE_URL}?buytest_payment=return&order=${encodeURIComponent(orderId)}`;
  let cardcomResult: Record<string, unknown>;
  try {
    cardcomResult = await cardcomRequest("/LowProfile/Create", {
      TerminalNumber: config.terminalNumber,
      ApiName: config.apiName,
      Operation: "ChargeOnly",
      ReturnValue: orderId,
      Amount: plan.amountAgorot / 100,
      SuccessRedirectUrl: returnBase,
      FailedRedirectUrl: `${SITE_URL}?buytest_payment=failed&order=${encodeURIComponent(orderId)}`,
      CancelRedirectUrl: `${SITE_URL}?buytest_payment=cancelled&order=${encodeURIComponent(orderId)}`,
      WebHookUrl: WEBHOOK_URL,
      ProductName: plan.title,
      Language: "he",
      ISOCoinId: 1,
      UIDefinition: {
        CardOwnerNameValue: customerName,
        CardOwnerPhoneValue: phone,
        CardOwnerEmailValue: email,
        IsCardOwnerPhoneRequired: true,
        IsCardOwnerEmailRequired: true,
      },
      Document: {
        DocumentTypeToCreate: "Auto",
        Name: customerName,
        Email: email,
        Mobile: phone,
        IsSendByEmail: true,
        Products: [{ Description: `${plan.title} · רכב ${plate}`, Quantity: 1, UnitCost: plan.amountAgorot / 100 }],
        ExternalId: orderId,
        Language: "he",
      },
    });
  } catch (error) {
    await updateOrder(orderId, { status: "failed", provider_payload: progressPayload(order.provider_payload, inheritedProgress, { provider: "cardcom", stage: "create_failed" }) });
    throw error;
  }
  const responseCode = Number(cardcomResult.ResponseCode);
  const lowProfileId = String(cardcomResult.LowProfileId || "");
  const paymentUrl = safePaymentUrl(cardcomResult.Url);
  if (responseCode !== 0 || !/^[0-9a-f-]{36}$/i.test(lowProfileId) || !paymentUrl) {
    await updateOrder(orderId, {
      status: "failed",
      provider_payload: progressPayload(order.provider_payload, inheritedProgress, { provider: "cardcom", stage: "create_rejected", responseCode, description: cleanText(cardcomResult.Description, 250) }),
    });
    return json(origin, { ok: false, error: "cardcom_create_failed" }, 502);
  }
  await updateOrder(orderId, {
    status: "payment_ready",
    payment_url: paymentUrl,
    provider_transaction_id: lowProfileId,
    provider_payload: progressPayload(order.provider_payload, inheritedProgress, { provider: "cardcom", stage: "payment_ready", responseCode: 0, lowProfileId }),
  });
  return json(origin, { ok: true, orderId, clientSecret, plate, plan: planKey, progress: inheritedProgress, paymentUrl });
}

async function paymentStatus(origin: string | null, body: Record<string, unknown>) {
  if (origin !== ALLOWED_ORIGIN) return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
  const orderId = String(body.orderId || "");
  const clientToken = String(body.clientSecret || "");
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || clientToken.length < 30) return json(origin, { ok: false, error: "invalid_status_request" }, 400);
  let order = await orderById(orderId);
  if (!order || !(await hashesMatch(String(order.client_secret_hash || ""), await sha256(clientToken)))) return json(origin, { ok: false, error: "order_not_found" }, 404);
  if (["pending", "payment_ready"].includes(String(order.status)) && order.provider_transaction_id) {
    try {
      const config = await cardcomConfig();
      if (config.enabled) order = await refreshCardcomOrder(order, config);
    } catch (error) { console.warn("Cardcom status refresh failed", String(error)); }
  }
  const expiresAt = new Date(String(order.expires_at)).getTime();
  const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
  if (expired && !["paid", "expired"].includes(String(order.status))) order = await updateOrder(orderId, { status: "expired" }) || order;
  if (order.status === "paid" && !expired) {
    return json(origin, { ok: true, status: "paid", plan: order.plan, plate: order.plate, expiresAt: order.expires_at, progress: stageProgress(order.provider_payload), accessToken: await signedEntitlement(order) });
  }
  return json(origin, { ok: true, status: expired ? "expired" : order.status, paymentUrl: expired ? null : order.payment_url });
}

async function completeStage(origin: string | null, body: Record<string, unknown>) {
  if (origin !== ALLOWED_ORIGIN) return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
  const orderId = String(body.orderId || "");
  const clientToken = String(body.clientSecret || "");
  const stage = String(body.stage || "");
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || clientToken.length < 30 || !["premium", "report"].includes(stage)) {
    return json(origin, { ok: false, error: "invalid_stage_request" }, 400);
  }
  const order = await orderById(orderId);
  if (!order || !(await hashesMatch(String(order.client_secret_hash || ""), await sha256(clientToken)))) return json(origin, { ok: false, error: "order_not_found" }, 404);
  const expiresAt = new Date(String(order.expires_at)).getTime();
  if (String(order.status) !== "paid" || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !isPlan(order.plan)) {
    return json(origin, { ok: false, error: "paid_access_required" }, 403);
  }
  const plan = String(order.plan) as PlanKey;
  const scopes: readonly string[] = PLANS[plan].scopes;
  if (!scopes.includes(stage)) return json(origin, { ok: false, error: "stage_not_purchased" }, 403);
  const progress = stageProgress(order.provider_payload);
  if (stage === "report" && !progress.preInspectionCompleted && plan !== "report") {
    return json(origin, { ok: false, error: "previous_stage_required" }, 409);
  }
  const nextProgress: StageProgress = stage === "premium"
    ? { ...progress, preInspectionCompleted: true }
    : { preInspectionCompleted: true, reportCompleted: true };
  const updated = await updateOrder(orderId, { provider_payload: progressPayload(order.provider_payload, nextProgress) });
  if (!updated) throw new Error("stage_update_failed");
  return json(origin, { ok: true, progress: nextProgress, accessToken: await signedEntitlement(updated) });
}

async function redeemPaidAccess(origin: string | null, body: Record<string, unknown>) {
  if (origin !== ALLOWED_ORIGIN) return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
  const plate = cleanPlate(body.plate);
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^\d{7,8}$/.test(plate) || code.length < 20 || code.length > 120) return json(origin, { ok: false, error: "invalid_redemption" }, 400);
  const clientToken = randomToken();
  const result = await serviceRequest("/rest/v1/rpc/buytest_redeem_order_access", {
    method: "POST",
    body: JSON.stringify({ p_code_hash: await sha256(code), p_plate: plate, p_client_hash: await sha256(clientToken) }),
  });
  const data = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (!data.ok) return json(origin, { ok: false, error: "invalid_or_used_redemption" }, 404);
  return json(origin, { ok: true, orderId: data.orderId, clientSecret: clientToken, plate: data.plate, plan: data.plan, expiresAt: data.expiresAt });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return json(origin, { ok: false, error: "origin_not_allowed" }, 403);
    return new Response(null, { status: 204, headers: responseHeaders(origin) });
  }
  if (req.method !== "POST") return json(origin, { ok: false, error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(origin, { ok: false, error: "invalid_json" }, 400); }
  try {
    const action = String(body.action || "");
    if (action === "health") {
      const config = await cardcomConfig();
      return json(origin, { ok: true, paymentConfigured: config.enabled, provider: config.enabled ? "cardcom" : "cardcom_pending" });
    }
    if (action === "create") return await createPayment(origin, body);
    if (action === "status") return await paymentStatus(origin, body);
    if (action === "complete") return await completeStage(origin, body);
    if (action === "redeem") return await redeemPaidAccess(origin, body);
    return json(origin, { ok: false, error: "unknown_action" }, 400);
  } catch (error) {
    console.error("BuyTest payment service error", String(error));
    return json(origin, { ok: false, error: "payment_service_error" }, 500);
  }
});

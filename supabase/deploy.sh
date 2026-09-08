#!/usr/bin/env bash
#
# מדפלייט את ה-Edge Functions ומגדיר את הסודות של DriveCheck.
#
#   ./supabase/deploy.sh verify     בדיקת מוכנות בלבד — לא משנה כלום
#   ./supabase/deploy.sh secrets    הגדרת סודות בלבד
#   ./supabase/deploy.sh deploy     פריסת הפונקציות בלבד
#   ./supabase/deploy.sh            הכול: סודות, פריסה, ואז אימות
#
# סודות: לעולם לא כארגומנט בשורת הפקודה — הם נשמרים בהיסטוריית ה-shell
# ונראים ב-ps. הסקריפט קורא אותם ממשתני סביבה, ואם חסרים — מבקש בהקלדה סמויה.
#
set -euo pipefail

PROJECT_REF="${PROJECT_REF:-jggosolvobyfvablywzi}"
SITE_ORIGIN="${SITE_ORIGIN:-https://erez1980.github.io}"
SITE_URL="${SITE_URL:-https://erez1980.github.io/rk-buyandtest/}"
SUPABASE=(npx --yes supabase@latest)

JWT_FUNCTIONS=(vision-ocr buytest-analyze buytest-payment)
# ה-webhook נקרא על ידי Cardcom ודף ההגדרה נפתח בדפדפן; לשניהם אין JWT.
OPEN_FUNCTIONS=(buytest-payment-webhook buytest-cardcom-setup)

cd "$(dirname "$0")/.."

die() { printf '✗ %s\n' "$1" >&2; exit 1; }

require_token() {
  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    printf 'Supabase access token (supabase.com/dashboard/account/tokens): ' >&2
    read -rs SUPABASE_ACCESS_TOKEN; printf '\n' >&2
    export SUPABASE_ACCESS_TOKEN
  fi
  [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || die "לא סופק טוקן"
  case "$SUPABASE_ACCESS_TOKEN" in
    sbp_*) : ;;
    *) die "הטוקן אמור להתחיל ב-sbp_ — נראה שהודבק ערך אחר" ;;
  esac
}

set_secrets() {
  require_token
  if [ -z "${GOOGLE_VISION_API_KEY:-}" ]; then
    printf 'Google Vision API key (Enter כדי לדלג): ' >&2
    read -rs GOOGLE_VISION_API_KEY; printf '\n' >&2
  fi

  printf '▸ SITE_ORIGIN=%s\n' "$SITE_ORIGIN"
  printf '▸ SITE_URL=%s\n' "$SITE_URL"
  "${SUPABASE[@]}" secrets set --project-ref "$PROJECT_REF" \
    "SITE_ORIGIN=$SITE_ORIGIN" "SITE_URL=$SITE_URL" >/dev/null

  if [ -n "${GOOGLE_VISION_API_KEY:-}" ]; then
    case "$GOOGLE_VISION_API_KEY" in
      AIza*) : ;;
      *) die "מפתח Google אמור להתחיל ב-AIza" ;;
    esac
    # הערך לא מודפס, ולא מגיע ל-stdout של supabase
    "${SUPABASE[@]}" secrets set --project-ref "$PROJECT_REF" \
      "GOOGLE_VISION_API_KEY=$GOOGLE_VISION_API_KEY" >/dev/null
    printf '▸ GOOGLE_VISION_API_KEY נשמר (%d תווים)\n' "${#GOOGLE_VISION_API_KEY}"
  else
    printf '⚠ GOOGLE_VISION_API_KEY לא הוגדר — OCR יחזיר vision_key_not_configured\n'
  fi
  unset GOOGLE_VISION_API_KEY
}

deploy_functions() {
  require_token
  for fn in "${JWT_FUNCTIONS[@]}"; do
    printf '▸ %s (JWT)\n' "$fn"
    "${SUPABASE[@]}" functions deploy "$fn" --project-ref "$PROJECT_REF"
  done
  for fn in "${OPEN_FUNCTIONS[@]}"; do
    printf '▸ %s (ללא JWT)\n' "$fn"
    "${SUPABASE[@]}" functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt
  done
}

# בדיקת מוכנות לפני מיזוג: פונקציה שלא נפרסה מחזירה 404.
# פונקציה שקיימת ודורשת JWT מחזירה 401 — וזו התשובה התקינה כאן.
verify() {
  local base="https://$PROJECT_REF.supabase.co/functions/v1" failed=0
  printf 'בודק מוכנות מול %s\n' "$base"
  for fn in "${JWT_FUNCTIONS[@]}" "${OPEN_FUNCTIONS[@]}"; do
    # ה-|| חייב להיות נפרד: curl כותב 000 ל-stdout וגם יוצא בשגיאה,
    # ושרשור שניהם יצר קוד מזויף שעבר את הבדיקה.
    if ! code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST "$base/$fn" \
                  -H 'Content-Type: application/json' -d '{}' 2>/dev/null); then
      code=""
    fi
    case "$code" in
      2??|401|403|405|400|500) printf '  ✓ %-26s קיימת (HTTP %s)\n' "$fn" "$code" ;;
      404) printf '  ✗ %-26s לא נפרסה (404)\n' "$fn"; failed=1 ;;
      *)   printf '  ? %-26s אין תשובה (%s) — רשת חסומה או הפונקציה מושבתת\n' \
             "$fn" "${code:-no-response}"; failed=1 ;;
    esac
  done
  [ "$failed" -eq 0 ] || die "יש פונקציות חסרות — אין למזג לפני שכולן ירוקות"
  printf '✓ כל חמש הפונקציות פרוסות\n'
}

case "${1:-all}" in
  verify)  verify ;;
  secrets) set_secrets ;;
  deploy)  deploy_functions ;;
  all)     set_secrets; deploy_functions; verify ;;
  *)       die "שימוש: $0 [all|secrets|deploy|verify]" ;;
esac

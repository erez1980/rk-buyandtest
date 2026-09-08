#!/usr/bin/env bash
# מדפלייט את כל ה-Edge Functions ומגדיר את הסודות.
#
#   export SUPABASE_ACCESS_TOKEN=sbp_...      # supabase.com/dashboard/account/tokens
#   export GOOGLE_VISION_API_KEY=AIza...      # אופציונלי; בלעדיו ה-OCR לא יעבוד
#   ./supabase/deploy.sh
#
set -euo pipefail

PROJECT_REF="${PROJECT_REF:-jggosolvobyfvablywzi}"
SITE_ORIGIN="${SITE_ORIGIN:-https://erez1980.github.io}"
SITE_URL="${SITE_URL:-https://erez1980.github.io/rk-buyandtest/}"
SUPABASE="npx --yes supabase@latest"

: "${SUPABASE_ACCESS_TOKEN:?צריך SUPABASE_ACCESS_TOKEN}"
cd "$(dirname "$0")/.."

echo "▸ סודות"
$SUPABASE secrets set --project-ref "$PROJECT_REF" \
  SITE_ORIGIN="$SITE_ORIGIN" \
  SITE_URL="$SITE_URL"
if [ -n "${GOOGLE_VISION_API_KEY:-}" ]; then
  $SUPABASE secrets set --project-ref "$PROJECT_REF" GOOGLE_VISION_API_KEY="$GOOGLE_VISION_API_KEY"
else
  echo "  ⚠ GOOGLE_VISION_API_KEY לא הוגדר — ה-OCR יחזיר vision_key_not_configured"
fi

# הפונקציות שהלקוח קורא להן שולחות את מפתח ה-anon, ולכן דורשות JWT.
echo "▸ פונקציות שדורשות JWT"
for fn in vision-ocr buytest-analyze buytest-payment; do
  echo "  · $fn"
  $SUPABASE functions deploy "$fn" --project-ref "$PROJECT_REF"
done

# ה-webhook נקרא על ידי Cardcom ודף ההגדרה נפתח ישירות בדפדפן — שניהם ללא JWT.
echo "▸ פונקציות ללא JWT"
for fn in buytest-payment-webhook buytest-cardcom-setup; do
  echo "  · $fn"
  $SUPABASE functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt
done

echo "✓ הושלם"

# הרצת DriveCheck על תשתית משלך

הפרונטאנד הוא קובץ HTML סטטי אחד. כל השאר — הזמנות, תשלומים, OCR ופענוח —
רץ על פרויקט Supabase אחד. המדריך הזה מרים אותו מאפס.

## הפרויקט הפעיל

| | |
|---|---|
| Project ref | `jggosolvobyfvablywzi` |
| אזור | `eu-central-1` |
| ארגון | Erez Barazani |
| Dashboard | https://supabase.com/dashboard/project/jggosolvobyfvablywzi |

ה־ref ומפתח ה־`anon` כבר מוגדרים ב־`index.html`, בבלוק המסומן בראש ה־script.
מפתח ה־`anon` **אמור** להיות גלוי בקוד המקור — כך הוא מתוכנן. מה שמגן על
הנתונים הוא RLS יחד עם העובדה שכל גישה עוברת דרך Edge Functions.

## 1. פרויקט חדש (רק אם מרימים מאפס)

צור פרויקט ב־[supabase.com](https://supabase.com), ומ־Settings → API העתק את
ה־Project ref ואת מפתח ה־`anon` אל הבלוק ב־`index.html`.

## 2. סכימה

```bash
supabase link --project-ref <ה-ref-שלך>
supabase db push          # מריץ את migrations/0001_drivecheck_core.sql
```

או להדביק את הקובץ ב־SQL Editor. הוא יוצר את `buytest_orders`,
את `buytest_formula_overrides`, את כספת הקונפיגורציה ואת שלוש ה־RPC,
עם RLS מופעל וללא שום מדיניות שמאפשרת ל־`anon` לגעת בטבלאות.

> ⚠️ הסכימה שוחזרה מתוך קוד ה־Edge Functions ולא יוצאה מפרויקט חי.
> היא מספיקה להתקנה נקייה. אם יש לך פרויקט פעיל — השווה מולו קודם.

## 3. סודות

```bash
supabase secrets set SITE_ORIGIN=https://<הדומיין-שלך>          # ללא / בסוף
supabase secrets set SITE_URL=https://<הדומיין-שלך>/<נתיב>/     # דף החזרה אחרי תשלום
supabase secrets set GOOGLE_VISION_API_KEY=<המפתח>
```

`SUPABASE_URL` ו־`SUPABASE_SERVICE_ROLE_KEY` מוזרקים אוטומטית.

`SITE_ORIGIN` הוא מנגנון ההרשאה של כל הפונקציות: בקשה מ־origin אחר נדחית
ב־403. אם האתר רץ גם בכתובת נוספת, צריך לדפלייט מופע נוסף.

`SITE_URL` הוא הכתובת המלאה שאליה Cardcom מחזיר את הלקוח אחרי תשלום. ב־GitHub
Pages של פרויקט זה כולל את שם הריפו, למשל `https://user.github.io/repo/`.
אם לא מוגדר, ברירת המחדל היא `SITE_ORIGIN` עם `/` — שנכון רק לדומיין ייעודי.

**מפתח Google Vision:** ב־[Google Cloud Console](https://console.cloud.google.com)
יוצרים פרויקט → מפעילים **Cloud Vision API** → APIs & Services → Credentials →
Create credentials → API key. כדאי להגביל אותו ל־Cloud Vision API בלבד.
המפתח יושב רק בסודות של Supabase ולעולם לא מגיע לדפדפן.

## 4. פונקציות

```bash
./supabase/deploy.sh            # סודות, פריסה, ואז אימות
./supabase/deploy.sh verify     # בדיקת מוכנות בלבד — לא משנה כלום
./supabase/deploy.sh secrets    # סודות בלבד
./supabase/deploy.sh deploy     # פריסה בלבד
```

**אין להעביר סודות בשורת הפקודה.** ערך שנכתב כארגומנט נשמר בהיסטוריית ה־shell
ונראה לכל תהליך דרך `ps`. הסקריפט קורא מ־`SUPABASE_ACCESS_TOKEN` ומ־
`GOOGLE_VISION_API_KEY` אם הם מוגדרים בסביבה, ואחרת מבקש אותם בהקלדה סמויה
(`read -rs`) — התו לא מוצג, הערך לא מודפס ולא נכנס להיסטוריה.

הסקריפט מדפלייט את `vision-ocr`, `buytest-analyze` ו־`buytest-payment` עם
אימות JWT, ואת `buytest-payment-webhook` ו־`buytest-cardcom-setup` בלעדיו —
הראשון נקרא על ידי Cardcom והשני נפתח ישירות בדפדפן, ולשניהם אין JWT.

### אימות לפני מיזוג

`./supabase/deploy.sh verify` פונה לכל חמש הפונקציות. פונקציה שלא נפרסה מחזירה
404; פונקציה שקיימת ודורשת JWT מחזירה 401, וזו התשובה התקינה. **אין למזג את
ה־PR לפני שהפקודה הזו מסיימת ירוקה** — `index.html` כבר מצביע לפרויקט החדש,
ומיזוג מוקדם ישאיר את האתר החי קורא לפונקציות שאינן קיימות.

| פונקציה | תפקיד |
|---|---|
| `vision-ocr` | פרוקסי ל־Google Vision. בונה מחדש כל בקשה, כדי שלא ישמש כ־OCR חינמי לאחרים |
| `buytest-analyze` | פענוח דוח הבדיקה. דורש הרשאת תשלום תקפה |
| `buytest-payment` | פתיחת הזמנה, יצירת דף תשלום Cardcom, אימות והנפקת הרשאה |
| `buytest-payment-webhook` | קליטת אישור התשלום מ־Cardcom |
| `buytest-cardcom-setup` | דף חד־פעמי להזנת פרטי מסוף Cardcom לתוך הכספת |

## 5. Cardcom — לאן הכסף הולך

**כאן נקבע מי מקבל את החיובים.** הפרטים לא יושבים בקוד אלא בכספת
(`buytest_private_config`), תחת המפתחות:

```
cardcom_terminal_number     מספר המסוף — זה מי שמקבל את הכסף
cardcom_api_name
cardcom_api_password
cardcom_payments_enabled    '1' כדי להפעיל; כל ערך אחר משאיר תשלום כבוי
```

להזנה, מייצרים טוקן חד־פעמי:

```sql
select buytest_set_private_config(
  'buytest_cardcom_setup_token_hash',
  encode(digest('<טוקן-אקראי-ארוך>', 'sha256'), 'hex')
);
```

ואז נכנסים ל־`https://<ref>.supabase.co/functions/v1/buytest-cardcom-setup#<הטוקן>`.
הדף שולח את הפרטים ישירות לכספת ומתבטל לאחר שימוש. התשלום נשאר כבוי עד
שמפעילים אותו במפורש.

## 6. סודות נוספים

```sql
-- חתימת הרשאות התשלום. מחרוזת אקראית ארוכה; החלפה מבטלת גישות קיימות.
select buytest_set_private_config('buytest_entitlement_hmac_secret', '<אקראי-64-תווים>');

-- PIN לכניסת מנהל, כ-SHA-256
select buytest_set_private_config('buytest_manager_pin_hash',
  encode(digest('<ה-PIN-שלך>', 'sha256'), 'hex'));
```

## 7. בדיקה

1. פותחים את האתר, מזינים מספר רכב — שליפת הנתונים עובדת ללא Supabase
   (היא מגיעה מ־data.gov.il), ולכן היא לא מעידה שהחיבור תקין.
2. מעלים תמונה של דוח — אם ה־OCR עובד, `vision-ocr` והסוד מחוברים.
3. בקונסולה, `403 origin_not_allowed` פירושו ש־`SITE_ORIGIN` אינו תואם
   בדיוק לכתובת שממנה נטען הדף.

## תלויות חיצוניות שנשארות

| שירות | תפקיד | חשבון נדרש |
|---|---|---|
| Supabase | DB, Edge Functions, סודות | שלך |
| Google Cloud Vision | OCR של דוחות | שלך |
| Cardcom | סליקה | שלך |
| data.gov.il | נתוני רכב ממשרד התחבורה | ציבורי, ללא מפתח |

## בדיקות

```bash
python3 tests/static_checks.py    # ללא תלויות
python3 tests/browser_checks.py   # דורש: pip install playwright && playwright install chromium
```

רצות גם ב־GitHub Actions על כל push ו־PR (`.github/workflows/ci.yml`).
כל בדיקה נכתבה מול באג שקרה בפרויקט הזה, ואומתה שהיא נכשלת כשהבאג מוחזר.

## מה עוד לא נבדק

`vision-ocr` נפרסה ואומתה כקיימת, אך **מסלול ה־OCR מקצה לקצה לא הורץ** — הוא
דורש מפתח Google פעיל. אחרי הגדרת הסוד יש להעלות תמונת דוח אחת ולוודא שהטקסט
מזוהה. באותה בדיקה כדאי לוודא שאין הפרות CSP בקונסולה: `pdf.js` ו־`tesseract.js`
טוענים worker ונתוני שפה מ־`cdn.jsdelivr.net` ומ־`tessdata.projectnaptha.com`,
שניהם מותרים ב־CSP, אך הנתיבים האלה לא ניתנים להרצה בסביבת הפיתוח הסגורה.

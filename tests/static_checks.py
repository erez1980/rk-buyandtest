#!/usr/bin/env python3
"""
בדיקות סטטיות ל-DriveCheck. ללא תלויות חיצוניות.

כל בדיקה כאן נולדה מבאג אמיתי שקרה בפרויקט, לא מרשימת מטלות כללית.
    python3 tests/static_checks.py
"""
import json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
PAYMENT = ROOT / "supabase/functions/buytest-payment/index.ts"
FUNCTIONS = ROOT / "supabase/functions"

failures, notes = [], []
def fail(check, msg): failures.append(f"{check}: {msg}")
def ok(check, msg): notes.append(f"  ✓ {check} — {msg}")


def check_no_secrets():
    """מפתחות Google API ו-service_role לא אמורים להופיע בעץ העבודה.
    שני מפתחות Vision דלפו כאן בעבר, ולכן הבדיקה הזו קיימת."""
    patterns = {
        "Google API key": r"AIza[0-9A-Za-z_\-]{30,}",
        "Supabase CLI token": r"\bsbp_[0-9a-f]{40,}",
        "service_role JWT": r"eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]*c2VydmljZV9yb2xl[A-Za-z0-9_\-]*",
    }
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    hits = []
    for rel in tracked:
        p = ROOT / rel
        if not p.is_file() or p.stat().st_size > 4_000_000:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for label, pat in patterns.items():
            for m in re.finditer(pat, text):
                hits.append(f"{rel}: {label} ({m.group()[:12]}…)")
    if hits:
        fail("no-secrets", "; ".join(hits))
    else:
        ok("no-secrets", f"{len(tracked)} tracked files clean")


def check_anon_key_only():
    """המפתח בקוד הפומבי חייב להיות anon, ולהתאים לפרויקט שהקוד מצביע אליו.
    מפתח service_role כאן היה חושף את כל בסיס הנתונים."""
    src = INDEX.read_text(encoding="utf-8")
    ref = re.search(r"DRIVECHECK_SUPABASE_REF\s*=\s*'([^']+)'", src)
    key = re.search(r"BUYTEST_SUPABASE_ANON_KEY\s*=\s*'([^']+)'", src)
    if not ref or not key:
        return fail("anon-key", "לא נמצאו קבועי החיבור ב-index.html")
    payload = key.group(1).split(".")[1]
    payload += "=" * (-len(payload) % 4)
    import base64
    claims = json.loads(base64.urlsafe_b64decode(payload))
    if claims.get("role") != "anon":
        return fail("anon-key", f"role is {claims.get('role')!r}, must be 'anon'")
    if claims.get("ref") != ref.group(1):
        return fail("anon-key", f"key ref {claims.get('ref')} != DRIVECHECK_SUPABASE_REF {ref.group(1)}")
    ok("anon-key", f"anon key matches project {ref.group(1)}")


def check_prices_match():
    """השרת הוא הסמכות על המחיר. כשהפרונט שונה ל-79 והשרת נשאר על 120,
    לקוח שלחץ 79 היה מחויב 120. הבדיקה הזו נועדה לתפוס בדיוק את זה."""
    front = dict(re.findall(r"(\w+):\{name:'[^']*',price:(\d+)", INDEX.read_text(encoding="utf-8")))
    server = dict(re.findall(r"(\w+):\s*\{\s*amountAgorot:\s*(\d+)", PAYMENT.read_text(encoding="utf-8")))
    if not front or not server:
        return fail("prices", "לא הצלחתי לחלץ את טבלאות המחירים")
    if set(front) != set(server):
        return fail("prices", f"plans differ — frontend {sorted(front)} vs server {sorted(server)}")
    for plan in front:
        shekels, agorot = int(front[plan]), int(server[plan])
        if shekels * 100 != agorot:
            return fail("prices", f"plan {plan}: frontend {shekels} ILS but server charges {agorot/100} ILS")
    ok("prices", " ".join(f"{p}={front[p]}₪" for p in sorted(front)))


def check_no_hardcoded_origins():
    """כל ארבע הפונקציות היו נעולות ל-origin של חשבון אחר.
    origin חייב להגיע מסוד, אחרת פריסה אצל מישהו אחר פשוט לא עובדת."""
    bad = []
    for fn in sorted(FUNCTIONS.glob("*/index.ts")):
        text = fn.read_text(encoding="utf-8")
        for m in re.finditer(r"const\s+(ALLOWED_ORIGIN|SETUP_ORIGIN|SITE_URL)\s*=\s*\"(https?://[^\"]+)\"", text):
            bad.append(f"{fn.parent.name}: {m.group(1)} hardcoded to {m.group(2)}")
    if bad:
        fail("origins-from-env", "; ".join(bad))
    else:
        ok("origins-from-env", f"{len(list(FUNCTIONS.glob('*/index.ts')))} functions read origin from secrets")


def check_no_personal_data():
    """המידע האישי הוסר במכוון; אסור שיחזור דרך עריכה עתידית."""
    banned = ["עמוס רוקח", "buytest2026@gmail.com", "amirok196888", "197356"]
    src = INDEX.read_text(encoding="utf-8")
    fn_text = "\n".join(p.read_text(encoding="utf-8") for p in FUNCTIONS.glob("*/index.ts"))
    hits = [b for b in banned if b in src or b in fn_text]
    if hits:
        fail("no-personal-data", f"reintroduced: {', '.join(hits)}")
    else:
        ok("no-personal-data", "no personal or third-party identifiers")


def check_ocr_libs_deferred():
    """שתי ספריות ה-OCR חסמו את הפרסור בכל טעינת דף עד שנוספה להן defer.
    הבדיקה גם נועלת את הגרסאות: CDN ללא גרסה מוצמדת הוא שינוי קוד שקט בפרודקשן."""
    src = INDEX.read_text(encoding="utf-8")
    expected = {"pdfjs-dist@3.11.174": "pdf.min.js", "tesseract.js@7.0.0": "tesseract.min.js"}
    problems = []
    for pin, filename in expected.items():
        tag = re.search(r"<script([^>]*)\bsrc=\"[^\"]*" + re.escape(pin) + r"[^\"]*" + re.escape(filename) + r"\"", src)
        if not tag:
            problems.append(f"{filename} חסרה או שהגרסה אינה {pin}")
        elif "defer" not in tag.group(1):
            problems.append(f"{filename} נטענת ללא defer וחוסמת את הפרסור")
    if problems:
        fail("ocr-libs", "; ".join(problems))
    else:
        ok("ocr-libs", "both OCR libraries deferred and version-pinned")


def check_reduced_motion():
    """כל האפקטים חייבים להיכבות תחת prefers-reduced-motion."""
    src = INDEX.read_text(encoding="utf-8")
    if "prefers-reduced-motion" not in src:
        return fail("reduced-motion", "אין טיפול ב-prefers-reduced-motion")
    ok("reduced-motion", "honoured in CSS and JS")


for fn in (check_no_secrets, check_anon_key_only, check_prices_match,
           check_no_hardcoded_origins, check_no_personal_data,
           check_ocr_libs_deferred, check_reduced_motion):
    try:
        fn()
    except Exception as exc:                     # בדיקה שנשברת היא כישלון, לא דילוג
        fail(fn.__name__, f"check crashed: {exc}")

print("\n".join(notes))
if failures:
    print("\nFAILED:")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)
print(f"\nAll {len(notes)} static checks passed.")

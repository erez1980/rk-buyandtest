#!/usr/bin/env python3
"""
סורק את כל היסטוריית git אחרי סודות.

עץ העבודה נבדק ב-static_checks.py. הבדיקה הזו קיימת כי מפתח שנמחק מהקוד
עדיין ניתן לשליפה מקומיט ישן — מחיקה מהקוד היא לא ביטול.

סודות שכבר דלפו מתועדים ב-security/exposed-keys.json לפי SHA-256 בלבד,
כדי שהרשימה עצמה לא תפרסם אותם מחדש. הבדיקה נכשלת רק על סוד שאינו ברשימה,
כלומר על דליפה חדשה.

    python3 tests/history_scan.py
"""
import hashlib, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "security/exposed-keys.json"

PATTERNS = {
    "google-api-key": r"AIza[0-9A-Za-z_\-]{35}",
    "supabase-cli-token": r"\bsbp_[0-9a-f]{40,}",
    "openai-key": r"\bsk-[A-Za-z0-9]{32,}",
    "private-key-block": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "service-role-jwt": r"eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]*c2VydmljZV9yb2xl[A-Za-z0-9_\-]*",
}

def acknowledged():
    if not LEDGER.exists():
        return {}
    data = json.loads(LEDGER.read_text(encoding="utf-8"))
    return {e["sha256"]: e for e in data.get("acknowledged", [])}


def main():
    known = acknowledged()
    # כל האובייקטים בכל ההיסטוריה, לא רק ב-HEAD
    blobs = subprocess.run(
        ["git", "rev-list", "--objects", "--all"],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    paths = {}
    for line in blobs:
        sha, _, path = line.partition(" ")
        if path and not path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf")):
            paths.setdefault(sha, path)

    found, unknown = {}, []
    for sha, path in paths.items():
        raw = subprocess.run(["git", "cat-file", "-p", sha],
                             cwd=ROOT, capture_output=True).stdout
        if not raw or len(raw) > 6_000_000:
            continue
        text = raw.decode("utf-8", "ignore")
        for kind, pat in PATTERNS.items():
            for m in re.finditer(pat, text):
                secret = m.group()
                digest = hashlib.sha256(secret.encode()).hexdigest()
                found.setdefault(digest, {"kind": kind, "prefix": secret[:10] + "…", "paths": set()})
                found[digest]["paths"].add(path)

    for digest, info in found.items():
        if digest not in known:
            unknown.append(info)

    tracked = [d for d in found if d in known]
    print(f"scanned {len(paths)} blobs across all refs")
    for digest in tracked:
        e = known[digest]
        print(f"  • {e['prefix']} ({e['kind']}) — {e['status']}, ידוע ומתועד")

    if unknown:
        print("\nFAILED — סוד שאינו מתועד נמצא בהיסטוריה:")
        for info in unknown:
            print(f"  ✗ {info['prefix']} ({info['kind']}) in {sorted(info['paths'])[:3]}")
        print("\nמחיקה מהקוד אינה מספיקה. יש לבטל את הסוד אצל הספק,")
        print("ואז לתעד אותו ב-security/exposed-keys.json.")
        return 1

    pending = [known[d] for d in tracked if known[d]["status"] == "pending-rotation"]
    if pending:
        print(f"\n⚠ {len(pending)} מפתחות ממתינים לביטול אצל הספק (ראה SECURITY.md).")
    print("\nNo undocumented secrets in history.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

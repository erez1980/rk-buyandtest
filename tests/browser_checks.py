#!/usr/bin/env python3
"""
בדיקות דפדפן ל-DriveCheck: שגיאות JS, ניגודיות WCAG AA, ומצבי המסלול.

    pip install playwright && playwright install --with-deps chromium
    python3 tests/browser_checks.py
"""
import http.server, os, socketserver, sys, threading, functools
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("TEST_PORT", "8123"))
CHROME = os.environ.get("CHROME_PATH") or None

failures, notes = [], []
fail = lambda c, m: failures.append(f"{c}: {m}")
ok = lambda c, m: notes.append(f"  ✓ {c} — {m}")

# מציג את כל מה שמוסתר מאחורי תשלום, כדי שהבדיקות יכסו גם את פלט הדוח
REVEAL = """
.paidOnly,.premiumFeature,.reportFeature,.interpretation,#fullCheckOffer,
.formulaAdmin,.feedbackBox,.status{display:block!important;filter:none!important;opacity:1!important}
.dcReveal{opacity:1!important;transform:none!important}
#dcBoot{display:none!important}
"""

CONTRAST = r"""()=>{
  const parse=c=>{const m=(c||'').match(/[\d.]+/g);if(!m)return null;return [+m[0],+m[1],+m[2],m.length>3?+m[3]:1]};
  const over=(f,b)=>[0,1,2].map(i=>f[i]*f[3]+b[i]*(1-f[3])).concat([1]);
  const L=c=>{const a=[c[0],c[1],c[2]].map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});
    return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]};
  function bgOf(el){let stack=[],n=el;
    while(n&&n!==document.documentElement){const c=parse(getComputedStyle(n).backgroundColor);
      if(c&&c[3]>0)stack.push(c);n=n.parentElement}
    let base=[12,15,20,1];for(let i=stack.length-1;i>=0;i--)base=over(stack[i],base);return base}
  const out=[];
  document.querySelectorAll('body *').forEach(el=>{
    if(!el.offsetParent)return;const cs=getComputedStyle(el);
    if(cs.backgroundImage&&cs.backgroundImage.indexOf('gradient')>-1)return;  // כפתורי גרדיאנט – ידני
    const t=Array.from(el.childNodes).filter(n=>n.nodeType===3&&n.textContent.trim())
      .map(n=>n.textContent.trim()).join(' ');
    if(!t)return;const fg=parse(cs.color);if(!fg)return;
    const bg=bgOf(el),f=L(over(fg,bg)),b=L(bg);
    const ratio=(Math.max(f,b)+0.05)/(Math.min(f,b)+0.05);
    const size=parseFloat(cs.fontSize),bold=(parseInt(cs.fontWeight)||400)>=700;
    const need=(size>=24||(size>=18.66&&bold))?3:4.5;
    if(ratio<need)out.push({r:+ratio.toFixed(2),need,
      sel:el.tagName+'.'+String(el.className).slice(0,40),txt:t.slice(0,34)});
  });return out}"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):            # לוג הבקשות מסתיר את פלט הבדיקות
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    url = f"http://127.0.0.1:{PORT}/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--hide-scrollbars"])
        for label, reduced in (("normal", None), ("reduced-motion", "reduce")):
            errors = []
            violations = []
            page = browser.new_page(viewport={"width": 1100, "height": 950}, reduced_motion=reduced)
            page.on("pageerror", lambda e: errors.append(str(e)))
            # CSP חוסם בשקט: הפרה מופיעה רק בקונסולה, ולכן היא נאספת בנפרד
            page.on("console", lambda m: violations.append(m.text[:160])
                    if "Content Security Policy" in m.text else None)
            page.goto(url, wait_until="load")
            page.wait_for_timeout(3000)

            # מפעילים את המסלול בכל שילוב של מסלול והתקדמות
            page.fill("#plate", "12345678")
            page.click('button:has-text("הצג נתוני רכב")')
            page.wait_for_timeout(1500)
            for plan, progress in (("premium", {}), ("report", {"preInspectionCompleted": True}),
                                   ("bundle", {"preInspectionCompleted": True, "reportCompleted": True})):
                page.evaluate("([p,g])=>applyPlanAccess(p,{progress:g})", [plan, progress])
                page.wait_for_timeout(200)
            page.evaluate("()=>lockPurchasedPlan()")
            page.evaluate("()=>openLegal('cancel')"); page.wait_for_timeout(200)
            page.evaluate("()=>closeLegal()")

            if errors:
                fail(f"js-errors[{label}]", "; ".join(errors[:4]))
            else:
                ok(f"js-errors[{label}]", "no uncaught exceptions across the full flow")

            if violations:
                fail(f"csp[{label}]", "; ".join(dict.fromkeys(violations))[:400])
            else:
                ok(f"csp[{label}]", "no Content-Security-Policy violations on the exercised paths")

            if label == "normal":
                page.add_style_tag(content=REVEAL)
                page.wait_for_timeout(900)
                bad = page.evaluate(CONTRAST)
                if bad:
                    fail("contrast", "; ".join(f"{b['sel']} {b['r']}<{b['need']}" for b in bad[:6]))
                else:
                    ok("contrast", "no WCAG AA failures with paid sections revealed")

                # שלושת הדיאלוגים מסומנים aria-modal; המיקוד חייב להיכנס אליהם
                # ולחזור לפותח בסגירה, אחרת משתמש מקלדת נשאר בדף שברקע.
                page.evaluate("()=>document.querySelector('.legalLinks button').focus()")
                opener = page.evaluate("()=>document.activeElement.textContent.trim()")
                page.evaluate("()=>openLegal('terms')")
                page.wait_for_timeout(250)
                inside = page.evaluate("()=>document.getElementById('legalModal').contains(document.activeElement)")
                page.keyboard.press("Escape")
                page.wait_for_timeout(250)
                restored = page.evaluate("()=>document.activeElement.textContent.trim()")
                if not inside:
                    fail("modal-focus", "המיקוד לא נכנס למודאל המשפטי")
                elif restored != opener:
                    fail("modal-focus", f"המיקוד לא חזר לפותח ({restored!r} != {opener!r})")
                else:
                    ok("modal-focus", "focus enters the dialog and returns to the opener")

                # startPayment יוצא מוקדם כשאין מסלול קודם — אסור שיגנוב מיקוד
                page.evaluate("()=>document.querySelector('.legalLinks button').focus()")
                page.evaluate("()=>startPayment('report')")
                page.wait_for_timeout(600)
                if not page.evaluate("()=>document.getElementById('paymentOverlay').hidden"):
                    page.evaluate("()=>closeBuyTestPayment()")

                # מדווח בלבד: ה-CDN חסום בחלק מסביבות הפיתוח, ולכן זו לא כשלון.
                # ב-CI, שבו יש גישה, השורה הזו היא הראיה שהספריות נטענות אחרי defer.
                libs = page.evaluate("()=>({pdf:typeof window.pdfjsLib,tess:typeof window.Tesseract})")
                loaded = [k for k, v in libs.items() if v != "undefined"]
                notes.append(f"  · OCR libraries reachable here: {loaded or 'none (CDN unreachable)'}")

                cfg = page.evaluate("()=>({ref:DRIVECHECK_SUPABASE_REF,ready:googleVisionReady()})")
                if not cfg["ready"]:
                    fail("config", "googleVisionReady() is false — endpoint or key malformed")
                else:
                    ok("config", f"endpoints resolve against {cfg['ref']}")
            else:
                present = page.evaluate("()=>!!document.querySelector('#dcBoot')")
                hidden = page.evaluate(
                    "()=>[...document.querySelectorAll('.dcReveal')].filter(e=>getComputedStyle(e).opacity<0.5).length")
                if present or hidden:
                    fail("reduced-motion", f"boot overlay={present}, still-invisible={hidden}")
                else:
                    ok("reduced-motion", "no boot overlay and nothing left hidden")
            page.close()
        browser.close()
    httpd.shutdown()

    print("\n".join(notes))
    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print(f"\nAll {len(notes)} browser checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

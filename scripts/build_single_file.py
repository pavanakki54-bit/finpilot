"""Bundle the web UI into one self-contained HTML file.

    python scripts/build_single_file.py            -> dist/finpilot.html (full document)
    python scripts/build_single_file.py --fragment -> dist/finpilot-fragment.html (head/body content only,
                                                     for hosts that supply their own <html> skeleton)

CSS, JS and the knowledge base are inlined and the in-browser engine is forced,
so the file works from anywhere: an email attachment, a static host, a USB stick.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def build(fragment: bool) -> str:
    html = (WEB / "index.html").read_text(encoding="utf-8")
    kb = json.loads((WEB / "data" / "faqs.json").read_text(encoding="utf-8"))
    config = (WEB / "assets" / "config.js").read_text(encoding="utf-8")

    css = (WEB / "assets" / "styles.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="assets/styles.css">', f"<style>\n{css}</style>")

    def inline_script(match: re.Match) -> str:
        name = match.group(1)
        src = (WEB / "assets" / name).read_text(encoding="utf-8")
        if name == "config.js":
            src = f"window.FINPILOT_CONFIG = {{ apiBase: 'browser' }};\n{config}"
            src += "\nwindow.FP_KB = " + json.dumps(kb, ensure_ascii=False).replace("</", "<\\/") + ";\n"
        return f"<script>\n{src}\n</script>"

    html = re.sub(r'<script src="assets/([\w.]+)"></script>', inline_script, html)

    if fragment:
        head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
        head = re.sub(r"<meta (charset|name=\"viewport\")[^>]*>\n?", "", head)
        body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
        html = head.strip() + "\n" + body.strip() + "\n"
    return html


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fragment", action="store_true")
    args = ap.parse_args()
    out = ROOT / "dist" / ("finpilot-fragment.html" if args.fragment else "finpilot.html")
    out.parent.mkdir(exist_ok=True)
    out.write_text(build(args.fragment), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()

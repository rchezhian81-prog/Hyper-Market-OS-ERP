#!/usr/bin/env python3
"""Build the owner's reference WITH the SRE gap-fix layer, leaving every file of the owner's pack untouched.

Same composition as the pack's own build.py (base.css, professional.css, icons.js, architecture.json, app.js),
plus sre-gap-fixes.css after the stylesheets and sre-gap-fixes.js after the interaction code. The pack's
originals keep the hashes recorded in preservation-check.json; the output is a second file, never a rewrite.
Run from anywhere: python3 /path/to/source/build-v2.py
"""

import json
from pathlib import Path

OUTPUT = "SRE-Hypermarket-ERP-Professional-v2.html"


def main():
    source = Path(__file__).resolve().parent
    root = source.parent
    template = (source / "index.template.html").read_text(encoding="utf-8")
    architecture = json.loads((root / "architecture.json").read_text(encoding="utf-8"))
    css = "\n".join((source / n).read_text(encoding="utf-8") for n in ("base.css", "professional.css", "sre-gap-fixes.css"))
    app = "\n".join((source / n).read_text(encoding="utf-8") for n in ("app.js", "sre-gap-fixes.js"))
    replacements = {
        "/*__CSS__*/": css,
        "/*__ICONS__*/": (source / "icons.js").read_text(encoding="utf-8"),
        "/*__DATA__*/": "const ARCH=" + json.dumps(architecture, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/") + ";",
        "/*__APP__*/": app,
    }
    for marker, content in replacements.items():
        if template.count(marker) != 1:
            raise ValueError(f"Expected exactly one {marker} placeholder")
        template = template.replace(marker, content)
    # The title names the page; the fix layer is otherwise invisible in the markup.
    template = template.replace("<title>SRE Hyper Market · Store workspace</title>", "<title>SRE Store Workspace</title>")
    out = root / OUTPUT
    out.write_text(template, encoding="utf-8")
    print(f"Built {out.name}: {out.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()

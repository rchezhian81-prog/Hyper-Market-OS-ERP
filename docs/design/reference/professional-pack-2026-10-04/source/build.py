#!/usr/bin/env python3
"""Build the full, offline ERP prototype using only Python's standard library.

base.css is the uploaded model's original stylesheet. professional.css is the
visual revision layer. app.js retains the original interactions, with only the
copy changes recorded in presentation-changes.json. No CDN or build service is
required. Run from any directory: python3 /path/to/source/build.py
"""

import json
from pathlib import Path


def main():
    source = Path(__file__).resolve().parent
    root = source.parent
    template = (source / "index.template.html").read_text(encoding="utf-8")
    architecture = json.loads((root / "architecture.json").read_text(encoding="utf-8"))
    replacements = {
        "/*__CSS__*/": "\n".join(
            (source / name).read_text(encoding="utf-8")
            for name in ("base.css", "professional.css")
        ),
        "/*__ICONS__*/": (source / "icons.js").read_text(encoding="utf-8"),
        "/*__DATA__*/": "const ARCH=" + json.dumps(
            architecture, ensure_ascii=False, separators=(",", ":")
        ).replace("</", "<\\/") + ";",
        "/*__APP__*/": (source / "app.js").read_text(encoding="utf-8"),
    }
    for marker, content in replacements.items():
        if template.count(marker) != 1:
            raise ValueError(f"Expected exactly one {marker} placeholder")
        template = template.replace(marker, content)
    output = root / "SRE-Hypermarket-ERP-Professional.html"
    output.write_text(template, encoding="utf-8")
    print(f"Built {output.name}: {output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()

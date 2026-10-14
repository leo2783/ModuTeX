"""Read fixed installed WOFF2 name tables; fontTools is an audit tool only."""
import hashlib
import json
from pathlib import Path
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[2]
font_dir = root / "node_modules/mathlive/fonts"
records = []
for file in sorted(font_dir.glob("*.woff2")):
    with TTFont(file) as font:
        names = {
            str(name_id): sorted({name.toUnicode() for name in font["name"].names if name.nameID == name_id})
            for name_id in (0, 13, 14)
        }
    records.append({"path": file.relative_to(root).as_posix(),
                    "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "names": names})
if not records:
    raise RuntimeError("No installed WOFF2 fonts found")
print(json.dumps({"schemaVersion": 1, "method": "fontTools TTFont actual WOFF2 name table, IDs 0/13/14",
                  "verdict": "embedded-declarations-only-not-independent-clearance", "fonts": records}, indent=2))

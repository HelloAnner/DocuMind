#!/usr/bin/env python3
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path("/opt/cnpc-skills")
CASES = (
    ("cnpc-word.py", {"title": "验收", "sections": [{"heading": "结论", "paragraphs": ["通过"]}]}, ".docx", "word/document.xml"),
    ("cnpc-excel.py", {"sheets": [{"name": "数据", "rows": [["项目", "数值"], ["产量", 42]]}]}, ".xlsx", "xl/workbook.xml"),
    ("cnpc-ppt.py", {"slides": [{"title": "验收", "bullets": ["通过"]}]}, ".pptx", "ppt/presentation.xml"),
)

for script, payload, suffix, required in CASES:
    source = Path(f"{script}.json")
    source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    for repeat in (1, 2):
        output = Path(f"{script}-{repeat}{suffix}")
        subprocess.run([sys.executable, str(ROOT / script), str(source), str(output)], check=True)
        with zipfile.ZipFile(output) as archive:
            if archive.testzip() is not None or required not in archive.namelist():
                raise SystemExit(f"invalid generated package: {output}")
print("runner-smoke-ok")

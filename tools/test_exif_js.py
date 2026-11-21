#!/usr/bin/env python3
"""app.js의 EXIF 스캐너만 떼어 quickjs로 실제 파일에 돌려 검증한다."""
import json
import os
import sys

import quickjs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
APP = os.path.join(ROOT, "app.js")

src = open(APP, encoding="utf-8").read()
start = src.index("function readAscii(")
end = src.index("/* ------------------------------------------------------------------ *\n * 사진 불러오기")
scanner = src[start:end]

ctx = quickjs.Context()

def scan(path):
    data = open(path, "rb").read()
    array_literal = "new Uint8Array([" + ",".join(str(b) for b in data) + "])"
    ctx.eval("globalThis.__buf = " + array_literal + ";")
    return json.loads(ctx.eval("JSON.stringify(scanJpegMeta(__buf.buffer))"))

ctx.eval(scanner)

cases = [
    ("test/test-photo-gps.jpg", {"isJpeg": True, "gps": True, "device": True, "time": True,
                                 "model": "iPhone 15 Pro", "make": "Apple"}),
    ("test/test-photo-clean.jpg", {"isJpeg": True, "gps": False, "device": False, "time": False}),
]
ok = True
for rel, expect in cases:
    result = scan(os.path.join(ROOT, rel))
    print(rel, "->", json.dumps(result, ensure_ascii=False))
    for k, v in expect.items():
        if result.get(k) != v:
            ok = False
            print("   !! %s: expected %r got %r" % (k, v, result.get(k)))

print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)

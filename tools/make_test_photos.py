#!/usr/bin/env python3
"""테스트 사진 생성: EXIF(GPS·기기·촬영시각) 포함 JPEG 1장 + 깨끗한 JPEG 1장."""
import struct, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "test"))


def build_exif():
    """최소 EXIF(TIFF) 블록: Make/Model/Software/DateTime + ExifIFD(DateTimeOriginal) + GPS IFD."""
    make = b"Apple\x00"
    model = b"iPhone 15 Pro\x00"
    software = b"17.5.1\x00"
    dt = b"2026:11:20 10:03:41\x00"
    dto = b"2026:11:20 10:03:41\x00"

    # 값 영역을 뒤에 붙이기 위해 헤더/엔트리 크기 계산
    # TIFF header 8 + IFD0 (2 + 6*12 + 4) = 8 + 78 = 86 -> ExifIFD at 86
    ifd0_entries = 6
    off_ifd0 = 8
    off_exif = off_ifd0 + 2 + ifd0_entries * 12 + 4          # 86
    exif_entries = 1
    off_gps = off_exif + 2 + exif_entries * 12 + 4           # 86 + 18 = 104
    gps_entries = 6
    data_start = off_gps + 2 + gps_entries * 12 + 4          # 104 + 78 = 182

    data = bytearray()
    def add(blob):
        nonlocal data
        off = data_start + len(data)
        data += blob
        return off

    off_make = add(make)
    off_model = add(model)
    off_soft = add(software)
    off_dt = add(dt)
    off_dto = add(dto)
    # GPS: lat 37/1, 33/1, 0/1 ; lon 126/1, 58/1, 0/1
    off_lat = add(struct.pack("<6I", 37, 1, 33, 1, 0, 1))
    off_lon = add(struct.pack("<6I", 126, 1, 58, 1, 0, 1))
    off_gpsdate = add(b"2026:11:20\x00")

    out = bytearray()
    out += b"II" + struct.pack("<HI", 0x2A, off_ifd0)

    # IFD0
    out += struct.pack("<H", ifd0_entries)
    out += struct.pack("<HHII", 0x010F, 2, len(make), off_make)
    out += struct.pack("<HHII", 0x0110, 2, len(model), off_model)
    out += struct.pack("<HHII", 0x0131, 2, len(software), off_soft)
    out += struct.pack("<HHII", 0x0132, 2, len(dt), off_dt)
    out += struct.pack("<HHII", 0x8769, 4, 1, off_exif)
    out += struct.pack("<HHII", 0x8825, 4, 1, off_gps)
    out += struct.pack("<I", 0)

    # Exif IFD
    out += struct.pack("<H", exif_entries)
    out += struct.pack("<HHII", 0x9003, 2, len(dto), off_dto)
    out += struct.pack("<I", 0)

    # GPS IFD
    out += struct.pack("<H", gps_entries)
    out += struct.pack("<HHII", 0x0000, 1, 4, 0x00000202)  # GPSVersionID inline
    out += struct.pack("<HHII", 0x0001, 2, 2, struct.unpack("<I", b"N\x00\x00\x00")[0])
    out += struct.pack("<HHII", 0x0002, 5, 3, off_lat)
    out += struct.pack("<HHII", 0x0003, 2, 2, struct.unpack("<I", b"E\x00\x00\x00")[0])
    out += struct.pack("<HHII", 0x0004, 5, 3, off_lon)
    out += struct.pack("<HHII", 0x001D, 2, 11, off_gpsdate)
    out += struct.pack("<I", 0)

    assert len(out) == data_start, (len(out), data_start)
    out += data
    return b"Exif\x00\x00" + bytes(out)


def insert_app1(jpeg_bytes, app1):
    assert jpeg_bytes[:2] == b"\xff\xd8"
    payload = app1
    seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    return jpeg_bytes[:2] + seg + jpeg_bytes[2:]


def make_scene(w, h, label):
    img = Image.new("RGB", (w, h), (235, 241, 250))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=(int(232 - 40 * t), int(240 - 20 * t), 250))
    try:
        font_big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(h * 0.10))
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", int(h * 0.045))
    except Exception:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()

    # '가릴 대상' 카드
    card = [int(w * 0.08), int(h * 0.22), int(w * 0.46), int(h * 0.62)]
    d.rounded_rectangle(card, radius=int(h * 0.03), fill=(255, 255, 255), outline=(180, 196, 220), width=3)
    d.ellipse([card[0] + 30, card[1] + 30, card[0] + 30 + int(h * 0.16), card[1] + 30 + int(h * 0.16)],
              fill=(245, 190, 160))
    d.text((card[0] + 40, card[1] + int(h * 0.24)), "HONG GILDONG", font=font_big, fill=(20, 35, 60))
    d.text((card[0] + 40, card[1] + int(h * 0.36)), "010-1234-5678", font=font_small, fill=(90, 105, 130))
    d.text((card[0] + 40, card[1] + int(h * 0.43)), "37.5665 N  126.9780 E", font=font_small, fill=(90, 105, 130))

    # 오른쪽 설명
    d.text((int(w * 0.54), int(h * 0.28)), label, font=font_big, fill=(25, 45, 80))
    lines = ["SAMPLE PHOTO FOR TESTING", "mosaic / blur target: left card", "privacy tool demo"]
    y0 = int(h * 0.42)
    for i, line in enumerate(lines):
        d.text((int(w * 0.54), y0 + i * int(h * 0.075)), line, font=font_small, fill=(70, 90, 120))

    # 컬러 바
    colors = [(37, 99, 235), (16, 185, 129), (245, 158, 11), (239, 68, 68)]
    for i, c in enumerate(colors):
        d.rectangle([int(w * 0.54), int(h * 0.68) + i * int(h * 0.055),
                     int(w * 0.54) + int(w * 0.06), int(h * 0.68) + (i + 1) * int(h * 0.055) - 6], fill=c)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)

    img = make_scene(1600, 1200, "GPS + iPhone")
    raw = os.path.join(OUT, "_raw.jpg")
    img.save(raw, "JPEG", quality=92)
    with open(raw, "rb") as f:
        jpeg = f.read()
    with open(os.path.join(OUT, "test-photo-gps.jpg"), "wb") as f:
        f.write(insert_app1(jpeg, build_exif()))
    os.remove(raw)

    img2 = make_scene(1200, 900, "CLEAN JPEG")
    img2.save(os.path.join(OUT, "test-photo-clean.jpg"), "JPEG", quality=92)

    for n in ("test-photo-gps.jpg", "test-photo-clean.jpg"):
        p = os.path.join(OUT, n)
        print(n, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()

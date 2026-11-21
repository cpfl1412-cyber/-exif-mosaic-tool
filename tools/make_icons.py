#!/usr/bin/env python3
"""사진 안전 정리 앱 아이콘 생성 (실제 PNG)."""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024  # 작업 해상도


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, c1, c2):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.45 + y * 0.55) / size
            px[x, y] = lerp(c1, c2, t)
    return img


def scene(size):
    """아이콘 안에 들어갈 작은 '사진' 장면 (하늘 + 해 + 산 + 인물 실루엣)."""
    img = Image.new("RGB", (size, size), (219, 234, 254))
    d = ImageDraw.Draw(img)
    # 하늘 그라데이션
    for y in range(size):
        t = y / size
        d.line([(0, y), (size, y)], fill=lerp((226, 240, 255), (168, 205, 255), t))
    # 해
    d.ellipse([size * 0.60, size * 0.10, size * 0.86, size * 0.36], fill=(255, 205, 92))
    # 산
    d.polygon([(0, size * 0.78), (size * 0.32, size * 0.44), (size * 0.62, size * 0.80),
               (size, size * 0.56), (size, size), (0, size)], fill=(88, 158, 122))
    d.polygon([(0, size * 0.88), (size * 0.44, size * 0.66), (size * 0.80, size * 0.90),
               (size, size * 0.80), (size, size), (0, size)], fill=(54, 122, 92))
    # 인물 실루엣 (가릴 대상)
    cx = size * 0.30
    d.ellipse([cx - size * 0.055, size * 0.50, cx + size * 0.055, size * 0.61], fill=(250, 214, 182))
    d.rounded_rectangle([cx - size * 0.10, size * 0.615, cx + size * 0.10, size * 0.90],
                        radius=size * 0.05, fill=(59, 84, 146))
    return img


def pixelate(img, block):
    w, h = img.size
    small = img.resize((max(1, w // block), max(1, h // block)), Image.BOX)
    return small.resize((w, h), Image.NEAREST)


def draw_icon(size=1024, maskable=False, rounded=True):
    scale = 1.0
    bg = gradient(S, (18, 35, 58), (37, 99, 235))

    # 사진 카드
    card_w = S * (0.60 if maskable else 0.66)
    card_h = card_w * 1.16
    cx, cy = S / 2, S / 2 - S * 0.015
    photo = pixelate(scene(420), 22)
    # 카드 그림자
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([cx - card_w / 2, cy - card_h / 2 + 8, cx + card_w / 2, cy + card_h / 2 + 8],
                         radius=card_w * 0.14, fill=(6, 14, 26, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.035))
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow)

    d = ImageDraw.Draw(bg)
    card = [cx - card_w / 2, cy - card_h / 2, cx + card_w / 2, cy + card_h / 2]
    d.rounded_rectangle(card, radius=card_w * 0.14, fill=(255, 255, 255, 255))

    # 사진 영역(카드 안쪽, 위쪽)
    pad = card_w * 0.075
    inner = [card[0] + pad, card[1] + pad, card[2] - pad, card[3] - pad - card_h * 0.10]
    iw, ih = int(inner[2] - inner[0]), int(inner[3] - inner[1])
    photo = photo.resize((iw, ih), Image.LANCZOS)
    # 둥근 마스크
    mask = Image.new("L", (iw, ih), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, iw - 1, ih - 1], radius=int(card_w * 0.07), fill=255)
    bg.paste(photo, (int(inner[0]), int(inner[1])), mask)

    # 자물쇠 배지 (오른쪽 아래)
    r = card_w * 0.20
    lx, ly = card[2] - r * 0.95, card[3] - r * 0.95
    d = ImageDraw.Draw(bg)
    d.ellipse([lx - r, ly - r, lx + r, ly + r], fill=(29, 78, 216, 255), outline=(255, 255, 255, 255),
              width=int(card_w * 0.035))
    # 자물쇠 몸통
    bw, bh = r * 0.78, r * 0.60
    body = [lx - bw / 2, ly - bh * 0.10, lx + bw / 2, ly + bh * 0.90]
    d.rounded_rectangle(body, radius=bw * 0.18, fill=(255, 255, 255, 255))
    # 고리
    arc_w = bw * 0.52
    d.arc([lx - arc_w / 2, ly - bh * 0.95, lx + arc_w / 2, ly - bh * 0.10 + arc_w * 0.1],
          start=180, end=360, fill=(255, 255, 255, 255), width=int(bw * 0.15))
    # 열쇠 구멍
    d.ellipse([lx - bw * 0.09, ly + bh * 0.28, lx + bw * 0.09, ly + bh * 0.46], fill=(29, 78, 216, 255))

    if rounded and not maskable:
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(bg, (0, 0), m)
        return out.convert("RGB") if False else out
    return bg.convert("RGB")


def save(img, name, size):
    img = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print(path, img.size, img.mode)


icon = draw_icon(maskable=False, rounded=True)
save(icon, "icon-512.png", 512)
save(icon, "icon-192.png", 192)

# 애플 터치 아이콘: 투명도 없는 정사각(아이폰이 직접 둥글게 자름)
apple = draw_icon(maskable=False, rounded=False)
save(apple.convert("RGB"), "apple-touch-icon.png", 180)

# 마스커블: 배경 꽉 차게 + 안전 영역
maskable = draw_icon(maskable=True, rounded=False)
save(maskable, "icon-maskable-512.png", 512)

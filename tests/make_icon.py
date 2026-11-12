# -*- coding: utf-8 -*-
"""Generate the LilacLingua app icon (purple crystal + bilingual speech)."""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(OUT, exist_ok=True)
S = 4096
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
px = img.load()

# Rounded-square gradient background with a soft radial glow.
def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))

top = (46, 16, 101, 255)
bottom = (124, 58, 237, 255)
glow = (196, 181, 253, 255)
for y in range(S):
    t = y / (S - 1)
    base = lerp(top, bottom, t * 0.92)
    for x in range(S):
        dx = (x - S * 0.5) / (S * 0.5)
        dy = (y - S * 0.46) / (S * 0.5)
        d = max(0.0, 1.0 - math.sqrt(dx * dx + dy * dy))
        g = d ** 2 * 0.36
        px[x, y] = lerp(base, glow, g)

mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
img.putalpha(mask)

d = ImageDraw.Draw(img, "RGBA")

# Outer soft ring.
d.rounded_rectangle(
    [int(S * 0.055), int(S * 0.055), int(S * 0.945), int(S * 0.945)],
    radius=int(S * 0.19),
    outline=(221, 214, 254, 70),
    width=int(S * 0.007),
)

# Back speech bubble.
back = [int(S * 0.235), int(S * 0.245), int(S * 0.80), int(S * 0.66)]
d.rounded_rectangle(back, radius=int(S * 0.105), fill=(167, 139, 250, 115))
d.polygon(
    [
        (int(S * 0.31), int(S * 0.64)),
        (int(S * 0.255), int(S * 0.755)),
        (int(S * 0.40), int(S * 0.665)),
    ],
    fill=(167, 139, 250, 115),
)

# Front speech bubble with vertical lavender-white gradient.
front = [int(S * 0.185), int(S * 0.325), int(S * 0.815), int(S * 0.755)]
front_img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
fd = ImageDraw.Draw(front_img)
for y in range(front[1], front[3] + 1):
    t = (y - front[1]) / max(1, front[3] - front[1])
    col = lerp((255, 255, 255, 255), (235, 226, 255, 255), t * 0.9)
    fd.line([(front[0], y), (front[2], y)], fill=col)
fmask = Image.new("L", (S, S), 0)
fmd = ImageDraw.Draw(fmask)
fmd.rounded_rectangle(front, radius=int(S * 0.10), fill=255)
front_img.putalpha(fmask)
img.alpha_composite(front_img)

# Speech-bubble tail.
d.polygon(
    [
        (int(S * 0.35), int(S * 0.73)),
        (int(S * 0.30), int(S * 0.86)),
        (int(S * 0.475), int(S * 0.745)),
    ],
    fill=(240, 234, 255, 255),
)

# Front bubble highlight.
d.rounded_rectangle(
    [int(S * 0.205), int(S * 0.345), int(S * 0.795), int(S * 0.46)],
    radius=int(S * 0.06),
    fill=(255, 255, 255, 80),
)

# Crystal / sparkle in the middle.
cx, cy = int(S * 0.5), int(S * 0.525)
spark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(spark)
points = []
for i in range(16):
    ang = -math.pi / 2 + i * math.pi / 8
    r = int(S * 0.145) if i % 2 == 0 else int(S * 0.052)
    points.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r))
sd.polygon(points, fill=(124, 58, 237, 255))
spark = spark.filter(ImageFilter.GaussianBlur(int(S * 0.004)))
img.alpha_composite(spark)
d.polygon(points, fill=(109, 40, 217, 255))
# Inner facet.
inner = []
for i in range(16):
    ang = -math.pi / 2 + i * math.pi / 8
    r = int(S * 0.088) if i % 2 == 0 else int(S * 0.030)
    inner.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r))
d.polygon(inner, fill=(237, 233, 254, 255))
d.ellipse(
    [cx - int(S * 0.018), cy - int(S * 0.018), cx + int(S * 0.018), cy + int(S * 0.018)],
    fill=(139, 92, 246, 255),
)

# Three sound bars at the lower right of the bubble.
bar_color = (124, 58, 237, 235)
base_y = int(S * 0.70)
for i, (bx, h) in enumerate([(0.61, 0.048), (0.655, 0.082), (0.70, 0.062)]):
    x = int(S * bx)
    d.rounded_rectangle(
        [x, base_y - int(S * h), x + int(S * 0.018), base_y],
        radius=int(S * 0.009),
        fill=bar_color,
    )

# Small sparkles around the bubble.
def star(cx_, cy_, r, col):
    pts = []
    for i in range(8):
        ang = -math.pi / 2 + i * math.pi / 4
        rr = r if i % 2 == 0 else r * 0.34
        pts.append((cx_ + math.cos(ang) * rr, cy_ + math.sin(ang) * rr))
    d.polygon(pts, fill=col)

star(int(S * 0.825), int(S * 0.29), int(S * 0.042), (237, 233, 254, 235))
star(int(S * 0.19), int(S * 0.22), int(S * 0.026), (196, 181, 253, 210))
star(int(S * 0.80), int(S * 0.81), int(S * 0.020), (196, 181, 253, 170))

# Subtle inner glow/shadow at the bottom.
shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sh = ImageDraw.Draw(shade)
sh.ellipse([int(S * 0.12), int(S * 0.80), int(S * 0.88), int(S * 1.02)], fill=(31, 12, 68, 90))
shade = shade.filter(ImageFilter.GaussianBlur(int(S * 0.03)))
img.alpha_composite(shade)

# Downsample and export.
icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save(os.path.join(OUT, "icon.png"))
icon.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "logo-256.png"))
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
icon.save(os.path.join(OUT, "icon.ico"), sizes=ico_sizes)
print("icon written", os.path.join(OUT, "icon.ico"))

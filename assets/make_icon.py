"""把 icon.svg 的设计重绘成 180x180 的位图（市场卡片只收 png/jpg/webp，不收 svg）。

4 倍超采样再缩到 180，边缘才干净。跑法：
  python assets/make_icon.py
"""
from PIL import Image, ImageDraw
import os

S = 4                     # 超采样倍数
W = 180                   # 最终尺寸
N = W * S                 # 画布尺寸
k = N / 64.0              # svg viewBox 是 64x64

def sc(v):
    return v * k

# 1. 斜向三段渐变底色
stops = [(0.0, (0xff, 0xc2, 0xdd)), (0.55, (0xf7, 0xa8, 0xc8)), (1.0, (0x9e, 0xc9, 0xff))]
grad = Image.new("RGB", (N, N))
px = grad.load()
for y in range(N):
    for x in range(N):
        t = (x / (N - 1) + y / (N - 1)) / 2.0        # 对角线参数
        for i in range(len(stops) - 1):
            a, ca = stops[i]
            b, cb = stops[i + 1]
            if a <= t <= b:
                f = (t - a) / (b - a)
                px[x, y] = tuple(int(ca[j] + (cb[j] - ca[j]) * f) for j in range(3))
                break
        else:
            px[x, y] = stops[-1][1]

# 2. 圆角裁剪
mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([sc(3), sc(3), sc(61), sc(61)], radius=sc(15), fill=255)
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# 3. 信封主体
d.rounded_rectangle([sc(11), sc(17), sc(53), sc(44)], radius=sc(5), fill=(255, 255, 255, 245))
# 4. 信封口的 V 形折线
d.line([(sc(12.5), sc(21.5)), (sc(32), sc(34.5)), (sc(51.5), sc(21.5))],
       fill=(0xe0, 0x65, 0x9b, 255), width=int(sc(2.6)), joint="curve")

# 5. 两道涟漪（白色）
def ripple(y0, depth, half, alpha, width):
    pts = []
    steps = 60
    for i in range(steps + 1):
        t = i / steps
        x = sc(32) + (t - 0.5) * 2 * half * k
        y = sc(y0) + sc(depth) * (1 - ((2 * t - 1) ** 2))
        pts.append((x, y))
    d.line(pts, fill=(255, 255, 255, alpha), width=int(sc(width)), joint="curve")

ripple(50.5, -2.6, 6.5, 230, 2.2)
ripple(56.0, -1.8, 4.25, 150, 1.8)

out = img.resize((W, W), Image.LANCZOS)
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon-180.png")
out.save(path, "PNG", optimize=True)
print("saved", path, out.size, os.path.getsize(path), "B")
"""
生成便携版图标（纯 Python，无第三方依赖）。
设计：蓝紫渐变圆角方块 + 三根白色竖条（对应「多栏对比」）。
输出：build/icon.png（512）与 build/icon.ico（多尺寸，PNG 压缩条目）。

用法：python scripts/make-icon.py
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')

# 渐变色：与界面主色一致
C1 = (0x4D, 0x6B, 0xFE)
C2 = (0x7A, 0x5C, 0xFF)

# 三根竖条的 (中心 x 比例, 高度比例)：高度不同，一眼看出是「对比」
BARS = ((0.355, 0.44), (0.500, 0.56), (0.645, 0.46))


def render(size, ss):
    """渲染 size×size 的 RGBA 像素，ss 倍超采样后盒式降采样"""
    n = size * ss
    pad = n * 0.03
    x0, y0 = pad, pad
    x1, y1 = n - pad, n - pad
    radius = n * 0.215

    bar_w = n * 0.115
    bar_r = n * 0.030
    mid_y = n * 0.5

    # 每个输出像素累计：覆盖到的样本颜色之和 + 覆盖次数
    sR = [0.0] * (size * size)
    sG = [0.0] * (size * size)
    sB = [0.0] * (size * size)
    sN = [0] * (size * size)

    for py in range(n):
        cy = py + 0.5
        for px in range(n):
            cx = px + 0.5

            # 圆角方块
            dx = max(x0 + radius - cx, 0.0, cx - (x1 - radius))
            dy = max(y0 + radius - cy, 0.0, cy - (y1 - radius))
            if math.hypot(dx, dy) > radius:
                continue

            # 渐变（左上 → 右下）
            t = (cx + cy) / (2.0 * n)
            r = C1[0] + (C2[0] - C1[0]) * t
            g = C1[1] + (C2[1] - C1[1]) * t
            b = C1[2] + (C2[2] - C1[2]) * t

            # 左上角柔和高光
            hl = max(0.0, 1.0 - math.hypot(cx - n * 0.22, cy - n * 0.18) / (n * 0.62))
            r = min(255.0, r + 26 * hl * hl)
            g = min(255.0, g + 22 * hl * hl)
            b = min(255.0, b + 14 * hl * hl)

            # 白色竖条
            for bx, bh in BARS:
                bcx = n * bx
                top = mid_y - n * bh / 2
                bottom = mid_y + n * bh / 2
                hx = max(bcx - bar_w / 2 + bar_r - cx, 0.0, cx - (bcx + bar_w / 2 - bar_r))
                hy = max(top + bar_r - cy, 0.0, cy - (bottom - bar_r))
                if math.hypot(hx, hy) <= bar_r:
                    r = g = b = 255.0
                    break

            idx = (py // ss) * size + (px // ss)
            sR[idx] += r
            sG[idx] += g
            sB[idx] += b
            sN[idx] += 1

    total = ss * ss
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            i = y * size + x
            count = sN[i]
            if count == 0:
                row += b'\x00\x00\x00\x00'
                continue
            alpha = round(255 * count / total)
            row += bytes(
                (
                    round(sR[i] / count),
                    round(sG[i] / count),
                    round(sB[i] / count),
                    alpha,
                )
            )
        rows.append(bytes(row))
    return rows


def png_bytes(size, rows):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def build_ico(pngs):
    """pngs: [(size, png)] -> .ico（PNG 压缩条目，Win10/11 原生支持）"""
    count = len(pngs)
    offset = 6 + 16 * count
    entries = b''
    blobs = b''
    for size, data in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return struct.pack('<HHH', 0, 1, count) + entries + blobs


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 512 只作为 png 母版；.ico 目录项的宽高各占 1 字节，最大只能到 256
    master = png_bytes(512, render(512, 2))
    with open(os.path.join(OUT_DIR, 'icon.png'), 'wb') as f:
        f.write(master)
    print('icon.png', len(master), 'bytes')

    sizes = [(256, 3), (128, 3), (64, 4), (48, 4), (32, 4), (16, 4)]
    pngs = [(size, png_bytes(size, render(size, ss))) for size, ss in sizes]
    ico = build_ico(pngs)
    with open(os.path.join(OUT_DIR, 'icon.ico'), 'wb') as f:
        f.write(ico)
    print('icon.ico', len(ico), 'bytes, entries:', [s for s, _ in pngs])


if __name__ == '__main__':
    main()

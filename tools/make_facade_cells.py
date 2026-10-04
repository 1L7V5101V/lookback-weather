#!/usr/bin/env python3
"""
从亚洲旧楼立面图集里切出可平铺的「开间单元」。

图集是手绘拼版，竖向不是规整开间网格，所以整张平铺会露馅。
做法：按楼层带切，每带含约 3 个开间，各存成一张独立小图，
让 city3d 每层随机挑一张，避免整栋楼出现明显重复。

用法: python tools/make_facade_cells.py <facade.jpg> <输出目录>
"""
import os
import sys

from PIL import Image

# 楼层带（y0, y1）与该带内的开间数
BANDS = [
    (60, 300, 3),
    (300, 540, 3),
    (540, 780, 3),
    (780, 1000, 3),
    (1020, 1240, 3),
]


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    im = Image.open(src).convert('RGB')
    W, H = im.size
    n = 0
    for bi, (y0, y1, bays) in enumerate(BANDS):
        if y1 > H:
            continue
        bw = W / bays
        for k in range(bays):
            # 稍微往里收一点，避免带上相邻开间的边缘线
            pad = 6
            x0 = int(k * bw + pad)
            x1 = int((k + 1) * bw - pad)
            cell = im.crop((x0, y0, x1, y1))
            # 统一缩到同一尺寸，方便按 UV 重复使用
            cell = cell.resize((384, 240), Image.LANCZOS)
            name = 'bay_b%d_%d.png' % (bi, k)
            cell.save(os.path.join(out, name))
            n += 1
            print('  %-18s <- 图集 x %4d..%4d  y %4d..%4d' % (name, x0, x1, y0, y1))
    print('\n共切出 %d 个开间单元 -> %s' % (n, out))


if __name__ == '__main__':
    main()

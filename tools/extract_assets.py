#!/usr/bin/env python3
"""
从 Wallpaper Engine 的 scene.pkg (PKGV0023) 提取图层素材。

容器结构（逆向自 3365960230 / 蓦然回首结尾动态时间变化）：

  "TEXV0005\\0"
  "TEXI0001\\0"  u32 x4 元数据, u32 width, u32 height, ...
  "TEXB0003\\0"  u32 count
                  每条: u32 level, i32 nameLen(-1=无), u32 format, u32 ?, u32 w, u32 h, u32 ?, u32 ?, u32 dataLen, data

  data 段要么是完整 PNG（89 50 4e 47 ... IEND），要么是裸像素。

用法:
  python tools/extract_assets.py <scene.pkg> <输出目录>
"""
import json
import os
import re
import struct
import sys


# ---------- scene.pkg (PKGV) ----------
def read_pkg(path):
    d = open(path, 'rb').read()
    if d[4:8] != b'PKGV':
        raise SystemExit('not a PKGV container: %s' % path)
    off = 16
    entries = []
    while off + 4 <= len(d):
        (nl,) = struct.unpack_from('<I', d, off)
        if not (3 < nl < 512):
            break
        raw = d[off + 4:off + 4 + nl]
        try:
            name = raw.decode('utf-8')
        except UnicodeDecodeError:
            break
        if not re.fullmatch(r'[\w\-./\u3000-\u9fff\u3040-\u30ff ]+\.\w+', name):
            break
        off += 4 + nl
        foff, size = struct.unpack_from('<II', d, off)
        off += 8
        entries.append((name, foff, size))
    return d, off, entries


# ---------- .tex (TEXV0005) ----------
PNG_SIG = b'\x89PNG\r\n\x1a\n'


def png_extent(blob, start):
    """返回从 start 开始的 PNG 的结束偏移（含 IEND 块），找不到返回 None。"""
    i = blob.find(PNG_SIG, start)
    if i < 0:
        return None
    p = i + 8
    while p + 8 <= len(blob):
        (length,) = struct.unpack_from('>I', blob, p)
        ctype = blob[p + 4:p + 8]
        p += 12 + length
        if ctype == b'IEND':
            return p
    return None


def read_tex(blob):
    """解析 .tex。

    TEXI 块里前 4 个 u32 是元数据，第 5/6 个是 width/height（已验证：
    天空5 -> 5120x2483，与 scene.json 里该层的 size 完全一致）。
    TEXB 块里每个图像记录的头部布局尚未完全确认，但**不需要确认**：
    直接扫 PNG 签名 + IEND 就能拿到完整的图像数据（mip0 通常最大）。
    """
    meta = {}
    i = blob.find(b'TEXI0001\x00')
    if i < 0:
        raise ValueError('no TEXI chunk')
    f = struct.unpack_from('<6I', blob, i + 9)
    meta['a'], meta['b'], meta['c'], meta['d'] = f[0], f[1], f[2], f[3]
    meta['width'], meta['height'] = f[4], f[5]

    pngs = []
    start = 0
    while True:
        s = blob.find(PNG_SIG, start)
        if s < 0:
            break
        e = png_extent(blob, s)
        if e is None:
            break
        pngs.append(blob[s:e])
        start = e
    return meta, pngs


def main():
    pkg_path = sys.argv[1] if len(sys.argv) > 1 else \
        r'E:/SteamLibrary/steamapps/workshop/content/431960/3365960230/scene.pkg'
    out_dir = sys.argv[2] if len(sys.argv) > 2 else 'lookback-weather/assets'
    os.makedirs(out_dir, exist_ok=True)

    blob, base, entries = read_pkg(pkg_path)
    report = []
    for name, off, size in entries:
        if not name.endswith('.tex'):
            continue
        stem = name.split('/')[-1][:-4]
        try:
            meta, pngs = read_tex(blob[base + off:base + off + size])
        except Exception as exc:                       # noqa: BLE001
            report.append((name, 'FAIL %s' % exc, 0))
            continue
        if not pngs:
            report.append((name, '%dx%d 压缩格式，未内嵌 PNG（跳过）'
                           % (meta['width'], meta['height']), 0))
            continue
        biggest = max(pngs, key=len)
        dst = os.path.join(out_dir, stem + '.png')
        open(dst, 'wb').write(biggest)
        report.append((name, '%dx%d  %d 张内嵌 PNG，取最大 %d KB'
                       % (meta['width'], meta['height'], len(pngs),
                          len(biggest) // 1024), len(biggest)))

    for name, info, n in sorted(report):
        print('%-46s %s' % (name, info))
    json.dump([{'src': n, 'info': i} for n, i, _ in report],
              open(os.path.join(out_dir, '_extract_report.json'), 'w',
                   encoding='utf-8'), ensure_ascii=False, indent=1)
    ok = sum(1 for _, _, n in report if n)
    print('\n%d/%d 个 .tex 导出为 PNG -> %s' % (ok, len(report), out_dir))


if __name__ == '__main__':
    main()

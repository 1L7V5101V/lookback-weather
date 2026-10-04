#!/usr/bin/env python3
"""
极简 FBX 7.3.0(binary) 解析器 —— 只取我们需要的东西。

目标：把美术给的 FBX 转成 city3d.js 能直接吃的小型二进制，
因此只解析 Geometry / Model / Material / Connections，
不做完整 FBX 规范（不支持 skin/animation/camera）。

用法:
  python tools/fbx_extract.py <build_001.fbx> <输出目录> [--mesh 名称过滤]
输出:
  <输出目录>/model.bin   自定义紧凑格式（见 HEADER）
  <输出目录>/model.json  元数据：部件、材质、包围盒、贴图清单
"""
import json
import os
import struct
import sys
import zlib

HEADER = b'LBFB0001'      # 魔数 + 版本


# ---------------------------------------------------------------- 底层读取
class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def raw(self, n):
        v = self.d[self.p:self.p + n]
        self.p += n
        return v

    def u32(self):
        v = struct.unpack_from('<I', self.d, self.p)[0]
        self.p += 4
        return v

    def f32(self):
        v = struct.unpack_from('<f', self.d, self.p)[0]
        self.p += 4
        return v

    def f64(self):
        v = struct.unpack_from('<d', self.d, self.p)[0]
        self.p += 8
        return v

    def i64(self):
        v = struct.unpack_from('<q', self.d, self.p)[0]
        self.p += 8
        return v


def read_property(r):
    t = chr(r.u8())
    if t == 'Y':
        return struct.unpack('<h', r.raw(2))[0]
    if t == 'C':
        return r.u8() != 0
    if t == 'I':
        return struct.unpack('<i', r.raw(4))[0]
    if t == 'F':
        return struct.unpack('<f', r.raw(4))[0]
    if t == 'D':
        return struct.unpack('<d', r.raw(8))[0]
    if t == 'L':
        return struct.unpack('<q', r.raw(8))[0]
    if t in 'fdlib':
        n = r.u32()
        enc = r.u32()
        clen = r.u32()
        blob = r.raw(clen)
        if enc == 1:
            blob = zlib.decompress(blob)
        fmt = {'f': 'f', 'd': 'd', 'l': 'q', 'i': 'i', 'b': 'b'}[t]
        return list(struct.unpack('<%d%s' % (n, fmt), blob))
    if t == 'S':
        n = r.u32()
        enc = r.u32()
        clen = r.u32()
        blob = r.raw(clen)
        if enc == 1:
            blob = zlib.decompress(blob)
        return blob.decode('utf-8', 'replace')
    if t == 'R':
        return r.raw(n_ := r.u32())
    raise ValueError('未知属性类型 %r @%d' % (t, r.p))


NULL13 = b'\x00' * 13


def read_node(r, end=None):
    """读一个节点记录。返回 (name, props, children) 或 None（空记录）。

    关键：每个含子节点的记录，其嵌套列表末尾都跟着一个 13 字节的 NULL 记录，
    位置正好在 EndOffset 处。不吃掉它，上层就会把 NULL 误当成下一个节点。
    """
    p0 = r.p
    if r.d[p0:p0 + 13] == NULL13:
        r.p += 13
        return None
    end_off = r.u32()
    n_props = r.u32()
    r.u32()                 # PropertyListLen（本解析器用不到）
    name_len = r.u8()
    name = r.raw(name_len).decode('utf-8', 'replace') if name_len else ''
    props = [read_property(r) for _ in range(n_props)]
    if end_off == 0:
        return None
    kids = []
    while r.p < end_off:
        sub = read_node(r)
        if sub is None:
            break
        kids.append(sub)
    if r.p == end_off and r.d[r.p:r.p + 13] == NULL13:
        r.p += 13
    return (name, props, kids)


# ---------------------------------------------------------------- 工具
def node_children(node, name):
    return [k for k in (node[2] if node else []) if k[0] == name]


def first(node, name):
    k = node_children(node, name)
    return k[0] if k else None


def find_all(node, name, out=None):
    if out is None:
        out = []
    if node is None:
        return out
    if node[0] == name:
        out.append(node)
    for k in node[2]:
        find_all(k, name, out)
    return out


def mat_mul(a, b):
    """4x4 行主序矩阵相乘 a*b。"""
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def trs_to_mat(t, r, s):
    """FBX 的 Rotation 是欧拉角(度)，Translation/Scaling 是欧拉角/缩放。"""
    rx, ry, rz = [v * 3.141592653589793 / 180.0 for v in r]
    cx, sx = __import__('math').cos(rx), __import__('math').sin(rx)
    cy, sy = __import__('math').cos(ry), __import__('math').sin(ry)
    cz, sz = __import__('math').cos(rz), __import__('math').sin(rz)
    # R = Rz * Ry * Rx
    m = [
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0,
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0,
        -sy, cy * sx, cy * cx, 0,
        0, 0, 0, 1]
    sx2, sy2, sz2 = s
    for i in range(3):
        m[i] *= sx2
        m[4 + i] *= sy2
        m[8 + i] *= sz2
    m[12], m[13], m[14] = t[0], t[1], t[2]
    return m


# ---------------------------------------------------------------- 主流程
def main():
    src = sys.argv[1]
    out = sys.argv[2]
    name_filter = None
    if '--mesh' in sys.argv:
        name_filter = sys.argv[sys.argv.index('--mesh') + 1]
    os.makedirs(out, exist_ok=True)

    data = open(src, 'rb').read()
    assert data[:21] == b'Kaydara FBX Binary  \x00', '不是 FBX binary'
    ver = struct.unpack_from('<I', data, 23)[0]
    r = Reader(data)
    r.p = 27
    # 顶层是一串节点记录，不是单个根节点。
    # 之前只读了一个（FBXHeaderExtension），所以 Objects 永远找不到。
    top = []
    while r.p < len(data) - 13:
        node = read_node(r, len(data))
        if node is None:      # NULL 记录 = 列表结束
            break
        top.append(node)
    print('FBX 版本 %d，顶层节点 %d 个: %s'
          % (ver, len(top), ', '.join(n[0] for n in top[:8])))

    root = ('ROOT', [], top)

    objects = first(root, 'Objects')
    conns = node_children(objects, 'C')

    # 连接表
    geo_of_model, mat_of_model, parent_of = {}, {}, {}
    for c in conns:
        p = c[1]
        if len(p) >= 3 and p[0] in ('OO', 'op'):
            parent_of.setdefault(p[2], []).append(p[1])
        if c[0] == 'C' and len(p) >= 3:
            kind = p[0]
            if kind == 'OO':
                parent_of.setdefault(p[2], []).append(p[1])
            elif kind == 'OB':
                geo_of_model.setdefault(p[1], []).append(p[2])
            elif kind == 'OM':
                mat_of_model.setdefault(p[1], []).append(p[2])
    print('连接: 模型->几何 %d, 模型->材质 %d' % (len(geo_of_model), len(mat_of_model)))

    geometries = {g[1][0]: g for g in find_all(objects, 'Geometry')}
    models = {m[1][0]: m for m in find_all(objects, 'Model')}
    materials = {m[1][0]: m for m in find_all(objects, 'Material')}
    print('Geometry %d, Model %d, Material %d' % (len(geometries), len(models), len(materials)))

    # 几何 -> 网格材质
    mesh_mat = {}
    for mid, gids in geo_of_model.items():
        for gid in gids:
            if gid in materials:
                nm = first(materials[gid], 'Name')
                mesh_mat.setdefault(gid, nm[1][0] if nm else 'default')
    for gid in geometries:
        mesh_mat.setdefault(gid, 'default')

    # 材质 -> 贴图
    mat_tex = {}
    for mat in materials.values():
        node = first(mat, 'Properties70')
        if not node:
            continue
        for p in node[2]:
            if p[0] == 'P':
                pname = p[1][0]
                if pname in ('DiffuseColor', 'NormalMap', 'SpecularColor'):
                    if p[2] and p[2][0] == 'S' and len(p[2]) > 3 and p[2][3]:
                        rel = p[2][3]
                        mat_tex.setdefault(mat[1][0], {})[pname] = rel
    if mat_tex:
        print('材质贴图:', json.dumps(mat_tex, ensure_ascii=False))

    parts = []
    blobs = []
    for mid, m in models.items():
        if m[1][1] != 'Mesh':
            continue
        if name_filter and name_filter not in m[1][2]:
            continue
        trs = [([0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]) for _ in range(1)][0]
        t = r_ = s = None
        for key, idx in (('Translation', 0), ('Rotation', 1), ('Scaling', 2)):
            n = first(m, 'Lcl ' + key)
            if n:
                v = list(n[1][1])
                if key == 'Translation':
                    t = v
                elif key == 'Rotation':
                    r_ = v
                else:
                    s = v
        M = trs_to_mat(t or [0, 0, 0], r_ or [0, 0, 0], s or [1, 1, 1])

        for gid in geo_of_model.get(mid, []):
            gnode = geometries.get(gid)
            if not gnode:
                continue
            verts_node = first(gnode, 'Vertices')
            poly_node = first(gnode, 'PolygonVertexIndex')
            if not verts_node or not poly_node:
                continue
            verts = verts_node[1][1]
            polys = poly_node[1][1]

            # 法线 / UV / 材质索引
            normals, uv, mat_idx = None, None, None
            for lay in node_children(gnode, 'LayerElementNormal'):
                nn = first(lay, 'Normals')
                if nn:
                    normals = (nn[1][1], lay[1][0], lay[1][1])
            for lay in node_children(gnode, 'LayerElementUV'):
                un = first(lay, 'UV') or first(lay, 'UVIndex')
                if un:
                    uv = (un[1][1], lay[1][0], lay[1][1], un[1][0])
            for lay in node_children(gnode, 'LayerElementMaterial'):
                mn = first(lay, 'Materials')
                if mn:
                    mat_idx = (mn[1][1], lay[1][0], lay[1][1])

            # 多边形扇形三角化
            tris = []
            i = 0
            while i < len(polys):
                loop = []
                while i < len(polys):
                    v = polys[i]
                    if v < 0:
                        loop.append((~v))
                        i += 1
                        break
                    loop.append(v)
                    i += 1
                for k in range(1, len(loop) - 1):
                    tris.append((loop[0], loop[k], loop[k + 1]))

            if not tris:
                continue
            idxmap = sorted(set(x for t3 in tris for x in t3))
            remap = {v: i for i, v in enumerate(idxmap)}
            n = len(idxmap)
            pos = [0.0] * (n * 3)
            nrm = [0.0] * (n * 3)
            tex = [0.0] * (n * 2)
            for i, v in enumerate(idxmap):
                x, y, z = verts[v * 3:v * 3 + 3]
                # 变换到世界
                pos[i * 3] = M[0] * x + M[1] * y + M[2] * z + M[12]
                pos[i * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[13]
                pos[i * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[14]
                if normals:
                    arr, mit, rit = normals
                    src = (i if mit == 'ByPolygonVertex' or mit == 'ByVertice'
                           else None)
                    nx = ny = nz = 0.0
                    if arr:
                        j = (v if mit == 'ByVertice' or mit == 'ByControlPoint' else i)
                        if rit == 'Direct':
                            nx, ny, nz = arr[j * 3:j * 3 + 3]
                        else:
                            k = idxmap.index(v) if False else v
                            if v < len(arr) // 3:
                                nx, ny, nz = arr[v * 3:v * 3 + 3]
                    nrm[i * 3] = M[0] * nx + M[1] * ny + M[2] * nz
                    nrm[i * 3 + 1] = M[4] * nx + M[5] * ny + M[6] * nz
                    nrm[i * 3 + 2] = M[8] * nx + M[9] * ny + M[10] * nz
                if uv:
                    arr, mit, rit, uidx = uv
                    j = (v if mit == 'ByVertice' or mit == 'ByControlPoint' else i)
                    if uidx:
                        if uidx[0] == 'eUseDirect':
                            j = v
                        else:
                            base = idxmap.index(v) if False else v
                            if v < len(uidx):
                                j = uidx[v]
                                j = (~j) if j < 0 else j
                    if j < len(arr) // 2:
                        tex[i * 2] = arr[j * 2]
                        tex[i * 2 + 1] = arr[j * 2 + 1]

            ind = []
            for a, b, c2 in tris:
                ind += [remap[a], remap[b], remap[c2]]

            # 材质分组（简化：整块用一个材质）
            matname = mesh_mat.get(gid, 'default')
            off = len(blobs)
            body = struct.pack('<%df' % len(pos), *pos)
            body += struct.pack('<%df' % len(nrm), *nrm)
            body += struct.pack('<%df' % len(tex), *tex)
            body += struct.pack('<%dI' % len(ind), *ind)
            blobs.append(body)
            parts.append(dict(name=m[1][2], gid=gid, material=matname,
                              vertices=n, indices=len(ind),
                              offset=off, length=len(body)))
            print('  部件 %-22s 顶点 %6d 三角 %6d 材质 %s'
                  % (m[1][2][:22], n, len(ind) // 3, matname))

    if not parts:
        print('没解析出任何网格')
        return 1

    meta = dict(version=1, parts=parts, materials=mat_tex)
    allp = []
    for p in parts:
        allp.append(p)
    # 包围盒
    minb = [1e30] * 3
    maxb = [-1e30] * 3
    for p in parts:
        off = p['offset']
        vp = struct.unpack_from('<%df' % (p['vertices'] * 3), blobs[0], off)
        for i in range(0, len(vp), 3):
            for k in range(3):
                minb[k] = min(minb[k], vp[i + k])
                maxb[k] = max(maxb[k], vp[i + k])
    meta['bbox'] = dict(min=minb, max=maxb)

    with open(os.path.join(out, 'model.bin'), 'wb') as f:
        f.write(HEADER)
        f.write(b''.join(blobs))
    json.dump(meta, open(os.path.join(out, 'model.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    total = os.path.getsize(os.path.join(out, 'model.bin'))
    print('\n包围盒 min=%s max=%s' % ([round(v, 2) for v in minb], [round(v, 2) for v in maxb]))
    print('model.bin %.2f MB, %d 个部件' % (total / 1048576, len(parts)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
# 用 Blender 把 FBX 转成紧凑二进制（避开 glTF 的开销，three.js 直接吃）
#
# 导出格式（.bin）：
#   "LBM1" 魔数
#   u32 partCount
#   每个 part: u32 nameLen + name(utf8), u32 matLen + mat(utf8),
#              u32 vcount, f32 pos[vcount*3], f32 nrm[vcount*3], f32 uv[vcount*2],
#              u32 icount, u32 idx[icount]
#
# 用法: blender -b --python tools/fbx_to_bin.py -- <fbx> <out.bin>
import bpy
import struct
import sys
import os

argv = sys.argv[sys.argv.index('--') + 1:]
src = argv[0]
dst = argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, use_anim=False)

# 收集网格，按材质分组
parts = []
seen = {}
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    me = obj.data
    me.calc_loop_triangles()
    if not me.loop_triangles:
        continue
    mat = ''
    if me.materials and me.materials[0]:
        mat = me.materials[0].name
    key = (obj.name, mat)
    if key in seen:
        continue
    seen[key] = 1

    mw = obj.matrix_world
    nv = len(me.vertices)
    pos = []
    nrm = []
    uv = []
    for v in me.vertices:
        co = mw @ v.co
        pos += [co.x, co.y, co.z]
        nrm += [v.normal.x, v.normal.y, v.normal.z]
    uvl = me.uv_layers.active
    for i in range(nv):
        if uvl:
            d = uvl.data[i].uv
            uv += [d[0], d[1]]
        else:
            uv += [0.0, 0.0]
    idx = []
    for t in me.loop_triangles:
        idx += [t.vertices[0], t.vertices[1], t.vertices[2]]
    parts.append((obj.name, mat, pos, nrm, uv, idx))
    print('  part %-28s mat=%-14s v=%-6d tri=%d'
          % (obj.name[:28], mat[:14], nv, len(idx) // 3))

# 整体变换：把模型摆到「原点在地、+Y 朝上」的 3D 场景里（three.js 习惯）
mn = [1e30] * 3
mx = [-1e30] * 3
for name, mat, pos, nrm, uv, idx in parts:
    for i in range(0, len(pos), 3):
        for k in range(3):
            mn[k] = min(mn[k], pos[i + k])
            mx[k] = max(mx[k], pos[i + k])
print('bbox min=%s max=%s' % ([round(v, 3) for v in mn], [round(v, 3) for v in mx]))
cx = (mn[0] + mx[0]) / 2.0
cz = (mn[2] + mx[2]) / 2.0

out = bytearray()
out += b'LBM1'
out += struct.pack('<I', len(parts))
for name, mat, pos, nrm, uv, idx in parts:
    # 居中到 XZ 原点，Y 从 0 起。
    # 注意：这一步是在 Blender 内部做的，FBX 导入器已经按 Z-up 把模型摆正，
    # 所以顶点是 (x, y, z)，其中 z 才是楼高（y 是平面尺寸）。
    npos = []
    nnrm = []
    for i in range(0, len(pos), 3):
        x, y, z = pos[i], pos[i + 1], pos[i + 2]
        # ---- 关键：Blender 是 Z-up，three.js 是 Y-up ----
        # 绕 X 轴 -90°：(x, y, z) -> (x, z, -y)
        # 这是一个真正的旋转（det=+1，手性不变），所以三角形绕序不用翻转。
        # 不做这一步的话，three.js 里 Y 会拿到 Blender 的 Z（真正的楼高），
        # 整栋楼就会「横躺」在屏幕纵深上。
        npos += [x - cx, z, -(y - cz)]
    nb = name.encode('utf-8')
    mb = mat.encode('utf-8')
    out += struct.pack('<I', len(nb)) + nb
    out += struct.pack('<I', len(mb)) + mb
    out += struct.pack('<I', len(npos) // 3)
    out += struct.pack('<%df' % len(npos), *npos)
    out += struct.pack('<%df' % len(nrm), *nrm)
    out += struct.pack('<%df' % len(uv), *uv)
    out += struct.pack('<I', len(idx))
    out += struct.pack('<%dI' % len(idx), *idx)

open(dst, 'wb').write(bytes(out))
print('写出 %s  %.2f MB  %d 个部件' % (dst, os.path.getsize(dst) / 1048576, len(parts)))

meta = dict(
    parts=[dict(name=n, material=m, vertices=len(p) // 3, tris=len(i) // 3)
           for n, m, p, nr, u, i in parts],
    size=[round(mx[0] - mn[0], 4), round(mx[1] - mn[1], 4), round(mx[2] - mn[2], 4)]
)
import json
json.dump(meta, open(os.path.splitext(dst)[0] + '.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
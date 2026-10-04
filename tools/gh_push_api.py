#!/usr/bin/env python3
"""
git 协议在这个网络下会被 RST/超时，但 api.github.com 走得通（gh 能建仓库就是证据）。
所以改用 GitHub REST API 上传：blob -> tree -> commit -> ref。

用法: python tools/gh_push_api.py <owner/repo> <本地目录> <message>
"""
import base64
import json
import os
import subprocess
import sys
import tempfile


def gh(api_path, body=None, method='GET'):
    """调用 gh api。body 非空时走 POST + --input。"""
    cmd = ['gh', 'api', api_path, '--method', method]
    tmp = None
    if body is not None:
        tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False,
                                         encoding='utf-8')
        json.dump(body, tmp, ensure_ascii=False)
        tmp.close()
        cmd += ['--input', tmp.name]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip()[:400])
        out = (r.stdout or '').strip()
        return json.loads(out) if out else None
    finally:
        if tmp:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass


SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'assets'}


def collect(root, exclude_rel):
    """收集要上传的文件；exclude_rel 是相对 root 的排除前缀列表。"""
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, root).replace('\\', '/')
            if any(rel == e or rel.startswith(e + '/') for e in exclude_rel):
                continue
            files.append((rel, full))
    return sorted(files)


def init_repo(repo, root):
    """空仓库上 git/blobs 会报 409，先用 Contents API 建一个首 commit。"""
    import base64 as _b64
    body = {
        'message': 'chore: init repository',
        'content': _b64.b64encode(b'# lookback-weather').decode(),
        'branch': 'main'
    }
    try:
        r = gh('repos/%s/contents/.init' % repo, body, 'PUT')
        print('已初始化空仓库 (首 commit %s)' % r['commit']['sha'][:8])
        return r['commit']['sha']
    except RuntimeError as e:
        if 'already exists' in str(e):
            print('仓库已有内容，跳过初始化')
            return None
        raise


def main():
    repo = sys.argv[1]
    root = sys.argv[2]
    msg = sys.argv[3] if len(sys.argv) > 3 else 'update'
    # 排除：版权素材、gitignore 管的那些（用 git 自己算出来的清单最准）
    tracked = subprocess.run(['git', 'ls-files'], capture_output=True,
                            text=True, cwd=root).stdout.split('\n')
    tracked = [t for t in tracked if t.strip()]
    print('待上传 %d 个文件（取自 git ls-files，已排除未入库的素材）' % len(tracked))

    base = init_repo(repo, root)

    tree = []
    for i, rel in enumerate(tracked, 1):
        full = os.path.join(root, rel)
        with open(full, 'rb') as f:
            raw = f.read()
        binary = rel.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bin'))
        body = {'content': base64.b64encode(raw).decode() if binary
                else raw.decode('utf-8', 'replace'),
                'encoding': 'base64' if binary else 'utf-8'}
        r = gh('repos/%s/git/blobs' % repo, body, 'POST')
        tree.append({'path': rel, 'mode': '100644', 'type': 'blob',
                     'sha': r['sha']})
        print('  [%2d/%d] %s' % (i, len(tracked), rel))

    tree_sha = gh('repos/%s/git/trees' % repo, {'tree': tree}, 'POST')['sha']
    print('tree: %s' % tree_sha)

    commit = gh('repos/%s/git/commits' % repo,
                {'message': msg, 'tree': tree_sha,
                 'parents': [base] if base else []}, 'POST')
    print('commit: %s' % commit['sha'])

    ref = 'repos/%s/git/refs' % repo
    try:
        gh(ref, {'ref': 'refs/heads/main', 'sha': commit['sha']}, 'POST')
        print('已创建 refs/heads/main')
    except RuntimeError as e:
        if 'already exists' not in str(e):
            raise
        gh(ref + '/heads/main', {'sha': commit['sha'], 'force': False}, 'PATCH')
        print('已更新 refs/heads/main')
    print('\n完成: https://github.com/%s' % repo)


if __name__ == '__main__':
    main()

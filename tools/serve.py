#!/usr/bin/env python3
"""本地预览服务器（开发用）。

和 `python -m http.server` 的唯一区别：对所有响应加 `Cache-Control: no-store`。
浏览器会把 js/css 缓存得很死，改完 sun.js 刷新还是旧代码，很容易把「以为没改」
误判成「改了没效果」。开发期禁掉缓存省掉这个坑。

    python tools/serve.py            # 8777
    python tools/serve.py 8080       # 换端口
"""
import sys
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lookback-weather')


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 别刷屏


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    print('蓦然回首 · 实时天气壁纸')
    print('  目录:', os.path.normpath(ROOT))
    print('  地址: http://127.0.0.1:%d/index.html?panel=1&hud=1' % port)
    print('  已禁用缓存，改完 js 刷新即生效')
    print('  Ctrl+C 停止\n')
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
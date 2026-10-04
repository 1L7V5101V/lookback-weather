@echo off
REM 启动本地预览服务器并打开浏览器
setlocal
set PORT=8777
set DIR=%~dp0..\lookback-weather

echo.
echo   蓦然回首 · 实时天气壁纸 —— 本地预览
echo   ----------------------------------------
echo   目录: %DIR%
echo   地址: http://127.0.0.1:%PORT%/index.html?panel=1^&hud=1
echo   提示: 用 serve.py 而不是 http.server —— 它会禁掉浏览器缓存，
echo         否则改完 js 刷新出来还是旧代码。
echo   停止: 关闭本窗口，或 Ctrl+C
echo.

cd /d "%DIR%"
start "" "http://127.0.0.1:%PORT%/index.html?panel=1&hud=1"
python "%~dp0serve.py" %PORT%
endlocal

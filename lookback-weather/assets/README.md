# assets —— 这里应该放什么

**仓库里不含这些文件**，因为它们是第三方作品，不能随仓库分发。
克隆后请自行准备，否则壁纸会只显示房间、窗外是空的（代码不会崩，只会给控制台警告）。

## 1. 房间与人物（2D 层）

来自 Wallpaper Engine 创意工坊 **[3365960230](https://steamcommunity.com/sharedfiles/filedetails/?id=3365960230)
《蓦然回首结尾动态时间变化》**，作者 **被_整除**。属于第三方作品，仅供本地研究/调试。

放入 `lookback-weather/assets/`：

| 文件 | 用途 | 备注 |
|---|---|---|
| `屋内.png` | 房间 + 窗框 + 桌面 | **必需**。它的 alpha 正好是干净窗洞，伪 2D 靠它合成 |
| `身体.png` `左手.png` `右手.png` | 人物 | 呼吸动画层 |
| `书.png` `塑料袋.png` | 桌面小物 | 摆动层 |
| `房屋.png` `房屋2~5.png` `夜晚.png` `熄灯后.png` `天空5.png` `msg_0.png` `回首_0012_2.png` `回首_0006_5.png` | 预渲染时段图 | **只在关闭 3D 外景时用**（面板里取消勾选「three.js 3D 外景」），可只放 `屋内` |

其中 `房屋*.png` 的 alpha 通道还能被 2D 模式的太阳阴影（`js/sunshade.js`）提取成天际线高度场。

## 2. 3D 城市素材

`lookback-weather/assets/city/`，两套：

| 文件 | 来源 | 说明 |
|---|---|---|
| `build_001.bin` | 你自备的 FBX（亚洲旧楼）经 `tools/fbx_to_bin.py` 转换 | 必需（若要用 3D）。格式见该脚本头部注释 |
| `build_001.json` | 同上，部件元数据 | 可选 |
| `apartment.jpg` `rooftop.jpg` `concrete.jpg` `concrete01.jpg` `facade.jpg` | 同上的贴图 | 缺失时会退回素色 |
| `bays/` | `facade.jpg` 切出的开间单元 | 可选，给占位方块升级立面用（代码已备好，默认关闭） |

生成方式：

```bash
# FBX -> LBM1 二进制
blender -b --python tools/fbx_to_bin.py -- \
    "/path/to/build_001.fbx" lookback-weather/assets/city/build_001.bin

# 立面图集切可平铺开间
python tools/make_facade_cells.py \
    lookback-weather/assets/city/facade.jpg lookback-weather/assets/city/bays
```

## 3. 反向工具

如果素材还没到手，可以用 `tools/extract_assets.py` 从工坊项目的 `scene.pkg` 里
提取 `.tex` 内嵌的 PNG（这些 `.tex` 里有 17/29 是明文 PNG，其余是压缩格式，需另写解码器）：

```bash
python tools/extract_assets.py \
    "E:/SteamLibrary/steamapps/workshop/content/431960/3365960230/scene.pkg" \
    lookback-weather/assets
```

## 发布到创意工坊前请注意

替换掉上面所有第三方素材后再发布。本仓库只提供代码。

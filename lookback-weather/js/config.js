/* config.js —— 全局配置与图层清单
 *
 * 想换美术？只改 LAYERS 里的 file 和几何，代码不用动。
 * 坐标系沿用原壁纸的虚拟画布 5120x2592（相机中心 2560,1296），
 * 这样从 scene.json 抠出来的 origin/size 可以直接用。
 */
window.LB = window.LB || {};

(function (LB) {
	'use strict';

	LB.VIEW = {
		W: 5120,
		H: 2592,
		CX: 2560,
		CY: 1296
	};

	/* 窗户在画面里的位置（虚拟坐标，注意 +y 朝上，所以 y 大的在屏幕上方）。
	 * 原壁纸的 shake 遮罩是压缩纹理解不出来，这里按画面比例标定：
	 * 窗户开口约占画面上半部 2/3，是光柱、尘埃、雨落点的依据。 */
	LB.WINDOW = { x: 120, y: 860, w: 4880, h: 1700 };

	/* 窗户玻璃（真正的孔径）—— 光柱就是它沿光线方向的剪切投影。
	 * 比 WINDOW 略小一圈，代表窗框内侧。 */
	LB.WINDOW_GLASS = { x: 240, y: 1180, w: 4640, h: 1180 };

	/* 时间源：real = 城市真实太阳 / clock = 系统时钟 / manual = 锁定小时 */
	LB.defaults = {
		locateMode: 'auto',
		cityInput: '北京',
		latLonInput: '39.9042,116.4074',
		solarMode: 'real',
		manualHour: 18,
		windowDir: 180,
		windowFine: 0,
		weatherAuto: true,
		cloudLowOv: 30,
		cloudMidOv: 25,
		cloudHighOv: 15,
		rainOverride: 0,
		windOverride: 10,
		windDirOv: 270,       // 手动风向（来向，0=北 90=东 180=南 270=西）
		wmoOverride: -1,        // -1 = 由云量/雨量自动推断；>=0 = 强制 WMO code
		autoRefreshMin: 30,
		leafSize: 0.8,
		rainSize: 0.6,
		shaftSize: 1,
		titleText: 'LOOK BACK',
		signText: '',
		showClock: true,
		parallax: 0.35,
		parallax3d: 0.55,    // 3D 模式下移动摄像机的幅度（0=锁死，1=窗宽约 1/4）
		showHud: false,
		devPanel: false,
		sunShade: 1.0,       // 2.5D 太阳阴影强度（仅 2D 模式），0=关闭
		city3d: true,        // 用 three.js 漫画风 3D 外景
		city3dScale: 0.6     // 3D 渲染分辨率比例
	};

	/* 覆盖 WE 用户属性；普通浏览器里跑时用默认值 */
	LB.props = Object.assign({}, LB.defaults);

	/* ---------------- 图层清单（换图改这里） ----------------
	 * kind:
	 *   'sky'    天空/云带 —— 横向无缝平移，做视差；受云量控制不透明度
	 *   'room'   室内+窗框+远景楼 —— 不平移，按太阳高度角交叉淡化
	 *   'front'  近景（人物/手/稿纸/塑料袋）—— 呼吸或摆动
	 *
	 * slot: 时间槽位，由 sun.js 按太阳高度角 + 上午/下午决定权重
	 *   dawn(黎明) morningLow(上午低角) noon(正午) afternoon(午后)
	 *   sunset(日落) dusk(暮光) night(夜) lateNight(深夜)
	 */
	LB.LAYERS = [
		// ---- 天空 / 云带（最远，横向无缝平移）----
		{ id: 'msg_0', file: 'assets/msg_0.png', kind: 'sky', slot: 'dawn',
		  cx: 2560, cy: 1634, w: 4096, h: 1529, scale: 1.25,
		  cloud: 'mid', parallax: 0.15, tint: 0.85 },
		{ id: 'sky_0012', file: 'assets/回首_0012_2.png', kind: 'sky', slot: ['morningLow', 'noon'],
		  cx: 2560, cy: 1555, w: 4096, h: 1784, scale: 1.25,
		  cloud: 'mid', parallax: 0.22, tint: 1.0 },
		{ id: 'sky_0006', file: 'assets/回首_0006_5.png', kind: 'sky', slot: 'afternoon',
		  cx: 2560, cy: 1783, w: 7676, h: 2822, scale: 0.68149,
		  cloud: 'mid', parallax: 0.28, tint: 0.95 },
		{ id: 'sky_5', file: 'assets/天空5.png', kind: 'sky', slot: 'sunset',
		  cx: 2560, cy: 1494, w: 5120, h: 2483, scale: 1,
		  cloud: 'low', parallax: 0.45, tint: 1.0 },

		// ---- 室内（房间 + 窗框 + 远景楼）----
		/* 以下 5 张是原作的预渲染时段图，3D 模式下用不到（3D 自带光照） */
		{ id: 'room_1', file: 'assets/房屋.png', kind: 'room', slot: 'dawn', hidden3d: true,
		  cx: 2560, cy: 1296, w: 5120, h: 2592 },
		{ id: 'room_2', file: 'assets/房屋2.png', kind: 'room', hidden3d: true, slot: 'morningLow',
		  cx: 2560, cy: 1418, w: 5120, h: 2419 },
		{ id: 'room_3', file: 'assets/房屋3.png', kind: 'room', hidden3d: true, slot: 'noon',
		  cx: 2560, cy: 1306, w: 5120, h: 2064 },
		{ id: 'room_4', file: 'assets/房屋4.png', kind: 'room', hidden3d: true, slot: 'afternoon',
		  cx: 2560, cy: 1249, w: 5120, h: 1965 },
		{ id: 'room_5', file: 'assets/房屋5.png', kind: 'room', hidden3d: true, slot: 'sunset',
		  cx: 2560, cy: 1238, w: 5120, h: 1979 },
		{ id: 'room_night', file: 'assets/夜晚.png', kind: 'room', slot: ['dusk', 'night'], hidden3d: true,
		  cx: 2614, cy: 1320, w: 5114, h: 2620 },
		{ id: 'room_in', file: 'assets/屋内.png', kind: 'room', slot: 'always',
		  cx: 2560, cy: 1296, w: 5120, h: 2592 },
		{ id: 'lights_off', file: 'assets/熄灯后.png', kind: 'room', slot: 'lateNight', hidden3d: true,
		  cx: 2558, cy: 1296, w: 5120, h: 2880 },

		// ---- 近景（呼吸 / 摆动）----
		{ id: 'hand_r', file: 'assets/右手.png', kind: 'front', slot: 'always',
		  cx: 2799, cy: 518, w: 348, h: 340, motion: 'breathe', amp: 3.0, friction: 1.0 },
		{ id: 'body', file: 'assets/身体.png', kind: 'front', slot: 'always',
		  cx: 2553, cy: 470, w: 551, h: 939, motion: 'breathe', amp: 1.8, friction: 2.5 },
		{ id: 'hand_l', file: 'assets/左手.png', kind: 'front', slot: 'always',
		  cx: 2295, cy: 512, w: 376, h: 353, motion: 'breathe', amp: 3.0, friction: 1.0 },
		{ id: 'book', file: 'assets/书.png', kind: 'front', slot: 'always',
		  cx: 1556, cy: 356, w: 374, h: 226, motion: 'sway', amp: 2.0 },
		{ id: 'bag', file: 'assets/塑料袋.png', kind: 'front', slot: 'always',
		  cx: 3645, cy: 596, w: 462, h: 250, motion: 'sway', amp: 14.0 }
	];

	/* 用于提取城市天际线高度场的参考层：它的 alpha 通道就是干净的城市剪影。
	 * 换素材后如果天际线变了，改这里的 file 指到新的那张。 */
	LB.SHADE_REF = { file: 'assets/房屋3.png', gridW: 1536 };

	/* 太阳高度角 -> 时间槽位权重。
	 * 这是本项目对原作最核心的一处替换：
	 * 原作用「系统时钟小时」切图，我们用「太阳高度角 + 上午/下午」切图，
	 * 于是换时区、换纬度、换季节都对得上。 */
	LB.SLOTS = {
		lateNight: { elev: [-90, -14], morning: null },
		dusk:      { elev: [-14, -6],  morning: null },
		sunset:    { elev: [-6, 4],    morning: false },
		dawn:      { elev: [-6, 4],    morning: true },
		morningLow:{ elev: [4, 22],    morning: true },
		afternoon: { elev: [4, 22],    morning: false },
		noon:      { elev: [22, 75],   morning: null },
		always:    { elev: [-90, 90],  morning: null }
	};

	/* WMO weather code -> 修正参数 */
	LB.WMO = {
		0:  { name: '晴',       cloud: 5,  dim: 0.0,  desat: 0.0,  sat: 1.0 },
		1:  { name: '大部晴朗',   cloud: 25, dim: 0.0,  desat: 0.05, sat: 1.0 },
		2:  { name: '多云',      cloud: 55, dim: 0.06, desat: 0.10, sat: 0.96 },
		3:  { name: '阴',        cloud: 95, dim: 0.20, desat: 0.28, sat: 0.85 },
		45: { name: '雾',        cloud: 90, dim: 0.26, desat: 0.42, sat: 0.7 },
		48: { name: '雾凇',      cloud: 90, dim: 0.26, desat: 0.42, sat: 0.7 },
		51: { name: '小毛毛雨',   cloud: 80, dim: 0.18, desat: 0.3,  sat: 0.8 },
		53: { name: '毛毛雨',     cloud: 85, dim: 0.22, desat: 0.34, sat: 0.78 },
		55: { name: '浓毛毛雨',   cloud: 90, dim: 0.26, desat: 0.38, sat: 0.75 },
		56: { name: '冻毛毛雨',   cloud: 90, dim: 0.26, desat: 0.38, sat: 0.75 },
		57: { name: '冻毛毛雨',   cloud: 92, dim: 0.28, desat: 0.4,  sat: 0.72 },
		61: { name: '小雨',      cloud: 88, dim: 0.24, desat: 0.36, sat: 0.76 },
		63: { name: '中雨',      cloud: 92, dim: 0.32, desat: 0.44, sat: 0.7 },
		65: { name: '大雨',      cloud: 96, dim: 0.44, desat: 0.55, sat: 0.62 },
		66: { name: '冻雨',      cloud: 94, dim: 0.36, desat: 0.46, sat: 0.68 },
		67: { name: '冻雨',      cloud: 96, dim: 0.46, desat: 0.56, sat: 0.62 },
		71: { name: '小雪',      cloud: 92, dim: 0.2,  desat: 0.5,  sat: 0.6 },
		73: { name: '中雪',      cloud: 95, dim: 0.26, desat: 0.6,  sat: 0.55 },
		75: { name: '大雪',      cloud: 98, dim: 0.34, desat: 0.68, sat: 0.5 },
		77: { name: '雪粒',      cloud: 90, dim: 0.24, desat: 0.55, sat: 0.55 },
		80: { name: '阵雨',      cloud: 70, dim: 0.2,  desat: 0.32, sat: 0.8 },
		81: { name: '强阵雨',     cloud: 85, dim: 0.3,  desat: 0.42, sat: 0.72 },
		82: { name: '暴雨',      cloud: 95, dim: 0.45, desat: 0.55, sat: 0.6 },
		85: { name: '阵雪',      cloud: 80, dim: 0.2,  desat: 0.55, sat: 0.6 },
		86: { name: '强阵雪',     cloud: 92, dim: 0.28, desat: 0.62, sat: 0.55 },
		95: { name: '雷阵雨',     cloud: 95, dim: 0.45, desat: 0.5,  sat: 0.65 },
		96: { name: '雷阵雨伴冰雹', cloud: 96, dim: 0.5, desat: 0.55, sat: 0.6 },
		99: { name: '强雷暴冰雹',  cloud: 98, dim: 0.58, desat: 0.62, sat: 0.55 }
	};
})(window.LB);

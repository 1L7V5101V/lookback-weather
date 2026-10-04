/* main.js —— Wallpaper Engine 接口 + 主循环
 *
 * WE 注入的接口（实测自 bin/webwallpaper64.exe）：
 *   window.wallpaperPropertyListener.applyUserProperties(props, context)
 *   window.wallpaperPropertyListener.applyGeneralProperties(props)
 *   window.wallpaperRegisterAudioListener(callback, frequency)   // 频谱
 *
 * 注意：普通浏览器里打开时这些接口不存在，所以全部做了存在性判断，
 * 这样同一份代码既能跑在 WE 里，也能在 localhost 上直接调试。
 */
(function (LB) {
	'use strict';

	const canvas = document.getElementById('stage');
	const glCanvas = document.getElementById('gl');
	const hud = document.getElementById('hud');
	const errBox = document.getElementById('err');

	const scene = new LB.Scene();
	const city3d = new LB.City3D(glCanvas);
	const renderer = new LB.Renderer(canvas, scene, city3d);

	/* 调试句柄：控制台里可以直接摸 LB.renderer.shade 等内部对象 */
	LB.scene = scene;
	LB.renderer = renderer;
	LB.city3d = city3d;

	let env = null;
	let paused = false;
	let audioEnergy = 0;

	/* ---------------- 鼠标视差 ---------------- */
	const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
	window.addEventListener('mousemove', (e) => {
		mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
		mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
	});

	/* ---------------- 面板样式（调参面板自己注入，避免污染主样式） ---------------- */
	function injectStyle() {
		if (document.getElementById('lp-style')) return;
		const s = document.createElement('style');
		s.id = 'lp-style';
		s.textContent =
			'.lp-root{position:fixed;top:0;right:0;width:436px;max-height:100vh;' +
			'display:none;flex-direction:column;z-index:9999;' +
			'background:rgba(10,13,19,.93);border-left:1px solid rgba(150,190,255,.16);' +
			'color:#cfe0ff;font:12px/1.5 "Microsoft YaHei",system-ui,sans-serif;' +
			'backdrop-filter:blur(6px)}' +
			'.lp-root.on{display:flex}' +
			'.lp-head{display:flex;align-items:center;justify-content:space-between;' +
			'padding:8px 10px;border-bottom:1px solid rgba(150,190,255,.16);position:sticky;top:0;' +
			'background:rgba(14,18,26,.96)}' +
			'.lp-title{font-weight:700;letter-spacing:.5px}' +
			'.lp-x{background:none;border:0;color:#8fa6c8;font-size:18px;cursor:pointer;line-height:1}' +
			'.lp-readout{padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:11px;' +
			'color:#a8c4e8;border-bottom:1px solid rgba(150,190,255,.12)}' +
			'.lp-readout b{color:#ffd479}' +
			'.lp-presets{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;' +
			'border-bottom:1px solid rgba(150,190,255,.12)}' +
			'.lp-body{overflow-y:auto;padding:4px 0 20px}' +
			'.lp-sec-t{padding:8px 10px 4px;color:#ffd479;font-weight:700;' +
			'border-top:1px solid rgba(150,190,255,.12);margin-top:4px}' +
			'.lp-row{display:flex;align-items:center;gap:8px;padding:3px 10px}' +
			'.lp-row>label{flex:0 0 92px;color:#9fb4d4}' +
			'.lp-ctl{flex:1;display:flex;align-items:center;gap:6px;min-width:0}' +
			'.lp-hint{padding:0 10px 4px 100px;color:#6d809e;font-size:11px;line-height:1.4}' +
			'.lp-slider{display:flex;align-items:center;gap:6px;width:100%}' +
			'.lp-slider input[type=range]{flex:1;min-width:0;accent-color:#5b9cff;height:16px}' +
			'.lp-val{flex:0 0 46px;text-align:right;font-family:ui-monospace,Consolas,monospace;' +
			'color:#ffd479;font-size:11px}' +
			'.lp-root select,.lp-root input[type=text]{flex:1;min-width:0;background:#161c26;color:#cfe0ff;' +
			'border:1px solid rgba(150,190,255,.22);border-radius:3px;padding:2px 4px;font-size:11px}' +
			'.lp-root input[type=checkbox]{accent-color:#5b9cff;width:14px;height:14px}' +
			'.lp-btn{background:#1c2432;color:#cfe0ff;border:1px solid rgba(150,190,255,.22);' +
			'border-radius:3px;padding:3px 7px;cursor:pointer;font-size:11px}' +
			'.lp-btn:hover{background:#27344a}' +
			'.lp-preset{background:#212a3a}' +
			'.lp-primary{background:#274a7d;border-color:#3d6fb5}' +
			'.lp-btns{display:flex;gap:6px;padding:6px 10px;flex-wrap:wrap;align-items:center}' +
			/* ---- 楼群布局：表格表单 ---- */
			'.lp-form{padding:0 6px}' +
			'.lp-tbl{width:100%;border-collapse:collapse;font-size:11px}' +
			'.lp-tbl th{color:#8fa6c8;font-weight:400;text-align:center;padding:3px 2px;' +
			'  border-bottom:1px solid rgba(150,190,255,.2)}' +
			'.lp-tbl td{padding:1px 2px;text-align:center}' +
			'.lp-tbl tr:nth-child(even){background:rgba(255,255,255,.03)}' +
			'.lp-tbl tr.hero{background:rgba(255,205,110,.11)}' +
			'.lp-idx{color:#6d809e}' +
			'.lp-cell{display:block}' +
			'.lp-tbl input[type=number]{width:46px;background:#161c26;color:#cfe0ff;' +
			'  border:1px solid rgba(150,190,255,.2);border-radius:3px;padding:1px 2px;' +
			'  font-size:11px;text-align:center}' +
			'.lp-tbl input[type=checkbox]{accent-color:#5b9cff;width:14px;height:14px}' +
			'.lp-del{background:none;border:0;color:#e08b8b;cursor:pointer;font-size:14px;line-height:1}' +
			'.lp-ok{background:#1f5c3a;border-color:#2f8a56}' +
			'.lp-warn{background:#5c3a1f;border-color:#8a5a2f}' +
			'.lp-import{border-color:rgba(127,230,255,.35)}' +
			'.lp-json{width:calc(100% - 20px);margin:2px 10px;background:#0e131b;color:#9fb4d4;' +
			'  border:1px solid rgba(150,190,255,.2);border-radius:3px;font:10px/1.4 monospace;padding:4px}';
		document.head.appendChild(s);
	}

	/* ---------------- WE 用户属性 ---------------- */
	/* 调试用：非 WE 环境下支持 ?hud=1&city=北京&lon=116.4&lat=39.9&mode=real&hour=18&win=180
	 * 在 WE 里这些参数会被用户属性覆盖，所以只是本地调试的便利通道。 */
	function devOverrides() {
		const q = new URLSearchParams(location.search);
		/* 简写 -> 正式属性名，方便命令行/浏览器调试 */
		const alias = { mode: 'solarMode', hour: 'manualHour', win: 'windowDir',
			dark: 'windowFine', cloud: 'cloudLowOv', rain: 'rainOverride',
			wind: 'windOverride', title: 'titleText', sign: 'signText',
			panel: 'devPanel', wmo: 'wmoOverride' };
		const o = {};
		q.forEach((v, k) => { o[alias[k] || k] = v; });
		if (q.get('hud') === '1') o.showHud = 'true';
		if (q.get('panel') === '1') o.devPanel = 'true';
		return o;
	}

	function applyProps(props) {
		const inWE = !!window.wallpaperPropertyListener;
		const src = Object.assign({}, devOverrides(), props || {});
		const def = LB.defaults;

		/* WE 传进来的值类型不固定：布尔可能是 true/"true"/1，这里统一规整 */
		function bool(v, d) {
			if (v === undefined || v === null) return d;
			if (typeof v === 'string') return v === 'true' || v === '1';
			return !!v;
		}
		function num(v, d) {
			const n = parseFloat(v);
			return isFinite(n) ? n : d;
		}

		const geoChanged =
			src.locateMode !== undefined || src.cityInput !== undefined ||
			src.latLonInput !== undefined;


		LB.props = {
			locateMode: src.locateMode !== undefined ? String(src.locateMode) : def.locateMode,
			cityInput: src.cityInput !== undefined ? String(src.cityInput) : def.cityInput,
			latLonInput: src.latLonInput !== undefined ? String(src.latLonInput) : def.latLonInput,
			solarMode: src.solarMode !== undefined ? String(src.solarMode) : def.solarMode,
			manualHour: num(src.manualHour, def.manualHour),
			windowDir: num(src.windowDir, def.windowDir),
			windowFine: num(src.windowFine, def.windowFine),
			weatherAuto: bool(src.weatherAuto, def.weatherAuto),
			cloudOverride: num(src.cloudOverride, def.cloudOverride),
			rainOverride: num(src.rainOverride, def.rainOverride),
			windOverride: num(src.windOverride, def.windOverride),
			autoRefreshMin: num(src.autoRefreshMin, def.autoRefreshMin),
			leafSize: num(src.leafSize, def.leafSize),
			rainSize: num(src.rainSize, def.rainSize),
			shaftSize: num(src.shaftSize, def.shaftSize),
			titleText: src.titleText !== undefined ? String(src.titleText) : def.titleText,
			signText: src.signText !== undefined ? String(src.signText) : def.signText,
			showClock: bool(src.showClock, def.showClock),
			parallax: num(src.parallax, def.parallax),
			showHud: bool(src.showHud, def.showHud),
			devPanel: bool(src.devPanel, def.devPanel),
			cloudLowOv: num(src.cloudLowOv, def.cloudLowOv),
			cloudMidOv: num(src.cloudMidOv, def.cloudMidOv),
			cloudHighOv: num(src.cloudHighOv, def.cloudHighOv),
			sunShade: num(src.sunShade, def.sunShade),
			city3d: bool(src.city3d, def.city3d),
			city3dScale: num(src.city3dScale, def.city3dScale),
			wmoOverride: num(src.wmoOverride, def.wmoOverride),
			windDirOv: num(src.windDirOv, def.windDirOv)
		};

		hud.classList.toggle('on', LB.props.showHud);
		if (LB.Panel) {
			injectStyle();
			if (LB.props.devPanel) LB.Panel.show(); else LB.Panel.hide();
		}
		if (geoChanged && inWE) LB.Weather.onPropsChanged();
		if (!inWE && (q_has('city') || q_has('lat') || q_has('lon'))) {
			const S = LB.Weather.state;
			const q = new URLSearchParams(location.search);
			if (q.has('lat')) S.lat = parseFloat(q.get('lat')) || S.lat;
			if (q.has('lon')) S.lon = parseFloat(q.get('lon')) || S.lon;
			if (q.has('city')) S.cityName = q.get('city');
			LB.Weather.onPropsChanged();
		}
	}
	function q_has(k) { return new URLSearchParams(location.search).has(k); }

	if (window.wallpaperPropertyListener) {
		window.wallpaperPropertyListener.applyUserProperties = applyProps;
		window.wallpaperPropertyListener.applyGeneralProperties = function () { };
		window.wallpaperPropertyListener.setPaused = function (v) {
			paused = !!v;
			if (!v && window.___wpxUnpause) window.___wpxUnpause();
		};
	}

	/* 音频响应：保留原作的音频响应能力，
	 * 让光柱在音乐里有轻微呼吸（音频能量只作为小幅调制，不喧宾夺主） */
	if (typeof window.wallpaperRegisterAudioListener === 'function') {
		try {
			window.wallpaperRegisterAudioListener(function (data) {
				let s = 0;
				if (data && data.length) {
					for (let i = 0; i < data.length; i += 4) s += data[i] || 0;
					s /= (data.length / 4) || 1;
				}
				audioEnergy += (s - audioEnergy) * 0.15;
			}, 60);
		} catch (e) { /* 音频不可用就算了 */ }
	}

	/* ---------------- HUD ---------------- */
	function drawHUD() {
		if (!LB.props.showHud) return;
		const S = LB.Weather.state;
		const fmin = (m) => LB.Sun.formatMinutes(m, env.tzHours);
		const lines = [
			'位置   ' + S.lat.toFixed(4) + ', ' + S.lon.toFixed(4) + '  ' + S.cityName +
			'   [' + S.geoSourceKind + ']',
			'天气   ' + env.weatherName + ' (WMO ' + env.code + ')   来源 ' +
			(S.weatherSource === 'live' ? '实时' : S.weatherSource === 'manual' ? '手动' : '默认') +
			'   云 低/中/高 ' + Math.round(env.cloud.low * 100) + '/' +
			Math.round(env.cloud.mid * 100) + '/' + Math.round(env.cloud.high * 100) +
			'   风 ' + env.wind.toFixed(1) + 'km/h   降水概率 ' + Math.round(env.precip * 100) + '%',
			'太阳   高度角 ' + env.sun.elev.toFixed(2) + '°   方位角 ' + env.sun.azim.toFixed(1) + '°' +
			'   ' + (env.sun.morning ? '上午' : '下午') +
			(env.sun.manualHour !== undefined ? '   [锁定 ' + env.sun.manualHour + ' 点]' : ''),
			'日出   ' + fmin(env.sun.sunriseMin) + '   日落 ' + fmin(env.sun.sunsetMin) +
			'   正午 ' + fmin(env.sun.solarNoonMin) + '   (UTC' +
			(env.tzHours >= 0 ? '+' : '') + env.tzHours + ' ' + S.tzSource + ')',
			'窗户   朝向 ' + env.windowAzim.toFixed(0) + '°   相对 ' + env.sunRel.toFixed(1) +
			'°   光柱 ' + (env.shaft * 100).toFixed(0) + '%   昼夜 ' +
			(env.daylight * 100).toFixed(0) + '%',
			'槽位   ' + Object.keys(env.slots).filter((k) => env.slots[k] > 0.02)
				.map((k) => k + ':' + (env.slots[k] * 100).toFixed(0)).join('  '),
			'音频   ' + (audioEnergy * 100).toFixed(1) + '%' +
			(S.lastError ? '\n注意   ' + S.lastError : '')
		];
		hud.textContent = lines.join('\n');
	}

	/* ---------------- 主循环 ---------------- */
	let last = 0;
	function loop(now) {
		requestAnimationFrame(loop);
		const t = now / 1000;
		let dt = last ? Math.min(0.05, t - last) : 0.016;
		last = t;
		if (paused || document.hidden) return;

		/* 鼠标视差平滑 */
		mouse.x += (mouse.tx - mouse.x) * 0.045;
		mouse.y += (mouse.ty - mouse.y) * 0.045;
		scene.offset.x = -mouse.x * 120 * LB.props.parallax;
		scene.offset.y = -mouse.y * 60 * LB.props.parallax;

		env = LB.Weather.computeEnv(new Date());

		/* 3D 场景用同一份 env，室内外的光因此永远一致 */
		if (renderer.use3D()) {
			city3d.setEnv(env);
			city3d.render(dt, env);
		} else {
			city3d.setVisible(false);
		}
		/* 音频只做很轻的调制 */
		env.shaft *= 1 + audioEnergy * 0.35;

		renderer.frame(dt, env);
		drawHUD();
		if (LB.Panel) LB.Panel.update(env);
	}

	/* 快捷键：P 开关调参面板，H 开关 HUD */
	window.addEventListener('keydown', function (e) {
		if (e.key === 'p' || e.key === 'P') { if (LB.Panel) LB.Panel.toggle(); }
		if (e.key === 'h' || e.key === 'H') {
			LB.props.showHud = !LB.props.showHud;
			hud.classList.toggle('on', LB.props.showHud);
		}
	});

	/* ---------------- 启动 ---------------- */
	function boot() {
		applyProps({});
		scene.onReady = function () {
			/* 3D 外景 */
			if (LB.props.city3d) {
				city3d.scale = Math.min(1, Math.max(0.25, LB.props.city3dScale));
				if (city3d.init()) city3d.setVisible(true);
				city3d.resize(window.innerWidth, window.innerHeight);
			}
			scene.applyMode(LB.props.city3d);

			/* 城市就绪后重画一次楼群表单（面板是先于 3D 加载的）。
			 * 注意不能写 if (city3d.onCityReady)：它在构造函数里是 null，
			 * 条件永远为假，钩子挂不上（之前就踩过）。 */
			(function () {
				const prev = city3d.onCityReady;
				city3d.onCityReady = function () {
					prev && prev();
					if (LB.Panel && LB.Panel.resetCityDraft) LB.Panel.resetCityDraft();
				};
			})();
			const refFile = LB.SHADE_REF.file;
			const ref = scene.layers.filter(function (L) { return L.file === refFile; })[0];
			if (ref) renderer.buildShade(ref);
			else renderer.shadeTries = 0;

			LB.Weather.init();
			scene.resize(canvas);
			requestAnimationFrame(loop);
		};
		scene.load();

		window.addEventListener('resize', () => {
			scene.resize(canvas);
			if (city3d.ok) city3d.resize(window.innerWidth, window.innerHeight);
		});

		/* 没有 WE 时给出提示，方便排查 file:// 下的取数问题 */
		setTimeout(function () {
			const S = LB.Weather.state;
			if (!window.wallpaperPropertyListener && !S.updatedAt && S.lastError) {
				errBox.style.display = 'grid';
				errBox.textContent = '壁纸已启动，但天气未取到：\n' + S.lastError +
					'\n\n太阳位置仍在正常工作（依赖经纬度，不联网）。';
			}
		}, 12000);
	}

	boot();
})(window.LB);

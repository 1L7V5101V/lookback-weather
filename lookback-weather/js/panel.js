/* panel.js —— 实时调参面板
 *
 * 浏览器里：URL 加 ?panel=1 打开，或按 P 开关。
 * Wallpaper Engine 里：属性面板勾「调参面板」(devPanel) 打开，或按 P。
 *
 * 面板直接读写 LB.props / LB.Weather.state，所以改动下一帧就生效，不用刷新。
 */
(function (LB) {
	'use strict';

	if (!LB.Panel) LB.Panel = {};

	/* ---------------- 小工具 ---------------- */
	/* 控件注册表：key -> {el, fmt, out}，用于预设/外部改动后回写 UI */
	const bind = {};
	LB.Panel._bind = bind;

	function h(tag, cls, txt) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (txt !== undefined) e.textContent = txt;
		return e;
	}

	function row(parent, label, control, hint) {
		const r = h('div', 'lp-row');
		const l = h('label', null, label);
		r.appendChild(l);
		const box = h('div', 'lp-ctl');
		box.appendChild(control);
		r.appendChild(box);
		parent.appendChild(r);
		if (hint) {
			const hh = h('div', 'lp-hint', hint);
			parent.appendChild(hh);
		}
		return r;
	}

	function section(parent, title) {
		const s = h('div', 'lp-sec');
		s.appendChild(h('div', 'lp-sec-t', title));
		parent.appendChild(s);
		return s;
	}

	function slider(parent, label, opts) {
		const key = opts.key, min = opts.min, max = opts.max, step = opts.step || 1;
		const wrap = h('div', 'lp-slider');
		const inp = h('input');
		inp.type = 'range';
		inp.min = min; inp.max = max; inp.step = step;
		inp.value = LB.props[key];
		const out = h('span', 'lp-val', String(LB.props[key]));
		inp.addEventListener('input', function () {
			const v = parseFloat(inp.value);
			LB.props[key] = v;
			out.textContent = opts.fmt ? opts.fmt(v) : String(v);
			if (opts.onChange) opts.onChange(v);
		});
		wrap.appendChild(inp);
		wrap.appendChild(out);
		row(parent, label, wrap, opts.hint);
		bind[key] = { el: inp, out: out, fmt: opts.fmt };
		return bind[key];
	}

	function select(parent, label, options, opts) {
		const key = opts.key;
		const sel = h('select');
		options.forEach(function (o) {
			const op = h('option', null, o.label);
			op.value = String(o.value);
			sel.appendChild(op);
		});
		sel.value = String(LB.props[key]);
		sel.addEventListener('change', function () {
			const raw = sel.value;
			const num = parseFloat(raw);
			LB.props[key] = (opts.numeric && isFinite(num) && String(num) === raw) ? num : raw;
			if (opts.onChange) opts.onChange(LB.props[key]);
		});
		row(parent, label, sel, opts.hint);
		bind[key] = { el: sel };
		return bind[key];
	}

	function textbox(parent, label, opts) {
		const key = opts.key;
		const inp = h('input');
		inp.type = 'text';
		inp.value = LB.props[key];
		inp.addEventListener('change', function () {
			LB.props[key] = inp.value;
			if (opts.onChange) opts.onChange(inp.value);
		});
		row(parent, label, inp, opts.hint);
		bind[key] = { el: inp };
		return bind[key];
	}

	function checkbox(parent, label, opts) {
		const key = opts.key;
		const inp = h('input');
		inp.type = 'checkbox';
		inp.checked = !!LB.props[key];
		inp.addEventListener('change', function () {
			LB.props[key] = inp.checked;
			if (opts.onChange) opts.onChange(inp.checked);
		});
		row(parent, label, inp, opts.hint);
		bind[key] = { el: inp };
		return bind[key];
	}

	/* ---- 数值输入框（楼群编辑用） ---- */
	function numbox(parent, label, obj, field, onChange, step) {
		const wrap = h('div', 'lp-num');
		const inp = h('input');
		inp.type = 'number';
		inp.step = step || 1;
		inp.value = obj[field];
		inp.addEventListener('change', function () {
			const v = parseFloat(inp.value);
			if (!isFinite(v)) { inp.value = obj[field]; return; }
			obj[field] = v;
			if (onChange) onChange(v);
		});
		wrap.appendChild(h('span', 'lp-num-l', label));
		wrap.appendChild(inp);
		parent.appendChild(wrap);
		return inp;
	}

	function button(parent, label, fn, cls) {
		const b = h('button', 'lp-btn' + (cls ? ' ' + cls : ''), label);
		b.addEventListener('click', fn);
		parent.appendChild(b);
		return b;
	}

	/* ---------------- 预设 ---------------- */
	const PRESETS = {
		'正午': { solarMode: 'manual', manualHour: 12, windowDir: 180, windowFine: 0,
			weatherAuto: false, cloudLowOv: 8, cloudMidOv: 5, cloudHighOv: 5,
			windOverride: 6, rainOverride: 0, wmoOverride: 0 },
		'黄金时刻': { solarMode: 'manual', manualHour: 16.4, windowDir: 250, windowFine: 0,
			weatherAuto: false, cloudLowOv: 25, cloudMidOv: 20, cloudHighOv: 15,
			windOverride: 8, rainOverride: 0, wmoOverride: 1 },
		'日落': { solarMode: 'manual', manualHour: 17.75, windowDir: 255, windowFine: 0,
			weatherAuto: false, cloudLowOv: 35, cloudMidOv: 30, cloudHighOv: 20,
			windOverride: 10, rainOverride: 0, wmoOverride: 2 },
		'暮光': { solarMode: 'manual', manualHour: 18.4, windowDir: 270, windowFine: 0,
			weatherAuto: false, cloudLowOv: 20, cloudMidOv: 15, cloudHighOv: 10,
			windOverride: 6, rainOverride: 0, wmoOverride: 0 },
		'夜晚': { solarMode: 'manual', manualHour: 22.5, windowDir: 180, windowFine: 0,
			weatherAuto: false, cloudLowOv: 15, cloudMidOv: 10, cloudHighOv: 5,
			windOverride: 5, rainOverride: 0, wmoOverride: 0 },
		'阴天': { solarMode: 'manual', manualHour: 10, windowDir: 180, windowFine: 0,
			weatherAuto: false, cloudLowOv: 95, cloudMidOv: 88, cloudHighOv: 70,
			windOverride: 14, rainOverride: 0, wmoOverride: 3 },
		'小雨': { solarMode: 'manual', manualHour: 15, windowDir: 200, windowFine: 0,
			weatherAuto: false, cloudLowOv: 90, cloudMidOv: 80, cloudHighOv: 60,
			windOverride: 18, rainOverride: 70, wmoOverride: 61 },
		'雷暴': { solarMode: 'manual', manualHour: 16, windowDir: 210, windowFine: 0,
			weatherAuto: false, cloudLowOv: 100, cloudMidOv: 95, cloudHighOv: 85,
			windOverride: 55, rainOverride: 95, wmoOverride: 95 },
		'大雪': { solarMode: 'manual', manualHour: 13, windowDir: 180, windowFine: 0,
			weatherAuto: false, cloudLowOv: 95, cloudMidOv: 90, cloudHighOv: 80,
			windOverride: 25, rainOverride: 90, wmoOverride: 73 },
		'背光房间': { solarMode: 'manual', manualHour: 12, windowDir: 0, windowFine: 0,
			weatherAuto: false, cloudLowOv: 8, cloudMidOv: 5, cloudHighOv: 5,
			windOverride: 6, rainOverride: 0, wmoOverride: 0 }
	};

	const DIRS = [
		{ label: '正北 0°', value: 0 }, { label: '东北 45°', value: 45 },
		{ label: '正东 90°', value: 90 }, { label: '东南 135°', value: 135 },
		{ label: '正南 180°', value: 180 }, { label: '西南 225°', value: 225 },
		{ label: '正西 270°', value: 270 }, { label: '西北 315°', value: 315 }
	];

	/* ---------------- 构建面板 ---------------- */
	let root = null;
	let readout = null;

	function build() {
		root = h('div', 'lp-root');
		document.body.appendChild(root);

		const head = h('div', 'lp-head');
		head.appendChild(h('div', 'lp-title', '实时调参'));
		const collapse = h('button', 'lp-x', '×');
		collapse.addEventListener('click', () => hide());
		head.appendChild(collapse);
		root.appendChild(head);

		readout = h('div', 'lp-readout');
		root.appendChild(readout);

		/* ---- 预设 ---- */
		const pre = h('div', 'lp-presets');
		Object.keys(PRESETS).forEach(function (name) {
			button(pre, name, function () {
				Object.assign(LB.props, PRESETS[name]);
				syncAll();
			}, 'lp-preset');
		});
		root.appendChild(pre);

		const body = h('div', 'lp-body');

		/* ---- 位置 ---- */
		const s1 = section(body, '位置');
		select(s1, '定位方式', [
			{ label: '自动（IP）', value: 'auto' },
			{ label: '手动城市名', value: 'manual' },
			{ label: '手动经纬度', value: 'latlon' }
		], {
			key: 'locateMode',
			onChange: () => LB.Weather.onPropsChanged()
		});
		textbox(s1, '城市名', {
			key: 'cityInput', hint: '支持中文，回车或失焦生效，如：成都 / Reykjavik / Tokyo',
			onChange: () => LB.Weather.onPropsChanged()
		});
		textbox(s1, '纬度,经度', {
			key: 'latLonInput', hint: '例：39.9042,116.4074',
			onChange: () => LB.Weather.onPropsChanged()
		});
		const b1 = h('div', 'lp-btns');
		button(b1, '重新拉取天气', () => LB.Weather.onPropsChanged(), 'lp-primary');
		s1.appendChild(b1);

		/* ---- 太阳与窗 ---- */
		const s2 = section(body, '太阳与窗户');
		select(s2, '太阳位置来源', [
			{ label: '真实太阳（按城市）', value: 'real' },
			{ label: '跟随系统时钟', value: 'clock' },
			{ label: '手动锁定时刻', value: 'manual' }
		], { key: 'solarMode' });
		slider(s2, '锁定时刻', {
			key: 'manualHour', min: 0, max: 23.9, step: 0.1,
			fmt: (v) => {
				const hh = Math.floor(v), mm = Math.round((v - hh) * 60);
				return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
			},
			hint: '城市当地钟表时间；日出日落仍按经纬度实时算'
		});
		select(s2, '窗户朝向', DIRS, { key: 'windowDir', numeric: true });
		slider(s2, '朝向微调', { key: 'windowFine', min: -45, max: 45, step: 1 });
		slider(s2, '光柱强度', { key: 'shaftSize', min: 0, max: 1.5, step: 0.05 });

		/* ---- 天气 ---- */
		const s3 = section(body, '天气');
		checkbox(s3, '跟随当地实时天气', { key: 'weatherAuto' });
		slider(s3, '低云量 %', { key: 'cloudLowOv', min: 0, max: 100, step: 1 });
		slider(s3, '中云量 %', { key: 'cloudMidOv', min: 0, max: 100, step: 1 });
		slider(s3, '高云量 %', { key: 'cloudHighOv', min: 0, max: 100, step: 1 });
		slider(s3, '风速 km/h', { key: 'windOverride', min: 0, max: 80, step: 1,
			hint: '驱动云漂移速度、飘落物横向漂移、雨线倾角' });
		slider(s3, '降水概率 %', { key: 'rainOverride', min: 0, max: 100, step: 1 });
		select(s3, '风向（来向）', [
			{ label: '北风（吹向南）', value: 0 }, { label: '东北风', value: 45 },
			{ label: '东风（吹向西）', value: 90 }, { label: '东南风', value: 135 },
			{ label: '南风（吹向北）', value: 180 }, { label: '西南风', value: 225 },
			{ label: '西风（吹向东）', value: 270 }, { label: '西北风', value: 315 }
		], { key: 'windDirOv', numeric: true, hint: '控制雨线倾角、云的漂移方向、飘落物横向运动' });
		const wmoOpts = [{ label: '自动推断', value: -1 }];
		Object.keys(LB.WMO).forEach(function (code) {
			wmoOpts.push({ label: code + ' ' + LB.WMO[code].name, value: parseInt(code, 10) });
		});
		select(s3, 'WMO 天气码', wmoOpts, { key: 'wmoOverride', numeric: true });

		/* ---- 画面 ---- */
		const s4 = section(body, '画面');
		slider(s4, '叶子透明度', { key: 'leafSize', min: 0, max: 1, step: 0.05 });
		slider(s4, '雨量', { key: 'rainSize', min: 0, max: 1, step: 0.05 });
		slider(s4, '鼠标视差（2D）', { key: 'parallax', min: 0, max: 1.5, step: 0.05 });
		slider(s4, '窗外视差（摄像机）', {
			key: 'parallax3d', min: 0, max: 2, step: 0.05,
			hint: '3D 模式下移动摄像机而不是平移图层：人物、书桌、显示器全静止，只有窗外的楼按透视分层错开'
		});
		slider(s4, '太阳阴影强度', { key: 'sunShade', min: 0, max: 1.4, step: 0.05,
			hint: '2.5D 高度场投影（仅 2D 模式）；0 关闭，回退到纯调色' });
		checkbox(s4, 'three.js 3D 外景', { key: 'city3d',
			hint: '关掉 = 回到纯 2D 预渲染图，方便 A/B 对比' });
		slider(s4, '3D 渲染分辨率', { key: 'city3dScale', min: 0.3, max: 1, step: 0.05,
			hint: '降低可省 GPU；窗外背景稍软反而更贴画感' });
		checkbox(s4, '显示日期与时钟', { key: 'showClock' });
		textbox(s4, '标题文字', { key: 'titleText' });
		textbox(s4, '署名', { key: 'signText' });

			/* ---- 楼群布局：表格表单 ----
		 * 每栋一行，改完点「应用」才生效（表单语义）：
		 * 草稿 -> 应用 = 写回 city3d.spec 并重建；还原 = 丢弃草稿。
		 * 这样可以连续改好几栋再一起看效果。 */
		const sCity = section(body, '楼群布局');
		sCity.appendChild(h('div', 'lp-hint',
			'x 左右(0=正对) · z 离窗远近(负=窗外) · 宽/深 分开 · 层 层数 · 偏转 朝向角'));
		const cityForm = h('form', 'lp-form');
		sCity.appendChild(cityForm);
		const tbl = h('table', 'lp-tbl');
		cityForm.appendChild(tbl);
		const thead = h('thead');
		const hr = h('tr');
		['#', 'x', 'z', '宽', '深', '层', '偏转', '可见', '素材', '近景', ''].forEach(function (t) {
			hr.appendChild(h('th', null, t));
		});
		thead.appendChild(hr);
		tbl.appendChild(thead);
		const tbody = h('tbody');
		tbl.appendChild(tbody);

		const cityBtns = h('div', 'lp-btns');
		const bAdd = h('button', 'lp-btn lp-primary', '添加一栋');
		const bApply = h('button', 'lp-btn lp-ok', '应用');
		const bRevert = h('button', 'lp-btn', '放弃改动');
		const bUndo = h('button', 'lp-btn', '撤销上一步');
		const bJson = h('button', 'lp-btn', '导出');
		const bReset = h('button', 'lp-btn lp-warn', '恢复默认布局');
		[bAdd, bApply, bRevert, bUndo, bJson, bReset].forEach(function (btn) {
			cityBtns.appendChild(btn);
		});
		sCity.appendChild(cityBtns);
		const io = h('textarea', 'lp-json');
		io.rows = 3; io.readOnly = true;
		sCity.appendChild(h('div', 'lp-hint', '导出（复制走就是存档）'));
		sCity.appendChild(io);
		sCity.appendChild(h('div', 'lp-hint', '导入：把 JSON 粘进下面这框，再点「导入」'));
		const imp = h('textarea', 'lp-json lp-import');
		imp.rows = 3;
		imp.placeholder = '[{"x":0,"z":-140,"w":24,"d":20,"floors":8,"yaw":0}]';
		sCity.appendChild(imp);
		const impBtns = h('div', 'lp-btns');
		const bImport = h('button', 'lp-btn lp-ok', '导入');
		const bFill = h('button', 'lp-btn', '从导入框填充导出框');
		impBtns.appendChild(bImport);
		impBtns.appendChild(bFill);
		sCity.appendChild(impBtns);
		const impMsg = h('div', 'lp-hint');
		sCity.appendChild(impMsg);

		/* 草稿 */
		let draft = null;
		function snapshot() {
			if (!LB.city3d || !LB.city3d.spec) return null;
			return LB.city3d.normalizeSpec(JSON.parse(JSON.stringify(LB.city3d.spec)));
		}

		function cell(row, label) {
			const td = h('td');
			const wrap = h('label', 'lp-cell');
			if (label) wrap.appendChild(h('span', 'lp-cell-l', label));
			td.appendChild(wrap);
			row.appendChild(td);
			return wrap;
		}
		function inputNum(row, obj, field, w) {
			const wrap = cell(row, null);
			const inp = h('input');
			inp.type = 'number';
			inp.value = obj[field];
			if (w) inp.style.width = w;
			inp.addEventListener('input', function () {
				const v = parseFloat(inp.value);
				if (isFinite(v)) obj[field] = v;
			});
			wrap.appendChild(inp);
			return inp;
		}
		function inputChk(row, obj, field) {
			const wrap = cell(row, null);
			const inp = h('input');
			inp.type = 'checkbox';
			inp.checked = !!obj[field];
			inp.addEventListener('change', function () { obj[field] = inp.checked; });
			wrap.appendChild(inp);
			return inp;
		}

		function hi(i) {
			if (!LB.city3d) return;
			LB.city3d.hiIndex = i;
			LB.city3d.setHighlight(i);
		}
		function clearHi() {
			if (!LB.city3d) return;
			LB.city3d.hiIndex = -1;
			LB.city3d.setHighlight(-1);
		}
		tbl.addEventListener('mouseleave', clearHi);

		function drawCityEditor() {
			const C = LB.city3d;
			tbody.innerHTML = '';
			if (!C || !C.spec) {
				tbody.appendChild(h('tr')).appendChild(
					h('td', null, '3D 外景未启用'));
				io.value = '';
				return;
			}
			if (!draft) draft = snapshot();
			draft.forEach(function (b, i) {
				const hidden = (b.visible === false);
				const tr = h('tr', (b.hero ? 'hero ' : '') + (hidden ? 'off' : ''));
				/* 鼠标移到这一行，就在 3D 里把那栋楼框出来 */
				tr.addEventListener('mouseenter', function () { hi(i); });
				tr.addEventListener('focusin', function () { hi(i); });
				tr.appendChild(h('td', 'lp-idx', String(i + 1)));
				inputNum(tr, b, 'x');
				inputNum(tr, b, 'z');
				inputNum(tr, b, 'w');
				inputNum(tr, b, 'd');
				inputNum(tr, b, 'floors');
				inputNum(tr, b, 'yaw');
				inputChk(tr, b, 'visible');
				inputChk(tr, b, 'hero');
				inputChk(tr, b, 'near');
				const td = h('td');
				const del = h('button', 'lp-del', '×');
				del.type = 'button';
				del.addEventListener('click', function () {
					if (draft.length <= 1) return;
					draft.splice(i, 1);
					drawCityEditor();
				});
				td.appendChild(del);
				tr.appendChild(td);
				tbody.appendChild(tr);
			});
			io.value = JSON.stringify(draft, null, 1);
			if (C.specRestored) {
				C.specRestored = false;
				impMsg.textContent = '已恢复你上次编辑并应用的布局（存在浏览器里）。';
			}
		}

		bAdd.addEventListener('click', function (e) {
			e.preventDefault();
			if (!draft) return;
			draft.push({ x: 0, z: -140, w: 24, d: 20, floors: 8, yaw: 0, hero: false, near: false });
			drawCityEditor();
		});
		bApply.addEventListener('click', function (e) {
			e.preventDefault();
			if (!LB.city3d || !draft) return;
			LB.city3d.pushUndo();
			LB.city3d.spec = LB.city3d.normalizeSpec(draft);
			LB.city3d.rebuild();
			LB.city3d.saveSpec();
			impMsg.textContent = '已应用并存档。';
			/* 重画一遍，隐藏的行才会变灰 */
			drawCityEditor();
		});
		bRevert.addEventListener('click', function (e) {
			e.preventDefault();
			draft = snapshot();
			drawCityEditor();
		});
		bJson.addEventListener('click', function (e) {
			e.preventDefault();
			if (LB.city3d) io.value = LB.city3d.exportSpec();
		});
		bUndo.addEventListener('click', function (e) {
			e.preventDefault();
			if (!LB.city3d || !LB.city3d.canUndo()) { impMsg.textContent = '没有可撤销的上一步。'; return; }
			LB.city3d.undo();
			draft = snapshot();
			drawCityEditor();
			impMsg.textContent = '已撤销上一步。';
		});
		bImport.addEventListener('click', function (e) {
			e.preventDefault();
			if (!LB.city3d) return;
			try {
				const n = LB.city3d.importSpec(imp.value);
				draft = snapshot();
				drawCityEditor();
				impMsg.textContent = '已导入 ' + n + ' 栋。';
			} catch (err) {
				impMsg.textContent = '导入失败：' + (err && err.message ? err.message : err);
			}
		});
		bFill.addEventListener('click', function (e) {
			e.preventDefault();
			io.value = imp.value;
			impMsg.textContent = '已复制到导出框，确认无误后可导出。';
		});
		bReset.addEventListener('click', function (e) {
			e.preventDefault();
			if (!LB.city3d) return;
			LB.city3d.resetSpec();
			draft = snapshot();
			drawCityEditor();
			impMsg.textContent = '已恢复默认布局。点「撤销上一步」可以退回。';
		});
		LB.Panel.drawCityEditor = drawCityEditor;
		LB.Panel.resetCityDraft = function () { draft = snapshot(); drawCityEditor(); };
		drawCityEditor();

		/* ---- 调试 ---- */
		const s5 = section(body, '调试');
		checkbox(s5, '显示调试信息 HUD', { key: 'showHud',
			onChange: (v) => document.getElementById('hud').classList.toggle('on', v) });

		root.appendChild(body);
		syncAll();
	}

	/* 把 LB.props 的当前值回写到所有控件（预设切换、外部改属性后用） */
	function syncAll() { refreshInputs(); }

	function refreshInputs() {
		Object.keys(bind).forEach(function (key) {
			const c = bind[key];
			if (!c || !c.el || !c.el.isConnected) return;
			if (c.el.type === 'checkbox') {
				c.el.checked = !!LB.props[key];
			} else if (document.activeElement !== c.el) {
				c.el.value = String(LB.props[key]);
			}
			if (c.out) c.out.textContent = c.fmt ? c.fmt(LB.props[key]) : String(LB.props[key]);
		});
	}

	function show() {
		if (!root) {
			try { build(); }
			catch (e) {
				LB.Panel.buildError = (e && e.message ? e.message : String(e));
				console.error('[panel] 构建失败', e);
				return;
			}
		}
		root.classList.add('on');
		LB.props.devPanel = true;
	}

	function hide() {
		if (root) root.classList.remove('on');
		LB.props.devPanel = false;
	}

	function toggle() { (root && root.classList.contains('on')) ? hide() : show(); }

	/* 每帧刷一次读数 */
	function update(env) {
		if (!root || !root.classList.contains('on') || !env) return;
		const S = LB.Weather.state;
		const fmin = (m) => LB.Sun.formatMinutes(m, env.tzHours);
		readout.innerHTML =
			'<b>' + env.weatherName + '</b> · ' + S.cityName + '<br>' +
			'太阳 ' + env.sun.elev.toFixed(1) + '° / ' + env.sun.azim.toFixed(0) + '° ' +
			(env.sun.morning ? '上午' : '下午') + '<br>' +
			'日出 ' + fmin(env.sun.sunriseMin) + ' · 日落 ' + fmin(env.sun.sunsetMin) + '<br>' +
			'窗户 ' + env.windowAzim.toFixed(0) + '° · 相对 ' + env.sunRel.toFixed(1) +
			'° · <b>光柱 ' + (env.shaft * 100).toFixed(0) + '%</b><br>' +
			'云 ' + Math.round(env.cloud.low * 100) + '/' + Math.round(env.cloud.mid * 100) +
			'/' + Math.round(env.cloud.high * 100) + ' · 风 ' + env.wind.toFixed(0) +
			' · 雨 ' + Math.round(env.precip * 100) + '%';
		refreshInputs();
	}

	LB.Panel = { show: show, hide: hide, toggle: toggle, update: update };
})(window.LB);

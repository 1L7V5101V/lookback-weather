/* particles.js —— 云漂移、雨雪、飘落物、雾、光柱里的尘埃
 *
 * 全部按虚拟坐标（5120x2592）工作，数量与强度都由实时环境量驱动：
 *   云漂移速度 <- wind_speed
 *   雨/雪密度   <- precipitation_probability + weather_code
 *   雨线倾角   <- wind_speed
 *   飘落物横向漂移 <- wind_speed
 *   雾浓度     <- overcast + 清晨时段
 */
(function (LB) {
	'use strict';

	const W = LB.VIEW.W, H = LB.VIEW.H;
	const WIN = LB.WINDOW;
	const clamp01 = LB.clamp01;

	/* ---------- 云层滚动量累积 ---------- */
	const scrollState = {};
	function advanceClouds(env, dt, scene) {
		const windFactor = 0.35 + env.wind / 26;          // 风越大飘越快
		LB.LAYERS.forEach((L) => {
			if (L.kind !== 'sky') return;
			const id = L.id;
			/* 低云更快，视差系数越大越快 */
			const speed = (L.parallax || 0.2) * windFactor * 62;
			scrollState[id] = ((scrollState[id] || 0) + speed * dt) % 100000;
		});
		scene.scroll = scrollState;
	}

	/* ---------- 雨 / 雪 ----------
	 * 坐标系提醒：渲染矩阵已翻转 Y，所以「屏幕向下」= 虚拟 y 减小。
	 * 早先版本用 d.y += v 来表示下落，实际是往上飘；雨线又画成向下，
	 * 于是“线条对、运动反”。现在统一用速度矢量 (vx, vy)，vy < 0 即下落。 */
	function Rain(scene, maxCount) {
		this.drops = [];
		this.max = maxCount || 900;
		this.intensity = 0;
		this.wet = false;
		this.snowy = false;
		this.wx = 0;
		this.fall = 1200;
	}
	Rain.prototype.set = function (env) {
		const p = LB.props;
		const target = env.wet ? env.precip * p.rainSize : 0;
		this.intensity += (target - this.intensity) * 0.05;
		this.wet = env.wet;
		this.snowy = env.snowy;
		this.wx = env.windX;
		this.fall = (env.snowy ? 260 : 1000) + env.precip * (env.snowy ? 160 : 900);
	};
	Rain.prototype.spawn = function (init) {
		return {
			x: Math.random() * (W + 2400) - 1200,
			y: init ? Math.random() * H : H + 120 + Math.random() * 400,
			s: 0.6 + Math.random() * 0.9,
			l: 120 + Math.random() * 190,
			a: 0.16 + Math.random() * 0.3,
			ph: Math.random() * 6.2832
		};
	};
	Rain.prototype.update = function (dt, t) {
		const want = Math.floor(this.intensity * this.max);
		while (this.drops.length < want) this.drops.push(this.spawn(false));
		if (this.drops.length > want) this.drops.length = want;
		for (let i = 0; i < this.drops.length; i++) {
			const d = this.drops[i];
			d.vy = -this.fall * d.s;                 // 向下
			d.vx = this.wx * (0.55 + 0.55 * d.s);     // 随风
			if (this.snowy) {
				d.vx += Math.sin((t || 0) * 1.4 + d.ph) * 26;   // 雪花左右摇摆
			}
			d.y += d.vy * dt;
			d.x += d.vx * dt;
			if (d.y < -180) {
				const n = this.spawn(false);
				d.x = n.x; d.y = n.y;
			}
			if (d.x > W + 1200) d.x -= (W + 2400);
			if (d.x < -1200) d.x += (W + 2400);
		}
	};
	Rain.prototype.draw = function (ctx, env) {
		if (!this.drops.length) return;
		ctx.save();
		if (this.snowy) {
			ctx.fillStyle = 'rgba(248,251,255,0.95)';
			for (let i = 0; i < this.drops.length; i++) {
				const d = this.drops[i];
				ctx.globalAlpha = Math.min(1, d.a * 1.9);
				ctx.beginPath();
				ctx.arc(d.x, d.y, 11 * d.s, 0, 6.2832);
				ctx.fill();
			}
		} else {
			/* 拖尾画在运动方向的反侧：tail = p − v·k。
			 * 线宽是虚拟单位，而虚拟→屏幕只有 ~0.19 倍，
			 * 早先给 1.6 相当于亚像素，雨几乎看不见。 */
			const pass = function (w, col, mul) {
				ctx.strokeStyle = col;
				ctx.lineWidth = w;
				ctx.beginPath();
				for (let i = 0; i < this.drops.length; i++) {
					const d = this.drops[i];
					ctx.globalAlpha = Math.min(1, d.a * mul);
					ctx.moveTo(d.x, d.y);
					ctx.lineTo(d.x - d.vx * 0.055, d.y - d.vy * 0.055);
				}
				ctx.stroke();
			};
			/* 主体：冷灰，在亮天空/亮楼上有对比 */
			pass.call(this, 7, 'rgba(120,146,178,0.55)', 1.0);
			/* 内芯高光 */
			pass.call(this, 2.2, 'rgba(235,244,255,0.75)', 1.0);
		}
		ctx.restore();
	};

	/* ---------- 飘落物（叶子/纸片） ---------- */
	function Motes(scene, count) {
		this.items = [];
		this.count = count || 26;
		this.alpha = 0;
		this.wx = 0;
		for (let i = 0; i < this.count; i++) this.items.push(this.spawn(true));
	}
	Motes.prototype.spawn = function (init) {
		return {
			x: Math.random() * (W + 1600) - 800,
			y: init ? Math.random() * H : H + 80 + Math.random() * 300,
			vy: -(38 + Math.random() * 70),           // 向下
			rot: Math.random() * 6.2832,
			vr: (Math.random() - 0.5) * 1.7,
			s: 0.55 + Math.random() * 0.9,
			phase: Math.random() * 6.2832,
			hue: Math.random() < 0.5 ? 'leaf' : 'paper'
		};
	};
	Motes.prototype.set = function (env) {
		this.alpha = LB.props.leafSize * (0.35 + 0.65 * clamp01(env.wind / 28));
		this.wx = env.windX;
	};
	Motes.prototype.update = function (dt, t) {
		for (let i = 0; i < this.items.length; i++) {
			const m = this.items[i];
			m.y += m.vy * dt * (0.7 + 0.5 * Math.sin(t * 0.7 + m.phase));
			/* 随风飘 + 自身摆动；横向速度带符号，风向反转这里就反转 */
			m.x += (this.wx * 0.85 * m.s + Math.sin(t * 1.6 + m.phase) * 34) * dt;
			m.rot += m.vr * dt;
			if (m.y < -160 || m.x > W + 900 || m.x < -900) {
				const n = this.spawn(false);
				n.rot = m.rot;
				this.items[i] = n;
			}
		}
	};
	Motes.prototype.draw = function (ctx) {
		if (this.alpha <= 0.01) return;
		ctx.save();
		for (let i = 0; i < this.items.length; i++) {
			const m = this.items[i];
			ctx.save();
			ctx.translate(m.x, m.y);
			ctx.rotate(m.rot);
			ctx.globalAlpha = this.alpha * (m.hue === 'leaf' ? 0.5 : 0.34);
			ctx.fillStyle = m.hue === 'leaf' ? '#7d6a4a' : '#cfc6b4';
			const w = 34 * m.s, h = 17 * m.s;
			ctx.beginPath();
			ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 6.2832);
			ctx.fill();
			ctx.restore();
		}
		ctx.restore();
	};

	/* ---------- 雾 ---------- */
	function Fog() { this.a = 0; }
	Fog.prototype.set = function (env, phase) {
		/* 阴天 + 清晨/黎明时段雾更重 */
		const dawn = (env.sun.elev > -8 && env.sun.elev < 10) ? 1 : 0.25;
		const target = clamp01(env.overcast * 0.85) * dawn * 0.55;
		this.a += (target - this.a) * 0.02;
		this.phase = phase;
	};
	Fog.prototype.draw = function (ctx, env) {
		if (this.a <= 0.01) return;
		ctx.save();
		ctx.globalCompositeOperation = 'screen';
		/* 屏幕顶部(H) -> 窗户下沿(WIN.y)，中间最浓 */
		const g = ctx.createLinearGradient(0, H, 0, WIN.y);
		g.addColorStop(0, LB.rgba(env.skyColor, this.a * 0.18));
		g.addColorStop(0.45, LB.rgba([0.52, 0.55, 0.60], this.a * 0.55));
		g.addColorStop(1, LB.rgba([0.45, 0.48, 0.55], 0));
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.restore();
	};

	/* ---------- 光柱 ----------
	 * 早先版本用 6 条硬边三角形，出来像舞台灯条纹，不像窗户透进来的光。
	 * 真实感来自三点：
	 *   1) 孔径投影：光柱的截面就是窗户玻璃的矩形，沿光线方向剪成一个平行四边形，
	 *      而不是随便几条射线；
	 *   2) 密度衰减：沿光线积分，靠近窗口最亮，指数衰减；
	 *   3) 介质不均匀：叠一层随时间缓慢流动的噪声，破掉平涂感。
	 * 三者都在一张低分辨率缓存图里算（太阳不动就不重算），再放大合成。 */
	function Shafts() {
		this.motes = []; this.t = 0;
		this.buf = null; this.bufCtx = null;
		this.noise = null; this.noiseT = 0;
		this.key = '';
	}

	Shafts.prototype.set = function (env) { this.env = env; };

	/* 一次性生成可平铺的值噪声 */
	Shafts.prototype._makeNoise = function () {
		const N = 128;
		const c = document.createElement('canvas');
		c.width = N; c.height = N;
		const g = c.getContext('2d');
		const img = g.createImageData(N, N);
		const grid = 8, cells = new Float32Array((grid + 1) * (grid + 1));
		for (let i = 0; i < cells.length; i++) cells[i] = Math.random();
		const at = (x, y) => cells[(y % grid) * (grid + 1) + (x % grid)];
		const sm = (t) => t * t * (3 - 2 * t);
		for (let y = 0; y < N; y++) {
			for (let x = 0; x < N; x++) {
				const fx = x / N * grid, fy = y / N * grid;
				const x0 = Math.floor(fx), y0 = Math.floor(fy);
				const tx = sm(fx - x0), ty = sm(fy - y0);
				const v = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
					(at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
				const p = (y * N + x) * 4;
				img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
				img.data[p + 3] = 255 * (0.45 + 0.55 * v);
			}
		}
		g.putImageData(img, 0, 0);
		this.noise = c;
	};

	/* 低分辨率缓存：窗户孔径沿光线方向的剪切投影 + 噪声 + 体积衰减 */
	Shafts.prototype._render = function (env) {
		const key = [
			Math.round(env.sun.elev * 3), Math.round(env.sunRel * 3),
			Math.round(env.shaft * 20), Math.round(LB.props.shaftSize * 20)
		].join(',');
		if (key === this.key) return;
		this.key = key;
		if (!this.noise) this._makeNoise();
		if (!this.buf) {
			this.buf = document.createElement('canvas');
			this.buf.width = 320; this.buf.height = 200;
			this.bufCtx = this.buf.getContext('2d');
		}
		const w = this.buf.width, h = this.buf.height;
		const g = this.bufCtx;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, w, h);

		const s = env.shaft;
		if (s <= 0.02) return;

		/* 窗户玻璃（孔径）四角，虚拟坐标 */
		const G = LB.WINDOW_GLASS;
		const corners = [
			{ x: G.x, y: G.y }, { x: G.x + G.w, y: G.y },
			{ x: G.x + G.w, y: G.y + G.h }, { x: G.x, y: G.y + G.h }
		];

		/* 光线在屏幕上的方向：太阳在右(rel>0)则光往左走；
		 * 竖直分量向下（虚拟 y 减小），仰角越低越平 */
		const rel = env.sunRel * Math.PI / 180;
		const dx = -Math.sin(rel);
		const elev = Math.max(1, env.sun.elev);
		const dy = -Math.max(0.25, Math.sin(elev * Math.PI / 180) * 1.15);
		/* 仰角越低光柱越长，但得有个上限：
		 * 不封顶的话 9° 的太阳会算出 8000+ 的长度，整屏糊成白板。 */
		let len = (LB.VIEW.H * 0.5) / Math.tan(Math.max(6, elev) * Math.PI / 180);
		len = Math.max(900, Math.min(3000, len));
		const norm = Math.hypot(dx, dy) || 1;
		const ux = dx / norm, uy = dy / norm;

		/* 映射到缓存图：缓存图覆盖整个虚拟画布 */
		const kx = w / LB.VIEW.W, ky = h / LB.VIEW.H;
		const px = (v) => v * kx, py = (v) => (LB.VIEW.H - v) * ky;

		/* 平行四边形：孔径四角沿光线方向推出 len */
		g.save();
		g.globalCompositeOperation = 'lighter';
		const grad = g.createLinearGradient(
			px(corners[0].x + ux * len * 0.25), py(corners[0].y + uy * len * 0.25),
			px(corners[0].x + ux * len), py(corners[0].y + uy * len));
		grad.addColorStop(0, 'rgba(255,238,205,0.85)');
		grad.addColorStop(0.22, 'rgba(255,228,182,0.44)');
		grad.addColorStop(0.55, 'rgba(255,220,168,0.16)');
		grad.addColorStop(1, 'rgba(255,214,160,0)');
		g.fillStyle = grad;
		g.beginPath();
		corners.forEach(function (c, i) {
			const a = px(c.x), b = py(c.y);
			const ax = px(c.x + ux * len), by = py(c.y + uy * len);
			if (i === 0) g.moveTo(a, b); else g.lineTo(a, b);
			void ax; void by;
		});
		/* 推出后的四个点 */
		for (let i = corners.length - 1; i >= 0; i--) {
			g.lineTo(px(corners[i].x + ux * len), py(corners[i].y + uy * len));
		}
		g.closePath();
		g.fill();
		g.restore();

		/* 孔径本身的一小片过曝辉光（随正对程度缩放） */
		g.save();
		g.globalCompositeOperation = 'lighter';
		const ag = g.createRadialGradient(
			px(G.x + G.w / 2), py(G.y + G.h * 0.6), 0,
			px(G.x + G.w / 2), py(G.y + G.h * 0.6), G.w * kx * 0.22);
		ag.addColorStop(0, 'rgba(255,240,210,0.22)');
		ag.addColorStop(1, 'rgba(255,230,190,0)');
		g.fillStyle = ag;
		g.fillRect(0, 0, w, h);
		g.restore();

		/* 介质噪声：两层反向流动。用 multiply 只做密度调制，
		 * 早先用 lighter 会整屏加白，直接把画面糊掉。 */
		g.save();
		g.globalCompositeOperation = 'multiply';
		const sc = 2.2;
		g.globalAlpha = 0.30;
		g.drawImage(this.noise, (-this.t * 26) % 128, (-this.t * 14) % 128, w * sc, h * sc);
		g.globalAlpha = 0.20;
		g.globalCompositeOperation = 'lighter';
		g.drawImage(this.noise, (this.t * 18) % 128, (this.t * 9) % 128, w * sc, h * sc);
		g.restore();
	};

	Shafts.prototype.update = function (dt) {
		this.t += dt;
		const e = this.env;
		/* 尘埃只在光柱强度够时才存在 */
		const want = Math.floor(64 * clamp01(e.shaft * 1.4));
		while (this.motes.length < want) {
			this.motes.push({
				x: WIN.x + Math.random() * WIN.w,
				y: WIN.y + Math.random() * WIN.h,
				r: 2.5 + Math.random() * 11,
				vx: 8 + Math.random() * 30,
				vy: -5 - Math.random() * 15,
				a: 0.06 + Math.random() * 0.26
			});
		}
		if (this.motes.length > want) this.motes.length = want;
		const drift = 14 + e.wind * 0.8;
		for (let i = 0; i < this.motes.length; i++) {
			const m = this.motes[i];
			m.x += (m.vx + drift) * dt;
			m.y += m.vy * dt;
			if (m.x > WIN.x + WIN.w + 200 || m.y < WIN.y - 200) {
				m.x = WIN.x - 120 + Math.random() * 200;
				m.y = WIN.y + Math.random() * WIN.h;
			}
		}
	};

	Shafts.prototype.draw = function (ctx, env) {
		const s = env.shaft;
		if (s <= 0.02) return;
		this._render(env);

		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		ctx.globalAlpha = clamp01(s * 0.34);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		/* 局部反变换 Y（全局矩阵已翻转） */
		ctx.scale(1, -1);
		ctx.drawImage(this.buf, 0, -LB.VIEW.H, LB.VIEW.W, LB.VIEW.H);
		ctx.restore();

		/* 光柱里的尘埃 */
		ctx.save();
		ctx.globalCompositeOperation = 'lighter';
		for (let i = 0; i < this.motes.length; i++) {
			const m = this.motes[i];
			ctx.globalAlpha = m.a * s * 0.8;
			ctx.fillStyle = '#ffeac6';
			ctx.beginPath();
			ctx.arc(m.x, m.y, m.r, 0, 6.2832);
			ctx.fill();
		}
		ctx.restore();
	};
	LB.Particles = {
		advanceClouds: advanceClouds,
		Rain: Rain,
		Motes: Motes,
		Fog: Fog,
		Shafts: Shafts
	};
})(window.LB);

/* render.js —— 合成器
 *
 * 绘制顺序（从后到前）沿用原壁纸的图层栈，但**驱动量全部换成真实环境量**：
 *   天空云带  -> 房间（按太阳高度角交叉淡化）-> 近景 -> 雾 -> 雨 -> 飘落物 -> 光柱 -> 文字
 */
(function (LB) {
	'use strict';

	const W = LB.VIEW.W, H = LB.VIEW.H;
	const clamp01 = LB.clamp01;

	function Renderer(canvas, scene, city3d) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { alpha: true });
		this.scene = scene;
		this.city3d = city3d || null;
		this.rain = new LB.Particles.Rain(scene, 900);
		this.motes = new LB.Particles.Motes(scene, 26);
		this.fog = new LB.Particles.Fog();
		this.shafts = new LB.Particles.Shafts();
		this.shade = new LB.SunShade();
		this.shadeTries = 0;
		this.t = 0;
	}

	/* 单个图层的权重：slot 可以是字符串或数组 */
	function weightOf(L, slots) {
		if (L.slot === 'always') return 1;
		if (Array.isArray(L.slot)) {
			let w = 0;
			for (let i = 0; i < L.slot.length; i++) w += slots[L.slot[i]] || 0;
			return w;
		}
		return slots[L.slot] || 0;
	}

	/* 云层不透明度：云量越大越实。不同高度用不同的云量字段。 */
	function cloudAlpha(env, which, base) {
		const c = which === 'low' ? env.cloud.low
			: which === 'high' ? env.cloud.high : env.cloud.mid;
		return base * (0.25 + 0.75 * clamp01(c));
	}

	/* 用参考层自己的虚拟矩形构建高度场（只做一次）。
	 * 注意：必须传该图层的 cx/cy/w/h/scale，不能拿 LB.WINDOW 代替——
	 * 两者根本不是同一个矩形，早先版本因此把高度场拉伸了 13.6% 并且整体错位。 */
	/* 3D 模式下雪的补充层：把 3D 的点粒子也裁到窗内画一遍会重复，
	 * 这里只留钩子，雪仍走 3D（点状在远处本来就读得出）。 */
	Renderer.prototype.snow2dDraw = function () {};

	Renderer.prototype.use3D = function () {
		return !!(this.city3d && this.city3d.ok && this.city3d.enabled);
	};

	Renderer.prototype.buildShade = function (refLayer) {
		if (!refLayer || !refLayer.img) return false;
		const w = refLayer.w * (refLayer.scale || 1);
		const h = refLayer.h * (refLayer.scale || 1);
		const rect = {
			x0: refLayer.cx - w / 2,
			y0: refLayer.cy - h / 2,     // y 向上，所以这是下边
			w: w, h: h
		};
		try {
			return this.shade.build(refLayer.img, rect, LB.SHADE_REF.gridW || 1024);
		} catch (e) {
			console.warn('[sunshade] 构建失败', e);
			return false;
		}
	};

	Renderer.prototype.frame = function (dt, env) {
		const ctx = this.ctx, scene = this.scene;
		this.t += dt;

		/* --- 环境量写回粒子系统 --- */
		LB.Particles.advanceClouds(env, dt, scene);
		this.rain.set(env); this.rain.update(dt);
		this.motes.set(env); this.motes.update(dt, this.t);
		this.fog.set(env, this.t);
		this.shafts.set(env); this.shafts.update(dt);

		/* --- 底色 ---
		 * 开了 3D 外景就保持透明（让底层 WebGL 透出来）；
		 * 否则自己填一层天色。 */
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		if (this.use3D()) {
			ctx.clearRect(0, 0, canvas_w(this), canvas_h(this));
		} else {
			ctx.fillStyle = LB.rgba(env.skyColor.map((v) => v * 0.55), 1);
			ctx.fillRect(0, 0, canvas_w(this), canvas_h(this));
		}

		scene.begin(ctx);

		/* --- 1. 天空 / 云带（仅 2D 模式） --- */
		const skies = [], rooms = [], fronts = [];
		scene.layers.forEach((L) => {
			if (!L.ready) return;
			if (L.hidden) return;
			if (L.kind === 'sky' && this.use3D()) return;      // 3D 提供天空
			if (L.kind === 'room' && this.use3D() && L.id !== 'room_in') return;
			const w = weightOf(L, env.slots);
			if (w <= 0.002) return;
			if (L.kind === 'sky') skies.push([L, w]);
			else if (L.kind === 'room') rooms.push([L, w]);
			else fronts.push([L, w]);
		});

		const par = LB.props.parallax;
		skies.sort((a, b) => (a[0].parallax || 0) - (b[0].parallax || 0));
		skies.forEach((pair) => {
			const L = pair[0], w = pair[1];
			const r = scene.rectOf(L);
			const scrollPx = (scene.scroll[L.id] || 0) * (L.scale || 1) +
				scene.offset.x * (L.parallax || 0) * -26 * par;
			scene.drawTiledSky(ctx, L, cloudAlpha(env, L.cloud || 'mid', w * (L.tint || 1)),
				scrollPx, r.w);
			/* 云被压暗 -> 天空更灰 */
			scene.tintRect(ctx, r.x, r.y, r.w, r.h,
				[0.28, 0.30, 0.34], env.overcast * 0.5 * w, 'source-atop');
			/* 日出日落给天空加一层暖色 */
			const warm = Math.max(0, 1 - Math.abs(env.sun.elev - 0) / 12);
			scene.tintRect(ctx, r.x, r.y, r.w, r.h,
				[1.0, 0.52, 0.22], warm * 0.35 * w, 'overlay');
		});

		/* --- 2. 房间：按太阳高度角交叉淡化，再统一调色 --- */
		rooms.forEach((pair) => {
			const L = pair[0], w = pair[1];
			scene.drawLayer(ctx, L, w);
			if (L.slot === 'always') return;
			if (this.use3D()) return;   // 3D 模式下室内只做整体明暗，不再逐层调色
			/* 白天偏亮、黄昏偏暖、夜里整体压暗偏蓝 */
			const day = env.daylight;
			const warm = Math.max(0, 1 - Math.abs(env.sun.elev - 3) / 14);
			const dark = 1 - day;
			scene.tintRect(ctx, -W, -H, W * 2, H * 2,
				[1.0, 0.62, 0.34], warm * 0.30 * w, 'overlay');
			scene.tintRect(ctx, -W, -H, W * 2, H * 2,
				[0.10, 0.14, 0.30], dark * 0.42 * w, 'multiply');
			scene.tintRect(ctx, -W, -H, W * 2, H * 2,
				[0.42, 0.45, 0.50], env.overcast * 0.34 * w, 'soft-light');
		});

		/* --- 2.5 太阳阴影（只在远景楼上，房间内不受影响） --- */
		if (LB.props.sunShade > 0.01 && this.shade.ready && !this.use3D()) {
			this.shade.compute(env);
			ctx.save();
			ctx.globalAlpha = LB.props.sunShade;
			this.shade.draw(ctx);
			ctx.restore();
		}

		/* --- 3. 光柱：房间里的空气介质，必须在远景之后、近景之前。
		 *    3D 模式下窗外已经有真光影了，这里只是"屋里那道光"，
		 *    叠在 3D 城市上会糊成一片奶白，所以压到 40%。 --- */
		if (this.use3D()) {
			const keep = env.shaft;
			env.shaft = env.shaft * 0.4;
			this.shafts.draw(ctx, env);
			env.shaft = keep;
		} else {
			this.shafts.draw(ctx, env);
		}

		/* --- 4. 降水与飘落物 ---
		 * WebGL 的 LineBasicMaterial 固定 1px，雨丝在窗外几乎看不见；
		 * 而且雨本来就该只出现在窗外。所以降水统一交给 2D 层画，
		 * 并裁剪到窗户开口内（房间层那里是透明的，裁剪正好对上窗洞）。 */
		ctx.save();
		ctx.beginPath();
		ctx.rect(LB.WINDOW.x, LB.WINDOW.y, LB.WINDOW.w, LB.WINDOW.h);
		ctx.clip();
		this.rain.draw(ctx, env);
		if (this.use3D()) this.snow2dDraw(ctx, env);
		ctx.restore();
		this.motes.draw(ctx);

		/* --- 5. 近景：呼吸 / 摆动（画在最前，不受日照影响） --- */
		const t = this.t;
		fronts.forEach((pair) => {
			const L = pair[0], w = pair[1];
			const r = scene.rectOf(L);
			ctx.save();
			if (L.motion === 'breathe') {
				const amp = (L.amp || 2) * (1 / Math.max(1, L.friction || 1));
				const ph = Math.sin(t * (L.friction > 2 ? 0.55 : 0.85) + r.x * 0.001) * amp;
				ctx.translate(r.x + r.w / 2, r.y + r.h);
				ctx.scale(1 + ph * 0.0016, 1 + ph * 0.0026);
				ctx.translate(-(r.x + r.w / 2), -(r.y + r.h));
			} else if (L.motion === 'sway') {
				const a = Math.sin(t * 0.72 + r.x * 0.002) * (L.amp || 2) * (Math.PI / 180);
				ctx.translate(r.x + r.w / 2, r.y);
				ctx.rotate(a);
				ctx.translate(-(r.x + r.w / 2), -r.y);
			}
			scene.drawLayer(ctx, L, w);
			ctx.restore();
		});

		/* 近景也要跟着室内明暗走，否则夜里人物会比房间亮 */
		scene.tintRect(ctx, -W, -H, W * 2, H * 2,
			[0.10, 0.13, 0.28], (1 - env.daylight) * 0.34, 'multiply');
		scene.tintRect(ctx, -W, -H, W * 2, H * 2,
			[1.0, 0.68, 0.40], Math.max(0, 1 - Math.abs(env.sun.elev - 5) / 16) * 0.22, 'overlay');

		/* --- 6. 雾 --- */
		this.fog.draw(ctx, env);

		/* --- 7. 文字 --- */
		LB.Text.draw(ctx, env, scene);

		scene.end(ctx);

		/* --- 8. 暗角 + 室内整体明暗，让桌面图标更清晰 --- */
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		/* 夜里室内压暗（3D 模式下窗外已经自己在变暗，这里只管室内） */
		const indoorDark = (1 - env.daylight) * (this.use3D() ? 0.34 : 0.0);
		if (indoorDark > 0.01) {
			ctx.globalCompositeOperation = 'source-atop';
			ctx.fillStyle = 'rgba(10,14,30,' + indoorDark.toFixed(3) + ')';
			ctx.fillRect(0, 0, canvas_w(this), canvas_h(this));
			ctx.globalCompositeOperation = 'source-over';
		}
		const vg = ctx.createRadialGradient(
			canvas_w(this) / 2, canvas_h(this) / 2, canvas_h(this) * 0.32,
			canvas_w(this) / 2, canvas_h(this) / 2, canvas_h(this) * 0.86);
		vg.addColorStop(0, 'rgba(0,0,0,0)');
		vg.addColorStop(1, 'rgba(0,0,0,0.34)');
		ctx.fillStyle = vg;
		ctx.fillRect(0, 0, canvas_w(this), canvas_h(this));
	};

	function canvas_w(r) { return r.canvas.width; }
	function canvas_h(r) { return r.canvas.height; }

	LB.Renderer = Renderer;
})(window.LB);

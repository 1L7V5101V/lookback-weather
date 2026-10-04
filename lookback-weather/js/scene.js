/* scene.js —— 图层清单加载 + 绘制原语 */
(function (LB) {
	'use strict';

	function mix(a, b, t) { return a + (b - a) * t; }
	function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
	LB.mix = mix;
	LB.clamp01 = clamp01;

	function rgba(c, a) {
		return 'rgba(' + Math.round(clamp01(c[0]) * 255) + ',' +
			Math.round(clamp01(c[1]) * 255) + ',' +
			Math.round(clamp01(c[2]) * 255) + ',' + a + ')';
	}
	LB.rgba = rgba;

	/* ------------------------------------------------------------------
	 * 场景：加载图层图片，维护屏幕->虚拟坐标变换
	 * ------------------------------------------------------------------ */
	function Scene() {
		this.layers = LB.LAYERS.map((l) => Object.assign({}, l, {
			img: null,
			ready: false,
			rect: null
		}));
		/* 3D 模式下，原作那几张预渲染时段房间图用不到（3D 自带光照） */
		this.applyMode = function (use3D) {
			this.layers.forEach((L) => {
				L.hidden = !!(use3D && L.hidden3d);
			});
		};
		this.applyMode(false);
		this.dpr = 1;
		this.view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
		this.offset = { x: 0, y: 0 };   // 鼠标视差
		this.scroll = 0;               // 云层累积滚动量
	}

	Scene.prototype.load = function () {
		const self = this;
		let pending = this.layers.length;
		this.layers.forEach((L) => {
			const img = new Image();
			img.onload = function () {
				L.img = img;
				L.ready = true;
				if (--pending === 0) self.onReady && self.onReady();
			};
			img.onerror = function () {
				console.warn('[lookback] 图层加载失败:', L.file);
				if (--pending === 0) self.onReady && self.onReady();
			};
			img.src = L.file;
		});
	};

	Scene.prototype.resize = function (canvas) {
		const w = canvas.clientWidth || window.innerWidth;
		const h = canvas.clientHeight || window.innerHeight;
		this.dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = Math.max(2, Math.round(w * this.dpr));
		canvas.height = Math.max(2, Math.round(h * this.dpr));

		/* 对齐方式：cover —— 填满屏幕，超出部分裁掉（对应 WE 的「覆盖」） */
		const s = Math.max(canvas.width / LB.VIEW.W, canvas.height / LB.VIEW.H);
		this.view.scale = s;
		this.view.w = canvas.width;
		this.view.h = canvas.height;
		this.view.ox = (canvas.width - LB.VIEW.W * s) / 2;
		this.view.oy = (canvas.height - LB.VIEW.H * s) / 2;
	};

	/* 虚拟坐标 -> 屏幕 CSS 像素（供 Canvas2D 使用，未乘 dpr） */
	Scene.prototype.toScreen = function (x, y) {
		const s = this.view.scale / this.dpr;
		return {
			x: (x - LB.VIEW.CX - this.offset.x) * s + this.screenW() / 2,
			y: -(y - LB.VIEW.CY - this.offset.y) * s + this.screenH() / 2
		};
	};

	Scene.prototype.screenW = function () { return this.view.w / this.dpr; };
	Scene.prototype.screenH = function () { return this.view.h / this.dpr; };

	/* 应用变换。
	 * 关键：Wallpaper Engine 场景坐标 +y 朝上（相机 up = 0 1 0），
	 * 而 Canvas +y 朝下，所以这里要翻转 Y 轴：
	 *   虚拟 (CX, CY) -> 屏幕中心，虚拟 y 越大 -> 屏幕上越高。
	 * 所有绘制代码都在「虚拟坐标、y 向上」的世界里写。 */
	Scene.prototype.begin = function (ctx) {
		const s = this.view.scale / this.dpr;
		const px = this.view.w / 2, py = this.view.h / 2;
		ctx.setTransform(s, 0, 0, -s,
			px - s * (LB.VIEW.CX + this.offset.x),
			py + s * (LB.VIEW.CY + this.offset.y));
		ctx.save();
	};

	Scene.prototype.end = function (ctx) {
		ctx.restore();
	};

	/* 图层的世界矩形（虚拟坐标） */
	Scene.prototype.rectOf = function (L) {
		const w = L.w * (L.scale || 1);
		const h = L.h * (L.scale || 1);
		return { x: L.cx - w / 2, y: L.cy - h / 2, w: w, h: h };
	};

	/* 画一张普通（不平铺）图层，带透明度。
	 *
	 * 关键：全局矩阵已经翻转了 Y（因为 WE 场景坐标 +y 朝上），
	 * 而 Chrome 的 drawImage 在镜像矩阵下会把图像也镜像，负高度并不会抵消
	 * （实测：flip+(-h) 与 flip+(+h) 结果完全一样，都是倒的）。
	 * 所以正确做法是在绘制前局部再翻一次 Y，再用正高度绘制。 */
	Scene.prototype.drawLayer = function (ctx, L, alpha) {
		if (!L.ready || alpha <= 0.002) return;
		const r = this.rectOf(L);
		ctx.save();
		ctx.scale(1, -1);
		ctx.globalAlpha = clamp01(alpha);
		ctx.drawImage(L.img, r.x, -(r.y + r.h), r.w, r.h);
		ctx.restore();
	};

	/* 横向无缝平铺的天空/云带。
	 * offsetPx: 累积滚动像素；parallax: 视差系数；tilingX: 无缝周期(虚拟单位) */
	Scene.prototype.drawTiledSky = function (ctx, L, alpha, offsetPx, tilingX) {
		if (!L.ready || alpha <= 0.002) return;
		const r = this.rectOf(L);
		const period = tilingX || r.w;
		const ox = ((offsetPx % period) + period) % period;

		ctx.save();
		ctx.beginPath();
		ctx.rect(-LB.VIEW.W, -LB.VIEW.H, LB.VIEW.W * 2, LB.VIEW.H * 2);
		ctx.clip();
		ctx.globalAlpha = clamp01(alpha);

		/* 覆盖 [-W, W] 至少三份 */
		let x = r.x - ox;
		const leftBound = -LB.VIEW.CX - LB.VIEW.W * 0.25;
		const rightBound = LB.VIEW.CX + LB.VIEW.W * 0.25;
		let guard = 0;
		while (x < leftBound && guard++ < 64) x += period;
		guard = 0;
		while (x + period < rightBound && guard++ < 64) x += period;
		for (; x < rightBound; x += period) {
			/* 同 drawLayer：局部反变换 Y，保证图像正立 */
			ctx.save();
			ctx.scale(1, -1);
			ctx.drawImage(L.img, x, -(r.y + r.h), period, r.h);
			ctx.restore();
			if (x > rightBound) break;
		}
		ctx.globalAlpha = 1;
		ctx.restore();
	};

	/* 给某个矩形区域叠加色调（太阳色/天气色），用 overlay/soft-light 保住细节 */
	Scene.prototype.tintRect = function (ctx, x, y, w, h, color, alpha, mode) {
		if (alpha <= 0.002) return;
		ctx.save();
		ctx.globalCompositeOperation = mode || 'soft-light';
		ctx.globalAlpha = clamp01(alpha);
		ctx.fillStyle = rgba(color, 1);
		ctx.fillRect(x, y, w, h);
		ctx.restore();
	};

	LB.Scene = Scene;
})(window.LB);

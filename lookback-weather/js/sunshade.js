/* sunshade.js —— 2.5D 高度场太阳阴影
 *
 * 做法（方案 C）：
 *   1) 从参考层的 alpha 通道自动提取城市天际线高度剖面 H(x)。
 *      房屋*.png 的 alpha 里「黑=天空、白=建筑+窗棂」，正好是干净的城市剪影，
 *      所以高度场跟着素材自动走，换图不用重画。
 *   2) 高度剖面与叠加图**全部在「参考层自己的虚拟矩形」里推导**，
 *      不依赖 LB.WINDOW —— 之前把整张源图压进按 WINDOW 宽高比算的网格，
 *      纵向拉伸了 13.6%，而且 baseY 写死成 WINDOW.y，导致阴影整体错位。
 *   3) 沿太阳屏幕方向做地平线行进（horizon marching）得到投影遮罩。
 *   4) 朗伯项 + 楼缝环境光遮蔽。
 *
 * 输出两张低分辨率叠加图：阴影层(multiply) 与 受光层(screen)。
 * 重算分帧摊销，重算期间继续显示旧图。
 *
 * 坐标系：全局矩阵已翻转 Y，虚拟 y 越大 = 屏幕越高。
 */
(function (LB) {
	'use strict';

	const clamp01 = LB.clamp01;

	function SunShade() {
		this.ready = false;
		this.prof = null;     // Float32Array，每列屋顶高度（相对基线，虚拟单位）
		this.mask = null;     // Uint8Array，1=建筑像素
		this.rect = null;     // 参考层的虚拟矩形 {x0,y0,w,h}
		this.baseY = 0;       // 建筑基线（虚拟 y）
		this.pxW = 1; this.pxH = 1;
		this.maxH = 1;
		this.cacheKey = '';
		this.pending = null;
		this.lightC = this.darkC = this.blurL = this.blurD = null;
		this.gridW = 0; this.gridH = 0;
	}

	/* refImg 已加载；rect 是该图层在虚拟画布里的矩形（y 向上） */
	SunShade.prototype.build = function (refImg, rect, gridW) {
		const w = gridW;
		const h = Math.max(8, Math.round(gridW * rect.h / rect.w));
		this.pxWTmp = rect.w / w;
		const off = document.createElement('canvas');
		off.width = w; off.height = h;
		const c = off.getContext('2d', { willReadFrequently: true });
		/* 保持宽高比：网格比例直接来自源图比例，不再有拉伸 */
		c.drawImage(refImg, 0, 0, w, h);
		let d;
		try {
			d = c.getImageData(0, 0, w, h).data;
		} catch (e) {
			console.warn('[sunshade] 无法读取像素（跨域？），太阳阴影已禁用');
			return false;
		}

		/* alpha -> 二值遮罩 */
		const mask0 = new Uint8Array(w * h);
		for (let i = 0, p = 3; i < mask0.length; i++, p += 4) mask0[i] = d[p] > 128 ? 1 : 0;

		/* 只分析窗户开口区域。
		 * 不限制的话，室内墙面/天花板整行不透明，会把基线检测拉到图像顶部，
		 * 而且叠加图会把室内墙面也染上日光。 */
		const c0 = Math.max(0, Math.floor((LB.WINDOW.x - rect.x0) / this.pxWTmp));
		const c1 = Math.min(w, Math.ceil((LB.WINDOW.x + LB.WINDOW.w - rect.x0) / this.pxWTmp));
		const winTop = rect.y0 + LB.WINDOW.y + LB.WINDOW.h;   // 开口上边（虚拟 y）
		const winBot = rect.y0 + LB.WINDOW.y;                 // 开口下边
		const rTop = Math.max(0, Math.floor((rect.y0 + rect.h - winTop) / (rect.h / h)));
		const rBot = Math.min(h, Math.ceil((rect.y0 + rect.h - winBot) / (rect.h / h)));

		/* 形态学开运算（先腐蚀后膨胀）抹掉细竖线。
		 * 窗棂只有十几像素宽，会在天际线上造成假尖峰，还会投出假影子。
		 * 只对「开口内」的区域做，免得把室内家具也当成建筑。 */
		const r = Math.max(2, Math.round(w / 380));
		const inWin = function (x, y) {
			return (y >= rTop && y <= rBot && x >= c0 && x <= c1) ? 1 : 0;
		};
		const opened = new Uint8Array(w * h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (!inWin(x, y) || !mask0[y * w + x]) continue;
				let ok = 1;
				for (let k = -r; k <= r && ok; k++) {
					const xx = x + k;
					if (xx < 0 || xx >= w || !mask0[y * w + xx]) ok = 0;
				}
				opened[y * w + x] = ok;
			}
		}
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (!opened[y * w + x]) continue;
				let hit = 0;
				for (let k = -r; k <= r && !hit; k++) {
					const xx = x + k;
					if (xx >= 0 && xx < w && opened[y * w + xx]) hit = 1;
				}
				opened[y * w + x] = hit;
			}
		}
		/* 上色遮罩：只在开口内 */
		const mask = opened;

		/* 遮挡剖面：楼底可能在窗台以下（看不见但存在），
		 * 所以剖面必须在**整列范围**上算，不能被开口下边截断，
		 * 否则基线会被抬到窗台、楼的高度凭空少一截。 */
		let baseRow = Math.floor(h * 0.7), best = -1;
		for (let y = 0; y < h - 1; y++) {
			let cnt = 0;
			const r0 = y * w;
			for (let x = c0; x <= c1; x++) if (mask0[r0 + x] && !mask0[r0 + x + w]) cnt++;
			if (cnt > best) { best = cnt; baseRow = y; }
		}
		if (best <= 0) baseRow = Math.round((rTop + rBot) / 2);

		/* 每列屋顶 -> 高度剖面（像素单位），再平滑 */
		const prof = new Float32Array(w);
		let maxH = 1;
		for (let x = c0; x <= c1; x++) {
			let top = -1;
			for (let y = 0; y < baseRow; y++) if (mask0[y * w + x]) { top = y; break; }
			const hh = top < 0 ? 0 : (baseRow - top);
			prof[x] = hh;
			if (hh > maxH) maxH = hh;
		}
		const sm = new Float32Array(w);
		for (let x = 0; x < w; x++) {
			if (x < c0 || x > c1) { sm[x] = 0; continue; }
			let s = 0, n = 0;
			for (let i = -2; i <= 2; i++) {
				const xx = x + i;
				if (xx >= c0 && xx <= c1) { s += prof[xx]; n++; }
			}
			sm[x] = n ? s / n : 0;
		}

		/* 全部换算成虚拟单位 */
		const k = rect.h / h;                       // 网格像素 -> 虚拟单位
		const vprof = new Float32Array(w);
		for (let x = 0; x < w; x++) vprof[x] = sm[x] * k;

		this.pxWTmp = rect.w / w;
		this.prof = vprof;
		this.maxH = Math.max(1, maxH * k);
		this.rect = rect;
		this.pxW = rect.w / w;
		this.pxH = rect.h / h;
		this.gridW = w; this.gridH = h;
		/* 图像自上而下；虚拟 y 向上 -> 图像顶边 = rect.y0 + rect.h */
		const yTop = rect.y0 + rect.h;
		this.baseY = yTop - baseRow * this.pxH;

		this.mask = mask;
		this.lightC = document.createElement('canvas');
		this.lightC.width = w; this.lightC.height = h;
		this.lightCtx = this.lightC.getContext('2d');
		this.darkC = document.createElement('canvas');
		this.darkC.width = w; this.darkC.height = h;
		this.darkCtx = this.darkC.getContext('2d');
		this.ready = true;
		return true;
	};

	/* 某虚拟 x 处的屋顶高度（相对基线） */
	SunShade.prototype.heightAt = function (vx) {
		const p = this.prof;
		if (!p || !this.rect) return 0;
		const t = (vx - this.rect.x0) / this.pxW;
		if (t < 0 || t >= p.length) return 0;
		const i = Math.floor(t), f = t - i;
		return p[i] * (1 - f) + p[Math.min(i + 1, p.length - 1)] * f;
	};

	/* ---------------- 分帧重算 ---------------- */
	SunShade.prototype.compute = function (env, rowsPerCall) {
		if (!this.ready) return false;
		const key = [
			Math.round(env.sun.elev * 3), Math.round(env.sunRel * 3),
			Math.round(env.overcast * 8), LB.props.windowDir, LB.props.windowFine
		].join(',');
		if (key !== this.cacheKey) {
			this.cacheKey = key;
			this.pending = this._beginCompute(env);
		}
		if (!this.pending) return false;
		const p = this.pending;
		const n = rowsPerCall || Math.ceil(this.gridH / 10);
		const y1 = Math.min(p.H, p.gy + n);
		this._renderBand(p, p.gy, y1);
		p.gy = y1;
		if (p.gy >= p.H) { this._finishCompute(p); this.pending = null; }
		return true;
	};

	SunShade.prototype._beginCompute = function (env) {
		const rel = env.sunRel * Math.PI / 180;
		const sinR = Math.sin(rel), cosR = Math.cos(rel);
		return {
			W: this.gridW, H: this.gridH,
			pxW: this.pxW, pxH: this.pxH,
			sx: sinR >= 0 ? 1 : -1,
			sinR: sinR, cosR: cosR,
			/* 太阳在楼后（rel≈0）-> 逆光；太阳在观察者身后（rel≈±180）-> 受光 */
			frontLight: Math.max(0, -cosR),
			backlit: Math.max(0, cosR),
			sideLit: Math.abs(sinR),
			elev: env.sun.elev,
			daylight: LB.Sun.daylight(env.sun.elev),
			overcast: clamp01(env.overcast),
			tanE: Math.max(0.05, Math.tan(Math.max(env.sun.elev, 2) * Math.PI / 180)),
			steps: 22, gy: 0,
			lImg: this.lightCtx.createImageData(this.gridW, this.gridH),
			dImg: this.darkCtx.createImageData(this.gridW, this.gridH)
		};
	};

	SunShade.prototype._renderBand = function (p, y0, y1) {
		const r = this.rect, mask = this.mask, maxH = this.maxH;
		const ld = p.lImg.data, dd = p.dImg.data;
		const W = p.W, steps = p.steps;
		const yTop = r.y0 + r.h;
		const soft = 1 - p.overcast * 0.8;
		const sinE = Math.max(0, Math.sin(p.elev * Math.PI / 180));
		/* 影子在屏幕上的长度 ∝ |sin(rel)|；射线每单位屏幕 x 上升 tanE/|sin(rel)| */
		const reach = maxH * p.sideLit / p.tanE;
		const rise = p.tanE / Math.max(p.sideLit, 0.25);
		const stepX = reach / steps;
		const march = stepX > 0.5 && p.sideLit * soft > 0.02;

		for (let gy = y0; gy < y1; gy++) {
			/* 网格行 -> 虚拟 y（向上） */
			const vy = yTop - gy * p.pxH;
			const hSelf = this.baseY - vy;          // >0 在建筑轮廓高度范围内
			for (let gx = 0; gx < W; gx++) {
				const vx = r.x0 + gx * p.pxW;
				const idx = (gy * W + gx) * 4;
				const isBuilding = mask[gy * W + gx] === 1;

				if (!isBuilding) {
					/* 天空辉光：只在太阳确实在窗外（逆光侧）出现 */
					const pos = clamp01(0.5 + p.sinR * 0.45);
					const side = clamp01(1 - Math.abs(gx / W - pos) * 4.5);
					const g = side * p.backlit * (1 - p.overcast * 0.7) * p.daylight * 0.9;
					ld[idx] = 255 * g * 0.98;
					ld[idx + 1] = 255 * g * 0.70;
					ld[idx + 2] = 255 * g * 0.40;
					ld[idx + 3] = 255 * clamp01(g * 2.4);
					dd[idx] = 255; dd[idx + 1] = 255; dd[idx + 2] = 255; dd[idx + 3] = 0;
					continue;
				}

				const roof = this.heightAt(vx);
				let sh = 0;
				if (march) {
					for (let t = 1; t <= steps; t++) {
						const u = t * stepX;
						const occ = this.heightAt(vx + p.sx * u);
						const over = (occ - (hSelf + u * rise)) / (maxH * 0.34);
						if (over > sh) sh = over > 1 ? 1 : over;
					}
				}
				sh = Math.max(sh, p.backlit * 0.8 * (1 - p.frontLight * 0.5));
				sh *= soft;

				const ao = 0.42 + 0.58 * clamp01(hSelf / (maxH * 0.55));
				const isRoof = hSelf > roof - p.pxH * 2.5;
				let lam = isRoof ? sinE
					: p.frontLight * (0.45 + 0.55 * Math.min(1, sinE * 2.2));
				lam *= soft * (1 - sh * 0.85);

				/* 阴影层（multiply） */
				const depth = 1 - sh * (0.30 + 0.16 * (1 - sinE));
				const amb = (1 - p.daylight * 0.7) * (1 - p.overcast * 0.3);
				let mr = depth * (1 - amb * 0.30);
				let mg = depth * (1 - amb * 0.26);
				let mb = depth * (1 - amb * 0.12);
				if (sh > 0.05) { mr *= 0.93; mg *= 0.97; }
				mr *= 0.72 + 0.28 * ao; mg *= 0.72 + 0.28 * ao; mb *= 0.78 + 0.22 * ao;
				dd[idx] = 255 * mr; dd[idx + 1] = 255 * mg; dd[idx + 2] = 255 * mb;
				dd[idx + 3] = 255;

				/* 受光层（screen） */
				const amt = lam * ao * p.daylight;
				ld[idx] = 255 * Math.min(1, amt);
				ld[idx + 1] = 255 * Math.min(1, amt * 0.80);
				ld[idx + 2] = 255 * Math.min(1, amt * 0.55);
				ld[idx + 3] = 255 * Math.min(1, amt * 1.8);
			}
		}
	};

	SunShade.prototype._finishCompute = function (p) {
		const W = p.W, H = p.H;
		this.lightCtx.putImageData(p.lImg, 0, 0);
		this.darkCtx.putImageData(p.dImg, 0, 0);
		/* 叠图会被放大 3 倍左右，原尺寸先模糊一次消掉阶梯锯齿 */
		if (!this.blurL) {
			this.blurL = document.createElement('canvas');
			this.blurL.width = W; this.blurL.height = H;
			this.blurLD = this.blurL.getContext('2d');
			this.blurD = document.createElement('canvas');
			this.blurD.width = W; this.blurD.height = H;
			this.blurDD = this.blurD.getContext('2d');
		}
		const blurPx = 'blur(' + Math.max(0.8, W / 1100).toFixed(2) + 'px)';
		this.blurLD.clearRect(0, 0, W, H);
		this.blurLD.filter = blurPx;
		this.blurLD.drawImage(this.lightC, 0, 0);
		this.blurLD.filter = 'none';
		this.blurDD.clearRect(0, 0, W, H);
		this.blurDD.filter = blurPx;
		this.blurDD.drawImage(this.darkC, 0, 0);
		this.blurDD.filter = 'none';
	};

	/* 叠加图只画在参考层的矩形范围内（遮罩保证只落在建筑/天空该落的地方） */
	SunShade.prototype.draw = function (ctx) {
		if (!this.ready || !this.blurD || !this.rect) return;
		const r = this.rect;
		ctx.save();
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.scale(1, -1);
		ctx.globalCompositeOperation = 'multiply';
		ctx.drawImage(this.blurD, r.x0, -(r.y0 + r.h), r.w, r.h);
		ctx.globalCompositeOperation = 'screen';
		ctx.drawImage(this.blurL, r.x0, -(r.y0 + r.h), r.w, r.h);
		ctx.restore();
	};

	LB.SunShade = SunShade;
})(window.LB);

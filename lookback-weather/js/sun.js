/* sun.js —— 太阳位置（NOAA 算法）+ 天色 LUT + 时间槽位权重
 *
 * 全部本地计算，不依赖网络：只要有经纬度，日出日落和太阳角度永远可用。
 */
(function (LB) {
	'use strict';

	const RAD = Math.PI / 180;

	/* 太阳高度角 -> 天色。t 为归一化色 (r,g,b 0-1) */
	const SKY_STOPS = [
		{ e: -90, c: [0.016, 0.024, 0.055] },  // 深夜
		{ e: -18, c: [0.022, 0.035, 0.078] },
		{ e: -12, c: [0.055, 0.075, 0.150] },  // 民用暮光
		{ e: -6,  c: [0.180, 0.150, 0.230] },
		{ e: -2,  c: [0.520, 0.270, 0.230] },  // 地平线
		{ e: 2,   c: [0.880, 0.470, 0.260] },  // 日出/日落
		{ e: 8,   c: [1.000, 0.740, 0.470] },  // 黄金时刻
		{ e: 20,  c: [1.000, 0.900, 0.780] },
		{ e: 40,  c: [0.870, 0.930, 1.000] },  // 白昼
		{ e: 70,  c: [0.930, 0.965, 1.000] }
	];

	function lerp(a, b, t) { return a + (b - a) * t; }

	function skyColor(elev) {
		let a = SKY_STOPS[0], b = SKY_STOPS[SKY_STOPS.length - 1];
		for (let i = 0; i < SKY_STOPS.length - 1; i++) {
			if (elev >= SKY_STOPS[i].e && elev <= SKY_STOPS[i + 1].e) {
				a = SKY_STOPS[i]; b = SKY_STOPS[i + 1];
				break;
			}
		}
		if (elev < SKY_STOPS[0].e) { a = b = SKY_STOPS[0]; }
		if (elev > SKY_STOPS[b === a ? 0 : SKY_STOPS.length - 1].e && a === b) { /* noop */ }
		const span = b.e - a.e;
		const t = span > 0 ? Math.min(1, Math.max(0, (elev - a.e) / span)) : 0;
		const s = t * t * (3 - 2 * t); // smoothstep
		return [lerp(a.c[0], b.c[0], s), lerp(a.c[1], b.c[1], s), lerp(a.c[2], b.c[2], s)];
	}

	/* 太阳高度角 -> 白昼强度 0..1（-6° 以下算夜） */
	function daylight(elev) {
		return Math.min(1, Math.max(0, (elev + 6) / 12));
	}

	function fmt(n, d) { return n.toFixed(d === undefined ? 2 : d); }

	/* ------------------------------------------------------------------
	 * NOAA 太阳位置算法（真太阳时，完全不依赖时区）
	 *   lat/lon : 度，东经为正
	 *   date    : 绝对时刻（Date）
	 * 返回 { elev, azim, morning, sunriseMin, sunsetMin, solarNoonMin }
	 *   elev/azim 为度，azim 自北顺时针
	 *   sunrise/sunset/noon 为「UTC 当日分钟数」，显示时再按目标城市时区换算
	 *
	 * 之前踩过的坑：
	 *   1) 用 getUTCHours() 同时又减时区偏移 -> 时区算了两遍，方位角偏 8 小时；
	 *   2) 方位角公式少了前面的负号 -> 正午算成 azimuth≈1° 而不是 180°。
	 * ------------------------------------------------------------------ */
	function position(lat, lon, date) {
		const start = Date.UTC(date.getUTCFullYear(), 0, 0);
		const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
		const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() +
			date.getUTCSeconds() / 60;

		const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (utcMin / 60 - 12) / 24);

		const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
			0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
		const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
			0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
			0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

		/* 真太阳时：UTC 分钟 + 时差方程 + 4×经度 */
		const tst = utcMin + eqTime + 4 * lon;
		const ha = (tst / 4 - 180) * RAD; // 时角（弧度）

		const latR = lat * RAD;
		const cosZ = Math.min(1, Math.max(-1,
			Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha)));
		const zen = Math.acos(cosZ);
		const elev = 90 - zen / RAD;

		let azim;
		const sinZ = Math.sin(zen);
		if (Math.abs(sinZ) < 1e-6) {
			azim = 180;
		} else {
			/* 注意前面那个负号，漏了会在正午算出 azimuth≈0 */
			const c = Math.min(1, Math.max(-1,
				-(Math.sin(latR) * cosZ - Math.sin(decl)) / (Math.cos(latR) * sinZ)));
			azim = Math.acos(c) / RAD;          // 0..180，自北
			azim = ha > 0 ? 360 - azim : azim;   // 下午在西方 -> 镜像
		}

		/* 日出日落：地平线 -0.833°，结果是 UTC 分钟 */
		const cosH = (Math.cos(90.833 * RAD) - Math.sin(latR) * Math.sin(decl)) /
			(Math.cos(latR) * Math.cos(decl));
		let sunrise = null, sunset = null, solarNoon = null;
		if (cosH >= -1 && cosH <= 1) {
			const H = Math.acos(cosH) / RAD;
			solarNoon = 720 - 4 * lon - eqTime;
			sunrise = solarNoon - 4 * H;
			sunset = solarNoon + 4 * H;
		}

		return {
			elev: elev,
			azim: azim,
			hourAngle: ((ha / RAD) % 360 + 360) % 360,
			sunriseMin: sunrise,
			sunsetMin: sunset,
			solarNoonMin: solarNoon,
			morning: ha < 0
		};
	}

	/* 构造一个「目标城市当地钟表 hour 点」对应的绝对时刻。
	 * 手动锁定时刻时用：用户说「18 点」，指的是他选的那个城市的 18 点。 */
	function dateAtLocalHour(baseDate, hour, tzHours) {
		const utcMin = (((hour * 60) - tzHours * 60) % 1440 + 1440) % 1440;
		const midnightUTC = Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(),
			baseDate.getUTCDate(), 0, 0, 0, 0);
		return new Date(midnightUTC + utcMin * 60000);
	}

	/* UTC 分钟 -> 目标城市当地 HH:MM */
	function formatMinutes(utcMin, tzHours) {
		if (utcMin === null || utcMin === undefined || !isFinite(utcMin)) return '--:--';
		let m = (utcMin + (tzHours || 0) * 60) % 1440;
		if (m < 0) m += 1440;
		const h = Math.floor(m / 60), mm = Math.floor(m % 60);
		return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
	}

	/* ---------- 时间槽位权重 ----------
	 * 输入太阳高度角 + 是否上午，输出每个槽位的连续权重（和为 1）。
	 * 边界用梯形 + smoothstep 软化，于是过渡是渐变而不是原作那种 18 分钟硬切。 */
	function smoothstep(e0, e1, x) {
		const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
		return t * t * (3 - 2 * t);
	}

	/* 梯形隶属度：在 [lo,hi] 内为 1，两侧各 soft 宽度渐变 */
	function band(e, lo, hi, soft) {
		return smoothstep(lo - soft, lo + soft, e) *
			(1 - smoothstep(hi - soft, hi + soft, e));
	}

	const BANDS = [
		{ key: 'lateNight', lo: -90, hi: -12, soft: 5, morning: null },
		{ key: 'dusk', lo: -12, hi: -5, soft: 4, morning: null },
		{ key: 'sunset', lo: -5, hi: 3, soft: 4, morning: false },
		{ key: 'dawn', lo: -5, hi: 3, soft: 4, morning: true },
		{ key: 'afternoon', lo: 3, hi: 22, soft: 5, morning: false },
		{ key: 'morningLow', lo: 3, hi: 22, soft: 5, morning: true },
		{ key: 'noon', lo: 22, hi: 90, soft: 8, morning: null }
	];

	function slotWeights(elev, morning) {
		const w = {};
		let sum = 0;
		for (let i = 0; i < BANDS.length; i++) {
			const b = BANDS[i];
			if (b.morning !== null && b.morning !== morning) continue;
			const v = band(elev, b.lo, b.hi, b.soft);
			if (v > 0) { w[b.key] = v; sum += v; }
		}
		if (sum <= 1e-6) {          // 理论上不会发生，兜底
			w[morning ? 'morningLow' : 'afternoon'] = 1;
			sum = 1;
		}
		for (const k in w) w[k] /= sum;
		return w;
	}

	/* 供 HUD 显示的主导槽位 */
	function dominant(weights) {
		let best = null, bv = -1;
		for (const k in weights) if (weights[k] > bv) { bv = weights[k]; best = k; }
		return best;
	}

	LB.Sun = {
		position: position,
		dateAtLocalHour: dateAtLocalHour,
		formatMinutes: formatMinutes,
		skyColor: skyColor,
		daylight: daylight,
		slotWeights: slotWeights,
		dominant: dominant,
		fmt: fmt
	};
})(window.LB);

/* weather.js —— 定位 + 实时天气 + 统一环境状态
 *
 * 设计原则：
 *   1. 太阳位置永远本地可算（只要有经纬度），断网也有真实日出日落；
 *   2. 天气只做增强。任何一步失败都退回「手动覆盖值」，绝不让壁纸黑屏；
 *   3. 全部带超时。Wallpaper Engine 里 fetch 可能因为 file:// 源被拒，
 *      所以每个请求都有 AbortController + 明确的失败原因，供 HUD 显示。
 */
(function (LB) {
	'use strict';

	const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
	const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
	const IP_GEO = ['https://ipwho.is/', 'https://get.geojs.io/v1/ip/geo.json'];
	const CACHE_KEY = 'lb.weather.v1';
	const TIMEOUT = 9000;

	/* ---------------- 运行时状态 ---------------- */
	const S = {
		lat: 39.9042,
		lon: 116.4074,
		cityName: '北京',
		geoSource: '默认',

		// 天气（单位：cloud/rain 为 0-100，wind 为 km/h）
		cloudLow: 40, cloudMid: 40, cloudHigh: 40,
		windSpeed: 10,
		windDirection: 270,     // 气象学约定：风的「来向」，0=北 90=东 180=南 270=西
		precipProb: 0,
		snowfall: 0,
		temperature: null,
		weatherCode: 0,
		isDay: true,

		// 数据来源：live=联网成功  manual=用户手动覆盖  default=内置默认
		weatherSource: 'default',
		geoSourceKind: 'default',
		tzHours: -new Date().getTimezoneOffset() / 60,
		tzSource: '系统时区',
		lastFetch: 0,
		lastError: '',
		updatedAt: null
	};

	let refreshTimer = 0;

	/* 目标城市的时区（小时）。优先用 open-meteo 返回的 utc_offset，
	 * 其次用地理编码返回的时区名，最后用本机时区。 */
	function setTimezone(name, utcOffsetSeconds) {
		if (typeof utcOffsetSeconds === 'number' && isFinite(utcOffsetSeconds)) {
			S.tzHours = utcOffsetSeconds / 3600;
			S.tzSource = 'open-meteo';
			return;
		}
		if (name) {
			try {
				const dtf = new Intl.DateTimeFormat('en-US', {
					timeZone: name, timeZoneName: 'shortOffset'
				});
				const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(dtf.format(new Date()));
				if (m) {
					S.tzHours = parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 60 : 0);
					S.tzSource = name;
					return;
				}
			} catch (e) { /* 时区名不认识就忽略 */ }
		}
		S.tzHours = -new Date().getTimezoneOffset() / 60;
		S.tzSource = '系统时区';
	}

	/* ---------------- 工具 ---------------- */
	function withTimeout(promiseFactory, ms) {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), ms);
		return promiseFactory(ctl.signal).finally(() => clearTimeout(t));
	}

	async function getJSON(url) {
		return withTimeout((signal) => fetch(url, { signal, cache: 'no-store' }), TIMEOUT)
			.then((r) => {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r.json();
			});
	}

	function saveCache() {
		try {
			localStorage.setItem(CACHE_KEY, JSON.stringify({
				lat: S.lat, lon: S.lon, cityName: S.cityName,
				cloudLow: S.cloudLow, cloudMid: S.cloudMid, cloudHigh: S.cloudHigh,
				windSpeed: S.windSpeed, precipProb: S.precipProb, snowfall: S.snowfall,
				temperature: S.temperature, weatherCode: S.weatherCode,
				weatherSource: S.weatherSource, updatedAt: S.updatedAt
			}));
		} catch (e) { /* file:// 下 localStorage 可能不可用，忽略 */ }
	}

	function loadCache() {
		try {
			const raw = localStorage.getItem(CACHE_KEY);
			if (!raw) return false;
			const c = JSON.parse(raw);
			if (typeof c.lat !== 'number' || typeof c.lon !== 'number') return false;
			Object.keys(c).forEach((k) => { if (k in S) S[k] = c[k]; });
			return true;
		} catch (e) { return false; }
	}

	/* ---------------- 定位 ---------------- */
	async function locateByIP() {
		const errs = [];
		for (let i = 0; i < IP_GEO.length; i++) {
			try {
				const j = await getJSON(IP_GEO[i]);
				if (j.success === false) throw new Error(j.message || '接口返回失败');
				const lat = j.latitude !== undefined ? j.latitude : j.lat;
				const lon = j.longitude !== undefined ? j.longitude : j.lon;
				if (typeof lat === 'number' && typeof lon === 'number') {
					S.lat = lat; S.lon = lon;
					S.cityName = j.city || j.region || ('IP ' + (j.ip || ''));
					S.geoSourceKind = 'ip:' + new URL(IP_GEO[i]).host;
					setTimezone(null, null);
					S.lastError = '';
					return true;
				}
				errs.push(new URL(IP_GEO[i]).host + ' 返回里没有经纬度');
			} catch (e) { errs.push(new URL(IP_GEO[i]).host + ' ' + (e.message || e)); }
		}
		throw new Error(errs.join(' / '));
	}

	async function locateByCity(name) {
		const url = GEOCODE + '?name=' + encodeURIComponent(name) +
			'&count=1&language=zh&format=json';
		const j = await getJSON(url);
		if (!j.results || !j.results.length) throw new Error('找不到城市「' + name + '」');
		S.lat = j.results[0].latitude;
		S.lon = j.results[0].longitude;
		S.cityName = j.results[0].name;
		S.geoSourceKind = 'geocode';
		setTimezone(j.results[0].timezone, null);
		S.lastError = '';
		return true;
	}

	function locateManual(text) {
		const m = String(text || '').split(/[,，\s]+/).map(Number);
		if (m.length >= 2 && m.every((n) => isFinite(n)) &&
			m[0] >= -90 && m[0] <= 90 && m[1] >= -180 && m[1] <= 180) {
			S.lat = m[0]; S.lon = m[1];
			S.cityName = m[0].toFixed(3) + ', ' + m[1].toFixed(3);
			S.geoSourceKind = 'manual';
			setTimezone(null, null);
			return true;
		}
		return false;
	}

	/* ---------------- 天气 ---------------- */
	async function fetchWeather() {
		const url = OPEN_METEO +
			'?latitude=' + S.lat.toFixed(4) + '&longitude=' + S.lon.toFixed(4) +
			'&current=temperature_2m,weather_code,is_day,cloud_cover_low,cloud_cover_mid,' +
			'cloud_cover_high,wind_speed_10m,wind_direction_10m,wind_gusts_10m,' +
			'precipitation_probability,snowfall' +
			'&daily=sunrise,sunset' +
			'&timezone=auto&forecast_days=1&wind_speed_unit=kmh';

		const j = await getJSON(url);
		const c = j.current || {};
		if (typeof c.cloud_cover_low !== 'number') throw new Error('返回结构异常');

		S.cloudLow = c.cloud_cover_low;
		S.cloudMid = c.cloud_cover_mid;
		S.cloudHigh = c.cloud_cover_high;
		S.windSpeed = c.wind_speed_10m;
		if (typeof c.wind_direction_10m === 'number') S.windDirection = c.wind_direction_10m;
		S.precipProb = c.precipitation_probability || 0;
		S.snowfall = c.snowfall || 0;
		S.temperature = c.temperature_2m;
		S.weatherCode = c.weather_code;
		S.isDay = !!c.is_day;
		setTimezone(j.timezone, j.utc_offset_seconds);
		S.weatherSource = 'live';
		S.updatedAt = new Date();
		S.lastError = '';
		saveCache();
		return j;
	}

	/* WMO code 归类，用于决定是否下雨/下雪 */
	function isWet(code) {
		return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ||
			(code >= 95 && code <= 99);
	}
	function isSnowy(code) {
		return (code >= 71 && code <= 77) || code === 85 || code === 86;
	}

	/* ---------------- 对外：计算当前环境 ---------------- */
	function computeEnv(now) {
		const P = LB.props;
		const date = now || new Date();

		/* 1) 太阳位置（真太阳时，只依赖绝对时刻 + 经纬度） */
		let sp;
		if (P.solarMode === 'clock') {
			/* 兼容对比用：完全复刻原壁纸的 engine.timeOfDay 行为 */
			const h = date.getHours() + date.getMinutes() / 60;
			sp = LB.Sun.position(0, 0, date);
			sp.elev = h * 15 - 90;
			sp.morning = h < 12;
			sp.azim = sp.morning ? 90 + sp.elev * 1.4 : 270 + sp.elev * 1.4;
		} else if (P.solarMode === 'manual') {
			/* manualHour 指目标城市的当地钟表小时 */
			sp = LB.Sun.position(S.lat, S.lon,
				LB.Sun.dateAtLocalHour(date, P.manualHour, S.tzHours));
			sp.manualHour = P.manualHour;
		} else {
			sp = LB.Sun.position(S.lat, S.lon, date);
		}
		sp.tzHours = S.tzHours;

		/* 2) 天气数值：实时 / 手动覆盖 */
		let cloudLow, cloudMid, cloudHigh, wind, precip, code, windDir;
		if (P.weatherAuto && S.weatherSource === 'live') {
			cloudLow = S.cloudLow; cloudMid = S.cloudMid; cloudHigh = S.cloudHigh;
			wind = S.windSpeed; precip = S.precipProb; code = S.weatherCode;
			windDir = S.windDirection;
		} else {
			cloudLow = P.cloudLowOv; cloudMid = P.cloudMidOv; cloudHigh = P.cloudHighOv;
			wind = P.windOverride;
			windDir = P.windDirOv;
			precip = P.rainOverride;
			code = P.wmoOverride >= 0 ? P.wmoOverride
				: (precip > 0 ? 61
					: (cloudLow > 70 ? 3 : (cloudLow > 30 ? 2 : 0)));
		}

		/* 风的水平分量。
		 * wind_direction_10m 是「来向」，风实际往 来向+180° 吹。
		 * 屏幕上 +x = 东，所以「西风」(来向 270) 吹向东 -> wx 为正。
		 * 换算：1 km/h -> 12 个虚拟单位/秒。 */
		const windX = -Math.sin(windDir * Math.PI / 180) * wind * 12;

		const wmo = LB.WMO[code] || LB.WMO[0];

		/* 3) 天色 = 太阳色 与 天气色 按云量混合 */
		const sunC = LB.Sun.skyColor(sp.elev);
		const dayF = LB.Sun.daylight(sp.elev);
		const cloudAvg = (cloudLow * 0.45 + cloudMid * 0.35 + cloudHigh * 0.20) / 100;
		const overcast = Math.min(1, cloudAvg * 0.75 + wmo.dim);
		const grey = [0.30, 0.32, 0.36];
		const skyC = [
			LB.mix(sunC[0], grey[0], overcast * 0.72),
			LB.mix(sunC[1], grey[1], overcast * 0.72),
			LB.mix(sunC[2], grey[2], overcast * 0.70)
		];

		/* 4) 窗户与太阳的相对方位：决定有没有光柱、光柱朝哪偏。
		 *  rel = 0 表示太阳正对窗户（直射，最强）；±90° 是侧光；超过 90° 太阳在墙后，没有光。
		 *  阴天/雨天再乘一个衰减 —— 厚云下不会有清晰光柱。 */
		const winAzim = (P.windowDir + P.windowFine + 360) % 360;
		let rel = sp.azim - winAzim;
		rel = ((rel % 360) + 540) % 360 - 180;   // -180..180，0 = 太阳正对窗户
		const facing = Math.max(0, Math.cos(rel * Math.PI / 180)); // 0..1
		const clearSky = 1 - Math.min(1, overcast * 0.85);
		const shaftBase = dayF * Math.pow(facing, 1.4) * clearSky;

		return {
			date: date,
			sun: sp,
			tzHours: S.tzHours,
			skyColor: skyC,
			sunColor: sunC,
			daylight: dayF,
			overcast: overcast,
			desat: wmo.desat,
			sat: wmo.sat,
			weatherName: wmo.name,
			code: code,
			cloud: { low: cloudLow / 100, mid: cloudMid / 100, high: cloudHigh / 100 },
			wind: wind,
			windDir: windDir,     // 来向，0=北
			windX: windX,         // 有符号的横向分量（虚拟单位/秒）
			precip: precip / 100,
			wet: isWet(code),
			snowy: isSnowy(code),
			snowfall: S.snowfall,
			temperature: S.temperature,
			windowAzim: winAzim,
			sunRel: rel,
			shaft: shaftBase * P.shaftSize,
			slots: LB.Sun.slotWeights(sp.elev, sp.morning)
		};
	}

	/* ---------------- 生命周期 ---------------- */
	async function refreshLocation() {
		const P = LB.props;
		try {
			if (P.locateMode === 'latlon') {
				if (!locateManual(P.latLonInput)) throw new Error('经纬度格式应为 纬度,经度');
			} else if (P.locateMode === 'manual') {
				await locateByCity(P.cityInput);
			} else {
				await locateByIP();
			}
			S.lastError = '';
			saveCache();
		} catch (e) {
			S.lastError = '定位失败：' + (e && e.message ? e.message : e);
			if (P.locateMode !== 'auto') {
				// 用户明确要求手动模式却失败：仍然尝试解析经纬度
				locateManual(P.latLonInput);
			}
		}
	}

	async function refreshWeather() {
		if (!LB.props.weatherAuto) { S.weatherSource = 'manual'; return; }
		try {
			await fetchWeather();
			scheduleRefresh();
		} catch (e) {
			S.lastError = '天气获取失败：' + (e && e.message ? e.message : e) +
				'（已使用缓存/手动值）';
			if (S.weatherSource !== 'live') S.weatherSource = loadCache() ? 'live' : 'default';
			scheduleRefresh();
		}
	}

	function scheduleRefresh() {
		clearTimeout(refreshTimer);
		const min = Math.max(5, LB.props.autoRefreshMin | 0);
		refreshTimer = setTimeout(refreshWeather, min * 60000);
	}

	LB.Weather = {
		state: S,
		computeEnv: computeEnv,
		init: function () {
			loadCache();
			refreshLocation().then(refreshWeather);
		},
		onPropsChanged: function () {
			clearTimeout(refreshTimer);
			refreshLocation().then(refreshWeather);
		}
	};
})(window.LB);

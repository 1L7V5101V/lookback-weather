/* text.js —— 标题 / 署名 / 日期 / 时钟
 *
 * 原作这些是 WE 内置 text 图层，字体 Anurati + Alcubierre（来自别人的工坊项，
 * 也是有版权的）。这里先用系统等宽字体顶替，发布前换成你有授权的字体。
 */
(function (LB) {
	'use strict';

	const FONT = '"Courier New", ui-monospace, Menlo, Consolas, monospace';

	/* 原作文字层的位置（虚拟坐标，直接沿用 scene.json） */
	const POS = {
		title: { x: 2602, y: 2164, size: 62, sizeH: 850 },
		sign: { x: 2542, y: 1738, size: 34, sizeH: 1194 },
		date: { x: 2531, y: 1862, size: 26, sizeH: 599 },
		clock: { x: 2508, y: 1955, size: 30, sizeH: 368 }
	};

	function centered(ctx, text, x, y, px, alpha, color) {
		ctx.save();
		/* 场景坐标 y 向上，所以文字要局部翻转，否则会上下颠倒 */
		ctx.translate(x, y);
		ctx.scale(1, -1);
		ctx.font = '600 ' + px + 'px ' + FONT;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.globalAlpha = alpha;
		ctx.fillStyle = color;
		/* 一点辉光，模仿原作的高斯柔化 */
		ctx.shadowColor = 'rgba(0,0,0,0.55)';
		ctx.shadowBlur = px * 0.55;
		ctx.fillText(text, 0, 0);
		ctx.fillText(text, 0, 0);
		ctx.restore();
	}

	function two(v) { return (v < 10 ? '0' : '') + v; }

	LB.Text = {
		draw: function (ctx, env, scene) {
			const P = LB.props;
			/* 夜里文字压暗，白天几乎不可见（跟原作一致：文字是"画"的一部分） */
			const lum = 0.55 + 0.45 * env.daylight;
			const white = 'rgba(238,244,255,' + (0.82 * lum).toFixed(3) + ')';
			const warm = 'rgba(255,232,200,' + (0.72 * lum).toFixed(3) + ')';

			if (P.titleText) {
				centered(ctx, P.titleText, POS.title.x, POS.title.y,
					POS.title.size, 0.9, white);
			}
			if (P.signText) {
				centered(ctx, P.signText, POS.sign.x, POS.sign.y,
					POS.sign.size, 0.72, warm);
			}
			if (P.showClock) {
				const d = env.date;
				const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
				centered(ctx, d.getFullYear() + '.' + two(d.getMonth() + 1) + '.' +
					two(d.getDate()) + ' 周' + wk,
					POS.date.x, POS.date.y, POS.date.size, 0.6, white);
				centered(ctx, two(d.getHours()) + ':' + two(d.getMinutes()),
					POS.clock.x, POS.clock.y, POS.clock.size, 0.6, white);
			}
		}
	};
})(window.LB);

/* city3d.js —— 漫画风 3D 外景（three.js）
 *
 * 思路：房间保留原来的 2D 手绘（屋内.png 的 alpha 正好是干净窗洞），
 * 窗外换成真 3D 场景，垫在 2D 画布下面，靠 alpha 自然合成。
 * 这样「伪 2D」成立：室内是画，室外是光。
 *
 * 光照是真的：太阳方向来自 sun.js 算出的真实高度角/方位角，
 * 窗户朝向决定相机朝向，所以「太阳在不在窗前」这件事在 3D 里自然成立。
 *
 * 世界坐标约定（与 2D 侧的 +y 朝上一致）：
 *   相机朝 -Z 看；+X = 窗户朝向右转 90° 的方向
 *   rel = 太阳方位角 − 窗户法线   →  太阳水平方向 = (sin rel, 0, −cos rel)
 */
(function (LB) {
	'use strict';

	const clamp01 = LB.clamp01;

	/* ---------- 确定性随机（保证每次生成同一座城市） ---------- */
	function mulberry32(a) {
		return function () {
			a |= 0; a = a + 0x6D2B79F5 | 0;
			let t = Math.imul(a ^ a >>> 15, 1 | a);
			t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
			return ((t ^ t >>> 14) >>> 0) / 4294967296;
		};
	}

	/* 配色取自原作那种低饱和暖灰 + 少量赭红 */
	const PALETTE = [
		0xbcae97, 0xab9778, 0x988074, 0x8d5f4c, 0x74819a,
		0x556377, 0x7c868f, 0xa89a83, 0x5f6875, 0x9c8a74
	];

	function City3D(canvas) {
		this.canvas = canvas;
		this.enabled = false;
		this.ok = false;
		this.scale = 0.6;          // 3D 渲染分辨率比例（窗外背景，稍软反而更贴画感）
		this.quality = 1;
		this.shadowDirty = true;
		this.sunKey = '';
		this.t = 0;
		this.cityReady = false;
		this._dt = 0.016;
		this._wx = 0;
		this._rainFall = 50;
		this._snowFall = 6;
		this.onCityReady = null;
	}

	/* ---------------- 初始化 ---------------- */
	City3D.prototype.init = function () {
		const THREE = window.THREE;
		const self = this;
		if (!THREE) {
			console.warn('[city3d] three.js 未加载');
			return false;
		}
		this.THREE = THREE;
		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({
				canvas: this.canvas, antialias: true, alpha: false,
				powerPreference: 'high-performance'
			});
		} catch (e) {
			console.warn('[city3d] WebGL 不可用：', e);
			return false;
		}
		renderer.setPixelRatio(1);
		if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
		else if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
		/* 色调映射：没有它，赛璐璐色阶 + 方向光会直接顶到纯白 */
		if (THREE.ACESFilmicToneMapping !== undefined && 'toneMapping' in renderer) {
			renderer.toneMapping = THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = 0.78;
		} else if ('toneMapping' in renderer) {
			renderer.toneMapping = 1;   // Linear
			renderer.toneMappingExposure = 0.9;
		}
		if ('shadowMap' in renderer) {
			renderer.shadowMap.enabled = true;
			if (THREE.PCFSoftShadowMap) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
			/* 太阳不动时阴影贴图不用重画 */
			renderer.shadowMap.autoUpdate = false;
		}
		this.renderer = renderer;

		this.scene = new THREE.Scene();
		/* 平视。原作的构图（从房屋3.png 的 alpha 量出来的）：
		 *   建筑基线在画面 77% 处 -> 相机略高于街面、接近平视
		 *   屋顶中位数约在 40%   -> 多数楼顶略高于视平线
		 *   最高楼顶几乎顶到上沿 -> 最高楼约在 75° 仰角方向
		 * 所以：相机基本水平，只压 2°，楼群集中在正前方一小片。 */
		this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.5, 4200);
		this.camera.position.set(0, 0, 60);
		this.camera.lookAt(0, -6, -160);

		this._buildSky();
		this._buildLights();
		this._buildClouds();
		this._buildWeather();
		/* 楼群布局：优先用你上次编辑存下来的那份，没有才用默认 */
		const saved = this.loadSaved();
		this.spec = saved || JSON.parse(JSON.stringify(LB.CITY_SPEC));
		this.specRestored = !!saved;
		/* 开间贴图要先加载完再拼城市 */
		this.loadKit('assets/city/build_001.bin', function () {
		self._loadBays(function () {
			try {
				self._buildCity();
				self.cityReady = true;
			} catch (e) {
				self.cityError = (e && e.message ? e.message : String(e));
				console.error('[city3d] 建城失败', e);
			}
			if (self.onCityReady) self.onCityReady();
		});
		});

		this.ok = true;
		return true;
	};

	/* 加载立面开间单元（15 张，约 380x240） */
	City3D.prototype._loadBays = function (done) {
		const THREE = this.THREE;
		const self = this;
		const files = [
			'bay_b0_0', 'bay_b0_1', 'bay_b0_2',
			'bay_b1_0', 'bay_b1_1', 'bay_b1_2',
			'bay_b2_0', 'bay_b2_1', 'bay_b2_2',
			'bay_b3_0', 'bay_b3_1', 'bay_b3_2',
			'bay_b4_0', 'bay_b4_1', 'bay_b4_2'
		];
		this.bayTex = [];
		this._bayMats = {};
		const loader = new THREE.TextureLoader();
		let left = files.length;
		if (!left) { done(); return; }
		files.forEach(function (n) {
			loader.load('assets/city/bays/' + n + '.png', function (tex) {
				tex.colorSpace = THREE.SRGBColorSpace;
				tex.anisotropy = Math.min(8, self.renderer.capabilities.getMaxAnisotropy());
				self.bayTex.push(tex);
				if (--left === 0) done();
			}, undefined, function () {
				if (--left === 0) done();
			});
		});
	};

	/* 开间材质缓存：同一张图 + 同一个色只用一份材质 */
	City3D.prototype.bayMatFor = function (tex, col) {
		const base = (col && col.isColor) ? col : new this.THREE.Color(col);
		const key = tex.uuid + '_' + base.getHexString();
		if (this._bayMats[key]) return this._bayMats[key];
		const m = new THREE.MeshToonMaterial({
			map: tex, gradientMap: this.ramp,
			color: base.clone().multiplyScalar(1.06)
		});
		this._bayMats[key] = m;
		return m;
	};

	/* ---------------- 天空 ---------------- */
	City3D.prototype._buildSky = function () {
		const THREE = this.THREE;
		const geo = new THREE.SphereGeometry(1500, 32, 20);
		this.skyUniforms = {
			topColor: { value: new THREE.Color(0x6fa8d8) },
			botColor: { value: new THREE.Color(0xf0d9c0) },
			sunDir: { value: new THREE.Vector3(0, 1, -1).normalize() },
			sunColor: { value: new THREE.Color(0xffd9a0) },
			sunSize: { value: 0.9994 },
			nightMix: { value: 0 }
		};
		const mat = new THREE.ShaderMaterial({
			side: THREE.BackSide, depthWrite: true, fog: false,
			uniforms: this.skyUniforms,
			vertexShader: [
				'varying vec3 vDir;',
				'void main(){ vDir = normalize(position);',
				'  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
			].join('\n'),
			fragmentShader: [
				'uniform vec3 topColor, botColor, sunDir, sunColor;',
				'uniform float sunSize, nightMix;',
				'varying vec3 vDir;',
				'void main(){',
				'  float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);',
				'  vec3 col = mix(botColor, topColor, pow(h, 0.75));',
				/* 太阳光晕 */
				'  float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);',
				'  col += sunColor * pow(d, 220.0) * 1.6;',
				'  col += sunColor * pow(d, 14.0) * 0.22;',
				/* 地平线附近压暗一点，像漫画里的天际 */
				'  col = mix(col, col*0.82, smoothstep(0.52,0.46,h)*0.7);',
				'  gl_FragColor = vec4(col, 1.0);',
				'}'
			].join('\n')
		});
		this.sky = new THREE.Mesh(geo, mat);
		this.sky.frustumCulled = false;
		this.sky.renderOrder = -10;
		this.scene.add(this.sky);
	};

	/* ---------------- 灯光 ---------------- */
	City3D.prototype._buildLights = function () {
		const THREE = this.THREE;
		this.sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
		this.sun.position.set(-40, 60, -80);
		this.sun.castShadow = true;
		const s = this.sun.shadow;
		s.mapSize.width = 2048; s.mapSize.height = 2048;
		s.camera.left = -90; s.camera.right = 90;
		s.camera.top = 110; s.camera.bottom = -90;
		s.camera.near = 1; s.camera.far = 1400;
		if ('bias' in s) s.bias = -0.0012;
		if ('normalBias' in s) s.normalBias = 0.6;
		this.scene.add(this.sun);
		this.scene.add(this.sun.target);

		this.hemi = new THREE.HemisphereLight(0xbcd6ee, 0x5a5148, 0.75);
		this.scene.add(this.hemi);
		this.fill = new THREE.DirectionalLight(0x9fb6cc, 0.22);
		this.fill.position.set(60, 30, 40);
		this.scene.add(this.fill);
	};

	/* ---------------- 城市 ---------------- */
	City3D.prototype._buildCity = function () {
		const THREE = this.THREE;
		const rnd = mulberry32(20241004);

		/* 赛璐璐三段色阶 */
		const ramp = new THREE.DataTexture(
			new Uint8Array([58, 64, 84, 255, 108, 112, 128, 255,
				186, 188, 198, 255, 234, 234, 238, 255]),
			4, 1, THREE.RGBAFormat);
		if ('magFilter' in ramp) { ramp.magFilter = THREE.NearestFilter; ramp.minFilter = THREE.NearestFilter; }
		if ('needsUpdate' in ramp) ramp.needsUpdate = true;
		this.ramp = ramp;

		const geo = new THREE.BoxGeometry(1, 1, 1);
		const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp });

		const parts = [];
		const outlines = [];
		const winParts = [];

		const box = new THREE.BoxGeometry(1, 1, 1);
		const winGeo = new THREE.PlaneGeometry(1, 1);
		const planeGeo = new THREE.PlaneGeometry(1, 1);
		const facade = [];
		const ledgeMat = new THREE.MeshToonMaterial({ color: 0x9a9084, gradientMap: ramp });

		/* 只有 8 栋，和原作一样。原作那种"几栋宽楼挤在一起"的密度，
		 * 一旦铺成 20 列 × 10 行就变成俯瞰城市群，完全不像了。 */
		/* 只有 8 栋，和原作一样。原作那种"几栋宽楼挤在一起"的密度，
		 * 铺成 20 列 x 10 行就变成俯瞰城市群，完全不像了。
		 * HERO = 用上你给的亚洲旧楼素材那栋（挂屋顶模型 + 贴开间立面），
		 * 其余先用方块占位。 */
		/* 距离 ~300、fov 30° 时：水平线在画面正中，
		 * 基线要落在画面 54%（水平线下方 1.2°），中位屋顶在 28%（上方 6.6°），
		 * 最高屋顶几乎顶到上沿（上方 14.4°）。反算得到这些数字。
		 *   楼高 = 层数 * 4.6；街面 Y0 = -d*tan(1.2°) ≈ -6 */
		/* 窗洞实际占画面 0~88%（上沿到窗台）。按原作反算：
		 *   基线   在窗洞 77% -> 画面 68% -> 水平线下方 5.4°
		 *   中位屋顶 在窗洞 40% -> 画面 35% -> 水平线上方 4.5°
		 *   最高屋顶 几乎顶上沿 -> 画面 2%  -> 上方 14.4°
		 * d≈300 时：街面比眼睛低 28，楼高 45~105。
		/* 原作不是一排正对镜头的方块，而是不规则街谷：
		 *   · 左右各有一栋「很近 + 明显转角」的楼压住画面边缘（能看到两个立面）
		 *   · 中间是几栋高瘦塔楼，正对或轻微转角
		 *   · 远处一两栋小的
		 *   · 窗洞下半被「贴窗的近景楼顶」填满
		 *   · 没有窗台，楼基一直往下延伸、被室内家具遮住
		 * 最后一列是朝向角（度）：0 = 正对镜头。
		 */
		/* 楼群布局来自原作天际线测量（房屋3.png 的 alpha）：
		 *   占窗宽 / 屋顶在画面高度的百分比
		 *   5.5%/35%  13%/22-47%  13%/21%(最高塔)  6%/52%
		 *   2%/68%(近景矮楼，正好低于主角头顶)  45%/18-23%(右侧大楼群)
		 * x/z/宽/深/层数/偏转 都可在调参面板里实时改。
		 */
		const SPEC = this.spec || LB.CITY_SPEC;
		const FLOOR_H = 4.6;
		const BAY_W = 7.4;
		const Y0 = -34;              // 原作没有窗台：楼基一直往下延伸、被室内家具遮住
		this.heroRoofY = Y0;
		/* 主角楼在循环里就会被 _placeKit 塞进来，所以 group 必须先建 */
		this.cityGroup = new THREE.Group();

		/* 按 SPEC 下标记录每栋楼的变换，供面板高亮/选中用 */
		this.buildingInfo = [];
		for (let bi = 0; bi < SPEC.length; bi++) {
			const b = SPEC[bi];
			this.buildingInfo[bi] = {
				x: b.x, z: b.z, w: b.w, d: b.d,
				h: b.floors * FLOOR_H, yaw: b.yaw || 0, y0: Y0,
				hero: !!b.hero, visible: b.visible !== false
			};
			if (b.visible === false) continue;      // 面板里关掉可见性的不生成
			const sp = [b.x, b.z, b.w, b.d, b.floors, b.hero, b.yaw];
			const hero = !!b.hero;
			const h = b.floors * FLOOR_H;
			const col = b.color !== undefined ? b.color :
				PALETTE[(rnd() * PALETTE.length) | 0];

			if (hero) {
				/* 主角楼直接用素材本体（住宅体块 + 屋顶杂物），不再套方块 */
				this._placeKit(sp[0], Y0, sp[1], sp[2], sp[4], sp[6] || 0, sp[3]);
				continue;
			}

			const yaw = (sp[6] || 0) * Math.PI / 180;
			/* z > -60 的算近景，压暗成剪影 */
			const near = sp[1] > -60;
			const body = new THREE.Mesh(box, (function () {
				const mm = mat.clone();
				mm.color = new THREE.Color(col).multiplyScalar(near ? 0.34 : (hero ? 0.9 : 0.72));
				return mm;
			})());
			body.position.set(sp[0], Y0 + h / 2, sp[1]);
			body.scale.set(sp[2], h, sp[3]);
			body.rotation.y = yaw;
			body.castShadow = true;
			body.receiveShadow = true;
			body.updateMatrix();
			parts.push(body);

			const o = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
				color: 0x191b21, side: THREE.BackSide
			}));
			o.position.copy(body.position);
			o.scale.set(sp[2] * 1.014, h * 1.007, sp[3] * 1.014);
			o.rotation.y = yaw;
			o.updateMatrix();
			outlines.push(o);

			/* 占位楼保持纯方块；哪天想再升级成贴图楼，在这里套开间立面 */
			if (false && hero && this.bayTex.length) {
				const front = sp[1] + sp[3] / 2 + 0.35;
				const bays = Math.max(2, Math.round(sp[2] / BAY_W));
				for (let f = 0; f < sp[4]; f++) {
					const tex = this.bayTex[(rnd() * this.bayTex.length) | 0];
					const q = new THREE.Mesh(planeGeo, this.bayMatFor(tex, col));
					q.position.set(sp[0], Y0 + (f + 0.5) * FLOOR_H, front);
					q.scale.set(bays * BAY_W, FLOOR_H * 1.02, 1);
					q.receiveShadow = true;
					q.updateMatrix();
					facade.push(q);

					if (f % 2 === 1) {
						const ledge = new THREE.Mesh(box, ledgeMat);
						ledge.position.set(sp[0], Y0 + f * FLOOR_H + 0.3, front + 0.45);
						ledge.scale.set(sp[2] * 0.99, 0.62, 1.4);
						ledge.castShadow = true;
						ledge.receiveShadow = true;
						ledge.updateMatrix();
						facade.push(ledge);
					}
				}
				/* 屋顶模型挂在这栋顶上 */
				this._placeKit(sp[0], Y0 + h, sp[1], sp[2], 2, 0, sp[3]);
			}
		}

		/* 合并几何：几个 draw call 撑起整座城市 */
		this.cityGroup.add(this._merge(parts));
		this.cityGroup.add(this._merge(outlines));
		this.cityGroup.add(this._merge(facade));
		this.winMesh = this._merge(winParts);
		if (this.winMesh) {
			this.winMesh.material.transparent = true;
			this.winMesh.material.opacity = 0;
			this.winMesh.renderOrder = 1;
		}
		this.scene.add(this.cityGroup);

		/* 原作里看不到地面：楼基直接被窗台切断。
		 * 所以不建地面网格，窗台以下留空即可（那里本来就看不见）。 */
		/* 空气透视用原生指数雾。之前那张雾化板画在天空球前面
		 * （天空 depthWrite:false 不写深度），整片糊成白纸。 */
		if (THREE.FogExp2) {
			this.fog = new THREE.FogExp2(0xc9d8e6, 0.0006);
			this.scene.fog = this.fog;
		}
	};

	/* ---------------- 选中高亮 ----------------
	 * 面板里鼠标移到某一行，就在 3D 里把那栋楼框出来，
	 * 否则改数值时根本不知道改的是哪一栋。 */
	City3D.prototype.setHighlight = function (i) {
		const THREE = this.THREE;
		if (!this.ok) return false;
		if (!this.hiMesh) {
			const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
			this.hiMesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
				color: 0x7fe6ff, transparent: true, opacity: 0.95, depthTest: false
			}));
			this.hiMesh.renderOrder = 999;
			this.hiMesh.visible = false;
			this.scene.add(this.hiMesh);
		}
		const b = this.buildingInfo && this.buildingInfo[i];
		if (!b || b.visible === false) { this.hiMesh.visible = false; return false; }
		const m = this.hiMesh;
		m.visible = true;
		m.position.set(b.x, b.y0 + b.h / 2, b.z);
		m.rotation.y = b.yaw * Math.PI / 180;
		/* 稍微放大一点，避免和楼体重面导致闪烁 */
		m.scale.set(b.w * 1.04 + 0.6, b.h * 1.02 + 0.6, b.d * 1.04 + 0.6);
		return true;
	};

	/* ---------------- 你给的亚洲旧楼屋顶模型 ----------------
	 * build_001.bin 由 tools/fbx_to_bin.py 用 Blender 从 FBX 导出：
	 *   "LBM1" u32 partCount
	 *   每个 part: u32 nameLen+name, u32 matLen+mat,
	 *              u32 vcount, f32 pos, f32 nrm, f32 uv, u32 icount, u32 idx
	 * 模型本身尺度很小（1.7 x 1.6 x 1.75），所以按楼宽等比放大后放在屋顶。 */
	City3D.prototype.loadKit = function (binPath, done) {
		const THREE = this.THREE;
		const self = this;
		const loader = new THREE.FileLoader();
		loader.setResponseType('arraybuffer');
		loader.load(binPath, function (buf) {
			try {
				self.kitGroup = self._parseKit(buf);
				done && done();
			} catch (e) {
				self.kitError = '解析失败: ' + (e && e.message ? e.message : e);
				console.warn('[city3d]', self.kitError, e);
				done && done();
			}
		}, undefined, function (e) {
			self.kitError = '下载失败 (HTTP ' + (e && e.status ? e.status : '?') + ')';
			console.warn('[city3d]', self.kitError);
			done && done();
		});
	};

	City3D.prototype._parseKit = function (buf) {
		const THREE = this.THREE;
		const dv = new DataView(buf);
		let p = 0;
		if (String.fromCharCode.apply(null, new Uint8Array(buf, 0, 4)) !== 'LBM1') {
			throw new Error('魔数不对');
		}
		p = 4;
		const count = dv.getUint32(p, true); p += 4;
		const parts = [];
		for (let i = 0; i < count; i++) {
			const nl = dv.getUint32(p, true); p += 4;
			const name = new TextDecoder().decode(new Uint8Array(buf, p, nl)); p += nl;
			const ml = dv.getUint32(p, true); p += 4;
			const mat = new TextDecoder().decode(new Uint8Array(buf, p, ml)); p += ml;
			const vc = dv.getUint32(p, true); p += 4;
			/* 名字长度会把偏移推到非 4 字节对齐的位置，
			 * typed array 要求起始偏移是 4 的倍数，所以各自 slice 出来。 */
			function f32(n) {
				const a = new Float32Array(buf.slice(p, p + n * 4));
				p += n * 4;
				return a;
			}
			const pos = f32(vc * 3);
			const nrm = f32(vc * 3);
			const uv = f32(vc * 2);
			const ic = dv.getUint32(p, true); p += 4;
			const idx = new Uint32Array(buf.slice(p, p + ic * 4));
			p += ic * 4;
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
			g.setIndex(new THREE.BufferAttribute(idx, 1));
			parts.push([name, mat, g]);
		}
		/* 按材质并成几个 Mesh，并挂上各自的贴图 */
		const TEX = {
			rooftop_01: 'assets/city/rooftop.jpg',
			concrete_02: 'assets/city/concrete.jpg',
			concrete_01: 'assets/city/concrete01.jpg',
			concrete_fine: 'assets/city/apartment.jpg',
			build_01: 'assets/city/facade.jpg'
		};
		const byMat = {};
		parts.forEach(function (t) {
			const base = t[1].replace(/[.][0-9]+$/, '');
			(byMat[base] = byMat[base] || []).push(t[2]);
		});
		const grp = new THREE.Group();
		const self = this;
		const tl = new THREE.TextureLoader();
		const keys = Object.keys(byMat);
		let left = keys.length;
		keys.forEach(function (mname) {
			const merged = self._merge(byMat[mname].map(function (g2) {
				return { geometry: g2, matrix: new THREE.Matrix4() };
			}));
			const m = new THREE.MeshToonMaterial({ gradientMap: self.ramp });
			const path = TEX[mname];
			const finish = function (tex) {
				if (tex) {
					tex.colorSpace = THREE.SRGBColorSpace;
					tex.anisotropy = Math.min(8, self.renderer.capabilities.getMaxAnisotropy());
					m.map = tex;
					m.color = new THREE.Color(0xffffff);
					m.needsUpdate = true;
				} else {
					/* 贴图没加载出来时的兜底色，别让整块变成纯白 */
					m.color = new THREE.Color(mname.indexOf('rooftop') >= 0 ? 0x9aa0a6 : 0x9a9086);
				}
				if (--left === 0 && self.onKitReady) self.onKitReady();
			};
			if (path) tl.load(path, finish, undefined, function () { finish(null); });
			else finish(null);
			merged.material = m;
			merged.castShadow = true;
			merged.receiveShadow = true;
			grp.add(merged);
		});
		grp.userData.partCount = parts.length;
		return grp;
	};

	/* 把素材摆成一整栋楼：底面落在街面 Y0，高度对齐 floors*FLOOR_H */
	City3D.prototype._placeKit = function (x, groundY, z, w, floors, yawDeg, d) {
		if (!this.kitGroup) return false;
		const THREE = this.THREE;
		const k = this.kitGroup.clone();
		const bb = new THREE.Box3().setFromObject(k);
		const sz = bb.getSize(new THREE.Vector3());
		/* 先按目标高度缩放，再限制水平不要超出给定楼宽/楼深。
		   注意：build_001.bin 导出时已把 Blender 的 Z-up 绕 X 转成 three.js 的 Y-up，
		   所以这里 sz.y 就是真实的楼高，sz.x/sz.z 是平面尺寸。*/
		const targetH = floors * 4.6;
		let kk = targetH / Math.max(0.001, sz.y);
		kk = Math.min(kk, (w * 1.25) / Math.max(0.001, sz.x));
		if (d > 0) kk = Math.min(kk, (d * 1.9) / Math.max(0.001, sz.z));
		k.scale.set(kk, kk, kk);
		const b2 = new THREE.Box3().setFromObject(k);
		k.position.set(
			x - (b2.min.x + b2.max.x) / 2,
			groundY - b2.min.y,
			z - (b2.min.z + b2.max.z) / 2);
		if (yawDeg) k.rotation.y = yawDeg * Math.PI / 180;
		k.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
		this.cityGroup.add(k);
		this.kitPlaced = true;
		void THREE;
		return true;
	};

	/* 合并一组 Mesh 的几何（three.js 没有内置 merge，需手工塞 buffer） */
	City3D.prototype._merge = function (meshes) {
		if (!meshes || !meshes.length) return null;
		const THREE = this.THREE;
		/* 允许传裸 {geometry, matrix}（屋顶模型分组用）*/
		let vCount = 0, iCount = 0;
		meshes.forEach(function (m) {
			vCount += m.geometry.attributes.position.count;
			iCount += m.geometry.index ? m.geometry.index.count : 0;
		});
		const pos = new Float32Array(vCount * 3);
		const nrm = new Float32Array(vCount * 3);
		const uv = new Float32Array(vCount * 2);
		const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
		let vo = 0, io = 0;
		meshes.forEach(function (m) {
			const g = m.geometry, p = g.attributes.position, n = g.attributes.normal;
			const u = g.attributes.uv, ix = g.index;
			const mat = m.matrix || new THREE.Matrix4();
			const v = new THREE.Vector3();
			for (let i = 0; i < p.count; i++) {
				v.fromBufferAttribute(p, i).applyMatrix4(mat);
				pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
				if (n) {
					v.fromBufferAttribute(n, i).applyMatrix3(new THREE.Matrix3().getNormalMatrix(mat)).normalize();
					nrm[(vo + i) * 3] = v.x; nrm[(vo + i) * 3 + 1] = v.y; nrm[(vo + i) * 3 + 2] = v.z;
				}
				if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
			}
			for (let i = 0; i < ix.count; i++) idx[io + i] = ix.getX(i) + vo;
			vo += p.count; io += ix.count;
		});
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
		geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
		geo.setIndex(new THREE.BufferAttribute(idx, 1));
		geo.computeBoundingSphere();
		return new THREE.Mesh(geo, meshes[0].material ||
			new THREE.MeshToonMaterial({ color: 0x9a9a9a, gradientMap: this.ramp }));
	};

	/* ---------------- 云 ---------------- */
	City3D.prototype._buildClouds = function () {
		const THREE = this.THREE;
		/* 程序化生成一张云贴图：几个柔和的团块 */
		const S = 256;
		const c = document.createElement('canvas');
		c.width = S; c.height = S;
		const g = c.getContext('2d');
		g.clearRect(0, 0, S, S);
		const rnd = mulberry32(7);
		g.fillStyle = '#ffffff';
		for (let i = 0; i < 26; i++) {
			const x = S * (0.12 + rnd() * 0.76);
			const y = S * (0.34 + rnd() * 0.34);
			const r = S * (0.05 + rnd() * 0.12);
			const grad = g.createRadialGradient(x, y, 0, x, y, r);
			grad.addColorStop(0, 'rgba(255,255,255,0.55)');
			grad.addColorStop(1, 'rgba(255,255,255,0)');
			g.fillStyle = grad;
			g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
		}
		let tex;
		try {
			tex = new THREE.CanvasTexture(c);
		} catch (e) { tex = null; }
		if (tex && 'wrapS' in tex) {
			tex.wrapS = THREE.RepeatWrapping;
			tex.repeat.set(3, 1);
		}

		/* 高 / 中 / 低 三层，各自受一个云量字段控制 */
		this.cloudLayers = [];
		const defs = [
			{ key: 'high', y: 150, z: -520, w: 1100, h: 200, spd: 0.55, rep: 3 },
			{ key: 'mid', y: 108, z: -400, w: 800, h: 160, spd: 1.0, rep: 2.2 },
			{ key: 'low', y: 76, z: -300, w: 560, h: 120, spd: 1.9, rep: 1.7 }
		];
		const rnd2 = mulberry32(31);
		defs.forEach((d) => {
			if (!tex) return;
			const t2 = tex.clone();
			t2.needsUpdate = true;
			t2.wrapS = THREE.RepeatWrapping;
			t2.repeat.set(d.rep, 1);
			const m = new THREE.MeshBasicMaterial({
				map: t2, transparent: true, opacity: 0.5,
				depthWrite: false, color: 0xffffff, fog: false
			});
			for (let i = 0; i < 2; i++) {
				const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), m);
				mesh.position.set((rnd2() - 0.5) * 260, d.y, d.z + i * 44);
				mesh.renderOrder = -1;
				this.scene.add(mesh);
				this.cloudLayers.push({ mesh: mesh, mat: m, spd: d.spd * d.spd, key: d.key });
			}
		});
	};

	/* ---------------- 天气粒子 ---------------- */
	City3D.prototype._buildWeather = function () {
		const THREE = this.THREE;
		const N = 1400;
		/* 雨用线段，能画出雨丝；雪用点 */
		const rp = new Float32Array(N * 6);
		const rd = new Float32Array(N * 6);
		for (let i = 0; i < N; i++) {
			const x = (Math.random() - 0.5) * 260;
			const y = Math.random() * 120;
			const z = -60 - Math.random() * 200;
			rp[i * 6] = x; rp[i * 6 + 1] = y; rp[i * 6 + 2] = z;
			rd[i * 6] = x; rd[i * 6 + 1] = y + 2.5; rd[i * 6 + 2] = z;
		}
		const rg = new THREE.BufferGeometry();
		rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
		this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({
			color: 0xcfe2ff, transparent: true, opacity: 0, depthWrite: false
		}));
		this.rain.frustumCulled = false;
		this.scene.add(this.rain);

		const sp = new Float32Array(N * 3);
		for (let i = 0; i < N; i++) {
			sp[i * 3] = (Math.random() - 0.5) * 220;
			sp[i * 3 + 1] = Math.random() * 120;
			sp[i * 3 + 2] = -20 - Math.random() * 160;
		}
		const sg = new THREE.BufferGeometry();
		sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
		this.snow = new THREE.Points(sg, new THREE.PointsMaterial({
			color: 0xf2f7ff, size: 0.9, sizeAttenuation: true,
			transparent: true, opacity: 0, depthWrite: false
		}));
		this.snow.frustumCulled = false;
		this.scene.add(this.snow);
	};

	/* ---------------- 每帧更新 ---------------- */
	City3D.prototype.setEnv = function (env) {
		if (!this.ok) return;
		const THREE = this.THREE;

		const rel = env.sunRel * Math.PI / 180;
		const elev = env.sun.elev * Math.PI / 180;

		/* ---- 3D 世界坐标约定（与 2D 的虚拟画布不是同一套，千万别混）----
		 *   +y = 上；相机在 z=+60 看向 -z；three.js 里相机右手 = +x
		 *   所以「面向窗户」时 -z 是窗户朝外方向（windowDir=180 → -z = 南），
		 *   而 +x = 西（面朝南时西在右手边，东在左手边）。
		 *
		 *   罗盘方位角 A → 朝阳光的单位向量 = (-sin A, ·, cos A)
		 *   验证：A=180(南) → (0,0,-1) ✓；A=90(东) → (-1,0,0) = -x = 屏幕左 ✓
		 *
		 * env.sunRel = azim − winAzim，于是展开后就是 (sin rel, 0, −cos rel)。
		 * （若把 +x 当成东、写成 (-sin rel, -cos rel)，下午的太阳会跑到窗户左边。）
		 */
		const horiz = new THREE.Vector3(Math.sin(rel), 0, -Math.cos(rel));
		const dir = horiz.clone().multiplyScalar(Math.cos(elev))
			.add(new THREE.Vector3(0, Math.sin(elev), 0)).normalize();

		/* 光源 */
		this.sun.position.copy(dir).multiplyScalar(260);
		this.sun.target.position.set(0, 6, -110);
		const dayF = env.daylight;
		const warm = Math.max(0, 1 - Math.abs(env.sun.elev - 6) / 20);
		const oc = env.overcast;
		this.sun.intensity = dayF * (1 - oc * 0.72) * 1.35;
		this.sun.color.setRGB(
			1.0,
			0.94 - warm * 0.14 - oc * 0.05,
			0.84 - warm * 0.34 - oc * 0.08);
		this.sun.castShadow = this.sun.intensity > 0.05;

		/* 环境光跟着天色走 */
		const sc = env.skyColor;
		this.hemi.color.setRGB(sc[0] * 0.9 + 0.06, sc[1] * 0.92 + 0.07, sc[2] * 1.0 + 0.1);
		this.hemi.intensity = 0.10 + dayF * 0.13 * (1 - oc * 0.3) + oc * 0.14;
		this.hemi.groundColor.setRGB(0.14, 0.13, 0.12);

		/* 天空 */
		/* 地平线沿用 LUT（黄昏暖、正午淡），天顶单独给饱和蓝，
		 * 否则正午整片天会白成一张纸。 */
		const zen = [0.13, 0.33, 0.68];
		const k = dayF * (1 - oc * 0.55) * 0.72;
		const topC = [
			sc[0] + (zen[0] - sc[0]) * k,
			sc[1] + (zen[1] - sc[1]) * k,
			sc[2] + (zen[2] - sc[2]) * k
		];
		const botC = [
			sc[0] * 1.05 + warm * 0.26, sc[1] * 0.96 + warm * 0.10, sc[2] * 0.86
		];
		this.skyUniforms.topColor.value.setRGB(
			Math.min(1, topC[0]), Math.min(1, topC[1]), Math.min(1, topC[2]));
		this.skyUniforms.botColor.value.setRGB(
			Math.min(1, botC[0]), Math.min(1, botC[1]), Math.min(1, botC[2]));
		this.skyUniforms.sunDir.value.copy(dir);
		this.skyUniforms.sunColor.value.setRGB(1.0, 0.86 - warm * 0.1, 0.66 - warm * 0.2);
		this.skyUniforms.sunSize.value = env.sun.elev > -1 ? 0.9993 : 0.9999;
		this.skyUniforms.nightMix.value = 1 - dayF;

		/* 窗户玻璃反光：太阳正对时才亮 */
		const facing = Math.max(0, Math.cos(rel));
		this.fill.intensity = 0.03 + facing * dayF * 0.10;

		/* 夜里窗户亮灯 */
		if (this.winMesh) {
			this.winMesh.material.opacity = Math.pow(1 - dayF, 1.4) * 0.95;
			this.winMesh.visible = this.winMesh.material.opacity > 0.02;
		}

		/* 雾：跟着地平线色走，阴天更浓 */
		if (this.fog) {
			this.fog.color.setRGB(
				Math.min(1, botC[0] * 0.92), Math.min(1, botC[1] * 0.9), Math.min(1, botC[2] * 0.98));
			this.fog.density = 0.00042 + oc * 0.0013 + (1 - dayF) * 0.0006;
		}

		/* 云：三层各自的云量 + 风向漂移 */
		const cov = { high: env.cloud.high, mid: env.cloud.mid, low: env.cloud.low };
		const windSign = env.windX >= 0 ? 1 : -1;
		const windSpd = 3 + env.wind * 1.1;
		this.cloudLayers.forEach(function (L) {
			const target = clamp01(cov[L.key] !== undefined ? cov[L.key] : cov.mid);
			L.mat.opacity = 0.05 + 0.62 * target;
			L.mesh.position.x += windSign * windSpd * L.spd * this._dt;
			if (L.mesh.position.x > 340) L.mesh.position.x -= 680;
			if (L.mesh.position.x < -340) L.mesh.position.x += 680;
			L.mat.color.setRGB(
				0.55 + sc[0] * 0.75, 0.6 + sc[1] * 0.7, 0.68 + sc[2] * 0.65);
		}, this);

		/* 雨：交给 2D 层画（窗洞裁剪 + 可控线宽），3D 这份只留代码备用 */
		this.rain.material.opacity = 0;
		this.snow.material.opacity = env.snowy
			? clamp01(env.precip * LB.props.rainSize) * 0.9 : 0;
		this._wx = env.windX * 0.22;
		this._rainFall = 22 + env.precip * 20;
		this._snowFall = 3.2;

		/* 阴影贴图：太阳动了才重画 */
		const key = Math.round(env.sun.elev * 2) + '_' + Math.round(env.sunRel * 2);
		if (key !== this.sunKey) {
			this.sunKey = key;
			if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
		}
	};

	City3D.prototype.resize = function (w, h) {
		if (!this.ok) return;
		const W = Math.max(320, Math.round(w * this.scale));
		const H = Math.max(180, Math.round(h * this.scale));
		this.renderer.setSize(W, H, false);
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		if (this.camera) {
			this.camera.aspect = w / h;
			/* 竖屏时把视场角放大，避免只看到中间一小块 */
			this.camera.fov = this.camera.aspect < 1.6 ? 40 : 30;
			this.camera.updateProjectionMatrix();
		}
	};

	City3D.prototype.render = function (dt, env) {
		if (!this.ok || !this.enabled) return;
		this._dt = Math.min(0.05, dt);
		this.t += this._dt;

		/* 粒子积分 */
		if (this.rain.material.opacity > 0.01) {
			const p = this.rain.geometry.attributes.position;
			const a = p.array;
			const vx = this._wx, vy = -this._rainFall;
			for (let i = 0; i < a.length; i += 6) {
				a[i] += vx * this._dt; a[i + 1] += vy * this._dt;
				a[i + 3] = a[i] + vx * 0.06; a[i + 4] = a[i + 1] - vy * 0.06;
				if (a[i + 1] < -4) {
					a[i + 1] = 90 + Math.random() * 30;
					a[i] = (Math.random() - 0.5) * 260;
					a[i + 2] = -60 - Math.random() * 200;
					a[i + 3] = a[i]; a[i + 4] = a[i + 1] + 2.5;
				}
			}
			p.needsUpdate = true;
		}
		if (this.snow.material.opacity > 0.01) {
			const p = this.snow.geometry.attributes.position;
			const a = p.array;
			for (let i = 0; i < a.length; i += 3) {
				a[i] += (this._wx + Math.sin(this.t * 1.3 + i) * 1.6) * this._dt;
				a[i + 1] -= this._snowFall * this._dt;
				if (a[i + 1] < -4) {
					a[i + 1] = 170;
					a[i] = (Math.random() - 0.5) * 260;
					a[i + 2] = -60 - Math.random() * 200;
				}
			}
			p.needsUpdate = true;
		}

		this.renderer.render(this.scene, this.camera);
	};

	City3D.prototype.setVisible = function (v) {
		this.enabled = !!v;
		if (this.canvas) this.canvas.style.display = v ? 'block' : 'none';
		if (v && this.renderer && this.renderer.shadowMap) {
			this.renderer.shadowMap.needsUpdate = true;
		}
	};

	City3D.prototype.dispose = function () {
		if (this.renderer) this.renderer.dispose();
		this.ok = false;
	};

	/* ---------------- 楼群布局（可在调参面板里改，改完立即重建） ----------------
	 * x     左右位置（0 = 正对镜头，正=右）
	 * z     离窗多远（负数 = 窗外，越小越近）
	 * w/d   宽 / 深 —— 楼不是正方形，这两个要分开给
	 * floors 层数
	 * yaw   朝向角（度）：0 = 正对镜头，非 0 就能看到两个立面
	 * hero  true = 用那套亚洲旧楼素材
	 * near  true = 近景剪影（额外压暗）
	 * ---- 下面这组按原作天际线反算：fov 34、相机 y=0、窗距约 60 ----
	 */
	LB.CITY_SPEC = [
// 这是你调好的布局（原样保留）。
// 表单里点「载入默认布局」会回到这一份；编辑后会自动存进浏览器，
// 关掉页面再打开会接着上次那份，不会再丢。
		{ x: -46, z: -20, w: 32, d: 17, floors: 6, yaw: -23, hero: false, near: true, visible: true },
		{ x: -30, z: -129, w: 39, d: 15, floors: 5, yaw: 26, hero: false, near: false, visible: true },
		{ x: -21, z: -190, w: 27, d: 22, floors: 17, yaw: 15, hero: false, near: false, visible: true },
		{ x: 64, z: -178, w: 51, d: 42, floors: 15, yaw: 4, hero: false, near: false, visible: true },
		{ x: 50, z: -134, w: 14, d: 13, floors: 11, yaw: 8, hero: false, near: false, visible: false },
		{ x: 15, z: -148, w: 43, d: 10, floors: 4, yaw: -21, hero: false, near: true, visible: true },
		{ x: -10, z: -23, w: 24, d: 16, floors: 5, yaw: -63, hero: true, near: false, visible: true },
		{ x: 52, z: -24, w: 31, d: 34, floors: 6, yaw: 9, hero: false, near: false, visible: true },
		{ x: 47, z: -75, w: 18, d: 30, floors: 9, yaw: 4, hero: false, near: false, visible: true },
		{ x: -54, z: -145, w: 18, d: 16, floors: 12, yaw: 30, hero: false, near: true, visible: true },
		{ x: 11, z: -80, w: 20, d: 50, floors: 3, yaw: -77, hero: false, near: false, visible: true },
		{ x: 13, z: -250, w: 20, d: 20, floors: 8, yaw: 31, hero: false, near: false, visible: true },
		{ x: -86, z: -140, w: 47, d: 20, floors: 8, yaw: 63, hero: false, near: false, visible: true },
	];

	/* 归一化：手贴/导入的 JSON 可能缺字段，补齐后再用，
	 * 否则 undefined 会一路算进变换里（NaN 楼）。 */
	function normalizeSpec(arr) {
		return (arr || []).map(function (b) {
			return {
				x: num(b.x, 0), z: num(b.z, -140),
				w: num(b.w, 24), d: num(b.d, 20),
				floors: num(b.floors, 8), yaw: num(b.yaw, 0),
				hero: !!b.hero, near: !!b.near,
				visible: b.visible === false ? false : true
			};
		}).filter(function (b) { return b.w > 0 && b.d > 0 && b.floors > 0; });
		function num(v, d) {
			const n = parseFloat(v);
			return isFinite(n) ? n : d;
		}
	}
	City3D.prototype.normalizeSpec = normalizeSpec;

	/* 自动存档：每次应用都写一份，刷新/重开页面自动接着用 */
	const SAVE_KEY = 'lb.cityspec.v1';
	City3D.prototype.saveSpec = function () {
		try {
			localStorage.setItem(SAVE_KEY, JSON.stringify(this.spec));
			return true;
		} catch (e) { return false; }
	};
	City3D.prototype.loadSaved = function () {
		try {
			const raw = localStorage.getItem(SAVE_KEY);
			if (!raw) return null;
			const arr = normalizeSpec(JSON.parse(raw));
			return arr && arr.length ? arr : null;
		} catch (e) { return null; }
	};
	City3D.prototype.clearSaved = function () {
		try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 忽略 */ }
	};

	/* 改一栋楼 -> 立即重建（贴图已缓存，只有几何要重算，几十毫秒） */
	City3D.prototype.setBuilding = function (i, field, value) {
		if (!this.spec || !this.spec[i]) return false;
		this.spec[i][field] = value;
		this.rebuild();
		this.saveSpec();
		return true;
	};
	City3D.prototype.addBuilding = function () {
		this.spec.push({ x: 0, z: -140, w: 24, d: 20, floors: 8, yaw: 0, hero: false, near: false, visible: true });
		this.rebuild();
		return this.spec.length - 1;
	};
	City3D.prototype.removeBuilding = function (i) {
		if (this.spec.length <= 1 || !this.spec[i]) return false;
		this.spec.splice(i, 1);
		this.rebuild();
		this.saveSpec();
		return true;
	};
	City3D.prototype.exportSpec = function () {
		return JSON.stringify(this.spec, null, 1);
	};
	City3D.prototype.importSpec = function (txt) {
		const raw = JSON.parse(txt);
		if (!Array.isArray(raw) || !raw.length) throw new Error('不是有效的楼群数组');
		const arr = normalizeSpec(raw);
		this.pushUndo();
		this.spec = arr;
		this.rebuild();
		this.saveSpec();
		return arr.length;
	};

	/* 一步撤销：任何会覆盖布局的操作之前先存一份 */
	City3D.prototype.pushUndo = function () {
		this.undoSpec = JSON.parse(JSON.stringify(this.spec || []));
	};
	City3D.prototype.canUndo = function () { return !!(this.undoSpec && this.undoSpec.length); };
	City3D.prototype.undo = function () {
		if (!this.canUndo()) return false;
		this.spec = JSON.parse(JSON.stringify(this.undoSpec));
		this.undoSpec = null;
		this.rebuild();
		this.saveSpec();
		return true;
	};

	/* 重建：丢掉旧的 cityGroup 重新拼 */
	/* 回到出厂默认（会覆盖当前布局，但可撤销） */
	City3D.prototype.resetSpec = function () {
		this.pushUndo();
		this.spec = JSON.parse(JSON.stringify(LB.CITY_SPEC));
		this.rebuild();
		this.saveSpec();
		return this.spec.length;
	};

	City3D.prototype.rebuild = function () {
		if (!this.ok || !this.bayTex) return false;
		if (this.cityGroup) {
			this.scene.remove(this.cityGroup);
			this.cityGroup.traverse(function (o) {
				if (o.isMesh && o.geometry) o.geometry.dispose();
			});
		}
		this.kitPlaced = false;
		this._buildCity();
		if (this.hiIndex !== undefined && this.hiIndex >= 0) {
			this.setHighlight(this.hiIndex);
		}
		return true;
	};

	LB.City3D = City3D;
})(window.LB);

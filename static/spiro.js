(function () {
	'use strict';

	const trail = document.getElementById('trail');
	const overlay = document.getElementById('overlay');
	const stage = document.getElementById('stage');
	const trailCtx = trail.getContext('2d');
	const overlayCtx = overlay.getContext('2d');

	const DEFAULT_ARMS = {
		2: [{ L: 180, N: 1, e: 0 }, { L: 100, N: 7, e: 0 }],
		3: [{ L: 160, N: 1, e: 0 }, { L: 90, N: 5, e: 0 }, { L: 50, N: -3, e: 0 }],
		4: [{ L: 140, N: 1, e: 0 }, { L: 80, N: 5, e: 0 }, { L: 50, N: -3, e: 0 }, { L: 30, N: 11, e: 0 }],
		5: [{ L: 130, N: 1, e: 0 }, { L: 70, N: 4, e: 0 }, { L: 50, N: -3, e: 0 }, { L: 30, N: 7, e: 0 }, { L: 20, N: -11, e: 0 }],
	};

	const state = {
		arms: [],
		armCount: 2,
		inputMode: 'ratios',           // 'ratios' (current multiplicative) | 'teeth' (classic Spirograph)
		teeth: {
			outer: 96,
			inner: 30,
			type: 'hypo',              // 'hypo' (rolling inside) | 'epi' (rolling outside)
			offset: 0.7,               // pen offset as fraction of inner gear radius
		},
		vizMode: 'arms',
		colorMode: 'rainbow',
		strokeColor: '#ffffff',
		bgColor: '#000000',
		duration: 8,
		mute: true,
		volume: 0.30,
		view: { scale: 1, offsetX: 0, offsetY: 0 },
		running: false,
		paused: false,
		elapsed: 0,
		lastTimestamp: 0,
		t: 0,
		prevT: 0,
		points: [],
	};

	function setArmCount(n) {
		state.armCount = n;
		state.arms = DEFAULT_ARMS[n].map(a => ({ ...a }));
		renderArmRows();
	}

	function dpr() { return window.devicePixelRatio || 1; }

	function resizeCanvases() {
		const r = stage.getBoundingClientRect();
		const d = dpr();
		for (const c of [trail, overlay]) {
			c.width = Math.max(1, Math.round(r.width * d));
			c.height = Math.max(1, Math.round(r.height * d));
		}
		trailCtx.setTransform(d, 0, 0, d, 0, 0);
		overlayCtx.setTransform(d, 0, 0, d, 0, 0);
		renderTrail();
		renderOverlay(state.t);
	}

	function center() {
		const r = stage.getBoundingClientRect();
		return { x: r.width / 2, y: r.height / 2 };
	}

	function transformXY(x, y) {
		const c = center();
		return {
			x: c.x + state.view.offsetX + x * state.view.scale,
			y: c.y + state.view.offsetY + y * state.view.scale,
		};
	}

	function untransform(px, py) {
		const c = center();
		return {
			x: (px - c.x - state.view.offsetX) / state.view.scale,
			y: (py - c.y - state.view.offsetY) / state.view.scale,
		};
	}

	function computeFrame(t) {
		if (state.inputMode === 'teeth') {
			const { L1, L2, labRate1, labRate2 } = teethDerive();
			const a1 = 2 * Math.PI * labRate1 * t;
			const a2 = 2 * Math.PI * labRate2 * t;
			const p1 = { x: L1 * Math.cos(a1), y: L1 * Math.sin(a1) };
			const pen = { x: p1.x + L2 * Math.cos(a2), y: p1.y + L2 * Math.sin(a2) };
			return { pivots: [{ x: 0, y: 0 }, p1, pen], pen, angles: [a1, a2] };
		}
		// Multiplicative: each arm's lab-frame rate equals the product N1*N2*...*Ni,
		// so user-entered Ni reads as "rotations of arm i per rotation of arm i-1"
		// (and N1 is rotations per pattern). When an arm is eccentric (e > 0),
		// its ellipse is axis-aligned with the parent arm's rotating frame, so
		// the ellipse tilts with the parent. Arm 1 has no parent, so e is forced
		// to 0 there.
		const arms = state.arms.slice(0, state.armCount);
		const pivots = [{ x: 0, y: 0 }];
		const angles = [];
		let x = 0, y = 0;
		let labRate = 1;
		let parentAngle = 0;
		for (let i = 0; i < arms.length; i++) {
			const arm = arms[i];
			labRate *= arm.N;
			const angle = 2 * Math.PI * labRate * t;
			const e = i === 0 ? 0 : arm.e;
			const a = arm.L;
			const b = arm.L * (1 - e);
			if (e === 0) {
				x += a * Math.cos(angle);
				y += b * Math.sin(angle);
			} else {
				const local = angle - parentAngle;
				const lx = a * Math.cos(local);
				const ly = b * Math.sin(local);
				const cp = Math.cos(parentAngle);
				const sp = Math.sin(parentAngle);
				x += lx * cp - ly * sp;
				y += lx * sp + ly * cp;
			}
			angles.push(angle);
			pivots.push({ x, y });
			parentAngle = angle;
		}
		return { pivots, pen: { x, y }, angles };
	}

	function teethDerive() {
		const T1 = state.teeth.outer;
		const T2 = state.teeth.inner;
		const type = state.teeth.type;
		const offset = state.teeth.offset;
		const unit = 3;
		const R = T1 * unit;
		const r = T2 * unit;
		const sumOrDiff = type === 'hypo' ? (T1 - T2) : (T1 + T2);
		const g = gcd2(Math.abs(sumOrDiff), T2) || 1;
		const labRate1 = T2 / g;
		const labRate2 = (type === 'hypo' ? -1 : 1) * (sumOrDiff / g);
		const L1 = type === 'hypo' ? (R - r) : (R + r);
		const L2 = offset * r;
		return { L1, L2, labRate1, labRate2, R, r };
	}

	function maxAbsN() {
		if (state.inputMode === 'teeth') {
			const { labRate1, labRate2 } = teethDerive();
			return Math.max(1, Math.abs(labRate1), Math.abs(labRate2));
		}
		let m = 1;
		for (let i = 0; i < state.armCount; i++) {
			const v = Math.abs(state.arms[i].N);
			if (v > m) m = v;
		}
		return m;
	}

	function maxCumAbsN() {
		if (state.inputMode === 'teeth') {
			const { labRate1, labRate2 } = teethDerive();
			return Math.max(1, Math.abs(labRate1), Math.abs(labRate2));
		}
		let cum = 1, m = 1;
		for (let i = 0; i < state.armCount; i++) {
			cum *= state.arms[i].N;
			const v = Math.abs(cum);
			if (v > m) m = v;
		}
		return m;
	}

	function gcd2(a, b) {
		a = Math.abs(a); b = Math.abs(b);
		while (b) { const r = a % b; a = b; b = r; }
		return a;
	}

	function gcdN() {
		if (state.inputMode === 'teeth') {
			// Teeth-derived lab rates are coprime by construction, so GCD = 1.
			return 1;
		}
		// GCD of lab-frame rates (cumulative products). With the multiplicative
		// model this simplifies to |N1| in non-degenerate cases, but compute it
		// directly so the zero/edge cases stay honest.
		let g = 0;
		let labRate = 1;
		for (let i = 0; i < state.armCount; i++) {
			labRate *= state.arms[i].N;
			g = gcd2(g, labRate);
		}
		return g;
	}

	function updateGcdHint() {
		const hint = document.getElementById('gcdHint');
		const text = document.getElementById('gcdHintText');
		const g = gcdN();
		if (g > 1) {
			text.textContent = `Pattern traces ${g}× (gcd = ${g})`;
			hint.hidden = false;
		} else {
			hint.hidden = true;
		}
	}

	function simplifyByGcd() {
		const g = gcdN();
		if (g <= 1) return;
		// In the multiplicative model, GCD of lab rates equals |N1|, so reducing
		// arm 1 to ±1 brings the pattern down to a single trace. Other Ns (gear
		// ratios) are unchanged.
		state.arms[0].N = state.arms[0].N >= 0 ? 1 : -1;
		renderArmRows();
		if (!state.running || state.paused) renderOverlay(state.t);
	}

	function hueAt(t) {
		const K = maxAbsN();
		return ((t * 360 * K) % 360 + 360) % 360;
	}

	function fillBg(ctx, c) {
		const d = dpr();
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = state.bgColor;
		ctx.fillRect(0, 0, c.width, c.height);
		ctx.setTransform(d, 0, 0, d, 0, 0);
		ctx.restore();
	}

	function clearOverlay() {
		const d = dpr();
		overlayCtx.save();
		overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
		overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
		overlayCtx.setTransform(d, 0, 0, d, 0, 0);
		overlayCtx.restore();
	}

	function renderTrail() {
		fillBg(trailCtx, trail);
		if (state.points.length < 2) return;
		trailCtx.lineWidth = 1.2;
		trailCtx.lineJoin = 'round';
		trailCtx.lineCap = 'round';
		if (state.colorMode === 'solid') {
			trailCtx.strokeStyle = state.strokeColor;
			trailCtx.beginPath();
			const p0 = transformXY(state.points[0].x, state.points[0].y);
			trailCtx.moveTo(p0.x, p0.y);
			for (let i = 1; i < state.points.length; i++) {
				const p = transformXY(state.points[i].x, state.points[i].y);
				trailCtx.lineTo(p.x, p.y);
			}
			trailCtx.stroke();
		} else {
			for (let i = 1; i < state.points.length; i++) {
				const a = transformXY(state.points[i - 1].x, state.points[i - 1].y);
				const b = transformXY(state.points[i].x, state.points[i].y);
				trailCtx.strokeStyle = `hsl(${state.points[i].hue}, 90%, 60%)`;
				trailCtx.beginPath();
				trailCtx.moveTo(a.x, a.y);
				trailCtx.lineTo(b.x, b.y);
				trailCtx.stroke();
			}
		}
	}

	function strokeIncremental(prev, next) {
		const a = transformXY(prev.x, prev.y);
		const b = transformXY(next.x, next.y);
		trailCtx.lineWidth = 1.2;
		trailCtx.lineJoin = 'round';
		trailCtx.lineCap = 'round';
		trailCtx.strokeStyle = state.colorMode === 'rainbow'
			? `hsl(${next.hue}, 90%, 60%)`
			: state.strokeColor;
		trailCtx.beginPath();
		trailCtx.moveTo(a.x, a.y);
		trailCtx.lineTo(b.x, b.y);
		trailCtx.stroke();
	}

	function renderOverlay(t) {
		clearOverlay();
		if (state.vizMode === 'none') return;
		if (state.inputMode === 'teeth') return renderOverlayTeeth(t);
		const { pivots, angles } = computeFrame(t);
		const arms = state.arms.slice(0, state.armCount);

		if (state.vizMode === 'wheels') {
			for (let i = 0; i < arms.length; i++) {
				const c = transformXY(pivots[i].x, pivots[i].y);
				const e = i === 0 ? 0 : arms[i].e;
				const a = arms[i].L * state.view.scale;
				const b = arms[i].L * (1 - e) * state.view.scale;
				const parentLab = i === 0 ? 0 : angles[i - 1];
				const localCum = angles[i] - parentLab;
				overlayCtx.save();
				overlayCtx.translate(c.x, c.y);
				overlayCtx.rotate(parentLab);
				overlayCtx.lineWidth = 1;
				overlayCtx.strokeStyle = 'rgba(150, 200, 255, 0.5)';
				overlayCtx.beginPath();
				overlayCtx.ellipse(0, 0, Math.max(0.5, a), Math.max(0.5, b), 0, 0, 2 * Math.PI);
				overlayCtx.stroke();
				const teeth = Math.max(8, Math.abs(arms[i].N) * 8);
				overlayCtx.strokeStyle = 'rgba(150, 200, 255, 0.7)';
				const innerR = 0.92;
				for (let k = 0; k < teeth; k++) {
					const theta = (k / teeth) * 2 * Math.PI + localCum;
					const cs = Math.cos(theta), sn = Math.sin(theta);
					overlayCtx.beginPath();
					overlayCtx.moveTo(a * cs * innerR, b * sn * innerR);
					overlayCtx.lineTo(a * cs, b * sn);
					overlayCtx.stroke();
				}
				overlayCtx.restore();
			}
		}

		// Arms (lines through pivots)
		overlayCtx.strokeStyle = state.vizMode === 'wheels'
			? 'rgba(255, 255, 255, 0.45)'
			: 'rgba(255, 255, 255, 0.65)';
		overlayCtx.lineWidth = 1.5;
		overlayCtx.beginPath();
		for (let i = 0; i < pivots.length; i++) {
			const p = transformXY(pivots[i].x, pivots[i].y);
			if (i === 0) overlayCtx.moveTo(p.x, p.y);
			else overlayCtx.lineTo(p.x, p.y);
		}
		overlayCtx.stroke();

		for (let i = 0; i < pivots.length - 1; i++) {
			const p = transformXY(pivots[i].x, pivots[i].y);
			overlayCtx.fillStyle = i === 0 ? 'rgba(255, 80, 200, 0.95)' : 'rgba(255, 255, 255, 0.55)';
			overlayCtx.beginPath();
			overlayCtx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, 2 * Math.PI);
			overlayCtx.fill();
		}

		const last = pivots[pivots.length - 1];
		const penP = transformXY(last.x, last.y);
		overlayCtx.fillStyle = '#22e0ff';
		overlayCtx.beginPath();
		overlayCtx.arc(penP.x, penP.y, 4, 0, 2 * Math.PI);
		overlayCtx.fill();
	}

	function renderOverlayTeeth(t) {
		const { L1, L2, labRate1, labRate2, R, r } = teethDerive();
		const a1 = 2 * Math.PI * labRate1 * t;
		const a2 = 2 * Math.PI * labRate2 * t;
		const inner = { x: L1 * Math.cos(a1), y: L1 * Math.sin(a1) };
		const pen = { x: inner.x + L2 * Math.cos(a2), y: inner.y + L2 * Math.sin(a2) };
		const c0 = transformXY(0, 0);
		const c1 = transformXY(inner.x, inner.y);
		const cP = transformXY(pen.x, pen.y);
		const sc = state.view.scale;

		if (state.vizMode === 'wheels') {
			const T1 = state.teeth.outer;
			const T2 = state.teeth.inner;
			overlayCtx.lineWidth = 1;
			overlayCtx.strokeStyle = 'rgba(150, 200, 255, 0.5)';

			// Outer ring
			overlayCtx.beginPath();
			overlayCtx.arc(c0.x, c0.y, R * sc, 0, 2 * Math.PI);
			overlayCtx.stroke();
			// Inner gear
			overlayCtx.beginPath();
			overlayCtx.arc(c1.x, c1.y, r * sc, 0, 2 * Math.PI);
			overlayCtx.stroke();

			// Teeth: outer ring's teeth are static; inner gear's teeth rotate with it.
			overlayCtx.strokeStyle = 'rgba(150, 200, 255, 0.7)';
			const innerR = 0.94;
			for (let k = 0; k < T1; k++) {
				const theta = (k / T1) * 2 * Math.PI;
				const cs = Math.cos(theta), sn = Math.sin(theta);
				overlayCtx.beginPath();
				overlayCtx.moveTo(c0.x + R * sc * cs * innerR, c0.y + R * sc * sn * innerR);
				overlayCtx.lineTo(c0.x + R * sc * cs, c0.y + R * sc * sn);
				overlayCtx.stroke();
			}
			for (let k = 0; k < T2; k++) {
				const theta = (k / T2) * 2 * Math.PI + a2;
				const cs = Math.cos(theta), sn = Math.sin(theta);
				overlayCtx.beginPath();
				overlayCtx.moveTo(c1.x + r * sc * cs * innerR, c1.y + r * sc * sn * innerR);
				overlayCtx.lineTo(c1.x + r * sc * cs, c1.y + r * sc * sn);
				overlayCtx.stroke();
			}
		}

		// Arms (lines through pivots) — drawn in arms and wheels modes.
		overlayCtx.strokeStyle = state.vizMode === 'wheels'
			? 'rgba(255, 255, 255, 0.45)'
			: 'rgba(255, 255, 255, 0.65)';
		overlayCtx.lineWidth = 1.5;
		overlayCtx.beginPath();
		overlayCtx.moveTo(c0.x, c0.y);
		overlayCtx.lineTo(c1.x, c1.y);
		overlayCtx.lineTo(cP.x, cP.y);
		overlayCtx.stroke();

		overlayCtx.fillStyle = 'rgba(255, 80, 200, 0.95)';
		overlayCtx.beginPath();
		overlayCtx.arc(c0.x, c0.y, 5, 0, 2 * Math.PI);
		overlayCtx.fill();

		overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.55)';
		overlayCtx.beginPath();
		overlayCtx.arc(c1.x, c1.y, 3, 0, 2 * Math.PI);
		overlayCtx.fill();

		overlayCtx.fillStyle = '#22e0ff';
		overlayCtx.beginPath();
		overlayCtx.arc(cP.x, cP.y, 4, 0, 2 * Math.PI);
		overlayCtx.fill();
	}

	function step(timestamp) {
		if (!state.running || state.paused) return;
		if (state.lastTimestamp === 0) state.lastTimestamp = timestamp;
		const dt = timestamp - state.lastTimestamp;
		state.lastTimestamp = timestamp;
		state.elapsed += dt;

		const total = Math.max(0.001, state.duration) * 1000;
		const newT = Math.min(1, state.elapsed / total);

		// Sub-step the trail. Target ~40 segments per revolution at the highest
		// cumulative frequency present in the path, so curves stay smooth even
		// when an inner arm spins very fast (e.g. N = 300).
		const SEGS_PER_REV = 40;
		const totalSegments = SEGS_PER_REV * maxCumAbsN();
		const target = Math.ceil((newT - state.prevT) * totalSegments);
		const segments = Math.max(1, Math.min(2048, target));
		for (let i = 1; i <= segments; i++) {
			const u = state.prevT + (newT - state.prevT) * (i / segments);
			const f = computeFrame(u);
			const pt = { x: f.pen.x, y: f.pen.y, hue: hueAt(u) };
			const prev = state.points[state.points.length - 1];
			strokeIncremental(prev, pt);
			state.points.push(pt);
		}
		state.prevT = newT;
		state.t = newT;

		renderOverlay(newT);

		if (newT >= 1) {
			state.running = false;
			stopAudio();
			updateButtons();
			return;
		}
		requestAnimationFrame(step);
	}

	function start() {
		// Always reset and begin from the start.
		stopAudio();
		state.points = [];
		state.elapsed = 0;
		state.t = 0;
		state.prevT = 0;
		fillBg(trailCtx, trail);
		const f0 = computeFrame(0);
		state.points.push({ x: f0.pen.x, y: f0.pen.y, hue: hueAt(0) });
		state.running = true;
		state.paused = false;
		state.lastTimestamp = 0;
		startAudio();
		updateButtons();
		requestAnimationFrame(step);
	}

	function togglePause() {
		if (!state.running) return;
		state.paused = !state.paused;
		if (state.paused) {
			stopAudio();
		} else {
			state.lastTimestamp = 0;
			startAudio();
			requestAnimationFrame(step);
		}
		updateButtons();
	}

	function clearAll() {
		state.running = false;
		state.paused = false;
		stopAudio();
		state.points = [];
		state.t = 0;
		state.prevT = 0;
		state.elapsed = 0;
		fillBg(trailCtx, trail);
		renderOverlay(0);
		updateButtons();
	}

	function updateButtons() {
		const startBtn = document.getElementById('startBtn');
		const pauseBtn = document.getElementById('pauseBtn');
		startBtn.disabled = state.running && !state.paused;
		pauseBtn.disabled = !state.running;
		pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
	}

	// ---- Audio ----
	let audioCtx = null;
	let masterGain = null;
	let oscillators = [];

	function ensureAudio() {
		if (audioCtx) return audioCtx;
		try {
			const Ctor = window.AudioContext || window.webkitAudioContext;
			if (!Ctor) return null;
			audioCtx = new Ctor();
			masterGain = audioCtx.createGain();
			masterGain.gain.value = state.mute ? 0 : state.volume;
			masterGain.connect(audioCtx.destination);
		} catch (e) {
			console.warn('AudioContext not available:', e);
			audioCtx = null;
		}
		return audioCtx;
	}

	function startAudio() {
		if (state.mute) return;
		if (!ensureAudio()) return;
		if (audioCtx.state === 'suspended') audioCtx.resume();
		stopAudio();
		const baseHz = 110;
		const types = ['sine', 'triangle', 'sine', 'triangle', 'sine'];
		let freqs;
		if (state.inputMode === 'teeth') {
			const { labRate1, labRate2 } = teethDerive();
			freqs = [Math.max(1, Math.abs(labRate1)), Math.max(1, Math.abs(labRate2))];
		} else {
			freqs = [];
			for (let i = 0; i < state.armCount; i++) {
				freqs.push(Math.max(1, Math.abs(state.arms[i].N)));
			}
		}
		for (let i = 0; i < freqs.length; i++) {
			const osc = audioCtx.createOscillator();
			osc.type = types[i % types.length];
			osc.frequency.value = baseHz * freqs[i];
			const g = audioCtx.createGain();
			g.gain.value = 0.06 / Math.sqrt(freqs.length);
			osc.connect(g).connect(masterGain);
			osc.start();
			oscillators.push(osc);
		}
	}

	function stopAudio() {
		for (const osc of oscillators) {
			try { osc.stop(); } catch (_) { }
		}
		oscillators = [];
	}

	function applyMuteVolume() {
		if (masterGain) {
			masterGain.gain.value = state.mute ? 0 : state.volume;
		}
		if (state.mute) {
			stopAudio();
		} else if (state.running && !state.paused && oscillators.length === 0) {
			startAudio();
		}
	}

	// ---- UI ----
	function renderArmRows() {
		const c = document.getElementById('armRows');
		c.innerHTML = '';
		for (let i = 0; i < state.armCount; i++) {
			const arm = state.arms[i];
			const rotLabel = i === 0 ? 'Rotations' : 'Per parent';
			const eccField = i === 0 ? '' : `
				<div class="arm-field">
					<label>Eccentr.</label>
					<input type="range" min="0" max="0.9" step="0.05" value="${arm.e}" data-arm="${i}" data-prop="e">
					<span class="val">${Number(arm.e).toFixed(2)}</span>
				</div>`;
			const row = document.createElement('div');
			row.className = 'arm-row';
			row.innerHTML = `
				<div class="arm-row-header">Arm ${i + 1}</div>
				<div class="arm-field">
					<label>Length</label>
					<input type="range" min="20" max="300" step="1" value="${arm.L}" data-arm="${i}" data-prop="L">
					<span class="val">${arm.L}</span>
				</div>
				<div class="arm-field">
					<label>${rotLabel}</label>
					<input type="number" min="-20" max="20" step="1" value="${arm.N}" data-arm="${i}" data-prop="N">
				</div>${eccField}
			`;
			c.appendChild(row);
		}
		c.querySelectorAll('input').forEach(input => {
			input.addEventListener('input', (e) => {
				const i = +e.target.dataset.arm;
				const prop = e.target.dataset.prop;
				let v = parseFloat(e.target.value);
				if (Number.isNaN(v)) return;
				if (prop === 'N') v = Math.round(v);
				state.arms[i][prop] = v;
				const valSpan = e.target.parentElement.querySelector('.val');
				if (valSpan) valSpan.textContent = prop === 'e' ? v.toFixed(2) : String(v);
				if (prop === 'N') updateGcdHint();
				if (!state.running || state.paused) renderOverlay(state.t);
			});
		});
		updateGcdHint();
	}

	function wireSeg(id, onChange) {
		const seg = document.getElementById(id);
		seg.querySelectorAll('.seg-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				onChange(btn.dataset.val);
			});
		});
	}

	function applyInputModeVisibility() {
		const teethSec = document.getElementById('teethSection');
		const armsSec = document.getElementById('armsSection');
		const armCountCtl = document.getElementById('armCountControl');
		const teeth = state.inputMode === 'teeth';
		teethSec.hidden = !teeth;
		armsSec.hidden = teeth;
		armCountCtl.hidden = teeth;
	}

	function updateTeethInfo() {
		const el = document.getElementById('teethInfo');
		if (!el) return;
		if (state.inputMode !== 'teeth') {
			el.textContent = '';
			return;
		}
		const { labRate1, labRate2 } = teethDerive();
		el.textContent = `Lab rates: orbit ${labRate1}, gear ${labRate2}`;
	}

	function init() {
		setArmCount(2);
		stage.style.background = state.bgColor;
		applyInputModeVisibility();
		updateTeethInfo();
		resizeCanvases();
		renderOverlay(0);

		wireSeg('inputMode', v => {
			state.inputMode = v;
			applyInputModeVisibility();
			updateTeethInfo();
			clearAll();
		});
		wireSeg('armCount', v => {
			setArmCount(+v);
			clearAll();
		});
		wireSeg('vizMode', v => {
			state.vizMode = v;
			renderOverlay(state.t);
		});
		wireSeg('colorMode', v => {
			state.colorMode = v;
			renderTrail();
		});
		wireSeg('teethType', v => {
			state.teeth.type = v;
			updateTeethInfo();
			clearAll();
		});

		const outerInput = document.getElementById('outerTeeth');
		const innerInput = document.getElementById('innerTeeth');
		const offsetInput = document.getElementById('penOffset');
		const offsetVal = document.getElementById('offsetVal');
		outerInput.addEventListener('input', (e) => {
			const v = Math.max(3, Math.round(parseFloat(e.target.value) || 0));
			state.teeth.outer = v;
			updateTeethInfo();
			if (!state.running || state.paused) renderOverlay(state.t);
		});
		innerInput.addEventListener('input', (e) => {
			const v = Math.max(3, Math.round(parseFloat(e.target.value) || 0));
			state.teeth.inner = v;
			updateTeethInfo();
			if (!state.running || state.paused) renderOverlay(state.t);
		});
		offsetInput.addEventListener('input', (e) => {
			const v = parseFloat(e.target.value);
			state.teeth.offset = v;
			offsetVal.textContent = v.toFixed(2);
			if (!state.running || state.paused) renderOverlay(state.t);
		});

		document.getElementById('durationInput').addEventListener('input', (e) => {
			const v = parseFloat(e.target.value);
			if (v > 0) state.duration = v;
		});
		document.getElementById('strokeColor').addEventListener('input', (e) => {
			state.strokeColor = e.target.value;
			renderTrail();
		});
		document.getElementById('bgColor').addEventListener('input', (e) => {
			state.bgColor = e.target.value;
			stage.style.background = state.bgColor;
			renderTrail();
			renderOverlay(state.t);
		});
		document.getElementById('muteToggle').addEventListener('change', (e) => {
			state.mute = e.target.checked;
			applyMuteVolume();
		});
		document.getElementById('volumeSlider').addEventListener('input', (e) => {
			state.volume = (+e.target.value) / 100;
			applyMuteVolume();
		});

		document.getElementById('startBtn').addEventListener('click', start);
		document.getElementById('pauseBtn').addEventListener('click', togglePause);
		document.getElementById('clearBtn').addEventListener('click', clearAll);
		document.getElementById('resetViewBtn').addEventListener('click', () => {
			state.view = { scale: 1, offsetX: 0, offsetY: 0 };
			renderTrail();
			renderOverlay(state.t);
		});
		document.getElementById('savePngBtn').addEventListener('click', () => {
			const link = document.createElement('a');
			link.download = `spiro-${Date.now()}.png`;
			link.href = trail.toDataURL('image/png');
			link.click();
		});
		document.getElementById('panelToggle').addEventListener('click', () => {
			document.getElementById('panel').classList.toggle('open');
		});
		document.getElementById('simplifyBtn').addEventListener('click', simplifyByGcd);

		// Pan/zoom
		let dragging = false;
		let dragStart = { x: 0, y: 0, ox: 0, oy: 0 };
		stage.addEventListener('wheel', (e) => {
			e.preventDefault();
			const rect = stage.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const before = untransform(mx, my);
			const factor = Math.pow(1.0015, -e.deltaY);
			state.view.scale = Math.max(0.05, Math.min(50, state.view.scale * factor));
			const after = transformXY(before.x, before.y);
			state.view.offsetX += mx - after.x;
			state.view.offsetY += my - after.y;
			renderTrail();
			renderOverlay(state.t);
		}, { passive: false });

		stage.addEventListener('mousedown', (e) => {
			if (e.button !== 0) return;
			dragging = true;
			dragStart = { x: e.clientX, y: e.clientY, ox: state.view.offsetX, oy: state.view.offsetY };
		});
		window.addEventListener('mousemove', (e) => {
			if (!dragging) return;
			state.view.offsetX = dragStart.ox + (e.clientX - dragStart.x);
			state.view.offsetY = dragStart.oy + (e.clientY - dragStart.y);
			renderTrail();
			renderOverlay(state.t);
		});
		window.addEventListener('mouseup', () => { dragging = false; });

		stage.addEventListener('dblclick', () => {
			state.view = { scale: 1, offsetX: 0, offsetY: 0 };
			renderTrail();
			renderOverlay(state.t);
		});

		window.addEventListener('resize', resizeCanvases);

		updateButtons();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();

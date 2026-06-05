	function parseGCode(gcode, segmentCount = 64, initialState = {}) {
		const lines = gcode.split('\n');
		const movements = [];

		let currentPosition = {
			X: initialState.X ?? 0,
			Y: initialState.Y ?? 0,
			Z: initialState.Z ?? 0,
			A: initialState.A ?? 0,
		};
		let centerMode = initialState.centerMode ?? null;

		let modalState = {
			feedrate: initialState.feedrate ?? null,
			spindleSpeed: initialState.spindleSpeed ?? null,
			spindleOn: initialState.spindleOn ?? false,
			coolantOn: initialState.coolantOn ?? false,
			motion: initialState.motion ?? 'G0',
			motionMode: initialState.motionMode ?? 'G90',
			plane: initialState.plane ?? 'G17',
			units: initialState.units ?? 'mm',
			activeWcs: initialState.activeWcs ?? 'G54',
			wcs: initialState.wcs ?? {},
			tools: initialState.tools ?? {},
			radiusComp: initialState.radiusComp ?? 'G40',
			radiusCompTool: initialState.radiusCompTool ?? null,
			cycleMotion: initialState.cycleMotion ?? 'G80',
			returnLevel: initialState.returnLevel ?? 'G98',
			cycleR: initialState.cycleR ?? null,
			cycleZ: initialState.cycleZ ?? null,
			cycleP: initialState.cycleP ?? null,
			cycleQ: initialState.cycleQ ?? null,
		};

		const stateCache = new Map();
		stateCache.set(JSON.stringify(modalState), modalState);

		const setModal = (patch) => {
			const next = { ...modalState, ...patch };
			const key = JSON.stringify(next);
			const existing = stateCache.get(key);
			if (existing) {
				modalState = existing;
			} else {
				stateCache.set(key, next);
				modalState = next;
			}
		};

		const ARC_CENTER_TOLERANCE = 0.001;
		const FULL_CIRCLE_TOLERANCE = 1e-6;
		const firstArcDetected = { used: false };

		const addMove = (command, x, y, z, a, lineNumber, feedLength = 0, isMidpoint = false) => {
			movements.push({ command, X: x, Y: y, Z: z, A: a, lineNumber, feedLength, isMidpoint, state: modalState });
		};

		let cycleInitialZ = null;

		const emitCannedCycle = (x, y, lineNumber) => {
			const r = modalState.cycleR;
			const z = modalState.cycleZ;
			const initialZ = cycleInitialZ;
			if (r == null || z == null || initialZ == null) return;

			const a = currentPosition.A;

			// 1. Rapid to (X, Y, initialZ) — position over the hole at safe height
			let len = Math.hypot(x - currentPosition.X, y - currentPosition.Y, initialZ - currentPosition.Z);
			addMove('G0', x, y, initialZ, a, lineNumber, len, true);
			currentPosition = { X: x, Y: y, Z: initialZ, A: a };

			// 2. Rapid to (X, Y, R) — descend to retract level
			len = Math.abs(r - initialZ);
			addMove('G0', x, y, r, a, lineNumber, len, true);
			currentPosition = { X: x, Y: y, Z: r, A: a };

			// 3. Cycle-specific drilling step
			if (modalState.cycleMotion === 'G81') {
				const feedLen = Math.abs(z - r);
				addMove('G1', x, y, z, a, lineNumber, feedLen, true);
				currentPosition = { X: x, Y: y, Z: z, A: a };
			} else if (modalState.cycleMotion === 'G82') {
				const feedLen = Math.abs(z - r);
				addMove('G1', x, y, z, a, lineNumber, feedLen, true);
				currentPosition = { X: x, Y: y, Z: z, A: a };
				// Dwell: emit a 0-length move at the bottom. dwellMs not tracked in state separately
				// — cycleP on the move's state already exposes it.
				addMove('G1', x, y, z, a, lineNumber, 0, true);
			} else if (modalState.cycleMotion === 'G83') {
				const q = Math.abs(modalState.cycleQ ?? (r - z));
				const direction = z < r ? -1 : 1;
				const clearance = Math.abs(r - z) * 0.01;
				let lastBottom = r;
				while ((direction < 0 && lastBottom > z) || (direction > 0 && lastBottom < z)) {
					const peckZ = direction < 0 ? Math.max(lastBottom + direction * q, z) : Math.min(lastBottom + direction * q, z);
					addMove('G1', x, y, peckZ, a, lineNumber, Math.abs(currentPosition.Z - peckZ), true);
					currentPosition = { X: x, Y: y, Z: peckZ, A: a };
					lastBottom = peckZ;
					if (peckZ === z) break;
					addMove('G0', x, y, r, a, lineNumber, Math.abs(peckZ - r), true);
					currentPosition = { X: x, Y: y, Z: r, A: a };
					const resumeZ = peckZ - direction * clearance;
					addMove('G0', x, y, resumeZ, a, lineNumber, Math.abs(r - resumeZ), true);
					currentPosition = { X: x, Y: y, Z: resumeZ, A: a };
				}
			}

			// 4. Retract: G99 → R level, G98 → initial Z
			const retractZ = modalState.returnLevel === 'G99' ? r : initialZ;
			const retractLen = Math.abs(currentPosition.Z - retractZ);
			if (retractLen > 0) {
				addMove('G0', x, y, retractZ, a, lineNumber, retractLen, true);
				currentPosition = { X: x, Y: y, Z: retractZ, A: a };
			}
		};

		addMove(modalState.motion, currentPosition.X, currentPosition.Y, currentPosition.Z, currentPosition.A, 0);

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].toUpperCase().replace(/;.*$/, '').trim();
			if (line === '' || line.startsWith('(') || line.startsWith('%')) continue;

			const tokens = [...line.matchAll(/([A-Z])([-+]?[0-9]*\.?[0-9]+)/g)];
			const params = {};

			for (const [, letter, value] of tokens) {
				if (!params[letter]) params[letter] = [];
				params[letter].push(parseFloat(value));
			}

			let motionEmittedOnLine = false;
			let cycleStartedOnLine = false;

			const gCodes = params['G'] || [];
			for (const g of gCodes) {
				if (g === 90.1) centerMode = 'absolute';
				else if (g === 91.1) centerMode = 'relative';
				else if (g === 90) setModal({ motionMode: 'G90' });
				else if (g === 91) setModal({ motionMode: 'G91' });
				else if (g === 20) setModal({ units: 'inch' });
				else if (g === 21) setModal({ units: 'mm' });
				else if ([54, 55, 56, 57, 58, 59].includes(g)) setModal({ activeWcs: `G${g}` });
				else if (g === 92) {
					const gx = params['X']?.[0];
					const gy = params['Y']?.[0];
					const gz = params['Z']?.[0];
					const ga = params['A']?.[0];
					const active = modalState.activeWcs;
					const prev = modalState.wcs[active] || { X: 0, Y: 0, Z: 0, A: 0 };
					const next = { ...prev };
					if (gx !== undefined) next.X = currentPosition.X - gx;
					if (gy !== undefined) next.Y = currentPosition.Y - gy;
					if (gz !== undefined) next.Z = currentPosition.Z - gz;
					if (ga !== undefined) next.A = -ga;
					setModal({ wcs: { ...modalState.wcs, [active]: next } });
					delete params['X'];
					delete params['Y'];
					delete params['Z'];
					delete params['A'];
				}
				else if (g === 28) {
					const intermediate = { ...currentPosition };
					const gx = params['X']?.[0];
					const gy = params['Y']?.[0];
					const gz = params['Z']?.[0];
					const ga = params['A']?.[0];
					if (gx !== undefined) intermediate.X = modalState.motionMode === 'G90' ? gx : currentPosition.X + gx;
					if (gy !== undefined) intermediate.Y = modalState.motionMode === 'G90' ? gy : currentPosition.Y + gy;
					if (gz !== undefined) intermediate.Z = modalState.motionMode === 'G90' ? gz : currentPosition.Z + gz;
					if (ga !== undefined) intermediate.A = modalState.motionMode === 'G90' ? ga : currentPosition.A + ga;

					const len1 = Math.hypot(
						intermediate.X - currentPosition.X,
						intermediate.Y - currentPosition.Y,
						intermediate.Z - currentPosition.Z
					);
					addMove('G0', intermediate.X, intermediate.Y, intermediate.Z, intermediate.A, i, len1, true);

					const len2 = Math.hypot(intermediate.X, intermediate.Y, intermediate.Z);
					addMove('G0', 0, 0, 0, 0, i, len2, true);

					currentPosition = { X: 0, Y: 0, Z: 0, A: 0 };
					motionEmittedOnLine = true;

					delete params['X'];
					delete params['Y'];
					delete params['Z'];
					delete params['A'];
				}
				else if (g === 10) {
					const p = params['P']?.[0];
					const r = params['R']?.[0];
					if (p !== undefined && r !== undefined) {
						setModal({ tools: { ...modalState.tools, [p]: { ...(modalState.tools[p] || {}), r } } });
					}
				}
				else if (g === 40) setModal({ radiusComp: 'G40', radiusCompTool: null });
				else if (g === 41) setModal({ radiusComp: 'G41' });
				else if (g === 42) setModal({ radiusComp: 'G42' });
				else if (g === 80) {
					setModal({ cycleMotion: 'G80' });
					cycleInitialZ = null;
				}
				else if ([81, 82, 83].includes(g)) {
					const wasOff = modalState.cycleMotion === 'G80';
					setModal({ cycleMotion: `G${g}` });
					if (params['R'] !== undefined) setModal({ cycleR: params['R'][0] });
					if (params['Z'] !== undefined) setModal({ cycleZ: params['Z'][0] });
					if (g === 82 && params['P'] !== undefined) setModal({ cycleP: params['P'][0] });
					if (g === 83 && params['Q'] !== undefined) setModal({ cycleQ: params['Q'][0] });
					if (wasOff) cycleInitialZ = currentPosition.Z;
					cycleStartedOnLine = true;
				}
				else if (g === 98) setModal({ returnLevel: 'G98' });
				else if (g === 99) setModal({ returnLevel: 'G99' });
				else if ([0, 1, 2, 3, 4].includes(g)) setModal({ motion: `G${g}` });
				else if ([17, 18, 19].includes(g)) setModal({ plane: `G${g}` });
			}

			// Cycle-active line: emit the canned-cycle sub-moves at the line's X/Y, or at current X/Y
			// if the cycle was just commanded on this line (G81/G82/G83 fires once even without X/Y).
			const cycleHasXY = params['X'] !== undefined || params['Y'] !== undefined;
			if (modalState.cycleMotion !== 'G80' && (cycleHasXY || cycleStartedOnLine)) {
				// Re-latch R/Z/P/Q if specified on this (follow-up) line
				if (params['R'] !== undefined) setModal({ cycleR: params['R'][0] });
				if (params['Z'] !== undefined) setModal({ cycleZ: params['Z'][0] });
				if (modalState.cycleMotion === 'G82' && params['P'] !== undefined) setModal({ cycleP: params['P'][0] });
				if (modalState.cycleMotion === 'G83' && params['Q'] !== undefined) setModal({ cycleQ: params['Q'][0] });

				const cx = params['X']?.[0];
				const cy = params['Y']?.[0];
				const targetX = cx !== undefined
					? (modalState.motionMode === 'G90' ? cx : currentPosition.X + cx)
					: currentPosition.X;
				const targetY = cy !== undefined
					? (modalState.motionMode === 'G90' ? cy : currentPosition.Y + cy)
					: currentPosition.Y;

				emitCannedCycle(targetX, targetY, i);
				motionEmittedOnLine = true;

				delete params['X'];
				delete params['Y'];
				delete params['Z'];
			}

			if (params['D']) setModal({ radiusCompTool: params['D'][0] });

			const mCodes = params['M'] || [];
			for (const m of mCodes) {
				if (m === 3) setModal({ spindleOn: true });
				else if (m === 5) setModal({ spindleOn: false });
				else if (m === 7 || m === 8) setModal({ coolantOn: true });
				else if (m === 9) setModal({ coolantOn: false });
			}

			if (params['F']) setModal({ feedrate: params['F'][0] });
			if (params['S']) setModal({ spindleSpeed: params['S'][0] });

			const x = params['X']?.[0];
			const y = params['Y']?.[0];
			const z = params['Z']?.[0];
			const a = params['A']?.[0];
			const iVal = params['I']?.[0] ?? 0;
			const jVal = params['J']?.[0] ?? 0;
			const kVal = params['K']?.[0] ?? 0;
			const rVal = params['R']?.[0];

			if (motionEmittedOnLine) {
				// G28 (or future canned-cycle expansion) already emitted moves for this line
			} else if (modalState.motion === 'G2' || modalState.motion === 'G3') {
				const target = { ...currentPosition };
				if (x !== undefined) target.X = modalState.motionMode === 'G90' ? x : currentPosition.X + x;
				if (y !== undefined) target.Y = modalState.motionMode === 'G90' ? y : currentPosition.Y + y;
				if (z !== undefined) target.Z = modalState.motionMode === 'G90' ? z : currentPosition.Z + z;
				if (a !== undefined) target.A = modalState.motionMode === 'G90' ? a : currentPosition.A + a;

				let axisA = 'X', axisB = 'Y', keyA = 'I', keyB = 'J';
				if (modalState.plane === 'G18') { axisA = 'Z'; axisB = 'X'; keyA = 'K'; keyB = 'I'; }
				else if (modalState.plane === 'G19') { axisA = 'Y'; axisB = 'Z'; keyA = 'J'; keyB = 'K'; }

				const startA = currentPosition[axisA];
				const startB = currentPosition[axisB];
				const endA = target[axisA];
				const endB = target[axisB];

				let centerA, centerB;

				if (rVal !== undefined) {
					const dx = endA - startA;
					const dy = endB - startB;
					const chord2 = dx * dx + dy * dy;
					const h = Math.sqrt(Math.max(0, rVal * rVal - chord2 / 4));
					const dir = modalState.motion === 'G2' ? -1 : 1;

					const mx = (startA + endA) / 2;
					const my = (startB + endB) / 2;
					const nx = -dy / Math.sqrt(chord2);
					const ny = dx / Math.sqrt(chord2);

					centerA = mx + dir * h * nx;
					centerB = my + dir * h * ny;
				} else {
					const offsetFor = (key) => key === "I" ? iVal : key === "J" ? jVal : kVal;
					const relCenter = {
						A: currentPosition[axisA] + offsetFor(keyA),
						B: currentPosition[axisB] + offsetFor(keyB)
					};
					const absCenter = {
						A: offsetFor(keyA),
						B: offsetFor(keyB)
					};

					if (!centerMode && !firstArcDetected.used) {
						const distRel = Math.abs(
							Math.hypot(startA - relCenter.A, startB - relCenter.B) -
							Math.hypot(endA - relCenter.A, endB - relCenter.B)
						);
						const distAbs = Math.abs(
							Math.hypot(startA - absCenter.A, startB - absCenter.B) -
							Math.hypot(endA - absCenter.A, endB - absCenter.B)
						);
						centerMode = distRel <= distAbs ? 'relative' : 'absolute';
						firstArcDetected.used = true;
					}

					const chosen = centerMode === 'relative' ? relCenter : absCenter;
					centerA = chosen.A;
					centerB = chosen.B;
				}

				const startAngle = Math.atan2(startB - centerB, startA - centerA);
				let endAngle = Math.atan2(endB - centerB, endA - centerA);
				const radius = Math.hypot(startA - centerA, startB - centerB);

				let sweep = endAngle - startAngle;
				const isFullCircle = Math.hypot(endA - startA, endB - startB) < FULL_CIRCLE_TOLERANCE;

				if (!isFullCircle) {

					// if (isFullCircle) {
						// sweep = modalState.motion === 'G2' ? -2 * Math.PI : 2 * Math.PI;
					// } else {
						if (modalState.motion === 'G2' && sweep > 0) sweep -= 2 * Math.PI;
						if (modalState.motion === 'G3' && sweep < 0) sweep += 2 * Math.PI;
					// }

					const orthogonalAxis = (modalState.plane === 'G17') ? 'Z' : (modalState.plane === 'G18') ? 'Y' : 'X';
					const dOrthogonal = target[orthogonalAxis] - currentPosition[orthogonalAxis];
					const dA = target.A - currentPosition.A;
					const arcLength = Math.hypot(radius * Math.abs(sweep), dOrthogonal);

					const midJ = Math.ceil(segmentCount / 2);
					for (let j = 1; j <= segmentCount; j++) {
						const angle = startAngle + (sweep * j) / segmentCount;
						const ratio = j / segmentCount;
						const point = { ...currentPosition };

						point[axisA] = centerA + radius * Math.cos(angle);
						point[axisB] = centerB + radius * Math.sin(angle);
						point[orthogonalAxis] = currentPosition[orthogonalAxis] + ratio * dOrthogonal;
						point.A = currentPosition.A + ratio * dA;

						if (!Number.isNaN(point.X) && !Number.isNaN(point.Y) && !Number.isNaN(point.Z)) {
							addMove(modalState.motion, point.X, point.Y, point.Z, point.A, i, arcLength, j === midJ);
						}

					}

					currentPosition = { ...target };
				}

			} else {
				const pos = { ...currentPosition };
				if (x !== undefined) pos.X = modalState.motionMode === 'G90' ? x : currentPosition.X + x;
				if (y !== undefined) pos.Y = modalState.motionMode === 'G90' ? y : currentPosition.Y + y;
				if (z !== undefined) pos.Z = modalState.motionMode === 'G90' ? z : currentPosition.Z + z;
				if (a !== undefined) pos.A = modalState.motionMode === 'G90' ? a : currentPosition.A + a;

				if (!Number.isNaN(pos.X) && !Number.isNaN(pos.Y) && !Number.isNaN(pos.Z)) {
					const feedLength = Math.hypot(
						pos.X - currentPosition.X,
						pos.Y - currentPosition.Y,
						pos.Z - currentPosition.Z
					);
					currentPosition = { ...pos };
					addMove(modalState.motion, pos.X, pos.Y, pos.Z, pos.A, i, feedLength, true);
				}
			}
		}

		return movements;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { parseGCode };
	}

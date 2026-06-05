	function parseGCode(gcode, segmentCount = 64, initialState = {}) {
		const lines = gcode.split('\n');
		const movements = [];

		let currentPosition = {
			X: initialState.X ?? 0,
			Y: initialState.Y ?? 0,
			Z: initialState.Z ?? 0,
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

		const addMove = (command, x, y, z, lineNumber, feedLength = 0, isMidpoint = false) => {
			movements.push({ command, X: x, Y: y, Z: z, lineNumber, feedLength, isMidpoint, state: modalState });
		};

		addMove(modalState.motion, currentPosition.X, currentPosition.Y, currentPosition.Z, 0);

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].toUpperCase().replace(/;.*$/, '').trim();
			if (line === '' || line.startsWith('(') || line.startsWith('%')) continue;

			const tokens = [...line.matchAll(/([A-Z])([-+]?[0-9]*\.?[0-9]+)/g)];
			const params = {};

			for (const [, letter, value] of tokens) {
				if (!params[letter]) params[letter] = [];
				params[letter].push(parseFloat(value));
			}

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
				else if ([0, 1, 2, 3, 4].includes(g)) setModal({ motion: `G${g}` });
				else if ([17, 18, 19].includes(g)) setModal({ plane: `G${g}` });
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
			const iVal = params['I']?.[0] ?? 0;
			const jVal = params['J']?.[0] ?? 0;
			const kVal = params['K']?.[0] ?? 0;
			const rVal = params['R']?.[0];

			if (modalState.motion === 'G2' || modalState.motion === 'G3') {
				const target = { ...currentPosition };
				if (x !== undefined) target.X = modalState.motionMode === 'G90' ? x : currentPosition.X + x;
				if (y !== undefined) target.Y = modalState.motionMode === 'G90' ? y : currentPosition.Y + y;
				if (z !== undefined) target.Z = modalState.motionMode === 'G90' ? z : currentPosition.Z + z;

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
					const arcLength = Math.hypot(radius * Math.abs(sweep), dOrthogonal);

					const midJ = Math.ceil(segmentCount / 2);
					for (let j = 1; j <= segmentCount; j++) {
						const angle = startAngle + (sweep * j) / segmentCount;
						const ratio = j / segmentCount;
						const point = { ...currentPosition };

						point[axisA] = centerA + radius * Math.cos(angle);
						point[axisB] = centerB + radius * Math.sin(angle);
						point[orthogonalAxis] = currentPosition[orthogonalAxis] + ratio * dOrthogonal;

						if (!Number.isNaN(point.X) && !Number.isNaN(point.Y) && !Number.isNaN(point.Z)) {
							addMove(modalState.motion, point.X, point.Y, point.Z, i, arcLength, j === midJ);
						}

					}

					currentPosition = { ...target };
				}

			} else {
				const pos = { ...currentPosition };
				if (x !== undefined) pos.X = modalState.motionMode === 'G90' ? x : currentPosition.X + x;
				if (y !== undefined) pos.Y = modalState.motionMode === 'G90' ? y : currentPosition.Y + y;
				if (z !== undefined) pos.Z = modalState.motionMode === 'G90' ? z : currentPosition.Z + z;

				if (!Number.isNaN(pos.X) && !Number.isNaN(pos.Y) && !Number.isNaN(pos.Z)) {
					const feedLength = Math.hypot(
						pos.X - currentPosition.X,
						pos.Y - currentPosition.Y,
						pos.Z - currentPosition.Z
					);
					currentPosition = { ...pos };
					addMove(modalState.motion, pos.X, pos.Y, pos.Z, i, feedLength, true);
				}
			}
		}

		return movements;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { parseGCode };
	}

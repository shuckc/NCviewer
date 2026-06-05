const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseGCode } = require('../g_code_parser.js');

const sampleGcode = fs.readFileSync(
	path.join(__dirname, '..', 'samples', 'example-doc-part.gcode'),
	'utf8'
);

test('seed movement: starts at origin with G0', () => {
	const movements = parseGCode(sampleGcode);
	assert.ok(movements.length > 1, 'should produce more than just the seed');
	assert.strictEqual(movements[0].command, 'G0');
	assert.strictEqual(movements[0].X, 0);
	assert.strictEqual(movements[0].Y, 0);
	assert.strictEqual(movements[0].Z, 0);
});

test('G91 incremental motion mode is honoured', () => {
	const movements = parseGCode(sampleGcode);
	// First G00Z5.0 (line index 6) under G91 should set Z to +5.0 from origin
	const firstZMove = movements.find(m => m.lineNumber === 6);
	assert.ok(firstZMove, 'should emit a move for the G00 Z5.0 line');
	assert.strictEqual(firstZMove.Z, 5.0);
});

test('M03 turns spindle on; F and S are surfaced via state', () => {
	const movements = parseGCode(sampleGcode);
	// Line 8 (index 7) is `F300.0S6000M03` — does not itself emit motion,
	// but the next emitted move (line index 8, `G17G41D01G00X8.0Y8.0`) carries the new state.
	const afterM03 = movements.find(m => m.lineNumber === 8);
	assert.ok(afterM03, 'should emit a move for the line after M03');
	assert.strictEqual(afterM03.state.spindleOn, true, 'spindle should be on after M03');
	assert.strictEqual(afterM03.state.feedrate, 300.0);
	assert.strictEqual(afterM03.state.spindleSpeed, 6000);
});

test('M05 turns spindle off but retains the latched S value', () => {
	const movements = parseGCode(sampleGcode);
	// Last emitted move (before M05/M02) has spindle on; after the M05 line, no further motion
	// is emitted, so we exercise the off-state by checking states present in the cache via interning:
	// the very last move should be the post-Z7.0 line, with spindle still on.
	// To verify M05 takes effect when followed by motion, we can check that no move after lineNumber 17
	// has spindleOn === true. (Line 17 is `M05`.)
	const movesAfterM05 = movements.filter(m => m.lineNumber > 17);
	for (const m of movesAfterM05) {
		assert.strictEqual(m.state.spindleOn, false, 'no move after M05 should have spindleOn=true');
	}
});

test('arc (G3) interpolates into 64 sub-segments with one midpoint', () => {
	const movements = parseGCode(sampleGcode);
	// Line 13 (index 12) is `G03X15.0Y-15.0I15.0`
	const arcSegments = movements.filter(m => m.lineNumber === 12);
	assert.strictEqual(arcSegments.length, 64, 'arc should interpolate to 64 segments');
	for (const seg of arcSegments) {
		assert.strictEqual(seg.command, 'G3', 'interpolated segments retain G3 command');
	}
	const midpoints = arcSegments.filter(m => m.isMidpoint);
	assert.strictEqual(midpoints.length, 1, 'arc should have exactly one midpoint flag');
});

test('arc segments share a single feedLength value (full arc length)', () => {
	const movements = parseGCode(sampleGcode);
	const arcSegments = movements.filter(m => m.lineNumber === 12);
	const firstLen = arcSegments[0].feedLength;
	assert.ok(firstLen > 0, 'arc length should be positive');
	for (const seg of arcSegments) {
		assert.strictEqual(seg.feedLength, firstLen, 'all arc sub-segments share the full arc length');
	}
});

test('modal state objects are interned: identical states share a reference', () => {
	const movements = parseGCode(sampleGcode);
	const byKey = new Map();
	let pairs = 0;
	for (const m of movements) {
		const key = JSON.stringify(m.state);
		if (byKey.has(key)) {
			assert.strictEqual(m.state, byKey.get(key), `state ${key} should share reference`);
			pairs++;
		} else {
			byKey.set(key, m.state);
		}
	}
	assert.ok(pairs > 0, 'sample should produce at least one pair of identical states for interning to verify');
});

test('every movement carries a state reference', () => {
	const movements = parseGCode(sampleGcode);
	for (const m of movements) {
		assert.ok(m.state, 'every movement should have a state field');
		assert.ok('feedrate' in m.state, 'state should include feedrate');
		assert.ok('spindleSpeed' in m.state, 'state should include spindleSpeed');
		assert.ok('spindleOn' in m.state, 'state should include spindleOn');
	}
});

test('parses empty input without error', () => {
	const movements = parseGCode('');
	// Should still emit the seed movement
	assert.strictEqual(movements.length, 1);
	assert.strictEqual(movements[0].command, 'G0');
});

test('state-only line (F/S/M3) emits one 0-length movement with post-line state', () => {
	const movements = parseGCode(sampleGcode);
	// File line 8, `F300.0S6000M03` → lineNumber 7 (0-based)
	const stateMoves = movements.filter(m => m.lineNumber === 7);
	assert.strictEqual(stateMoves.length, 1, 'should emit exactly one movement for the state-only line');
	const mv = stateMoves[0];
	assert.strictEqual(mv.feedLength, 0, 'state-only move has zero feedLength');
	assert.strictEqual(mv.state.feedrate, 300.0);
	assert.strictEqual(mv.state.spindleSpeed, 6000);
	assert.strictEqual(mv.state.spindleOn, true);
});

test('initial modal state defaults: motion=G0, plane=G17, units=mm, tools={}', () => {
	const movements = parseGCode('');
	assert.strictEqual(movements[0].state.motion, 'G0');
	assert.strictEqual(movements[0].state.plane, 'G17');
	assert.strictEqual(movements[0].state.units, 'mm');
	assert.deepStrictEqual(movements[0].state.tools, {});
});

test('G10 P<n> R<r> sets tool radius in modal state', () => {
	const movements = parseGCode(sampleGcode);
	// Line 6 of sample (index 5): `G10P1R3.0`
	const afterG10 = movements.find(m => m.lineNumber === 5);
	assert.ok(afterG10, 'should emit a movement for the G10 line');
	assert.deepStrictEqual(afterG10.state.tools, { 1: { r: 3.0 } });
});

test('multiple G10 entries accumulate tools without losing prior ones', () => {
	const movements = parseGCode('G10P1R3.0\nG10P2R5.0\n');
	const last = movements[movements.length - 1];
	assert.deepStrictEqual(last.state.tools, { 1: { r: 3.0 }, 2: { r: 5.0 } });
});

test('default radius comp state is G40 off, no tool', () => {
	const movements = parseGCode('');
	assert.strictEqual(movements[0].state.radiusComp, 'G40');
	assert.strictEqual(movements[0].state.radiusCompTool, null);
});

test('G41 with D-word activates left comp and latches tool number', () => {
	const movements = parseGCode(sampleGcode);
	// File line 9 (`G17G41D01G00X8.0Y8.0`) → lineNumber 8
	const mv = movements.find(m => m.lineNumber === 8);
	assert.ok(mv, 'should emit a movement for the G41 line');
	assert.strictEqual(mv.state.radiusComp, 'G41');
	assert.strictEqual(mv.state.radiusCompTool, 1);
});

test('G40 cancels radius comp and clears D latch', () => {
	const movements = parseGCode(sampleGcode);
	// File line 17 (`G40G00X-8.0Y-8.0`) → lineNumber 16
	const mv = movements.find(m => m.lineNumber === 16);
	assert.ok(mv, 'should emit a movement for the G40 line');
	assert.strictEqual(mv.state.radiusComp, 'G40');
	assert.strictEqual(mv.state.radiusCompTool, null);
});

test('initial state argument seeds position and modal state', () => {
	const movements = parseGCode('X10Y10', 64, {
		X: 5, Y: 5, Z: 2,
		motion: 'G1',
		feedrate: 100,
		units: 'inch',
		plane: 'G18',
		spindleOn: true,
		spindleSpeed: 8000,
	});
	// Seed move at the provided position with the provided modal state
	assert.strictEqual(movements[0].X, 5);
	assert.strictEqual(movements[0].Y, 5);
	assert.strictEqual(movements[0].Z, 2);
	assert.strictEqual(movements[0].state.motion, 'G1');
	assert.strictEqual(movements[0].state.feedrate, 100);
	assert.strictEqual(movements[0].state.units, 'inch');
	assert.strictEqual(movements[0].state.plane, 'G18');
	assert.strictEqual(movements[0].state.spindleOn, true);
	assert.strictEqual(movements[0].state.spindleSpeed, 8000);

	// X10Y10 under absolute mode lands at (10,10,2) and inherits motion=G1
	const motionMove = movements[1];
	assert.strictEqual(motionMove.X, 10);
	assert.strictEqual(motionMove.Y, 10);
	assert.strictEqual(motionMove.Z, 2);
	assert.strictEqual(motionMove.state.motion, 'G1');
});

test('initial state partial overrides preserve other defaults', () => {
	const movements = parseGCode('', 64, { feedrate: 500 });
	assert.strictEqual(movements[0].state.feedrate, 500);
	assert.strictEqual(movements[0].state.motion, 'G0');
	assert.strictEqual(movements[0].state.units, 'mm');
	assert.strictEqual(movements[0].state.plane, 'G17');
	assert.strictEqual(movements[0].X, 0);
});

test('initial state with motionMode=G91 treats X/Y/Z as deltas', () => {
	const movements = parseGCode('X3Y4', 64, {
		X: 10, Y: 10, Z: 0,
		motionMode: 'G91',
	});
	const motionMove = movements[1];
	assert.strictEqual(motionMove.X, 13);
	assert.strictEqual(motionMove.Y, 14);
});

test('default motionMode is G90, activeWcs is G54, wcs map is empty, coolantOn is false', () => {
	const movements = parseGCode('');
	assert.strictEqual(movements[0].state.motionMode, 'G90');
	assert.strictEqual(movements[0].state.activeWcs, 'G54');
	assert.deepStrictEqual(movements[0].state.wcs, {});
	assert.strictEqual(movements[0].state.coolantOn, false);
});

test('G91 sets motionMode to G91 in modal state', () => {
	const movements = parseGCode(sampleGcode);
	// File line 3 (`G91`) → lineNumber 2
	const mv = movements.find(m => m.lineNumber === 2);
	assert.ok(mv);
	assert.strictEqual(mv.state.motionMode, 'G91');
});

test('G54-G59 update activeWcs', () => {
	const movements = parseGCode('G55\nG01X1\nG58\n');
	const afterG55 = movements.filter(m => m.lineNumber === 0).pop();
	assert.strictEqual(afterG55.state.activeWcs, 'G55');
	const afterG58 = movements.filter(m => m.lineNumber === 2).pop();
	assert.strictEqual(afterG58.state.activeWcs, 'G58');
});

test('G92 X Y Z stores origin offset in wcs map under activeWcs (no delta when at origin)', () => {
	const movements = parseGCode(sampleGcode);
	// File line 5 (`G92X0Y0Z0`) → lineNumber 4. At this point currentPosition is (0,0,0).
	const mv = movements.filter(m => m.lineNumber === 4).pop();
	assert.ok(mv, 'should emit a move for the G92 line');
	assert.deepStrictEqual(mv.state.wcs, { 'G54': { X: 0, Y: 0, Z: 0, A: 0 } });
});

test('G92 with non-zero deltas computes offset = currentPosition - given', () => {
	// Move to (10, 20, 0) absolute, then G92 X0 Y0 Z0 — declares current as origin → offset (10, 20, 0)
	const movements = parseGCode('G90\nG01X10Y20\nG92X0Y0Z0\n');
	const mv = movements[movements.length - 1];
	assert.deepStrictEqual(mv.state.wcs['G54'], { X: 10, Y: 20, Z: 0, A: 0 });
});

test('G92 does not emit motion to its X/Y/Z parameters', () => {
	// G92 must consume X/Y/Z so they are not interpreted as a move target
	const movements = parseGCode('G90\nG92X100Y200Z300\n');
	const last = movements[movements.length - 1];
	// Position should still be 0,0,0 — G92 modifies WCS, not toolhead position
	assert.strictEqual(last.X, 0);
	assert.strictEqual(last.Y, 0);
	assert.strictEqual(last.Z, 0);
});

test('G92 against a non-default WCS targets that WCS only', () => {
	const movements = parseGCode('G55\nG92X0Y0Z0\n');
	const mv = movements[movements.length - 1];
	assert.deepStrictEqual(mv.state.wcs, { 'G55': { X: 0, Y: 0, Z: 0, A: 0 } });
	assert.strictEqual(mv.state.activeWcs, 'G55');
});

test('M07/M08 turn coolant on; M09 turns it off', () => {
	const onMist = parseGCode('M07\n');
	assert.strictEqual(onMist[onMist.length - 1].state.coolantOn, true);
	const onFlood = parseGCode('M08\n');
	assert.strictEqual(onFlood[onFlood.length - 1].state.coolantOn, true);
	const off = parseGCode('M08\nM09\n');
	assert.strictEqual(off[off.length - 1].state.coolantOn, false);
});

test('G21 sets units to mm; G20 sets units to inch', () => {
	const mmMoves = parseGCode(sampleGcode);
	// After G21 on file line 4 (lineNumber 3), every subsequent state has units=mm
	const afterG21 = mmMoves.filter(m => m.lineNumber >= 3);
	for (const m of afterG21) {
		assert.strictEqual(m.state.units, 'mm');
	}
	const inchMoves = parseGCode('G20\nG01X10Y10\n');
	const motionMove = inchMoves.find(m => m.lineNumber === 1);
	assert.strictEqual(motionMove.state.units, 'inch');
});

test('arc-interpolated segments carry motion=G3 in modal state', () => {
	const movements = parseGCode(sampleGcode);
	const arcSegments = movements.filter(m => m.lineNumber === 12);
	for (const seg of arcSegments) {
		assert.strictEqual(seg.state.motion, 'G3');
	}
});

test('motion mode is preserved across state-only lines', () => {
	const movements = parseGCode(sampleGcode);
	// Line 8 (`F300.0S6000M03`, lineNumber 7) is a state-only line emitted AFTER G00 on line 7.
	// modalState.motion at that point should still be 'G0'.
	const stateMv = movements.find(m => m.lineNumber === 7);
	assert.strictEqual(stateMv.state.motion, 'G0', 'motion should remain G0 across F/S/M-only line');
});

test('M05 line emits a 0-length movement with spindle off and S latched', () => {
	const movements = parseGCode(sampleGcode);
	// File line 18, `M05` → lineNumber 17 (0-based)
	const m05Moves = movements.filter(m => m.lineNumber === 17);
	assert.strictEqual(m05Moves.length, 1, 'should emit exactly one movement for the M05 line');
	const mv = m05Moves[0];
	assert.strictEqual(mv.feedLength, 0);
	assert.strictEqual(mv.state.spindleOn, false);
	assert.strictEqual(mv.state.spindleSpeed, 6000, 'S value should remain latched across M05');
});

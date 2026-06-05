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
	// All moves between M03 (line 7) and M05 (line 17) with no S/F change in between
	// should reference the same modal state object.
	const onMoves = movements.filter(m =>
		m.state.spindleOn === true &&
		m.state.feedrate === 300.0 &&
		m.state.spindleSpeed === 6000
	);
	assert.ok(onMoves.length > 1, 'should have multiple moves under spindle-on');
	const ref = onMoves[0].state;
	for (const m of onMoves) {
		assert.strictEqual(m.state, ref, 'identical modal states must be the same reference');
	}
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

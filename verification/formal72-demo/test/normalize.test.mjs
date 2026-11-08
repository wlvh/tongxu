import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLabel} from '../src/index.mjs';
test('preserves a nonempty trimmed label', () => assert.equal(normalizeLabel('  Alpha  '), 'Alpha'));
test('uses Untitled for a blank default label', () => assert.equal(normalizeLabel('  '), 'Untitled'));
test('uses an explicit fallback for a blank label', () => assert.equal(normalizeLabel(' ', 'Draft'), 'Draft'));

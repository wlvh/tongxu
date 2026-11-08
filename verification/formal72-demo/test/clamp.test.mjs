import test from 'node:test';
import assert from 'node:assert/strict';
import {clamp} from '../src/index.mjs';
test('preserves an interior integer', () => assert.equal(clamp(5, 0, 10), 5));
test('uses the lower bound below the range', () => assert.equal(clamp(-2, 0, 10), 0));
test('uses the upper bound above the range', () => assert.equal(clamp(12, 0, 10), 10));
test('preserves a fractional interior value', () => assert.equal(clamp(4.5, 0, 10), 4.5));

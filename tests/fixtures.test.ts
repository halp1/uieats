import { describe, expect, it } from 'vitest';
import { assertFixturesUnchanged } from './helpers/fixtures.ts';

describe('fixture integrity', () => {
	it('matches the recorded manifest', () => {
		// The fixtures ARE the expectations. If one is reformatted, re-captured or
		// partially overwritten, every parser test would silently start asserting
		// whatever the new bytes say. Fail here instead.
		expect(() => assertFixturesUnchanged()).not.toThrow();
	});
});

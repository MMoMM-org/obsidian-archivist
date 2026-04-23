import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW = readFileSync(
	resolve(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
	'utf8',
);

describe('ci.yml workflow', () => {
	it('triggers on pull_request against main', () => {
		expect(WORKFLOW).toMatch(
			/^on:[\s\S]*?pull_request:[\s\S]*?branches:\s*\[\s*["']?main["']?\s*\]/m,
		);
	});

	it('defines five required jobs', () => {
		for (const job of ['lint', 'typecheck', 'test', 'audit', 'build']) {
			expect(WORKFLOW).toMatch(new RegExp(`^\\s{2}${job}:`, 'm'));
		}
	});

	it('runs on ubuntu-latest and macos-latest', () => {
		expect(WORKFLOW).toMatch(/ubuntu-latest/);
		expect(WORKFLOW).toMatch(/macos-latest/);
	});

	it('uses Node 20', () => {
		expect(WORKFLOW).toMatch(/node-version:\s*["']?20/);
	});

	it("audit uses '--audit-level=high'", () => {
		expect(WORKFLOW).toMatch(/npm audit[^\n]*--audit-level=high/);
	});

	it('includes a bundle-size gate with 1 MB threshold', () => {
		// Either explicit byte-count (1048576 / 1000000) or human-readable "1M" / "1 MB".
		expect(WORKFLOW).toMatch(/(1048576|1000000|1\s?M[B]?)/);
	});
});

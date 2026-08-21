import { describe, expect, it } from 'vitest';
import { PanelMissingError, panelOrThrow, readPanels, UpstreamErrorPage } from './panels.ts';
import { loadFixture } from '../../../../tests/helpers/fixtures.ts';

describe('readPanels', () => {
	it('reads the JSON envelope upstream returns for navigation calls', () => {
		const panels = readPanels(loadFixture('select-unit-1.hall.json'));
		expect(panels.has('childUnitsPanel')).toBe(true);
		expect(panels.get('childUnitsPanel')).toContain('Gregory Drive Diner');
	});

	it('keeps empty panels out of the map so callers can branch on presence', () => {
		// The envelope always lists every panel; most are empty strings. Treating
		// "present but empty" as present is how the hall/standalone branch gets
		// taken the wrong way.
		const panels = readPanels(loadFixture('select-unit-1.hall.json'));
		expect(panels.has('menuPanel')).toBe(false);
		expect(panels.has('itemPanel')).toBe(false);
	});

	it('falls back to raw HTML for endpoints that do not return JSON', () => {
		// The nutrition label and hours endpoints answer with bare HTML, and the
		// server misreports content-type, so we sniff by trying JSON first.
		const panels = readPanels(loadFixture('label-122098028.html'));
		expect(panels.has('__raw')).toBe(true);
		expect(panels.get('__raw')).toContain('Blondie Bars');
	});

	it('rejects the start-up error page instead of parsing it as content', () => {
		// Upstream answers HTTP 200 with this when it is unhealthy. Seen live.
		const errorPage =
			'<html><head><title>NetNutrition Start-up Error</title></head><body>The system has encountered an error</body></html>';
		expect(() => readPanels(errorPage)).toThrow(UpstreamErrorPage);
	});

	it('rejects an envelope that reports failure', () => {
		expect(() => readPanels('{"success":false,"panels":[]}')).toThrow();
	});
});

describe('panelOrThrow', () => {
	it('returns the panel when present', () => {
		const panels = readPanels(loadFixture('select-childunit-2.menulist.json'));
		expect(panelOrThrow(panels, 'menuPanel')).toContain('Menu List For');
	});

	it('names the panel it wanted and what it got, for a legible failure', () => {
		const panels = readPanels(loadFixture('select-childunit-2.menulist.json'));
		expect(() => panelOrThrow(panels, 'itemPanel')).toThrow(PanelMissingError);
		expect(() => panelOrThrow(panels, 'itemPanel')).toThrow(/itemPanel.*menuPanel/s);
	});
});

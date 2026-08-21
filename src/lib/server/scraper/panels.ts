/**
 * NetNutrition's response envelope.
 *
 * Navigation endpoints answer with
 *   {"success":true,"panels":[{"id":"itemPanel","html":"..."}, ...]}
 * while the nutrition-label and hours endpoints answer with bare HTML. The
 * server misreports Content-Type for both, so the only reliable discriminator
 * is attempting JSON.parse and falling back.
 */

export class PanelMissingError extends Error {
	constructor(wanted: string, available: string[]) {
		super(
			`Expected panel "${wanted}" in the response, but it contained: ` +
				(available.length ? available.join(', ') : '(no non-empty panels)')
		);
		this.name = 'PanelMissingError';
	}
}

export class UpstreamErrorPage extends Error {
	constructor(excerpt: string) {
		super(`Upstream returned its error page instead of content: ${excerpt}`);
		this.name = 'UpstreamErrorPage';
	}
}

export class UpstreamFailure extends Error {
	constructor() {
		super('Upstream responded with success:false');
		this.name = 'UpstreamFailure';
	}
}

/** Key used for responses that are raw HTML rather than a panel envelope. */
export const RAW_PANEL = '__raw';

interface Envelope {
	success?: boolean;
	panels?: { id: string; html: string }[];
}

// Upstream serves these with HTTP 200 when it is unhealthy, so status codes
// alone do not detect an outage.
const ERROR_PAGE_MARKERS = ['NetNutrition Start-up Error', 'The system has encountered an error'];

export function readPanels(body: string): Map<string, string> {
	for (const marker of ERROR_PAGE_MARKERS) {
		if (body.includes(marker)) {
			throw new UpstreamErrorPage(body.slice(0, 200).replace(/\s+/g, ' ').trim());
		}
	}

	let envelope: Envelope | undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === 'object' && 'panels' in parsed) {
			envelope = parsed as Envelope;
		}
	} catch {
		// Not JSON: a raw-HTML endpoint. Fall through.
	}

	if (!envelope) {
		return new Map([[RAW_PANEL, body]]);
	}

	if (envelope.success === false) throw new UpstreamFailure();

	const panels = new Map<string, string>();
	for (const panel of envelope.panels ?? []) {
		// The envelope always lists every panel and blanks the ones that did not
		// change. Only non-empty panels are meaningful, and callers branch on
		// presence (childUnitsPanel => hall, menuPanel => standalone).
		if (panel.html && panel.html.trim() !== '') panels.set(panel.id, panel.html);
	}
	return panels;
}

export function panelOrThrow(panels: Map<string, string>, id: string): string {
	const html = panels.get(id);
	if (html === undefined) throw new PanelMissingError(id, [...panels.keys()]);
	return html;
}

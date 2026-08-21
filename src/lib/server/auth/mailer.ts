/**
 * Sending the login code.
 *
 * Resend in production, the console in development. The console fallback is not
 * a stub to be replaced later -- it is how the whole auth flow is exercised
 * without a network or a real inbox, and it is what `bun run dev` uses.
 *
 * A send failure must never be silent: if the mail does not go out, the user is
 * staring at a code entry form for a code that will never arrive. The caller
 * gets the failure and says so.
 */
import { Resend } from 'resend';
import { CODE_TTL_SECONDS } from './codes.ts';

export interface Mailer {
	sendLoginCode(email: string, code: string): Promise<void>;
}

const FROM = process.env.MAIL_FROM ?? 'uieats <onboarding@resend.dev>';

function body(code: string): { subject: string; text: string; html: string } {
	const minutes = Math.round(CODE_TTL_SECONDS / 60);
	const subject = `${code} is your uieats sign-in code`;

	// The code is in the subject as well as the body, so it can be read from a
	// notification without opening anything.
	const text = [
		`Your uieats sign-in code is ${code}.`,
		'',
		`It works once and expires in ${minutes} minutes.`,
		'',
		'If you did not ask to sign in, you can ignore this — someone typed your',
		'address by mistake, and no account was created or changed.'
	].join('\n');

	const html = `<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#171717">
	<p>Your uieats sign-in code is</p>
	<p style="font-family:ui-monospace,monospace;font-size:32px;font-weight:700;letter-spacing:0.15em;margin:16px 0">${code}</p>
	<p>It works once and expires in ${minutes} minutes.</p>
	<p style="color:#525252;font-size:13px">If you did not ask to sign in, you can ignore this — someone typed your address by mistake, and no account was created or changed.</p>
</div>`;

	return { subject, text, html };
}

class ConsoleMailer implements Mailer {
	async sendLoginCode(email: string, code: string): Promise<void> {
		const { subject } = body(code);
		console.log(
			`\n  ┌─ mail (console) ────────────────────────────\n` +
				`  │ to      ${email}\n` +
				`  │ subject ${subject}\n` +
				`  │ code    ${code}\n` +
				`  └─────────────────────────────────────────────\n`
		);
	}
}

class ResendMailer implements Mailer {
	#client: Resend;

	constructor(apiKey: string) {
		this.#client = new Resend(apiKey);
	}

	async sendLoginCode(email: string, code: string): Promise<void> {
		const { subject, text, html } = body(code);
		const result = await this.#client.emails.send({
			from: FROM,
			to: email,
			subject,
			text,
			html
		});

		// Resend reports failures in the payload rather than by throwing, so an
		// unchecked call looks like a success and strands the user on the code
		// form. Turn it into an exception the action can report.
		if (result.error) {
			throw new Error(`Resend refused the message: ${result.error.message}`);
		}
	}
}

let cached: Mailer | undefined;

export function getMailer(): Mailer {
	if (!cached) {
		const key = process.env.RESEND_API_KEY?.trim();
		cached = key ? new ResendMailer(key) : new ConsoleMailer();
		if (!key) {
			console.log('[mail] RESEND_API_KEY is not set — login codes will print to this console.');
		}
	}
	return cached;
}

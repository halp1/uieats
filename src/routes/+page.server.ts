/** The root is always "today on campus", never a landing page. */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { campusToday } from '$lib/server/time';

export const load: PageServerLoad = () => {
	// campusToday(), not the server's date: a UTC host would send everyone to
	// tomorrow's menu from 7pm Central onwards.
	redirect(307, `/d/${campusToday()}`);
};

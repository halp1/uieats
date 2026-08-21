/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The service worker, and the one decision in it that matters.
 *
 * **Pages and data are never cached.** Only the immutable build assets are --
 * the hashed JS, CSS and fonts, plus the icons, whose filenames change whenever
 * their contents do.
 *
 * That is not a shortcut. Caching an HTML response here would mean a menu page,
 * with allergen chips on it, served from a copy taken at some unknown earlier
 * time. Recipes change, suppliers get substituted, labels lag, and a dish can be
 * re-made with a different formulation the same week -- so a cached menu is a
 * set of allergen claims the app can no longer stand behind. Worse in a PWA than
 * in a browser: in standalone display there is no address bar, no reload
 * affordance, nothing to suggest what you are looking at is not live.
 *
 * The whole app is built on making staleness visible -- the footer says how old
 * the data is and warns past 30 hours; the verdict model has `unknown` as a
 * first-class answer. A cache-first service worker would quietly undo all of it.
 *
 * So: offline gets an honest offline page, not yesterday's lunch.
 */
import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE = `uieats-static-${version}`;
const OFFLINE_PAGE = '/offline.html';

/**
 * Everything here is content-addressed or explicitly versioned, so it can be
 * cached indefinitely without ever going stale in a way that matters.
 */
const PRECACHE = [...build, ...files];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			// Take over immediately: the previous worker's cache is keyed by the old
			// version and is about to be deleted anyway.
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	// Build assets and static files: cache-first, because their names change when
	// their contents do.
	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}

	// A page. Network only -- see the note at the top of this file. On failure,
	// the offline page says why there is nothing rather than showing something
	// that might be wrong.
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(async () => {
				const cached = await caches.match(OFFLINE_PAGE);
				return (
					cached ??
					new Response('Offline. uieats does not keep menus on your device.', {
						status: 503,
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					})
				);
			})
		);
		return;
	}

	// Anything else (a form POST response, a data request) goes straight to the
	// network with no interception at all.
});

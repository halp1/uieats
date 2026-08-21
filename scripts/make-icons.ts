#!/usr/bin/env node
/**
 * Renders the app icon to PNG, with no dependencies.
 *
 * The icon is a miniature Nutrition Facts panel, which is the app's whole visual
 * thesis in a 32-pixel box: a heavy title rule over rows of label-left,
 * value-right bars in graduated weights. It is also, conveniently, nothing but
 * axis-aligned rectangles -- so there is no need for an SVG rasterizer, which is
 * just as well because this machine has none. Every pixel is placed here and the
 * output is byte-identical on any machine.
 *
 * PNG is hand-encoded: signature, IHDR, IDAT (zlib, one filter-0 scanline per
 * row), IEND. That is about forty lines and removes a build dependency from a
 * project that has gone to some trouble to avoid native builds.
 *
 *   node scripts/make-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'static');

// ---------------------------------------------------------------------------
// The drawing, in normalised 0..1 coordinates so it scales to any size
// ---------------------------------------------------------------------------

interface Bar {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * The panel: a black field with white bars.
 *
 * Row weights descend the way a real label's do, and each row is split into a
 * long left bar (the nutrient name) and a short right one (its value) -- the
 * left-locked / right-locked structure that the whole app is laid out on. Three
 * rows, not six: at 16px anything finer turns to grey mush.
 */
const BARS: Bar[] = [
	// "Nutrition Facts" wordmark, then the heavy rule under it.
	{ x: 0.16, y: 0.21, w: 0.5, h: 0.075 },
	{ x: 0.16, y: 0.335, w: 0.68, h: 0.075 },

	// Three nutrient rows: name on the left, value locked right.
	{ x: 0.16, y: 0.49, w: 0.34, h: 0.05 },
	{ x: 0.72, y: 0.49, w: 0.12, h: 0.05 },

	{ x: 0.16, y: 0.615, w: 0.26, h: 0.05 },
	{ x: 0.72, y: 0.615, w: 0.12, h: 0.05 },

	{ x: 0.16, y: 0.74, w: 0.3, h: 0.05 },
	{ x: 0.72, y: 0.74, w: 0.12, h: 0.05 }
];

/**
 * Renders to RGBA bytes.
 *
 * `inset` shrinks the drawing toward the centre, leaving the background to fill
 * the rest -- that is how a maskable icon survives Android cropping it to a
 * circle, which eats everything outside the middle 80%.
 */
function render(size: number, inset = 0): Uint8Array {
	const px = new Uint8Array(size * size * 4);

	// Background: black, fully opaque.
	for (let i = 0; i < size * size; i++) {
		px[i * 4 + 3] = 255;
	}

	const scale = 1 - inset * 2;
	for (const bar of BARS) {
		const x0 = Math.round((inset + bar.x * scale) * size);
		const y0 = Math.round((inset + bar.y * scale) * size);
		// At least one pixel: a hairline that rounds to zero would simply vanish
		// at the small sizes, which is where the icon is actually seen.
		const w = Math.max(1, Math.round(bar.w * scale * size));
		const h = Math.max(1, Math.round(bar.h * scale * size));

		for (let y = y0; y < Math.min(size, y0 + h); y++) {
			for (let x = x0; x < Math.min(size, x0 + w); x++) {
				const i = (y * size + x) * 4;
				px[i] = 255;
				px[i + 1] = 255;
				px[i + 2] = 255;
				px[i + 3] = 255;
			}
		}
	}
	return px;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	// 10..12 stay zero: deflate, adaptive filtering, no interlace.

	// One filter byte (0 = none) per scanline.
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		const at = y * (size * 4 + 1);
		raw[at] = 0;
		Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, at + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', new Uint8Array(0))
	]);
}

// ---------------------------------------------------------------------------
// The same drawing as SVG, for the browser tab
// ---------------------------------------------------------------------------

function svg(): string {
	const rects = BARS.map(
		(b) =>
			`<rect x="${(b.x * 100).toFixed(1)}" y="${(b.y * 100).toFixed(1)}" ` +
			`width="${(b.w * 100).toFixed(1)}" height="${(b.h * 100).toFixed(1)}" fill="#fff"/>`
	).join('\n\t');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
	<title>uieats</title>
	<rect width="100" height="100" fill="#000"/>
	${rects}
</svg>
`;
}

// ---------------------------------------------------------------------------

const sizes = [
	{ file: 'icon-192.png', size: 192, inset: 0 },
	{ file: 'icon-512.png', size: 512, inset: 0 },
	// Android crops a maskable icon to whatever shape it likes, keeping only the
	// middle 80%, so the drawing is inset to survive it.
	{ file: 'icon-maskable-512.png', size: 512, inset: 0.1 },
	// iOS does not honour a manifest icon for the home screen, and it composites
	// onto white unless the icon is opaque -- which this one is.
	{ file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
	{ file: 'favicon-32.png', size: 32, inset: 0 }
];

for (const { file, size, inset } of sizes) {
	const png = encodePng(size, render(size, inset));
	writeFileSync(join(OUT, file), png);
	console.log(`  ${file.padEnd(26)} ${size}x${size}  ${png.length.toLocaleString()} bytes`);
}

writeFileSync(join(OUT, 'icon.svg'), svg());
console.log(`  ${'icon.svg'.padEnd(26)} vector`);

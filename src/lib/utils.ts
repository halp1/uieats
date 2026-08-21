/**
 * Helpers the shadcn-svelte components expect to import from `$lib/utils.js`.
 *
 * `cn` comes from tailwind-variants rather than a separate tailwind-merge
 * dependency -- tailwind-variants already carries the merge logic, and the
 * project has a standing rule against dependencies it does not need.
 */
import { cn as merge } from 'tailwind-variants';
import type { Snippet } from 'svelte';

export function cn(...classes: unknown[]): string {
	return merge(classes as never) ?? '';
}

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = Omit<T, 'children'>;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithChildren<T> = T & { children?: Snippet };

/**
 * Typed wrappers over the NetNutrition endpoints. These return RAW response
 * bodies and do no parsing, so transport and interpretation stay separable
 * (and so the fake transport in tests has one obvious seam).
 */
import type { Transport } from './transport/client.ts';

/**
 * NOTE: "SelecUnitAndtMenu" is misspelled UPSTREAM. It is not a typo here, and
 * correcting it produces a 404.
 */
export const SELECT_UNIT_AND_MENU = ['Menu', 'SelecUnitAndtMenu'] as const;

/** Hall -> venues, OR a menu list directly when the unit has no children. */
export function selectUnit(t: Transport, unitOid: number): Promise<string> {
	return t.post('Unit', 'SelectUnitFromUnitsList', { unitOid });
}

/** Venue -> its published menu list. */
export function selectChildUnit(t: Transport, unitOid: number): Promise<string> {
	return t.post('Unit', 'SelectUnitFromChildUnitsList', { unitOid });
}

/**
 * Menu -> its item grid.
 *
 * Passing unitOid alongside menuOid makes this independent of whatever the
 * session last selected, which is what allows menus to be fetched
 * concurrently on a single session.
 */
export function selectMenu(t: Transport, unitOid: number, menuOid: number): Promise<string> {
	return t.post(...SELECT_UNIT_AND_MENU, { unitOid, menuOid });
}

/** Item -> its nutrition label. Returns raw HTML, not a panel envelope. */
export function itemNutritionLabel(
	t: Transport,
	detailOid: number,
	menuOid: number
): Promise<string> {
	return t.post('NutritionDetail', 'ShowItemNutritionLabel', { detailOid, menuOid });
}

/** Venue -> weekly hours. Returns raw HTML, not a panel envelope. */
export function hoursOfOperation(t: Transport, unitOid: number): Promise<string> {
	return t.post('Unit', 'GetHoursOfOperationMarkup', { unitOid });
}

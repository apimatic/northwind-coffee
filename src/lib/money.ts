/**
 * Money is always an integer number of minor units (cents). Never use floats for amounts.
 */
export type Cents = number;

export const DEFAULT_CURRENCY = "USD";

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid money amount: ${value}`);
  }
  return value;
}

export function lineTotal(unitPriceCents: Cents, quantity: number): Cents {
  assertCents(unitPriceCents);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`Invalid quantity: ${quantity}`);
  }
  return assertCents(unitPriceCents * quantity);
}

export function sumCents(amounts: readonly Cents[]): Cents {
  return assertCents(amounts.reduce((total, amount) => total + assertCents(amount), 0));
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats cents for display, e.g. 1950 -> "$19.50". */
export function formatMoney(cents: Cents, currency: string = DEFAULT_CURRENCY): string {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter.format(assertCents(cents) / 100);
}

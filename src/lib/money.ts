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

/** Formats cents as a plain decimal string with two places, e.g. 1950 -> "19.50" (for payment APIs). */
export function centsToDecimal(cents: Cents): string {
  assertCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * Parses a non-negative decimal amount with at most two decimal places ("19.5", "19.50", "$1,019.50")
 * into cents without floating point. Returns null if the text is not a valid amount.
 */
export function parseDecimalToCents(text: string): Cents | null {
  const match = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const whole = Number((match[1] ?? "").replaceAll(",", ""));
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

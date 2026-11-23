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

const DECIMAL_AMOUNT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/**
 * Parses a decimal amount with at most two fraction digits ("12", "12.3", "12.34") into cents, using integer
 * arithmetic only. Returns null for anything else. Used for PayPal amounts and amounts typed into forms.
 */
export function parseDecimalAmount(value: string): Cents | null {
  const match = DECIMAL_AMOUNT.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Formats cents as a decimal amount string for an API, e.g. 1950 -> "19.50". */
export function toDecimalAmount(cents: Cents): string {
  assertCents(cents);
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

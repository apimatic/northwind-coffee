import { describe, expect, it } from "vitest";
import { centsToDecimal, parseDecimalToCents } from "../src/lib/money";

describe("money helpers for payment APIs", () => {
  it("formats cents as a two-place decimal string", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(2250)).toBe("22.50");
    expect(centsToDecimal(123456789)).toBe("1234567.89");
    expect(() => centsToDecimal(1.5)).toThrow(RangeError);
    expect(() => centsToDecimal(-1)).toThrow(RangeError);
  });

  it("parses decimal amounts into cents without floating point", () => {
    expect(parseDecimalToCents("22.50")).toBe(2250);
    expect(parseDecimalToCents("22.5")).toBe(2250);
    expect(parseDecimalToCents("22")).toBe(2200);
    expect(parseDecimalToCents(" $1,019.99 ")).toBe(101999);
    expect(parseDecimalToCents("0.29")).toBe(29);
    expect(parseDecimalToCents("0.07")).toBe(7);
    for (const bad of ["", "abc", "1.234", "-1", "1e3", "1,23", "12.", ".5", "Infinity", "99999999999999999999"]) {
      expect(parseDecimalToCents(bad), bad).toBeNull();
    }
  });
});

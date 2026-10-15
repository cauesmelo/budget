import { describe, expect, it } from 'vitest';
import { formatMoneyAmount, formatNumber, parseLocalizedNumber } from '../src/lib/numbers';

describe('Brazilian numeric formatting', () => {
  it.each([
    [0, '0'], [-0, '0'], [1_000, '1.000'], [1_234_567.89, '1.234.567,89'],
    [-1_234.56, '-1.234,56'], [0.125, '0,125'], [0.00000123, '0,00000123'],
    [1e21, '1.000.000.000.000.000.000.000'], [1.0000000000000002, '1,0000000000000002'],
  ])('formats %s without losing input precision', (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  it('rounds only when a display precision is explicitly requested', () => {
    expect(formatNumber(1_234.5678, 2)).toBe('1.234,57');
    expect(formatNumber(1_234.5, 0)).toBe('1.235');
    expect(formatNumber(0.00000123, 2)).toBe('0');
    expect(formatNumber(-0.00000123, 2)).toBe('0');
  });

  it.each([0, 0.12345678912345678, 5e-324, 1e-20, -1e-20, 1e21, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER])('round-trips the complete decimal display for %s', value => {
    expect(parseLocalizedNumber(formatNumber(value))).toBe(value);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite display values: %s', value => {
    expect(() => formatNumber(value)).toThrow();
  });

  it.each([-1, 1.5, 21, Infinity])('rejects invalid display precision: %s', precision => {
    expect(() => formatNumber(1, precision)).toThrow();
  });
});

describe('exact currency amount formatting', () => {
  it.each([
    [0, '0,00'], [1, '0,01'], [-1, '-0,01'], [100_000, '1.000,00'],
    [123_456_789, '1.234.567,89'], [-123_456_789, '-1.234.567,89'],
    [Number.MAX_SAFE_INTEGER, '90.071.992.547.409,91'],
    [-Number.MAX_SAFE_INTEGER, '-90.071.992.547.409,91'],
  ])('formats %s integer cents exactly', (value, expected) => {
    expect(formatMoneyAmount(value)).toBe(expected);
  });

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cents: %s', value => {
    expect(() => formatMoneyAmount(value)).toThrow();
  });
});

describe('localized numeric input', () => {
  it.each([
    ['1.000', 1_000], ['1.234.567,89', 1_234_567.89], ['1234,567', 1_234.567],
    ['1,234', 1.234], ['-1.234,56', -1_234.56], ['+0,25', 0.25], ['  1.000,00  ', 1_000],
    ['0,00000123', 0.00000123], [',5', 0.5], ['.5', 0.5], ['0.125', 0.125],
    ['0.0001', 0.0001], ['12.34', 12.34], ['1234.567', 1_234.567], ['-0', 0],
  ])('parses %s as %s', (value, expected) => {
    expect(parseLocalizedNumber(value)).toBe(expected);
  });

  it.each(['', ' ', 'NaN', 'Infinity', '1e3', '1 000', '1,234.56', '12.34.567', '1.00.000', '1,23,4', '1.', '1,', 'R$ 1.000,00', '--1', '0x10', '1/2', '9'.repeat(400)])('rejects malformed or nonfinite input: %s', value => {
    expect(() => parseLocalizedNumber(value)).toThrow();
  });
});

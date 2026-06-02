import { describe, expect, it } from 'vitest';
import { formatTracSymbol, formatTrac } from '../src/ui/lib/formatTrac.js';

describe('formatTracSymbol (BUG-013)', () => {
  it('returns "TRAC" for empty/null/undefined symbol', () => {
    expect(formatTracSymbol('', '8453')).toBe('TRAC');
    expect(formatTracSymbol(null, '8453')).toBe('TRAC');
    expect(formatTracSymbol(undefined, '8453')).toBe('TRAC');
  });

  it('appends "(testnet)" qualifier on testnet chain ids when symbol does not already say so', () => {
    expect(formatTracSymbol('v9TRAC', '84532')).toBe('v9TRAC (testnet)');
    expect(formatTracSymbol('TRAC', '11155111')).toBe('TRAC (testnet)');
    expect(formatTracSymbol('xTRAC', '31337')).toBe('xTRAC (testnet)');
  });

  it('does NOT double-qualify when the symbol already announces test status', () => {
    expect(formatTracSymbol('test-TRAC', '84532')).toBe('test-TRAC');
    expect(formatTracSymbol('TestTRAC', '84532')).toBe('TestTRAC');
  });

  it('returns the raw symbol for production chain ids', () => {
    expect(formatTracSymbol('TRAC', '8453')).toBe('TRAC');
    expect(formatTracSymbol('TRAC', '1')).toBe('TRAC');
    expect(formatTracSymbol('TRAC', '100')).toBe('TRAC');
  });

  it('handles compound chain ids ("base:84532")', () => {
    expect(formatTracSymbol('v9TRAC', 'base:84532')).toBe('v9TRAC (testnet)');
    expect(formatTracSymbol('TRAC', 'eth:1')).toBe('TRAC');
  });
});

describe('formatTrac (GH #915 — never render "NaN")', () => {
  it('returns an em-dash for missing/non-numeric balances', () => {
    expect(formatTrac(null)).toBe('—');
    expect(formatTrac(undefined)).toBe('—');
    expect(formatTrac('')).toBe('—');
    expect(formatTrac('not-a-number')).toBe('—');
    expect(formatTrac(NaN)).toBe('—');
  });

  it('never returns the literal string "NaN"', () => {
    for (const v of [null, undefined, '', 'x', NaN, {}, []]) {
      expect(formatTrac(v as unknown)).not.toBe('NaN');
    }
  });

  it('formats numeric balances to 2 decimals (string or number)', () => {
    expect(formatTrac('12.5')).toBe('12.50');
    expect(formatTrac(0)).toBe('0.00');
    expect(formatTrac('0')).toBe('0.00');
    expect(formatTrac(1234.567)).toBe('1234.57');
    expect(formatTrac(42)).toBe('42.00');
  });
});

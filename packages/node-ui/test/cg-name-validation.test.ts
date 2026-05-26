import { describe, expect, it } from 'vitest';
import { CG_NAME_MAX_LENGTH, sanitiseCgName, validateCgName } from '../src/ui/components/Modals/cgNameValidation.js';

describe('cg-name validation (BUG-016)', () => {
  describe('sanitiseCgName', () => {
    it('returns empty for non-string / null / undefined', () => {
      expect(sanitiseCgName(null as unknown as string)).toBe('');
      expect(sanitiseCgName(undefined as unknown as string)).toBe('');
      expect(sanitiseCgName(123 as unknown as string)).toBe('');
    });

    it('strips full HTML tags including paired open/close', () => {
      expect(sanitiseCgName('<script>alert(1)</script>')).toBe('alert(1)');
      expect(sanitiseCgName('<b>Pharma</b>')).toBe('Pharma');
      expect(sanitiseCgName('<img src=x onerror=foo() />')).toBe('');
    });

    it('strips lonely `<` and `>` characters', () => {
      expect(sanitiseCgName('Project >>> Beta')).toBe('Project Beta');
      expect(sanitiseCgName('< not a tag >')).toBe('not a tag');
    });

    it('strips ASCII control characters (0x00-0x1F + 0x7F)', () => {
      expect(sanitiseCgName('a\u0000b\u001Fc\u007Fd')).toBe('abcd');
    });

    it('collapses internal whitespace and trims edges', () => {
      expect(sanitiseCgName('  Pharma   Drug   Interactions  ')).toBe('Pharma Drug Interactions');
      expect(sanitiseCgName('\n\tnewlines\n\tand\ttabs\n\t')).toBe('newlines and tabs');
    });

    it(`enforces ${CG_NAME_MAX_LENGTH}-char hard cap`, () => {
      const long = 'A'.repeat(CG_NAME_MAX_LENGTH + 50);
      const out = sanitiseCgName(long);
      expect(out.length).toBe(CG_NAME_MAX_LENGTH);
    });

    it('keeps unicode and emoji intact (multi-byte must survive)', () => {
      expect(sanitiseCgName('Pharma 🧪')).toBe('Pharma 🧪');
      expect(sanitiseCgName('日本語プロジェクト')).toBe('日本語プロジェクト');
    });

    it('idempotent — sanitising a clean string is a no-op', () => {
      const clean = 'Pharma Drug Interactions';
      expect(sanitiseCgName(sanitiseCgName(clean))).toBe(clean);
    });
  });

  describe('validateCgName', () => {
    it('rejects empty / whitespace-only / control-only input', () => {
      expect(validateCgName('')).not.toBeNull();
      expect(validateCgName('   ')).not.toBeNull();
      expect(validateCgName('\u0000\u001F')).not.toBeNull();
    });

    it('flags pasted HTML even though sanitise would scrub it (so the user sees the warning)', () => {
      expect(validateCgName('<script>alert(1)</script>')).toContain('HTML');
      expect(validateCgName('<b>safe</b>')).toContain('HTML');
    });

    it('flags overlong input but tells the user the trim length', () => {
      const long = 'A'.repeat(CG_NAME_MAX_LENGTH + 1);
      expect(validateCgName(long)).toMatch(/trimmed.*characters/i);
    });

    it('accepts a normal short name', () => {
      expect(validateCgName('Pharma Drug Interactions')).toBeNull();
      expect(validateCgName('日本語プロジェクト')).toBeNull();
    });

    it('does NOT flag a name that uses normal ASCII punctuation', () => {
      expect(validateCgName('Project: alpha & beta (v2)')).toBeNull();
    });
  });
});

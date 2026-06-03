import { describe, it, expect } from 'vitest';
import { procNetLocalPortHex } from '../src/daemon/oxigraph-listen-port.js';

describe('procNetLocalPortHex', () => {
  it('formats ports for /proc/net/tcp matching', () => {
    expect(procNetLocalPortHex(7878)).toBe('C61E');
    expect(procNetLocalPortHex(8080)).toBe('901F');
  });
});

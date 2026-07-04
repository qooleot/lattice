import { describe, it, expect } from 'vitest';
import { doctor, findJava } from '../../src/solvers/doctor.js';

describe('doctor', () => {
  it('finds a JDK >= 17', () => {
    const java = findJava();
    expect(java).toMatch(/java$/);
  });
  it('reports toolchain status', async () => {
    const r = await doctor();
    expect(r.java.ok).toBe(true);
    expect(r.alloyJar).toBe(true);
    expect(r.quint).toBe(true);
  });
});

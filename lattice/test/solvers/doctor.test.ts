import { describe, it, expect } from 'vitest';
import { doctor, findJava, parseJavaMajor } from '../../src/solvers/doctor.js';

describe('parseJavaMajor', () => {
  it('parses java version "1.8.0_131" (old scheme) as 8', () => {
    const banner = 'java version "1.8.0_131"';
    expect(parseJavaMajor(banner)).toBe(8);
  });
  it('parses openjdk version "21.0.11" (9+ scheme) as 21', () => {
    const banner = 'openjdk version "21.0.11" 2024-04-16';
    expect(parseJavaMajor(banner)).toBe(21);
  });
  it('returns 0 for unparseable banners', () => {
    const banner = 'gibberish';
    expect(parseJavaMajor(banner)).toBe(0);
  });
});

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

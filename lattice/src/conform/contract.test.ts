import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderContract } from './contract.js';
import { loadGenInput } from '../generate/load.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('renderContract', () => {
  const src = renderContract(loadGenInput(join(repoRoot, '.lattice-session-subscriptions')).model);

  it('emits per-aggregate spec-state interfaces with region unions and ref fields as nullable string', () => {
    expect(src).toContain('export interface SubscriptionSpecState');
    expect(src).toContain(`status: 'trialing' | 'active' | 'pastDue' | 'canceled' | 'expired';`);
    expect(src).toContain(`settlement: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';`);
    expect(src).toContain('latestInvoice: string | null;');
    expect(src).toContain('amountPaid: number;');
  });

  it('emits the typed override surface', () => {
    expect(src).toContain('export interface SpecOverrides');
    expect(src).toContain('export function defineOverrides(o: SpecOverrides): SpecOverrides { return o }');
    expect(src).not.toContain('import '); // self-contained
  });
});

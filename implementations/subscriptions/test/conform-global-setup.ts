import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.conform', 'snapshots'),
    { recursive: true, force: true });
}

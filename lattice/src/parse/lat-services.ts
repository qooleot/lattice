import { createDefaultCoreModule, createDefaultSharedCoreModule, inject, EmptyFileSystem } from 'langium';
import type { LangiumCoreServices, LangiumSharedCoreServices } from 'langium';
import { LatGeneratedModule, LatGeneratedSharedModule } from './generated/module.js';

// Parse-only services: no LSP, no linking — the grammar has no cross-references (spec P2/P7).
export function createLatServices(): LangiumCoreServices {
  const shared: LangiumSharedCoreServices = inject(
    createDefaultSharedCoreModule(EmptyFileSystem), LatGeneratedSharedModule);
  const lat = inject(createDefaultCoreModule({ shared }), LatGeneratedModule);
  shared.ServiceRegistry.register(lat);
  return lat;
}

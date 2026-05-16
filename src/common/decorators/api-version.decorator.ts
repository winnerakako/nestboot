import { applyDecorators, Controller, SetMetadata } from '@nestjs/common';

export const API_VERSION_KEY = 'apiVersion';

/**
 * Versioned controller decorator.
 * Prefixes the controller route with the version.
 *
 * Usage:
 *   @VersionedController('v1', 'users')  → /api/v1/users
 *   @VersionedController('v2', 'users')  → /api/v2/users
 *
 * Both can coexist in the same app.
 */
export function VersionedController(version: string, path = '') {
  const fullPath = path ? `${version}/${path}` : version;
  return applyDecorators(
    SetMetadata(API_VERSION_KEY, version),
    Controller(fullPath),
  );
}

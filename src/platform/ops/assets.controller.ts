import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { RawResponse } from '../http/envelope.interceptor.js';
import { OpsGuard } from './ops.guard.js';

const require = createRequire(import.meta.url);

/**
 * The console's two static files, read once and served from memory.
 *
 * Serving them from the app rather than a CDN is what lets /ops keep a strict
 * `default-src 'self'` policy — and it means the console still works during the
 * incident where outbound network is exactly what is broken.
 */
const HTMX = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
const CSS = readFileSync(join(import.meta.dirname, 'view', 'ops.css'), 'utf8');

@UseGuards(OpsGuard)
@Controller()
export class OpsAssetsController {
  @Get('assets/htmx.min.js')
  @RawResponse()
  @Header('content-type', 'application/javascript; charset=utf-8')
  // Pinned by package version, so the content at this URL only changes on a
  // deploy that changed the dependency.
  @Header('cache-control', 'public, max-age=86400')
  htmx(): string {
    return HTMX;
  }

  @Get('assets/ops.css')
  @RawResponse()
  @Header('content-type', 'text/css; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  css(): string {
    return CSS;
  }
}

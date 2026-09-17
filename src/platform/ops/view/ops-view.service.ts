import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { ConfigService } from '../../config/index.js';
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from '../ops-query.js';
import { registerHelpers } from './helpers.js';

const TEMPLATE_DIR = join(import.meta.dirname, 'templates');

export interface Tab {
  key: string;
  label: string;
  href: string;
  active?: boolean;
  badge?: string | number;
}

export interface PageContext {
  title: string;
  /** Rendered in a banner. Set it whenever the page could not read something. */
  degraded?: string;
  window?: WindowKey;
  currentPath?: string;
  /** Query parameters the time-window form must preserve. */
  carry?: Record<string, unknown>;
  [key: string]: unknown;
}

const TABS: Array<Omit<Tab, 'href'> & { path: string }> = [
  { key: 'workflows', label: 'Workflows', path: '/workflows' },
  { key: 'queues', label: 'Queues', path: '/queues' },
  { key: 'schedules', label: 'Schedules', path: '/schedules' },
  { key: 'logs', label: 'Logs', path: '/logs' },
  { key: 'errors', label: 'Errors', path: '/errors' },
  { key: 'requests', label: 'Requests', path: '/requests' },
  { key: 'health', label: 'Health', path: '/health' },
  { key: 'security', label: 'Security', path: '/security' },
];

/**
 * Renders a tab body into the shell.
 *
 * Handlebars is driven directly rather than through a Nest view engine: the
 * console is the only thing in the app that renders HTML, and one 60-line
 * service is less machinery than wiring an engine adapter — and far easier to
 * assert against in a test, which just reads the returned string.
 */
@Injectable()
export class OpsView {
  private readonly handlebars = Handlebars.create();
  private readonly cache = new Map<string, HandlebarsTemplateDelegate>();
  private readonly layout: HandlebarsTemplateDelegate;
  private readonly bare: HandlebarsTemplateDelegate;
  private readonly bootedAt = new Date();

  constructor(private readonly config: ConfigService) {
    registerHelpers(this.handlebars);
    this.registerPartials();
    this.layout = this.compile('layout');
    this.bare = this.compile('layout-bare');
  }

  private registerPartials(): void {
    for (const name of ['pager', 'searchbar', 'rail', 'empty']) {
      this.handlebars.registerPartial(name, this.source(join('partials', name)));
    }
  }

  private source(name: string): string {
    return readFileSync(join(TEMPLATE_DIR, `${name}.hbs`), 'utf8');
  }

  private compile(name: string): HandlebarsTemplateDelegate {
    const cached = this.cache.get(name);
    if (cached) return cached;

    // Compiled once and kept: in development a restart is fast enough, and a
    // stat() per render on every row of an eight-tab console is not free.
    const template = this.handlebars.compile(this.source(name), { strict: false });
    this.cache.set(name, template);
    return template;
  }

  render(template: string, context: PageContext, activeTab: string): string {
    const opsPath = this.config.get('OPS_PATH');
    const body = this.compile(template)({ ...context, opsPath });

    // The sign-in page gets no nav and no time picker: every link in them leads
    // somewhere this visitor is not allowed, and rendering them would leak the
    // shape of the console to someone who has not authenticated.
    if (activeTab === 'login') {
      return this.bare({
        ...context,
        body,
        opsPath,
        appName: this.config.get('APP_NAME'),
        version: this.config.get('GIT_SHA'),
      });
    }

    return this.layout({
      ...context,
      body,
      opsPath,
      appName: this.config.get('APP_NAME'),
      version: this.config.get('GIT_SHA'),
      role: this.config.get('ROLE'),
      healthy: !context.degraded,
      window: context.window ?? DEFAULT_WINDOW,
      windows: Object.keys(WINDOWS),
      currentPath: context.currentPath ?? `${opsPath}/${activeTab}`,
      carry: Object.entries(context.carry ?? {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => ({ key, value })),
      tabs: TABS.map((tab) => ({
        key: tab.key,
        label: tab.label,
        href: `${opsPath}${tab.path}`,
        active: tab.key === activeTab,
      })),
      renderedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      uptimeSeconds: Math.floor((Date.now() - this.bootedAt.getTime()) / 1000),
    });
  }
}

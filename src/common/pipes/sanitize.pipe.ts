import { ArgumentMetadata, PipeTransform, Injectable } from '@nestjs/common';

/**
 * Globally sanitizes all incoming string values:
 * - Trims whitespace
 * - Strips HTML tags (basic XSS prevention)
 * - Removes null bytes
 *
 * Apply globally in main.ts:
 *   app.useGlobalPipes(new SanitizePipe());
 */
@Injectable()
export class SanitizePipe implements PipeTransform {
  transform(value: any, metadata?: ArgumentMetadata) {
    if (metadata?.type === 'custom') {
      return value;
    }

    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }

    if (this.isPlainObject(value) || Array.isArray(value)) {
      return this.sanitizeObject(value);
    }

    return value;
  }

  private sanitizeString(value: string): string {
    return value
      .trim()
      .replace(/\0/g, '') // null bytes
      .replace(/<[^>]*>/g, '') // HTML tags
      .replace(/javascript:/gi, '') // javascript: protocol
      .replace(/on\w+\s*=/gi, ''); // inline event handlers
  }

  private sanitizeObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.transform(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = this.transform(value);
    }
    return sanitized;
  }

  private isPlainObject(value: any): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (Buffer.isBuffer(value)) return false;

    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
}

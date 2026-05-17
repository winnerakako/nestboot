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
    let result = value.trim().replace(/\0/g, ''); // null bytes

    // Multi-pass HTML stripping to handle nested payloads like <scr<script>ipt>
    let previous: string;
    do {
      previous = result;
      result = result
        .replace(/<[a-zA-Z/!][^>]*>/g, '') // closed HTML tags (starts with letter, / or ! — won't match "< 100 >")
        .replace(/<[a-zA-Z/][^>]*$/g, '') // unclosed HTML tags (e.g. <img src=x onerror=...) — won't match "price < 100"
        .replace(/javascript\s*:/gi, '') // javascript: protocol (with optional whitespace)
        .replace(/on\w+\s*=/gi, ''); // inline event handlers
    } while (result !== previous);

    return result;
  }

  private sanitizeObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.transform(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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

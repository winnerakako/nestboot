import { PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
export class ParseIntOrDefaultPipe implements PipeTransform {
  constructor(private readonly defaultValue: number = 0) {}

  transform(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? value : this.defaultValue;
    }

    if (typeof value !== 'string') {
      return this.defaultValue;
    }

    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) {
      return this.defaultValue;
    }

    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : this.defaultValue;
  }
}

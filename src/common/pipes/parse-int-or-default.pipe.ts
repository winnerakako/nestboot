import { PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
export class ParseIntOrDefaultPipe implements PipeTransform {
  constructor(private readonly defaultValue: number = 0) {}

  transform(value: any): number {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? this.defaultValue : parsed;
  }
}

import { ParseIntOrDefaultPipe } from './parse-int-or-default.pipe';

describe('ParseIntOrDefaultPipe', () => {
  it('parses complete integer values', () => {
    const pipe = new ParseIntOrDefaultPipe(10);

    expect(pipe.transform('42')).toBe(42);
    expect(pipe.transform('-2')).toBe(-2);
    expect(pipe.transform(7)).toBe(7);
  });

  it('falls back for partial, decimal, empty, and unsafe values', () => {
    const pipe = new ParseIntOrDefaultPipe(10);

    expect(pipe.transform('42abc')).toBe(10);
    expect(pipe.transform('1.5')).toBe(10);
    expect(pipe.transform('')).toBe(10);
    expect(pipe.transform(Number.MAX_SAFE_INTEGER + 1)).toBe(10);
  });
});

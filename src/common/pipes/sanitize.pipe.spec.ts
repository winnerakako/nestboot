import { SanitizePipe } from './sanitize.pipe';

describe('SanitizePipe', () => {
  it('sanitizes body strings recursively', () => {
    const pipe = new SanitizePipe();

    expect(
      pipe.transform(
        { name: '  <b>Ada</b>  ', nested: { url: 'javascript:alert(1)' } },
        { type: 'body', metatype: undefined },
      ),
    ).toEqual({ name: 'Ada', nested: { url: 'alert(1)' } });
  });

  it('does not rewrite custom route params like uploaded files', () => {
    const pipe = new SanitizePipe();
    const file = {
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 5,
      buffer: Buffer.from('hello'),
    };

    const result = pipe.transform(file, {
      type: 'custom',
      metatype: undefined,
    });

    expect(result).toBe(file);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
  });
});

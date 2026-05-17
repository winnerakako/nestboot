import { redact } from './log-redaction.service';

describe('log redaction', () => {
  it('redacts financial account identifiers before logging', () => {
    const result = redact({
      accountNumber: '1234567890',
      bankAccount: '0123456789',
      routing_number: '111000025',
      cardNumber: '4111111111111111',
      safe: 'visible',
    });

    expect(result).toEqual({
      accountNumber: '[REDACTED]',
      bankAccount: '[REDACTED]',
      routing_number: '[REDACTED]',
      cardNumber: '[REDACTED]',
      safe: 'visible',
    });
  });
});

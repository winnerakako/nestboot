import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  it('rejects email transports without registered providers', () => {
    const { error } = envValidationSchema.validate(
      { EMAIL_TRANSPORT: 'sendgrid' },
      { allowUnknown: true, abortEarly: false },
    );

    expect(error?.message).toContain('EMAIL_TRANSPORT');
  });
});

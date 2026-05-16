import { randomInt, randomUUID } from 'crypto';

export function generateId(): string {
  return randomUUID();
}

export function generateCode(length = 6): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(randomInt(chars.length));
  }
  return result;
}

export function generateOtp(length = 6): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += randomInt(10).toString();
  }
  return result;
}

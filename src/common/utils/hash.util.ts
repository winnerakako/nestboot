import * as bcrypt from 'bcrypt';

export async function hashPassword(
  password: string,
  rounds = 12,
): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export async function comparePassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

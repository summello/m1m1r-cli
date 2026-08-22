// macOS Keychain secret store (PLAN §4.1). Secrets never touch dotfiles or
// logs. Values are returned to callers only; this module never prints them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const KEYCHAIN_SERVICE = 'm1m1r';

export class KeychainError extends Error {
  constructor(
    public account: string,
    public code: string,
  ) {
    super(`keychain lookup failed for ${account} (exit ${code})`);
    this.name = 'KeychainError';
  }
}

export async function secretSet(account: string, value: string): Promise<void> {
  // -U updates if the item exists.
  await exec('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', value]);
}

export async function secretGet(account: string): Promise<string> {
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
    ]);
    return stdout.trim();
  } catch (e: unknown) {
    throw new KeychainError(account, String((e as { code?: string }).code ?? 'unknown'));
  }
}

export async function secretDelete(account: string): Promise<void> {
  await exec('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
}

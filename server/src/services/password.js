import crypto from 'node:crypto';
import { promisify } from 'node:util';
import config from '../config/index.js';

// Password hashing with scrypt (Node's built-in, memory-hard KDF; no native
// add-on to build). Hashes describe their own parameters,
//   scrypt$<log2 N>$<r>$<p>$<salt>$<hash>      (salt and hash in base64url)
// so the cost can be raised later: older hashes still verify, and are
// re-hashed with the current cost at the next successful sign-in.
//
// Default cost: N = 2^17, r = 8, p = 1 (128 MiB, the OWASP recommendation).
// PASSWORD_HASH_COST sets log2 N (the tests use a much cheaper 12).

const scrypt = promisify(crypto.scrypt);
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const HASH_PATTERN = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

// scrypt needs 128 * N * r bytes; Node refuses more than `maxmem` (32 MiB by
// default), so allow exactly what the parameters need, plus some headroom.
function derive(password, salt, { cost, blockSize, parallelism }) {
  const N = 2 ** cost;
  return scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: blockSize,
    p: parallelism,
    maxmem: 128 * N * blockSize * 2,
  });
}

export async function hashPassword(password, cost = config.auth.passwordHashCost) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, { cost, blockSize: BLOCK_SIZE, parallelism: PARALLELISM });
  return ['scrypt', cost, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parseHash(stored) {
  const match = typeof stored === 'string' ? HASH_PATTERN.exec(stored) : null;
  if (!match) return null;
  const [, cost, blockSize, parallelism, salt, key] = match;
  return {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism),
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
}

// A real hash of a random password, verified against when an account does
// not exist (or has no password), so a failed sign-in takes as long whether
// or not the email is registered.
let dummyHash = null;
async function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(18).toString('base64url'));
  return dummyHash;
}

// true only when `password` matches `stored`. A missing or unreadable hash
// never matches, after the same amount of work as a real check.
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored) ?? parseHash(await getDummyHash());
  const key = await derive(password, parsed.salt, parsed);
  const matches = key.length === parsed.key.length && crypto.timingSafeEqual(key, parsed.key);
  return matches && parseHash(stored) !== null;
}

// The hash was made with weaker parameters than the current ones.
export function needsRehash(stored, cost = config.auth.passwordHashCost) {
  const parsed = parseHash(stored);
  return !parsed || parsed.cost < cost || parsed.blockSize < BLOCK_SIZE || parsed.parallelism < PARALLELISM;
}

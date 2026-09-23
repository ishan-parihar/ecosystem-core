import { describe, expect, it, vi } from 'vitest';

import { MemoryCache } from '../cache/index.js';
import {
	createCacheLockoutStore,
	Lockout,
	LOCKOUT_POLICIES,
	lockoutKey,
	resolveLockoutPolicy,
	type LockoutRecord,
	type LockoutStore,
} from './lockout.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const POLICY = { maxAttempts: 3, windowMs: 60_000, lockoutMs: 120_000 };

function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

function memoryLockout(clockish = clock()) {
	const store = createCacheLockoutStore(new MemoryCache({ logger: silent }));
	return { lockout: new Lockout({ store, policy: POLICY, now: clockish.now, logger: silent }), clock: clockish };
}

describe('Lockout', () => {
	it('allows attempts below the threshold and reports what is left', async () => {
		const { lockout } = memoryLockout();
		expect(await lockout.check('k')).toMatchObject({ locked: false, attempts: 0, remainingAttempts: 3 });

		const first = await lockout.recordFailure('k');
		expect(first).toMatchObject({ locked: false, attempts: 1, remainingAttempts: 2 });

		const second = await lockout.recordFailure('k');
		expect(second).toMatchObject({ locked: false, attempts: 2, remainingAttempts: 1 });
	});

	it('locks on the attempt that reaches the threshold', async () => {
		const { lockout } = memoryLockout();
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');
		const third = await lockout.recordFailure('k');
		expect(third).toMatchObject({ locked: true, remainingAttempts: 0 });
		expect(third.retryAfterSec).toBe(120);
		expect(await lockout.check('k')).toMatchObject({ locked: true });
	});

	it('refuses for the full lockout duration and then forgets the count', async () => {
		const { lockout, clock: c } = memoryLockout();
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');

		c.advance(119_000);
		expect((await lockout.check('k')).locked).toBe(true);

		c.advance(2_000);
		// Elapsed lock clears the record rather than leaving it one failure from
		// another lock, which would make a single mistake cascade.
		expect(await lockout.check('k')).toMatchObject({ locked: false, attempts: 0, remainingAttempts: 3 });
	});

	it('does not extend an active lock on further attempts', async () => {
		// Extending on every attempt would let an attacker hold a legitimate user
		// out indefinitely, turning a defence into a denial-of-service tool.
		const { lockout, clock: c } = memoryLockout();
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');
		const locked = await lockout.recordFailure('k');
		const originalExpiry = locked.lockedUntilMs;

		c.advance(30_000);
		const again = await lockout.recordFailure('k');
		expect(again.lockedUntilMs).toBe(originalExpiry);
		expect(again.retryAfterSec).toBe(90);
	});

	it('treats a failure after the window as a fresh start', async () => {
		const { lockout, clock: c } = memoryLockout();
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');
		c.advance(61_000);
		// Someone who gives up for an hour should not return one attempt from a lock.
		expect(await lockout.recordFailure('k')).toMatchObject({ attempts: 1, locked: false });
	});

	it('clears the record on success', async () => {
		const { lockout } = memoryLockout();
		await lockout.recordFailure('k');
		await lockout.recordFailure('k');
		await lockout.recordSuccess('k');
		expect(await lockout.check('k')).toMatchObject({ attempts: 0, remainingAttempts: 3 });
	});

	it('keeps keys independent', async () => {
		const { lockout } = memoryLockout();
		await lockout.recordFailure('a');
		await lockout.recordFailure('a');
		await lockout.recordFailure('a');
		expect((await lockout.check('a')).locked).toBe(true);
		expect((await lockout.check('b')).locked).toBe(false);
	});
});

describe('Lockout failure handling', () => {
	it('fails open when the store cannot be read, and says so', async () => {
		// A storage blip must not lock every user out of the surface at once.
		const warn = vi.fn();
		const store: LockoutStore = {
			read: async () => {
				throw new Error('store down');
			},
			write: async () => undefined,
			clear: async () => undefined,
		};
		const lockout = new Lockout({ store, policy: POLICY, logger: { ...silent, warn } });

		expect(await lockout.check('k')).toMatchObject({ locked: false });
		expect(await lockout.recordFailure('k')).toMatchObject({ locked: false });
		expect(warn).toHaveBeenCalled();
	});

	it('does not throw when the store cannot be written', async () => {
		const store: LockoutStore = {
			read: async () => null,
			write: async () => {
				throw new Error('store down');
			},
			clear: async () => undefined,
		};
		const lockout = new Lockout({ store, policy: POLICY, logger: silent });
		await expect(lockout.recordFailure('k')).resolves.toMatchObject({ attempts: 1 });
	});

	it('does not throw when the clear fails', async () => {
		const store: LockoutStore = {
			read: async () => null,
			write: async () => undefined,
			clear: async () => {
				throw new Error('store down');
			},
		};
		const lockout = new Lockout({ store, policy: POLICY, logger: silent });
		await expect(lockout.recordSuccess('k')).resolves.toBeUndefined();
	});
});

describe('policies', () => {
	it('preserves the hub defaults so adoption does not change behaviour', () => {
		expect(LOCKOUT_POLICIES.authPassword).toEqual({
			maxAttempts: 5,
			windowMs: 15 * 60 * 1000,
			lockoutMs: 15 * 60 * 1000,
		});
	});

	it('resolves by name and applies overrides', () => {
		expect(resolveLockoutPolicy('authPassword')).toEqual(LOCKOUT_POLICIES.authPassword);
		expect(resolveLockoutPolicy('authPassword', { maxAttempts: 9 }).maxAttempts).toBe(9);
	});

	it('accepts a policy name or an object', async () => {
		const store = createCacheLockoutStore(new MemoryCache({ logger: silent }));
		const byName = new Lockout({ store, policy: 'authEmail', logger: silent });
		expect((await byName.recordFailure('k')).remainingAttempts).toBe(2);
	});
});

describe('lockoutKey', () => {
	it('normalises case and whitespace on the subject', () => {
		expect(lockoutKey('auth', '  User@Example.COM ')).toBe('auth:user@example.com');
	});

	it('includes the ip when there is one, so one address cannot lock a whole organisation', () => {
		expect(lockoutKey('auth', 'a@b.co', '1.2.3.4')).toBe('auth:a@b.co:1.2.3.4');
	});

	it('omits the ip entirely rather than interpolating "undefined"', () => {
		// `auth:a@b.co:undefined` would pool every anonymous attempt into one key.
		expect(lockoutKey('auth', 'a@b.co', null)).toBe('auth:a@b.co');
		expect(lockoutKey('auth', 'a@b.co')).toBe('auth:a@b.co');
	});
});

describe('createCacheLockoutStore', () => {
	it('round-trips a record through a cache store', async () => {
		const cache = new MemoryCache({ logger: silent });
		const store = createCacheLockoutStore(cache, 'lo:');
		const record: LockoutRecord = { attempts: 2, firstAttemptAtMs: 1, lastAttemptAtMs: 2, lockedUntilMs: null };
		await store.write('k', record, 60);
		expect(await store.read('k')).toEqual(record);
		await store.clear('k');
		expect(await store.read('k')).toBeNull();
	});

	it('namespaces its keys so lockouts cannot collide with cached values', async () => {
		const cache = new MemoryCache({ logger: silent });
		await createCacheLockoutStore(cache, 'lockout:').write(
			'k',
			{ attempts: 1, firstAttemptAtMs: 0, lastAttemptAtMs: 0, lockedUntilMs: null },
			60,
		);
		expect(await cache.get('lockout:k')).not.toBeNull();
		expect(await cache.get('k')).toBeNull();
	});
});

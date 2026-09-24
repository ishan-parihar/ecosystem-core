import { describe, expect, it, vi } from 'vitest';

import {
	createSessionService,
	hasPermission,
	hasPremiumAccess,
	isAdmin,
	resolveRole,
	type ProfileLike,
	type SessionUser,
} from './index.js';

const USER: SessionUser = { id: 'user_1', email: 'someone@example.com' };

/** Ports with sensible defaults, overridden per test. */
function ports(overrides: Partial<Parameters<typeof createSessionService>[0]> = {}) {
	return {
		loadUser: vi.fn(async () => USER),
		loadProfile: vi.fn(async (): Promise<ProfileLike | null> => ({ id: 'user_1', is_admin: false, tier: 'free' })),
		...overrides,
	};
}

describe('resolveRole', () => {
	it('lets admin outrank tier, and falls back to user', () => {
		expect(resolveRole({ is_admin: true, tier: 'free' })).toBe('admin');
		expect(resolveRole({ is_admin: false, tier: 'sovereign' })).toBe('sovereign');
		expect(resolveRole({ is_admin: false, tier: 'free' })).toBe('free');
		expect(resolveRole({ is_admin: false, role: 'editor' })).toBe('editor');
		expect(resolveRole({})).toBe('user');
		expect(resolveRole(null)).toBe('user');
		// Whitespace-only values are not a role - the hub's `.env` values
		// arrive quoted and trimmed, and a stray space must not read as a tier.
		expect(resolveRole({ tier: '   ' })).toBe('user');
	});
});

describe('access predicates', () => {
	it('treats only the premium tiers as premium', () => {
		expect(hasPremiumAccess({ tier: 'sovereign' })).toBe(true);
		expect(hasPremiumAccess({ is_admin: true, tier: 'free' })).toBe(true);
		expect(hasPremiumAccess({ tier: 'free' })).toBe(false);
		expect(hasPremiumAccess(null)).toBe(false);
	});

	it('honours a caller-supplied premium tier set', () => {
		expect(hasPremiumAccess({ tier: 'pro' }, { premiumTiers: ['pro'] })).toBe(true);
		expect(hasPremiumAccess({ tier: 'sovereign' }, { premiumTiers: ['pro'] })).toBe(false);
	});

	it('reads permissions as an array or as a flag record', () => {
		expect(hasPermission({ permissions: ['publish'] }, 'publish')).toBe(true);
		expect(hasPermission({ permissions: ['publish'] }, 'refund')).toBe(false);
		expect(hasPermission({ permissions: { refund: true } }, 'refund')).toBe(true);
		expect(hasPermission({ permissions: { refund: false } }, 'refund')).toBe(false);
		expect(hasPermission({ is_admin: true }, 'anything')).toBe(true);
		expect(isAdmin({ is_admin: true })).toBe(true);
	});
});

describe('createSessionService', () => {
	it('returns null when there is no user, without loading a profile', async () => {
		const p = ports({ loadUser: vi.fn(async () => null) });
		expect(await createSessionService(p).getSession()).toBeNull();
		expect(p.loadProfile).not.toHaveBeenCalled();
	});

	it('resolves role, admin and premium flags from the profile', async () => {
		const p = ports({
			loadProfile: vi.fn(async () => ({ id: 'user_1', is_admin: false, tier: 'sovereign' })),
		});

		const session = await createSessionService(p).getSession();
		expect(session).toMatchObject({ role: 'sovereign', isAdmin: false, isPremium: true });
		expect(session?.user).toBe(USER);
	});

	it('enriches a slim profile before answering access questions', async () => {
		// The hub's hook caches exactly this shape: no `is_admin`, no `tier`.
		const slim = { id: 'user_1', email: 'someone@example.com', role: 'user', tier_rank: 3 };
		const enrichProfile = vi.fn(async () => ({ ...slim, is_admin: true, tier: 'sovereign' }));
		const p = ports({ loadProfile: vi.fn(async () => slim), enrichProfile });

		const session = await createSessionService(p).requireAdmin();
		expect(enrichProfile).toHaveBeenCalledWith(slim, USER);
		expect(session?.role).toBe('admin');
	});

	it('does not enrich a profile that already carries is_admin', async () => {
		const enrichProfile = vi.fn(async () => ({ is_admin: true }));
		const p = ports({ enrichProfile });

		await createSessionService(p).requirePremium();
		expect(enrichProfile).not.toHaveBeenCalled();
	});

	it('degrades to the slim profile when enrichment fails', async () => {
		const slim = { id: 'user_1', email: 'someone@example.com' };
		const warnings: string[] = [];
		const p = ports({
			loadProfile: vi.fn(async () => slim),
			enrichProfile: vi.fn(async () => {
				throw new Error('supabase down');
			}),
			logger: {
				info: () => undefined,
				warn: (message) => warnings.push(message),
				error: () => undefined,
			},
		});

		// A failed enrichment is a missing privilege, not a failed request.
		const session = await createSessionService(p).getSession();
		expect(session).not.toBeNull();
		expect(session?.isAdmin).toBe(false);
		expect(warnings.join(' ')).toContain('enrichment failed');
	});

	it('guards by role and by permission', async () => {
		const p = ports({
			loadProfile: vi.fn(async () => ({ id: 'user_1', is_admin: false, tier: 'free', permissions: ['publish'] })),
		});
		const service = createSessionService(p);

		expect(await service.requireUser()).not.toBeNull();
		expect(await service.requireAdmin()).toBeNull();
		expect(await service.requirePremium()).toBeNull();
		expect(await service.requirePermission('publish')).not.toBeNull();
		expect(await service.requirePermission('refund')).toBeNull();
	});

	it('never throws when a port fails - it returns null and logs', async () => {
		const errors: string[] = [];
		const p = ports({
			loadUser: vi.fn(async () => {
				throw new Error('auth service unreachable');
			}),
			logger: {
				info: () => undefined,
				warn: () => undefined,
				error: (message) => errors.push(message),
			},
		});

		expect(await createSessionService(p).getSession()).toBeNull();
		expect(errors.join(' ')).toContain('session loading failed');
	});
});

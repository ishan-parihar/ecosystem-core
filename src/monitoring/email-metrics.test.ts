import { describe, expect, it } from 'vitest';

import {
	shouldPauseSending,
	summarizeByLane,
	summarizeDelivery,
	type EmailSample,
} from './email-metrics.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const MINUTE = 60_000;

function samples(spec: Array<Partial<EmailSample> & { success: boolean; minutesAgo: number }>): EmailSample[] {
	return spec.map((entry) => ({
		at: NOW - entry.minutesAgo * MINUTE,
		success: entry.success,
		...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
		...(entry.lane === undefined ? {} : { lane: entry.lane }),
		...(entry.error === undefined ? {} : { error: entry.error }),
	}));
}

describe('summarizeDelivery', () => {
	it('counts sends and failures, and reports the rate', () => {
		const summary = summarizeDelivery(
			samples([
				{ success: true, minutesAgo: 5 },
				{ success: true, minutesAgo: 10 },
				{ success: true, minutesAgo: 15 },
				{ success: false, minutesAgo: 20 },
			]),
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary).toMatchObject({ total: 4, sent: 3, failed: 1, successRate: 75 });
	});

	it('excludes samples outside the window', () => {
		const summary = summarizeDelivery(
			samples([
				{ success: true, minutesAgo: 5 },
				{ success: false, minutesAgo: 200 },
			]),
			{ nowMs: NOW, windowMinutes: 60, thresholds: { minSamples: 1 } },
		);
		expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0 });
	});

	it('accepts ISO timestamps as well as epoch milliseconds', () => {
		const summary = summarizeDelivery(
			[
				{ at: new Date(NOW - MINUTE).toISOString(), success: true },
				{ at: NOW - 2 * MINUTE, success: true },
			],
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary.total).toBe(2);
	});

	it('skips an unparseable timestamp rather than corrupting the rate', () => {
		// Counting a sample whose time is unknown would distort the rate, and a
		// wrong rate is worse than a smaller sample.
		const summary = summarizeDelivery(
			[
				{ at: 'not a date', success: false },
				{ at: NOW - MINUTE, success: true },
			],
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary).toMatchObject({ total: 1, sent: 1, failed: 0, successRate: 100 });
	});

	it('averages only the durations that were measured', () => {
		const summary = summarizeDelivery(
			samples([
				{ success: true, minutesAgo: 5, durationMs: 100 },
				{ success: true, minutesAgo: 6, durationMs: 300 },
				{ success: true, minutesAgo: 7 },
			]),
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary.averageDurationMs).toBe(200);
	});

	it('reports null duration when nothing was measured', () => {
		const summary = summarizeDelivery(samples([{ success: true, minutesAgo: 5 }]), { nowMs: NOW });
		expect(summary.averageDurationMs).toBeNull();
	});

	it('reports the most recent failure reason', () => {
		const summary = summarizeDelivery(
			samples([
				{ success: false, minutesAgo: 30, error: 'old failure' },
				{ success: false, minutesAgo: 5, error: 'latest failure' },
			]),
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary.lastError).toBe('latest failure');
	});

	it('reports first and last sample times', () => {
		const summary = summarizeDelivery(
			samples([
				{ success: true, minutesAgo: 30 },
				{ success: true, minutesAgo: 5 },
			]),
			{ nowMs: NOW, thresholds: { minSamples: 1 } },
		);
		expect(summary.firstSampleAt).toBe(new Date(NOW - 30 * MINUTE).toISOString());
		expect(summary.lastSampleAt).toBe(new Date(NOW - 5 * MINUTE).toISOString());
	});
});

describe('thresholds', () => {
	it('raises an error below the error floor', () => {
		const summary = summarizeDelivery(
			[...Array(6)].map((_, i) => ({ at: NOW - i * MINUTE, success: false })).concat(
				[...Array(4)].map((_, i) => ({ at: NOW - (i + 10) * MINUTE, success: true })),
			),
			{ nowMs: NOW, thresholds: { minSamples: 5 } },
		);
		expect(summary.successRate).toBe(40);
		expect(summary.alerts).toEqual([
			expect.objectContaining({ level: 'error', message: expect.stringContaining('below the 90% floor') }),
		]);
		expect(shouldPauseSending(summary)).toBe(true);
	});

	it('raises a warning between the floors', () => {
		const summary = summarizeDelivery(
			[...Array(2)].map((_, i) => ({ at: NOW - i * MINUTE, success: false })).concat(
				[...Array(18)].map((_, i) => ({ at: NOW - (i + 10) * MINUTE, success: true })),
			),
			{ nowMs: NOW, thresholds: { minSamples: 5 } },
		);
		expect(summary.successRate).toBe(90);
		expect(summary.alerts).toEqual([expect.objectContaining({ level: 'warning' })]);
		expect(shouldPauseSending(summary)).toBe(false);
	});

	it('stays quiet when delivery is healthy', () => {
		const summary = summarizeDelivery(
			samples(Array.from({ length: 20 }, (_, i) => ({ success: true, minutesAgo: i }))),
			{ nowMs: NOW },
		);
		expect(summary.successRate).toBe(100);
		expect(summary.alerts).toEqual([]);
	});

	it('suppresses a verdict when there is too little data', () => {
		// Alerting on three samples produces noise, and a noisy monitor gets muted.
		const summary = summarizeDelivery(samples([{ success: false, minutesAgo: 5 }]), {
			nowMs: NOW,
			thresholds: { minSamples: 10 },
		});
		expect(summary.insufficientData).toBe(true);
		expect(summary.alerts).toEqual([]);
	});

	it('alerts on silence only when asked to', () => {
		const quiet = summarizeDelivery([], { nowMs: NOW, thresholds: { minSamples: 10 } });
		expect(quiet.alerts).toEqual([]);

		const watching = summarizeDelivery([], {
			nowMs: NOW,
			thresholds: { minSamples: 10, alertOnSilence: true },
		});
		// Warning, not error: a quiet window is normal on a low-traffic surface.
		expect(watching.alerts).toEqual([expect.objectContaining({ level: 'warning' })]);
	});
});

describe('summarizeByLane', () => {
	it('keeps the lanes separate, so a healthy campaign cannot mask a broken transaction lane', () => {
		// This is the reason the lane axis exists. Averaged together, six
		// transactional failures vanish inside forty campaign successes, and the
		// alert never fires for the outage that actually blocks people.
		const mixed: EmailSample[] = [
			...Array.from({ length: 6 }, (_, i) => ({ at: NOW - i * MINUTE, success: false, lane: 'transactional' as const })),
			...Array.from({ length: 40 }, (_, i) => ({ at: NOW - i * MINUTE, success: true, lane: 'campaign' as const })),
		];

		const breakdown = summarizeByLane(mixed, { nowMs: NOW, thresholds: { minSamples: 5 } });

		expect(breakdown.lanes.transactional.successRate).toBe(0);
		expect(breakdown.lanes.transactional.alerts[0]?.level).toBe('error');
		expect(breakdown.lanes.campaign.successRate).toBe(100);
		expect(breakdown.lanes.campaign.alerts).toEqual([]);
		// The blended figure looks fine, which is precisely the trap.
		expect(breakdown.overall.successRate).toBeGreaterThan(85);
	});

	it('filters to one lane directly', () => {
		const mixed: EmailSample[] = [
			{ at: NOW - MINUTE, success: false, lane: 'transactional' },
			{ at: NOW - MINUTE, success: true, lane: 'campaign' },
		];
		expect(summarizeDelivery(mixed, { nowMs: NOW, lane: 'campaign', thresholds: { minSamples: 1 } }).successRate).toBe(100);
		expect(summarizeDelivery(mixed, { nowMs: NOW, lane: 'transactional', thresholds: { minSamples: 1 } }).successRate).toBe(0);
	});
});

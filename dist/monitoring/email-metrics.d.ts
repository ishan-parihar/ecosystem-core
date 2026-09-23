/**
 * Delivery metrics: a pure function over injected samples.
 *
 * ## Why not the hub's monitor
 *
 * `lib/server/monitoring/email-health.ts` does this job today, and the shape is
 * wrong for a Worker in four separate ways:
 *
 * 1. It is a **module-level singleton** constructed on import, which contradicts
 *    the injection contract and makes the first request's configuration
 *    permanent.
 * 2. It calls **`setInterval`** to run health checks every five minutes. A
 *    Worker isolate has no durable lifecycle and may be evicted at any moment,
 *    so the interval is not a schedule, it is a coin flip on every cold start.
 * 3. It registers **`process.on('SIGTERM')`/`SIGINT`**, which requires
 *    `nodejs_compat` and means the module cannot load at all without it.
 * 4. It holds metrics in an **array on the instance**, so the numbers vanish
 *    with the isolate and two concurrent isolates disagree about the truth.
 *
 * None of that is fixable by renaming things, because the problem is the shape.
 * A metric is data; the right primitive is a function that takes samples and
 * returns a verdict. The caller decides where the samples live and when to ask.
 *
 * That makes this testable without a clock, usable from a cron route, a
 * scheduled Worker handler, or a CMS tool, and identical in behaviour whether it
 * runs in a Worker or in Node.
 *
 * The alerting thresholds are preserved from the hub so a surface switching over
 * does not change when it starts complaining: warn below 95%, error below 90%,
 * and no verdict at all until there is enough signal to justify one.
 */
export type EmailLane = 'transactional' | 'campaign';
/** One send outcome. ISO string or epoch milliseconds; both are accepted. */
export interface EmailSample {
    /** When the send was attempted. */
    at: string | number;
    success: boolean;
    /** Round-trip time, when measured. */
    durationMs?: number;
    /** The lane, when the caller distinguishes them. */
    lane?: EmailLane;
    /** Failure reason, for the samples that are counted as failures. */
    error?: string;
}
export interface DeliveryThresholds {
    /** Success rate below this raises a warning. Default 95. */
    warningSuccessRate: number;
    /** Success rate below this raises an error. Default 90. */
    errorSuccessRate: number;
    /** Minimum samples in the window before any verdict is offered. Default 10. */
    minSamples: number;
    /**
     * Alert when the window is silent while mail is expected.
     *
     * A monitor that only reacts to failures misses the worst outage, which is
     * one where nothing arrives at all.
     */
    alertOnSilence: boolean;
}
export type DeliveryAlertLevel = 'warning' | 'error';
export interface DeliveryAlert {
    level: DeliveryAlertLevel;
    message: string;
}
export interface DeliverySummary {
    windowMinutes: number;
    total: number;
    sent: number;
    failed: number;
    /** Percentage, rounded to two decimals. `0` when there were no samples. */
    successRate: number;
    /** Mean duration in milliseconds over samples that recorded one. `null` when none did. */
    averageDurationMs: number | null;
    firstSampleAt: string | null;
    lastSampleAt: string | null;
    /** The most recent failure reason, which is usually the actionable one. */
    lastError: string | null;
    alerts: DeliveryAlert[];
    /** True when there were too few samples for the thresholds to mean anything. */
    insufficientData: boolean;
}
export declare const DEFAULT_THRESHOLDS: DeliveryThresholds;
export interface SummarizeOptions {
    /** Window length in minutes. Default 60, matching the hub's health check. */
    windowMinutes?: number;
    /** Injectable clock in milliseconds. */
    nowMs?: number;
    thresholds?: Partial<DeliveryThresholds>;
    /** Restrict to one lane. */
    lane?: EmailLane;
}
/**
 * Summarise delivery over a window.
 *
 * Pure: no clock read unless one is injected, no storage, no logging. Samples
 * with an unparseable timestamp are skipped rather than counted, because
 * including them would corrupt the rate, and a corrupted rate is worse than a
 * smaller sample.
 */
export declare function summarizeDelivery(samples: EmailSample[], options?: SummarizeOptions): DeliverySummary;
export interface LaneBreakdown {
    windowMinutes: number;
    lanes: Record<EmailLane, DeliverySummary>;
    /** The combination of both lanes, for a single headline number. */
    overall: DeliverySummary;
}
/**
 * Summarise each lane separately and together.
 *
 * Separate matters because the two lanes fail for different reasons and have
 * different acceptable rates: a transactional failure is a person who cannot
 * confirm an address or receive a receipt, while a campaign failure is a
 * marketing send that can be retried later without anyone being blocked.
 * Averaging them hides a transactional outage behind a healthy campaign volume.
 */
export declare function summarizeByLane(samples: EmailSample[], options?: SummarizeOptions): LaneBreakdown;
/**
 * Build a `Retry-After`-style decision from a summary.
 *
 * Exists so a scheduled job does not have to re-derive "should I back off" from
 * the alert array, which is presentation-shaped.
 */
export declare function shouldPauseSending(summary: DeliverySummary): boolean;
//# sourceMappingURL=email-metrics.d.ts.map
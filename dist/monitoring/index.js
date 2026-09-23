/**
 * Monitoring.
 *
 * Pure aggregators over samples the caller supplies. Nothing here holds state,
 * schedules work, or registers a process handler, because a Worker isolate can
 * be evicted at any moment and has no durable lifecycle to hold any of that.
 */
export { DEFAULT_THRESHOLDS, shouldPauseSending, summarizeByLane, summarizeDelivery, } from './email-metrics.js';
//# sourceMappingURL=index.js.map
/**
 * The injected logger.
 *
 * The package never imports a logging library and never imports the consuming
 * application's logger module. Every module that needs to report something
 * takes a `Logger` as an argument, so the same code runs in a Cloudflare
 * Worker, in Vitest, and in a script without a single environment variable.
 *
 * `silentLogger` is the default. A library that logs by default is a library
 * that hijacks its consumer's log volume, so silence is opt-in the other way
 * round: the application passes its own logger when it wants output.
 */
export interface Logger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}
/** A logger that discards everything. */
export declare const silentLogger: Logger;
/**
 * Choose the logger to use for a call.
 *
 * Written once so every module resolves its logger identically, and so a
 * caller that passes `logger: undefined` explicitly gets the silent default
 * rather than a crash.
 */
export declare function resolveLogger(logger?: Logger): Logger;
//# sourceMappingURL=logger.d.ts.map
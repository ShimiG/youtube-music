// What the Worker is given by Cloudflare: the D1 database and its secrets.
export interface Env {
    DB: D1Database;
    /** Signs the session tokens. Required: set with `wrangler secret put JWT_SECRET`. */
    JWT_SECRET?: string;
    /** Whoever knows this code may create an account. Unset: sign-up is closed. */
    REGISTRATION_CODE?: string;
    /** Optional extra secret mixed into the stored login hashes. */
    AUTH_PEPPER?: string;
}

/** What is known about the caller once its session token has been checked. */
export interface Variables {
    userId: number;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

/** An error the client is told about: HTTP status, a stable code, a sentence. */
export class ApiError extends Error {
    constructor(
        readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 423 | 429 | 500 | 503,
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

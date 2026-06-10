export interface Options {
  http: {
    apiUrl: string;
    userAgentAppendix: string;
    retries: number;
    version: string;
    /**
     * The maximum amount of time (in milliseconds) to wait for a response
     * before aborting the request. A timed out request is retried like any
     * other transient network error (see {@link Options.http.retries}).
     *
     * Set to `0` to disable the timeout entirely (not recommended, as a
     * stalled connection will then hang forever).
     */
    timeout: number;
  };
  auth: {
    accessToken?: string;
  };
}

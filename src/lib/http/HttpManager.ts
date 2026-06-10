import 'isomorphic-unfetch';
import { fromBuffer } from 'file-type/browser';
import { DefaultUserAgent } from '../../util/constants';
import { Options } from '../../interfaces/Options';
import {
  ResponseLike,
  InternalRequest,
  RequestMethod,
  RouteLike,
  RequestData
} from '../../interfaces/Request';
import { HTTPError } from '../errors/HttpError';
import { StatsFMAPIError, StatsFMErrorData } from '../errors/StatsFMAPIError';
import sleep from '../../util/sleep';

export class HttpManager {
  accessToken?: string;

  constructor(public options: Required<Options>) {
    this.accessToken = options.auth.accessToken;
  }

  setToken(token?: string): void {
    this.accessToken = token;
  }

  /**
   * @param {InternalRequest} request
   * @returns {Promise<ResponseLike>} Returns a promise with the {@link ResponseLike response}.
   */
  private async queueRequest(request: InternalRequest): Promise<ResponseLike> {
    const { url, fetchOptions } = await this.resolveRequest(request);
    return await this.runRequest(url, fetchOptions, request);
  }

  resolveUrl(route: RouteLike, versioned?: boolean, query?: string): string {
    return `${this.options.http.apiUrl}${
      versioned === false ? '' : `/v${this.options.http.version}`
    }${route}${query ? `?${query}` : ''}`;
  }

  private async getFiles(files: InternalRequest['files']): Promise<FormData> {
    const formData = new FormData();

    // Attach all files to the request
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (Buffer.isBuffer(file.data)) {
        let finalContentType = file.contentType;
        if (!finalContentType) {
          // eslint-disable-next-line no-await-in-loop
          const parsedFileType = (await fromBuffer(file.data))?.mime;
          if (parsedFileType) {
            finalContentType = parsedFileType;
          }
        }
        formData.append(
          file.key,
          new Blob([file.data], { type: finalContentType ?? 'application/octet-stream' }),
          file.name
        );
      } else {
        formData.append(
          file.key,
          new Blob([`${file.data}`], { type: file.contentType }),
          file.name
        );
      }
    }
    return formData;
  }

  private async resolveRequest(request: InternalRequest): Promise<{
    url: string;
    fetchOptions: RequestInit;
  }> {
    let query = '';

    if (request.query) {
      const resolvedQuery = new URLSearchParams(
        Object.fromEntries(
          Object.entries(request.query).map(([key, value]) => [key, value.toString()])
        )
      ).toString();
      if (resolvedQuery !== '') {
        query = resolvedQuery;
      }
    }

    const headers = {
      'User-Agent': `${DefaultUserAgent} ${this.options.http.userAgentAppendix}`.trim()
    } as Record<string, string>;

    if (request.authRequired === true && !this.accessToken) {
      throw new Error('Expected access token to be set for this request, but none was found.');
    }

    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const url = this.resolveUrl(request.fullRoute, request.versioned, query);

    let finalBody: RequestInit['body'];
    let additionalHeaders: Record<string, string> = {};

    if (request.files?.length) {
      finalBody = await this.getFiles(request.files);
    } else if (request.body != null) {
      if (request.passThroughBody) {
        finalBody = request.body;
      } else {
        finalBody = request.body;
        additionalHeaders = {
          'Content-Type': 'application/json'
        };
      }
    }

    const method = request.method.toUpperCase();

    return {
      url,
      fetchOptions: {
        body: ['GET', 'HEAD'].includes(method) ? undefined : finalBody,
        headers: { ...request.headers, ...headers, ...additionalHeaders },
        method
      }
    };
  }

  private async runRequest(
    url: string,
    options: RequestInit,
    requestData: InternalRequest,
    retries = 0
  ): Promise<ResponseLike> {
    const method = options.method || RequestMethod.Get;

    const res = await this.makeRequest(url, options, retries);

    if (res === null) {
      await sleep(this.getRetryDelay(retries));
      return await this.runRequest(url, options, requestData, ++retries);
    }

    const { status } = res;

    if (status >= 200 && status < 300) {
      return res;
    }
    const handledError = await this.handleErrors(res, method, url, requestData, retries);
    if (handledError === null) {
      await sleep(this.getRetryDelay(retries));
      return await this.runRequest(url, options, requestData, ++retries);
    }
    return handledError;
  }

  /**
   * Exponential backoff (capped at 5s) used between retries so we don't
   * immediately hammer an endpoint that is already struggling.
   *
   * @param {number} retries - The number of retries already attempted.
   */
  private getRetryDelay(retries: number): number {
    return Math.min(2 ** retries * 500, 5000);
  }

  private async makeRequest(
    url: string,
    options: RequestInit,
    retries: number
  ): Promise<ResponseLike | null> {
    const { timeout } = this.options.http;

    // Abort the request if it takes too long. Without this a stalled
    // connection (e.g. a server that accepts the socket but never responds)
    // would leave the returned promise pending forever.
    const controller = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined;

    let res: ResponseLike;
    try {
      res = await fetch(url, { ...options, signal: controller.signal });
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;

      const timedOut = controller.signal.aborted || error.name === 'AbortError';
      const connectionReset =
        ('code' in error && error.code === 'ECONNRESET') || error.message.includes('ECONNRESET');

      if ((timedOut || connectionReset) && retries !== this.options.http.retries) {
        return null;
      }

      if (timedOut) {
        throw new Error(`Request to ${url} timed out after ${timeout}ms`);
      }

      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    return {
      body: res.body,
      arrayBuffer(): Promise<ArrayBuffer> {
        return res.arrayBuffer();
      },
      json(): Promise<any> {
        return res.json();
      },
      text(): Promise<string> {
        return res.text();
      },
      bodyUsed: res.bodyUsed,
      headers: res.headers,
      status: res.status,
      ok: res.ok
    };
  }

  private async handleErrors(
    res: ResponseLike,
    method: string,
    url: string,
    requestData: InternalRequest,
    retries: number
  ): Promise<ResponseLike> {
    const { status } = res;
    if (status >= 500 && status < 600) {
      if (retries < this.options.http.retries) {
        return null;
      }

      throw new HTTPError(status, method, url, requestData);
    } else {
      if (status >= 400 && status < 500) {
        if (status === 401 && requestData.authRequired) {
          this.setToken(null);
        }

        throw new StatsFMAPIError(
          (await this.parseResponse(res)) as StatsFMErrorData,
          status,
          method,
          url,
          requestData
        );
      }
      return res;
    }
  }

  /**
   * Runs a GET request from the api
   *
   * @param {string} fullRoute - The full route to query
   * @param {RequestData?} options - Optional request options
   */
  public get<T>(fullRoute: RouteLike, options: RequestData = {}): Promise<T> {
    return this.request({ ...options, fullRoute, method: RequestMethod.Get });
  }

  /**
   * Runs a DELETE request from the api
   *
   * @param {string} fullRoute - The full route to query
   * @param {RequestData?} options - Optional request options
   */
  public delete<T>(fullRoute: RouteLike, options: RequestData = {}): Promise<T> {
    return this.request({ ...options, fullRoute, method: RequestMethod.Delete });
  }

  /**
   * Runs a POST request from the api
   *
   * @param {string} fullRoute - The full route to query
   * @param {RequestData?} options - Optional request options
   */
  public post<T>(fullRoute: RouteLike, options: RequestData = {}): Promise<T> {
    return this.request({ ...options, fullRoute, method: RequestMethod.Post });
  }

  /**
   * Runs a PUT request from the api
   *
   * @param {string} fullRoute - The full route to query
   * @param {RequestData?} options - Optional request options
   */
  public put<T>(fullRoute: RouteLike, options: RequestData = {}): Promise<T> {
    return this.request({ ...options, fullRoute, method: RequestMethod.Put });
  }

  /**
   * Runs a PATCH request from the api
   *
   * @param {string} fullRoute - The full route to query
   * @param {RequestData?} options - Optional request options
   */
  public patch<T>(fullRoute: RouteLike, options: RequestData = {}): Promise<T> {
    return this.request({ ...options, fullRoute, method: RequestMethod.Patch });
  }

  /**
   * Runs a request from the api
   *
   * @param {InternalRequest} options - Request options
   */
  public async request<T>(options: InternalRequest): Promise<T> {
    const res = await this.raw(options);
    return await this.parseResponse<T>(res);
  }

  public async parseResponse<T>(res: ResponseLike): Promise<T> {
    const contentType = res.headers.get('content-type');
    if (contentType?.startsWith('application/json')) {
      return await res.json();
    }
    if (contentType?.startsWith('text/html')) {
      return res.text() as T;
    }
    if (contentType?.startsWith('image')) {
      return (await res.arrayBuffer()) as T;
    }
    return (await res.text()) as T;
  }

  /**
   * Runs a request from the API, yielding the raw Response object
   *
   * @param {InternalRequest} options - Request options
   */
  public raw(options: InternalRequest): Promise<ResponseLike> {
    return this.queueRequest(options);
  }
}

import type { ApiError } from "../types";

export class HttpError extends Error {
	readonly status: number;
	readonly body: unknown;
	readonly apiError: ApiError | null;

	constructor(status: number, body: unknown, apiError: ApiError | null) {
		const summary =
			apiError?.error_description ?? apiError?.error ?? `HTTP ${status}`;
		super(summary);
		this.name = "HttpError";
		this.status = status;
		this.body = body;
		this.apiError = apiError;
	}
}

function isApiError(value: unknown): value is ApiError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { error?: unknown }).error === "string"
	);
}

export interface JsonRequestOptions {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	bearer?: string;
	signal?: AbortSignal;
}

export interface HttpClient {
	request<T>(opts: JsonRequestOptions): Promise<T>;
}

export class FetchHttpClient implements HttpClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async request<T>(opts: JsonRequestOptions): Promise<T> {
		const url = `${this.baseUrl}${opts.path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (opts.bearer) {
			headers.Authorization = `Bearer ${opts.bearer}`;
		}
		const res = await fetch(url, {
			method: opts.method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: opts.signal,
		});
		const text = await res.text();
		const parsed: unknown = text.length === 0 ? null : safeParse(text);
		if (!res.ok) {
			throw new HttpError(res.status, parsed, isApiError(parsed) ? parsed : null);
		}
		return parsed as T;
	}
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

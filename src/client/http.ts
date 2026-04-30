import { requestUrl } from "obsidian";
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
}

export interface HttpClient {
	request<T>(opts: JsonRequestOptions): Promise<T>;
}

// Uses Obsidian's `requestUrl` (Electron net on desktop, native on mobile)
// instead of `fetch`. Per the plugin guidelines, this avoids CORS preflight
// and is the documented way to make network requests from a plugin.
export class FetchHttpClient implements HttpClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async request<T>(opts: JsonRequestOptions): Promise<T> {
		const url = `${this.baseUrl}${opts.path}`;
		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		if (opts.body !== undefined) headers["Content-Type"] = "application/json";
		if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

		const res = await requestUrl({
			url,
			method: opts.method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			throw: false,
		});
		const text = res.text;
		const parsed: unknown = text.length === 0 ? null : safeParse(text);
		if (res.status < 200 || res.status >= 300) {
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

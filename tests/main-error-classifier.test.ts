import { describe, expect, it } from "vitest";
import { classifyErrorForUser } from "../src/main";
import { HttpError } from "../src/client/http";

describe("classifyErrorForUser", () => {
	it("maps HTTP 401 to 'sign in again'", () => {
		const err = new HttpError(401, null, { error: "unauthorized" });
		expect(classifyErrorForUser(err)).toContain("sign in again");
	});

	it("maps invalid_token apiError to 'sign in again'", () => {
		const err = new HttpError(400, null, { error: "invalid_token" });
		expect(classifyErrorForUser(err)).toContain("sign in again");
	});

	it("maps refresh_token_reused apiError to 'sign in again'", () => {
		const err = new HttpError(400, null, { error: "refresh_token_reused" });
		expect(classifyErrorForUser(err)).toContain("sign in again");
	});

	it("maps invalid_grant apiError to 'sign in again'", () => {
		const err = new HttpError(400, null, { error: "invalid_grant" });
		expect(classifyErrorForUser(err)).toContain("sign in again");
	});

	it("maps HTTP 5xx to 'server error'", () => {
		const err = new HttpError(503, null, { error: "service_unavailable" });
		expect(classifyErrorForUser(err)).toContain("server error");
	});

	it("maps fetch TypeError to 'server unreachable'", () => {
		const err = new TypeError("Failed to fetch");
		expect(classifyErrorForUser(err)).toContain("unreachable");
	});

	it("falls back to generic message for unknown errors", () => {
		expect(classifyErrorForUser(new Error("kaboom"))).toMatch(
			/Huma sync failed.*kaboom/,
		);
	});
});

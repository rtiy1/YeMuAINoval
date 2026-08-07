import assert from "node:assert/strict";
import test from "node:test";
import { refreshCookieOptions, requestUsesHttps } from "./auth-cookie.mjs";

test("refresh cookie auto mode follows the actual request protocol", () => {
	assert.equal(requestUsesHttps({ secure: false, protocol: "http" }), false);
	assert.equal(requestUsesHttps({ secure: true, protocol: "https" }), true);
	assert.equal(refreshCookieOptions({ secure: false, protocol: "http" }, { env: {} }).secure, false);
	assert.equal(refreshCookieOptions({ secure: true, protocol: "https" }, { env: {} }).secure, true);
});

test("refresh cookie secure mode can be explicitly overridden", () => {
	assert.equal(refreshCookieOptions({ secure: false }, { env: { REFRESH_COOKIE_SECURE: "true" } }).secure, true);
	assert.equal(refreshCookieOptions({ secure: true }, { env: { REFRESH_COOKIE_SECURE: "false" } }).secure, false);
});

test("SameSite=None is kept only when the refresh cookie is secure", () => {
	const insecure = refreshCookieOptions(
		{ secure: false, protocol: "http" },
		{ env: { REFRESH_COOKIE_SAME_SITE: "none" }, maxAge: 1234 },
	);
	assert.deepEqual(insecure, {
		httpOnly: true,
		sameSite: "lax",
		secure: false,
		path: "/api/auth",
		maxAge: 1234,
	});
	const secure = refreshCookieOptions(
		{ secure: true, protocol: "https" },
		{ env: { REFRESH_COOKIE_SAME_SITE: "none" } },
	);
	assert.equal(secure.sameSite, "none");
	assert.equal(secure.secure, true);
});

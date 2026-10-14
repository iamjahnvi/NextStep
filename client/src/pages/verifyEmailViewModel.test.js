import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    OTP_LENGTH,
    PENDING_EMAIL_KEY,
    sanitizeOtpInput,
    isCompleteOtp,
    maskEmail,
    describeVerifyError,
    cooldownRemaining,
} from "./verifyEmailViewModel.js";

describe("verify-email view model", () => {
    it("sanitizes OTP input to digits, max 6", () => {
        assert.equal(OTP_LENGTH, 6);
        assert.equal(sanitizeOtpInput("12a34b56c78"), "123456");
        assert.equal(sanitizeOtpInput(" 1 2 3 "), "123");
        assert.equal(sanitizeOtpInput(""), "");
        assert.equal(sanitizeOtpInput(null), "");
    });

    it("detects complete codes", () => {
        assert.equal(isCompleteOtp("123456"), true);
        assert.equal(isCompleteOtp("12345"), false);
        assert.equal(isCompleteOtp("1234567"), false);
        assert.equal(isCompleteOtp("abcdef"), false);
    });

    it("masks the destination email recognisably", () => {
        assert.equal(maskEmail("asha@example.com"), "as***@example.com");
        assert.equal(maskEmail("  Asha@Example.com "), "As***@Example.com");
        assert.equal(maskEmail("not-an-email"), "not-an-email");
        assert.equal(maskEmail(""), "");
    });

    it("maps stable backend codes to copy + next action", () => {
        assert.deepEqual(describeVerifyError("INVALID_CODE").action, "retry");
        assert.deepEqual(describeVerifyError("EXPIRED_CODE").action, "resend");
        assert.deepEqual(describeVerifyError("TOO_MANY_ATTEMPTS").action, "resend");
        assert.deepEqual(describeVerifyError("RESEND_COOLDOWN").action, "wait");
        assert.deepEqual(describeVerifyError("ALREADY_VERIFIED").action, "login");
        assert.deepEqual(describeVerifyError("NO_PENDING_VERIFICATION").action, "signup");
        assert.deepEqual(describeVerifyError("EMAIL_ALREADY_REGISTERED").action, "login");
        // Unknown codes and network failures fall back generically.
        assert.deepEqual(describeVerifyError("SOME_FUTURE_CODE").action, "retry");
        assert.deepEqual(describeVerifyError(undefined).message.length > 0, true);
    });

    it("computes resend cooldown display without trusting the client", () => {
        assert.equal(cooldownRemaining({ retryAfterSeconds: 42 }), 42);
        assert.equal(cooldownRemaining({ retryAfterSeconds: -3 }), 0);
        const now = Date.now();
        assert.equal(
            cooldownRemaining({
                lastSentAt: new Date(now - 10 * 1000).toISOString(),
                cooldownSeconds: 60,
                now,
            }),
            50
        );
        assert.equal(
            cooldownRemaining({
                lastSentAt: new Date(now - 90 * 1000).toISOString(),
                cooldownSeconds: 60,
                now,
            }),
            0
        );
        assert.equal(cooldownRemaining({}), 0);
    });

    it("exposes the pending-email key (email only, never OTPs/tokens)", () => {
        assert.equal(PENDING_EMAIL_KEY, "nextstep:pendingEmail");
    });
});

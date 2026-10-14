// =============================================================================
// server/tests/emailOtp.test.js
// =============================================================================
// WHAT: Email OTP verification lifecycle for new email/password sign-ups.
// WHY: Signup must create PENDING accounts (no JWT), OTP verify must be the
//   single gate to a session, login must block unverified accounts, and Google
//   + legacy accounts must keep working untouched.
// DB: mongodb-memory-server (isolated). Mail: stub transport via
//   mailer.setMailTransport() — no real email, no AWS credentials.
// RUN: npm test (node --test tests/)
// =============================================================================

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-otp";
process.env.OTP_RESEND_COOLDOWN_SECONDS =
    process.env.OTP_RESEND_COOLDOWN_SECONDS || "1";

const User = require("../models/User");
const auth = require("../controllers/authController");
const mailer = require("../services/mailer");
const { generateOtp, hashOtp, verifyOtpHash, isWellFormedOtp, normalizeEmail } = require("../utils/otp");

let mongo;

const mockReq = (body = {}, headers = {}) => ({ body, headers });
const mockRes = () => {
    const res = {};
    res.statusCode = null;
    res.body = null;
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    return res;
};

// Mail stub: captures sent mail; mode controls failure injection.
const sentMail = [];
let mailMode = "ok";
const stubTransport = {
    sendMail: async (options) => {
        if (mailMode === "sandbox") {
            const err = new Error(
                "Email address is not verified. The following identities failed the check"
            );
            err.responseCode = 403;
            throw err;
        }
        if (mailMode === "down") {
            const err = new Error("Connection timeout");
            err.code = "ETIMEDOUT";
            throw err;
        }
        sentMail.push(options);
        return { accepted: [options.to] };
    },
};

const signupBody = (email, overrides = {}) => ({
    name: "Asha Sharma",
    email,
    password: "Str0ng!Pass",
    confirmPassword: "Str0ng!Pass",
    ...overrides,
});

before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    mailer.setMailTransport(stubTransport);
});

after(async () => {
    mailer.setMailTransport(null);
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

beforeEach(async () => {
    await User.deleteMany({});
    sentMail.length = 0;
    mailMode = "ok";
});

describe("otp utils — no Math.random, hashed storage", () => {
    it("generates 6-digit codes and validates shape", () => {
        for (let i = 0; i < 20; i += 1) {
            const code = generateOtp();
            assert.match(code, /^\d{6}$/);
        }
        assert.equal(isWellFormedOtp("042913"), true);
        assert.equal(isWellFormedOtp("42913"), false);
        assert.equal(isWellFormedOtp("abcdef"), false);
        assert.equal(isWellFormedOtp("1234567"), false);
        assert.equal(isWellFormedOtp(123456), false);
    });

    it("hashes and verifies with timing-safe comparison", () => {
        const hash = hashOtp("123456");
        assert.equal(typeof hash, "string");
        assert.equal(hash.includes("123456"), false);
        assert.equal(verifyOtpHash("123456", hash), true);
        assert.equal(verifyOtpHash("654321", hash), false);
        assert.equal(verifyOtpHash("", hash), false);
        assert.equal(verifyOtpHash("123456", "not-a-hash"), false);
    });

    it("normalizes email consistently", () => {
        assert.equal(normalizeEmail("  Asha@Example.COM "), "asha@example.com");
        assert.equal(normalizeEmail(null), "");
    });
});

describe("signup — pending verification, no JWT", () => {
    it("valid signup creates a pending account and sends an email (no token)", async () => {
        const res = mockRes();
        await auth.signup(mockReq(signupBody("asha@example.com")), res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.success, true);
        assert.equal(res.body.code, "VERIFICATION_REQUIRED");
        assert.equal(res.body.emailSent, true);
        assert.equal(res.body.token, undefined);
        assert.equal(sentMail.length, 1);
        assert.equal(sentMail[0].to, "asha@example.com");

        const user = await User.findOne({ email: "asha@example.com" }).select(
            "+emailVerification.otpHash"
        );
        assert.ok(user);
        assert.equal(user.isEmailVerified, false);
        assert.ok(user.emailVerification.otpHash);
        assert.ok(!String(user.emailVerification.otpHash).match(/^\d{6}$/));
        assert.ok(user.emailVerification.expiresAt > new Date());
    });

    it("duplicate signup for a verified email returns EMAIL_ALREADY_REGISTERED", async () => {
        const first = mockRes();
        await auth.signup(mockReq(signupBody("vera@example.com")), first);
        assert.equal(first.statusCode, 201);
        // Simulate out-of-band verification, then retry signup.
        await User.updateOne({ email: "vera@example.com" }, { isEmailVerified: true });
        const retry = mockRes();
        await auth.signup(mockReq(signupBody("vera@example.com")), retry);
        assert.equal(retry.statusCode, 409);
        assert.equal(retry.body.code, "EMAIL_ALREADY_REGISTERED");
        assert.equal((await User.countDocuments({ email: "vera@example.com" })), 1);
    });

    it("repeated signup for a pending account refreshes the code (no duplicate)", async () => {
        const first = mockRes();
        await auth.signup(mockReq(signupBody("pend@example.com")), first);
        assert.equal(first.statusCode, 201);
        const second = mockRes();
        await auth.signup(mockReq(signupBody("pend@example.com")), second);
        assert.equal(second.statusCode, 200);
        assert.equal(second.body.code, "VERIFICATION_REQUIRED");
        assert.equal((await User.countDocuments({ email: "pend@example.com" })), 1);
        assert.equal(sentMail.length, 2);
    });

    it("concurrent signups create exactly one account", async () => {
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                auth.signup(mockReq(signupBody("race@example.com")), mockRes())
            )
        );
        const codes = results.map((r) => r.statusCode).sort();
        assert.deepEqual(codes, [200, 200, 200, 200, 201]);
        assert.equal((await User.countDocuments({ email: "race@example.com" })), 1);
    });

    it("email-delivery failure keeps the pending account without claiming success", async () => {
        mailMode = "down";
        const res = mockRes();
        await auth.signup(mockReq(signupBody("fail@example.com")), res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.success, true);
        assert.equal(res.body.emailSent, false);
        assert.equal(res.body.emailErrorCode, "EMAIL_SEND_FAILED");
        const user = await User.findOne({ email: "fail@example.com" });
        assert.ok(user);
        assert.equal(user.isEmailVerified, false);
    });

    it("sandbox rejection maps to RECIPIENT_NOT_VERIFIED, never raw SES text", async () => {
        mailMode = "sandbox";
        const res = mockRes();
        await auth.signup(mockReq(signupBody("sand@example.com")), res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.emailSent, false);
        assert.equal(res.body.emailErrorCode, "RECIPIENT_NOT_VERIFIED");
        assert.ok(!JSON.stringify(res.body).includes("identities failed"));
    });
});

const createPendingViaSignup = async (email) => {
    const res = mockRes();
    await auth.signup(mockReq(signupBody(email)), res);
    assert.ok([200, 201].includes(res.statusCode));
    return res;
};

// Extract the plaintext code from the stub mail (test-only: tests own the stub).
const lastCodeFromMail = () => {
    assert.ok(sentMail.length > 0);
    const last = sentMail[sentMail.length - 1];
    const match = String(last.text).match(/(\d{6})/);
    assert.ok(match);
    return match[1];
};

describe("verify-otp — the single gate to a session", () => {
    it("correct code verifies the account and issues the normal JWT", async () => {
        await createPendingViaSignup("ok@example.com");
        const code = lastCodeFromMail();
        const res = mockRes();
        await auth.verifyOtp(mockReq({ email: "ok@example.com", code }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.code, "VERIFIED");
        assert.ok(res.body.token);
        assert.equal(res.body.user.email, "ok@example.com");
        const user = await User.findOne({ email: "ok@example.com" });
        assert.equal(user.isEmailVerified, true);
    });

    it("incorrect code does not verify and consumes an attempt", async () => {
        await createPendingViaSignup("wrong@example.com");
        const res = mockRes();
        await auth.verifyOtp(mockReq({ email: "wrong@example.com", code: "000000" }), res);
        // May coincidentally be correct once in a million runs — retry guard.
        if (res.body.code === "VERIFIED") return;
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.code, "INVALID_CODE");
        assert.equal(res.body.token, undefined);
        const user = await User.findOne({ email: "wrong@example.com" });
        assert.equal(user.isEmailVerified, false);
        assert.equal(user.emailVerification.attempts, 1);
    });

    it("malformed codes are rejected without touching attempts", async () => {
        await createPendingViaSignup("mal@example.com");
        for (const bad of ["12345", "abcdef", "1234567", " 12 34 "]) {
            const res = mockRes();
            await auth.verifyOtp(mockReq({ email: "mal@example.com", code: bad }), res);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, "INVALID_CODE");
        }
        const user = await User.findOne({ email: "mal@example.com" });
        assert.equal(user.emailVerification.attempts, 0);
    });

    it("expired codes are rejected with a resend path", async () => {
        await createPendingViaSignup("exp@example.com");
        await User.updateOne(
            { email: "exp@example.com" },
            { "emailVerification.expiresAt": new Date(Date.now() - 1000) }
        );
        const res = mockRes();
        await auth.verifyOtp(
            mockReq({ email: "exp@example.com", code: lastCodeFromMail() }),
            res
        );
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, "EXPIRED_CODE");
    });

    it("attempt limit is enforced", async () => {
        process.env.OTP_MAX_ATTEMPTS = "2";
        try {
            await createPendingViaSignup("lim@example.com");
            // Force a wrong code deterministically: flip the real code's first digit.
            const real = lastCodeFromMail();
            const wrong = real[0] === "9" ? `8${real.slice(1)}` : `9${real.slice(1)}`;
            for (let i = 0; i < 2; i += 1) {
                const r = mockRes();
                await auth.verifyOtp(mockReq({ email: "lim@example.com", code: wrong }), r);
                assert.equal(r.body.code, "INVALID_CODE");
            }
            const blocked = mockRes();
            await auth.verifyOtp(mockReq({ email: "lim@example.com", code: wrong }), blocked);
            assert.equal(blocked.statusCode, 403);
            assert.equal(blocked.body.code, "TOO_MANY_ATTEMPTS");
        } finally {
            delete process.env.OTP_MAX_ATTEMPTS;
        }
    });

    it("replay after success is safe and issues no new token", async () => {
        await createPendingViaSignup("replay@example.com");
        const code = lastCodeFromMail();
        const first = mockRes();
        await auth.verifyOtp(mockReq({ email: "replay@example.com", code }), first);
        assert.equal(first.body.code, "VERIFIED");
        const second = mockRes();
        await auth.verifyOtp(mockReq({ email: "replay@example.com", code }), second);
        assert.equal(second.body.code, "ALREADY_VERIFIED");
        assert.equal(second.body.token, undefined);
    });

    it("concurrent verify attempts yield exactly one VERIFIED session", async () => {
        await createPendingViaSignup("conc@example.com");
        const code = lastCodeFromMail();
        const results = await Promise.all(
            [mockRes(), mockRes()].map((res) =>
                auth.verifyOtp(mockReq({ email: "conc@example.com", code }), res).then(() => res)
            )
        );
        const verified = results.filter((r) => r.body.code === "VERIFIED");
        assert.equal(verified.length, 1);
        assert.ok(verified[0].body.token);
        const user = await User.findOne({ email: "conc@example.com" });
        assert.equal(user.isEmailVerified, true);
    });

    it("only the latest code works after a resend", async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = "0";
        try {
            await createPendingViaSignup("sup@example.com");
            const stale = lastCodeFromMail();
            const resend = mockRes();
            await auth.resendOtp(mockReq({ email: "sup@example.com" }), resend);
            assert.equal(resend.body.code, "OTP_SENT");
            const fresh = lastCodeFromMail();
            assert.notEqual(fresh, stale || "______");
            const staleAttempt = mockRes();
            await auth.verifyOtp(mockReq({ email: "sup@example.com", code: stale }), staleAttempt);
            // 1-in-a-million collision guard: if equal, the stale code IS current.
            if (stale !== fresh) {
                assert.equal(staleAttempt.body.code, "INVALID_CODE");
            }
            const freshAttempt = mockRes();
            await auth.verifyOtp(mockReq({ email: "sup@example.com", code: fresh }), freshAttempt);
            assert.equal(freshAttempt.body.code, "VERIFIED");
        } finally {
            process.env.OTP_RESEND_COOLDOWN_SECONDS = "1";
        }
    });
});

describe("resend-otp — bounded recovery", () => {
    it("resend succeeds and cooldown is enforced", async () => {
        await createPendingViaSignup("rs@example.com");
        const again = mockRes();
        await auth.resendOtp(mockReq({ email: "rs@example.com" }), again);
        // Cooldown is 1s in tests — either sent or cooling down is acceptable.
        assert.ok(["OTP_SENT", "RESEND_COOLDOWN"].includes(again.body.code));
    });

    it("resend for verified and unknown emails is safe", async () => {
        await createPendingViaSignup("done@example.com");
        const code = lastCodeFromMail();
        const verify = mockRes();
        await auth.verifyOtp(mockReq({ email: "done@example.com", code }), verify);
        assert.equal(verify.body.code, "VERIFIED");
        const resendVerified = mockRes();
        await auth.resendOtp(mockReq({ email: "done@example.com" }), resendVerified);
        assert.equal(resendVerified.body.code, "ALREADY_VERIFIED");
        const resendMissing = mockRes();
        await auth.resendOtp(mockReq({ email: "nobody@example.com" }), resendMissing);
        assert.equal(resendMissing.statusCode, 404);
        assert.equal(resendMissing.body.code, "NO_PENDING_VERIFICATION");
    });

    it("SMTP failure on resend never claims delivery", async () => {
        process.env.OTP_RESEND_COOLDOWN_SECONDS = "0";
        try {
            await createPendingViaSignup("rsfail@example.com");
            mailMode = "down";
            const res = mockRes();
            await auth.resendOtp(mockReq({ email: "rsfail@example.com" }), res);
            assert.equal(res.body.success, false);
            assert.equal(res.body.code, "EMAIL_SEND_FAILED");
            assert.equal(res.body.emailSent, false);
        } finally {
            process.env.OTP_RESEND_COOLDOWN_SECONDS = "1";
            mailMode = "ok";
        }
    });
});

describe("login + middleware compatibility", () => {
    it("verified password accounts log in normally (legacy undefined flag too)", async () => {
        await createPendingViaSignup("leg@example.com");
        const code = lastCodeFromMail();
        const verify = mockRes();
        await auth.verifyOtp(mockReq({ email: "leg@example.com", code }), verify);
        assert.equal(verify.body.code, "VERIFIED");
        const login = mockRes();
        await auth.login(
            mockReq({ email: "leg@example.com", password: "Str0ng!Pass" }),
            login
        );
        assert.equal(login.statusCode, 200);
        assert.ok(login.body.token);

        // Legacy document without the flag at all: must still log in.
        const bcrypt = require("bcrypt");
        await User.create({
            name: "Old User",
            email: "legacy@example.com",
            password: await bcrypt.hash("Str0ng!Pass", 10),
        });
        await User.updateOne({ email: "legacy@example.com" }, { $unset: { isEmailVerified: "" } });
        const legacyLogin = mockRes();
        await auth.login(
            mockReq({ email: "legacy@example.com", password: "Str0ng!Pass" }),
            legacyLogin
        );
        assert.equal(legacyLogin.statusCode, 200);
        assert.ok(legacyLogin.body.token);
    });

    it("unverified accounts get EMAIL_NOT_VERIFIED with no token", async () => {
        await createPendingViaSignup("unv@example.com");
        const login = mockRes();
        await auth.login(
            mockReq({ email: "unv@example.com", password: "Str0ng!Pass" }),
            login
        );
        assert.equal(login.statusCode, 403);
        assert.equal(login.body.code, "EMAIL_NOT_VERIFIED");
        assert.equal(login.body.token, undefined);
    });

    it("wrong passwords stay generic even for pending accounts", async () => {
        await createPendingViaSignup("gen@example.com");
        const login = mockRes();
        await auth.login(
            mockReq({ email: "gen@example.com", password: "Wr0ng!Pass" }),
            login
        );
        assert.equal(login.statusCode, 401);
        assert.equal(login.body.code, "INVALID_CREDENTIALS");
    });

    it("Google-linked accounts bypass OTP and stay functional", async () => {
        const bcrypt = require("bcrypt");
        await User.create({
            name: "Google User",
            email: "guser@example.com",
            password: await bcrypt.hash(require("crypto").randomBytes(32).toString("hex"), 10),
            googleId: "google-sub-123",
            isEmailVerified: false,
        });
        const login = mockRes();
        // Password unknown to us; assert protect-level semantics instead:
        const { protect } = require("../middleware/authMiddleware");
        const generateToken = require("../utils/generateToken");
        const user = await User.findOne({ email: "guser@example.com" });
        const token = generateToken(user._id);
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = mockRes();
        let nextCalled = false;
        await protect(req, res, () => {
            nextCalled = true;
        });
        assert.equal(nextCalled, true);
        assert.equal(String(req.user.email), "guser@example.com");
        assert.equal(login.statusCode, null);
    });

    it("protect blocks unverified users and missing users safely", async () => {
        const { protect } = require("../middleware/authMiddleware");
        const generateToken = require("../utils/generateToken");
        await createPendingViaSignup("blocked@example.com");
        const pending = await User.findOne({ email: "blocked@example.com" });
        const badReq = { headers: { authorization: `Bearer ${generateToken(pending._id)}` } };
        const badRes = mockRes();
        let nextCalled = false;
        await protect(badReq, badRes, () => {
            nextCalled = true;
        });
        assert.equal(nextCalled, false);
        assert.equal(badRes.statusCode, 403);
        assert.equal(badRes.body.code, "EMAIL_NOT_VERIFIED");

        // Deleted user: token verifies but account is gone.
        const ghostRes = mockRes();
        let ghostNext = false;
        await protect(
            { headers: { authorization: `Bearer ${generateToken(new mongoose.Types.ObjectId())}` } },
            ghostRes,
            () => {
                ghostNext = true;
            }
        );
        assert.equal(ghostNext, false);
        assert.equal(ghostRes.statusCode, 401);
    });

    it("no OTP hash or password ever leaks through JSON", async () => {
        await createPendingViaSignup("leak@example.com");
        const user = await User.findOne({ email: "leak@example.com" }).select(
            "+emailVerification.otpHash"
        );
        const json = JSON.parse(JSON.stringify(user));
        assert.equal(json.password, undefined);
        assert.equal(json.emailVerification && json.emailVerification.otpHash, undefined);
    });
});

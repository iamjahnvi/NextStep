const User = require("../models/User");

const bcrypt = require("bcrypt");

const crypto = require("crypto");

const generateToken = require("../utils/generateToken");

// google-auth-library: official Google library used to VERIFY the ID token
// (JWT) that the frontend receives from Google's Identity Services. Verifying
// cryptographically on the server is mandatory — we trust Google's signature,
// never the browser.
//
// NOTE: The OAuth client is created lazily per request (see getGoogleClient),
// NOT at module load — so a server started before GOOGLE_CLIENT_ID was added
// to .env still works after a restart-free env reload, and a missing ID
// produces a clear 500 instead of a cryptic verification failure.
// (GOOGLE_CLIENT_SECRET is not needed for this ID-token flow — it is only
// used by the authorization-code exchange, which we don't use.)
const { OAuth2Client } = require("google-auth-library");

const getGoogleClient = () => {
    const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
    if(!clientId){
        const err = new Error("GOOGLE_CLIENT_ID is not configured on the server.");
        err.code = "GOOGLE_NOT_CONFIGURED";
        throw err;
    }
    return new OAuth2Client(clientId);
};

const {
    validateEmail,
    validatePassword,
    validateName,
    validatePercentage,
    validateAge,
    validateDateOfBirth,
    validateGender,
} = require("../utils/validation");

const {
    normalizeEducationLevel,
    ALLOWED_EDUCATION_LEVELS,
} = require("../utils/educationLevels");

const {
    normalizeEmail,
    generateOtp,
    hashOtp,
    verifyOtpHash,
    isWellFormedOtp,
    getOtpConfig,
} = require("../utils/otp");

const { sendVerificationOtp } = require("../services/mailer");

// -----------------------------------------------------------------------------
// EMAIL-OTP VERIFICATION — shared account-lifecycle helpers
// SCOPE: new email/password sign-ups ONLY. Google accounts are provider-
//   verified; legacy documents (isEmailVerified missing) predate this flow.
//   A MISSING flag therefore counts as verified so existing users are never
//   locked out. Only an explicit `false` on a non-Google account is pending.
// -----------------------------------------------------------------------------
const isAccountVerified = (user) => {
    if (!user) return false;
    if (user.googleId) return true;
    if (user.isEmailVerified === undefined || user.isEmailVerified === null) return true;
    return user.isEmailVerified === true;
};

// Attach a fresh OTP (invalidating any prior code) to a user document.
// Returns the PLAINTEXT code + ttl for the single sendMail call — callers must
// never log, return, or store it beyond that call.
const issueFreshOtp = (user) => {
    const config = getOtpConfig();
    const code = generateOtp(config.length);
    const now = new Date();
    user.emailVerification = {
        otpHash: hashOtp(code),
        expiresAt: new Date(now.getTime() + config.ttlMinutes * 60000),
        attempts: 0,
        lastSentAt: now,
        resendCount: 0,
        resendWindowStart: now,
        consumedAt: undefined,
        purpose: "email-verification",
    };
    user.isEmailVerified = false;
    return { code, ttlMinutes: config.ttlMinutes };
};

// Send the code; on failure the pending account is preserved and the caller
// reports emailSent:false WITHOUT claiming delivery. Never throws for mail
// failures — returns a { mailed, code, message } outcome instead.
const deliverOtp = async (email, code, ttlMinutes) => {
    try {
        await sendVerificationOtp({ to: email, code, ttlMinutes });
        return { mailed: true, code: "OTP_SENT", message: "Verification code sent." };
    } catch (mailError) {
        if (mailError.code === "RECIPIENT_NOT_VERIFIED") {
            return {
                mailed: false,
                code: "RECIPIENT_NOT_VERIFIED",
                message:
                    "We could not deliver the code to this address yet (mail service restriction). " +
                    "Try a different address or use Resend once delivery is enabled.",
            };
        }
        if (mailError.code === "EMAIL_NOT_CONFIGURED") {
            return {
                mailed: false,
                code: "EMAIL_SEND_FAILED",
                message:
                    "Email delivery is not configured right now. Your account is saved — " +
                    "use Resend code to try again later.",
            };
        }
        return {
            mailed: false,
            code: "EMAIL_SEND_FAILED",
            message:
                "We could not send the verification email. Your account is saved — " +
                "use Resend code to try again.",
        };
    }
};

const {
    normalizeStream,
    normalizeUserSubjects,
    CANONICAL_STREAMS,
} = require("../utils/eligibility");

const signup = async (req , res) => {
    // res.status(201).json({
    //     success : true,
    //     message : "Signup endpoint working" ,
    // });

    // this was something that we had written for testing it on POSTMAN

    try{
        const{name , email , password , confirmPassword } = req.body;
        if(!name || !password || !email || !confirmPassword){
            return res.status(400).json({
                success : false ,
                errors : {
                    name : !name ? "Name is required" : null ,
                    email : !email ? "Email is required" : null ,
                    password : !password ? "Password is required" : null ,
                    confirmPassword : !confirmPassword ? "Password is required" : null
                }
            });
        }

        if(password.trim() != confirmPassword.trim()){
            return res.status(400).json({
                success : false , 
                message :  "Passwords don't match"
            })
        }

        // ---------------------------------------------------------------------
        // Email format validation (server-side)
        // HOW: validateEmail() runs a regex against the submitted email and
        //   rejects it if it is not a properly structured address.
        // WHY: Prevents malformed email addresses (e.g. "abc@", "user@.com")
        //   from being created in the database.
        // ---------------------------------------------------------------------
        // Normalize once (trim + lowercase) so lookups, storage, and OTP
        // binding all use the identical address. Schema lowercase:true only
        // lowercases on save — lookups must use the normalized form.
        const normalizedEmail = normalizeEmail(email);
        const emailCheck = validateEmail(normalizedEmail);
        if(!emailCheck.valid){
            return res.status(400).json({
                success : false ,
                errors : { email : emailCheck.message },
            });
        }

        // ---------------------------------------------------------------------
        // Password strength validation (server-side)
        // HOW: validatePassword() enforces production-grade rules: min 8 chars,
        //   at least one letter, one number, and one special character.
        // WHY: Weak passwords are the #1 security risk. Enforcing this on the
        //   server means the rule cannot be bypassed from the browser.
        // ---------------------------------------------------------------------
        const passwordCheck = validatePassword(password);
        if(!passwordCheck.valid){
            return res.status(400).json({
                success : false ,
                errors : { password : passwordCheck.message },
            });
        }

        // ---------------------------------------------------------------------
        // Name validation (server-side)
        // HOW: validateName() ensures the name contains only letters (plus
        //   spaces/hyphens/apostrophes for real compound names).
        // WHY: Flags users who enter numbers or special symbols as their name,
        //   keeping the database clean and the profile display sane.
        // ---------------------------------------------------------------------
        const nameCheck = validateName(name);
        if(!nameCheck.valid){
            return res.status(400).json({
                success : false ,
                errors : { name : nameCheck.message },
            });
        }

        const existingUser = await User.findOne({ email: normalizedEmail });

        // findOne tells MongoDB: "Search through the collection and return the very first document that matches the criteria I give you." Even if there are multiple users with the same criteria, it stops searching after finding the first match. If it finds nothing, it returns null.

        // ({email})  : the argument passed to findOne , defining the search criteria

        // ({email}) is the shorthand for writing , ({email : email})
        // the email : email , is  a key value pair
        // email as , key means the field name inside mongodb database dovument.
        // email is the variable holding the actual email.


        // -------------------------------------------------------------
        // OTP lifecycle: verified accounts keep the existing 409; pending
        // (unverified) accounts take the safe recovery path — refresh the
        // credentials to the latest attempt, invalidate the prior code, and
        // re-send. Verified accounts, passwords, Google identity and profile
        // are never overwritten here.
        // -------------------------------------------------------------
        if(existingUser && isAccountVerified(existingUser)){
            return res.status(409).json({
                success : false ,
                code : "EMAIL_ALREADY_REGISTERED" ,
                message : "An account with this email already exists. Please log in instead."
            })
        }

        const hashedPassword = await bcrypt.hash(password,10);


        // bcrypt : a popular , battle-tested npm package(library) used for securely hashing passwords.

        // explaination : bcrypt is not built into Node.js; it is an external dependency that implements the Bcrypt password-hashing function . It is specifically engineered to be slow and computationally expensive.

        const createPendingUser = async () => User.create({
            name ,
            email : normalizedEmail ,
            password : hashedPassword,
            isEmailVerified : false,
        });

        let user;
        let isRetry = false;
        if(existingUser){
            // Pending account retry: adopt the latest name/password (the user
            // may be correcting a typo) but touch nothing else.
            isRetry = true;
            existingUser.name = name;
            existingUser.password = hashedPassword;
            user = existingUser;
        } else {
            try {
                user = await createPendingUser();
            } catch (createError) {
                // Concurrent signup race: another request created the address
                // first. Recover via the same pending/verified branches instead
                // of failing with a 500 duplicate-key error.
                if(createError && createError.code === 11000){
                    const racedUser = await User.findOne({ email: normalizedEmail });
                    if(racedUser && isAccountVerified(racedUser)){
                        return res.status(409).json({
                            success : false ,
                            code : "EMAIL_ALREADY_REGISTERED" ,
                            message : "An account with this email already exists. Please log in instead."
                        });
                    }
                    if(racedUser){
                        isRetry = true;
                        racedUser.name = name;
                        racedUser.password = hashedPassword;
                        user = racedUser;
                    } else {
                        throw createError;
                    }
                } else {
                    throw createError;
                }
            }
        }

        // Issue (or re-issue) the OTP — this invalidates any prior code so
        // only the latest code can verify. No JWT is issued at this stage.
        const { code: otpCode, ttlMinutes } = issueFreshOtp(user);
        await user.save();
        const delivery = await deliverOtp(normalizedEmail, otpCode, ttlMinutes);

        // we respond with successful creation of profile of person, only after the data of the user has been saved in mongodb , otherwise if lessay , database is down , it would catch error , and hence print internal server issue.
        return res.status(isRetry ? 200 : 201).json({
            success : true,
            code : "VERIFICATION_REQUIRED",
            message : delivery.mailed
                ? (isRetry
                    ? "A fresh verification code was sent to your email."
                    : "Account created. A verification code was sent to your email.")
                : delivery.message,
            emailSent : delivery.mailed,
            email : user.email,
            expiresInMinutes : ttlMinutes,
            ...(delivery.mailed ? {} : { emailErrorCode : delivery.code }),
        });
    } catch(error) {
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server failed" 
        })
    }
}

const getMe = async (req , res) => {
    try{
        // Explicit safe projection: never return password hashes or OTP state.
        const user = req.user;
        return res.status(200).json({
            success : true ,
            user : {
                id: user._id,
                name: user.name,
                email: user.email,
                avatar: user.avatar,
                isEmailVerified: isAccountVerified(user),
                profile: user.profile,
            },
        });
    } catch(error) {
    console.error(error);

    res.status(500).json({
        success : false ,
        code : "INTERNAL_ERROR" ,
        message : "Internal Server error"
    });
}
} 

const login = async (req,res) => {
    try{
        const{email , password} = req.body;

        if(!email || !password){
            return res.status(400).json({
                success : false ,
                message : "All fields are required"
            })
        }

        // ---------------------------------------------------------------------
        // Email format validation on LOGIN flow (server-side)
        // HOW: Same validateEmail() regex used in signup is applied here, so the
        //   login form also flags an incorrectly-typed email before we even look
        //   the user up in the database.
        // WHY: Gives the user immediate, clear feedback at the very first point
        //   of entry rather than hiding behind a generic "invalid credentials".
        // ---------------------------------------------------------------------
        const emailCheck = validateEmail(email);
        if(!emailCheck.valid){
            return res.status(400).json({
                success : false ,
                code : "VALIDATION_ERROR" ,
                errors : { email : emailCheck.message },
            });
        }

        const normalizedEmail = normalizeEmail(email);
        const user = await User.findOne({ email: normalizedEmail });

        if(!user){
            return res.status(401).json({
                success : false  , 
                code : "INVALID_CREDENTIALS" ,
                message : "Invalid email or password"
            })
        }

        if(!user.password){
            // Defensive: manually-created documents without a password hash
            // must fail closed instead of crashing bcrypt.compare.
            return res.status(401).json({
                success : false ,
                code : "INVALID_CREDENTIALS" ,
                message : "Invalid email or password"
            });
        }

        const isPasswordCorrect = await bcrypt.compare(
            password ,
            user.password
        )
        if(!isPasswordCorrect){
            return res.status(401).json({
                success : false ,
                code : "INVALID_CREDENTIALS" ,
                message : "Invalid email or password"
            })
        }

        // Unverified password accounts get NO token — the frontend routes
        // them to the verification/resend flow via this stable code.
        // (Checked after the password so wrong passwords stay generic.)
        if(!isAccountVerified(user)){
            return res.status(403).json({
                success : false ,
                code : "EMAIL_NOT_VERIFIED" ,
                message : "Please verify your email before logging in. Enter the code we sent, or resend it.",
                email : user.email,
            });
        }

        const token = generateToken(user._id);

        return res.status(200).json({
            success : true ,
            message : "login successful",
            token,
            user : {
                id : user._id,
                name : user.name ,
                email : user.email ,
                isEmailVerified : isAccountVerified(user) ,

            } ,
        });



    } catch(error){
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server error" ,
        })

    };
}

// -----------------------------------------------------------------------------
// getGoogleConfig
// HOW: Returns the OAuth Client ID to the frontend so it can initialise Google
//   Identity Services. WHY: single source of truth — the client ID is only
//   stored in the server .env, never hard-coded in the frontend bundle.
// -----------------------------------------------------------------------------
const getGoogleConfig = async (req , res) => {
    try{
        const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
        if(!clientId){
            return res.status(500).json({
                success : false ,
                message : "Google sign-in is not configured (GOOGLE_CLIENT_ID missing on the server).",
            });
        }
        return res.status(200).json({
            success : true ,
            clientId ,
        });
    } catch(error){
        console.log(error);
        return res.status(500).json({
            success : false ,
            message : "Internal server error" ,
        });
    }
};

// -----------------------------------------------------------------------------
// googleAuth ("Continue with Google" / "Sign in with Google")
// HOW:  1. The frontend completes Google's account chooser and hands us an ID
//          token (a signed JWT) in req.body.credential.
//       2. googleClient.verifyIdToken() validates the token's signature, issuer,
//          audience and expiry against Google's public keys.
//       3. We trust the verified payload (email, name, picture) and either log
//          the user in (email exists) or create a brand-new account (email not
//          in DB). For OAuth-only users we generate a cryptographically-random
//          password, since they won't log in with a password.
//       4. A normal JWT for our own API is issued and returned.
// WHY:  This is the secure OAuth pattern — the server verifies the token instead
//   of trusting anything sent from the browser, and it auto-registers users, so
//   "Continue with Google" works as both signup and login.
// -----------------------------------------------------------------------------
const googleAuth = async (req , res) => {
    try{
        const { credential } = req.body;
        if(!credential){
            return res.status(400).json({
                success : false ,
                message : "Google credential is missing.",
            });
        }

        let googleClient;
        try{
            googleClient = getGoogleClient();
        } catch(configError){
            return res.status(500).json({
                success : false ,
                message : "Google sign-in is not configured (GOOGLE_CLIENT_ID missing on the server).",
            });
        }

        // cryptographic verification of Google's ID token
        const ticket = await googleClient.verifyIdToken({
            idToken : credential ,
            audience : (process.env.GOOGLE_CLIENT_ID || "").trim() ,
        });
        const payload = ticket.getPayload();

        const { email , email_verified , name , picture } = payload;

        // Google only issues tokens for verified emails; double-check anyway.
        if(!email || !email_verified){
            return res.status(401).json({
                success : false ,
                message : "Google account email is not verified.",
            });
        }

        let user = await User.findOne({ email });

        if(!user){
            // first time -> auto register (signup via Google). Google emails
            // are provider-verified, so no OTP flow applies.
            const randomPassword = crypto.randomBytes(32).toString("hex");
            const hashedPassword = await bcrypt.hash(randomPassword, 10);
            user = await User.create({
                name : name || email.split("@")[0] ,
                email ,
                password : hashedPassword ,
                googleId : payload.sub ,
                avatar : picture ,
                isEmailVerified : true ,
            });
        } else {
            // existing user -> just log in (and refresh their stored googleId/avatar).
            // Google just proved ownership of this address, so any pending
            // password-OTP state is resolved as verified — profile/password
            // are otherwise untouched.
            if(payload.sub && !user.googleId) user.googleId = payload.sub;
            if(picture && !user.avatar) user.avatar = picture;
            if(!isAccountVerified(user)) user.isEmailVerified = true;
            if(user.emailVerification && (user.emailVerification.otpHash || user.emailVerification.expiresAt)){
                user.emailVerification.otpHash = undefined;
                user.emailVerification.expiresAt = undefined;
                user.emailVerification.attempts = 0;
                user.emailVerification.consumedAt = new Date();
            }
            await user.save();
        }

        const token = generateToken(user._id);

        return res.status(200).json({
            success : true ,
            message : "Google sign-in successful" ,
            token ,
            user : { id : user._id , name : user.name , email : user.email } ,
        });
    } catch(error){
        console.log(error);
        return res.status(401).json({
            success : false ,
            message : "Google authentication failed. Please try again.",
        });
    }
}
// -----------------------------------------------------------------------------
// verifyOtp — POST /auth/verify-otp { email, code }
// HOW: The code is compared (timing-safe) against the stored hash; on success
//   the account is marked verified and consumed ATOMICALLY via a guarded
//   findOneAndUpdate, so concurrent requests cannot double-consume the code.
//   Only then is the normal JWT issued using existing conventions.
// WHY: This is the single gate that turns a pending account into a session.
// -----------------------------------------------------------------------------
const verifyOtp = async (req, res) => {
    try{
        const { email, code } = req.body || {};
        if(!email || !code){
            return res.status(400).json({
                success : false ,
                code : "VALIDATION_ERROR" ,
                message : "Email and verification code are required.",
            });
        }
        const normalizedEmail = normalizeEmail(email);
        const emailCheck = validateEmail(normalizedEmail);
        if(!emailCheck.valid){
            return res.status(400).json({
                success : false ,
                code : "VALIDATION_ERROR" ,
                errors : { email : emailCheck.message },
            });
        }
        if(!isWellFormedOtp(String(code).trim())){
            return res.status(400).json({
                success : false ,
                code : "INVALID_CODE" ,
                message : "Enter the 6-digit verification code from your email.",
            });
        }
        const trimmedCode = String(code).trim();

        const user = await User.findOne({ email: normalizedEmail })
            .select("+emailVerification.otpHash");

        // Idempotent replays: already-verified accounts succeed WITHOUT a new
        // token — the user should log in normally. Checked BEFORE the OTP
        // presence check because success consumes (unsets) the OTP state.
        if(user && isAccountVerified(user)){
            return res.status(200).json({
                success : false ,
                code : "ALREADY_VERIFIED" ,
                message : "This email is already verified. Please log in.",
            });
        }

        if(!user || !user.emailVerification || !user.emailVerification.otpHash){
            return res.status(404).json({
                success : false ,
                code : "NO_PENDING_VERIFICATION" ,
                message : "No pending verification for this email. Sign up again or resend the code.",
            });
        }

        const config = getOtpConfig();
        const verification = user.emailVerification;

        if(verification.consumedAt){
            return res.status(400).json({
                success : false ,
                code : "INVALID_CODE" ,
                message : "This code has already been used. Resend a new code to continue.",
            });
        }

        if(!verification.expiresAt || verification.expiresAt.getTime() <= Date.now()){
            return res.status(400).json({
                success : false ,
                code : "EXPIRED_CODE" ,
                message : "This code has expired. Resend a new code to continue.",
            });
        }

        if((verification.attempts || 0) >= config.maxAttempts){
            return res.status(403).json({
                success : false ,
                code : "TOO_MANY_ATTEMPTS" ,
                message : "Too many incorrect attempts. Resend a new code to continue.",
            });
        }

        if(!verifyOtpHash(trimmedCode, verification.otpHash)){
            const updated = await User.findOneAndUpdate(
                { _id: user._id },
                { $inc : { "emailVerification.attempts" : 1 } },
                { returnDocument : "after" }
            );
            const attemptsLeft = Math.max(
                0,
                config.maxAttempts - ((updated && updated.emailVerification && updated.emailVerification.attempts) || 0)
            );
            return res.status(401).json({
                success : false ,
                code : "INVALID_CODE" ,
                message : attemptsLeft > 0
                    ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before you need a new code.`
                    : "Incorrect code. Resend a new code to continue.",
                attemptsLeft,
            });
        }

        // Correct code: atomically verify + consume, guarded on the exact hash
        // so a concurrent request (or a resend that superseded this code)
        // cannot also succeed.
        const consumed = await User.findOneAndUpdate(
            {
                _id: user._id,
                "emailVerification.otpHash": verification.otpHash,
                "emailVerification.consumedAt": { $exists: false },
            },
            {
                $set: {
                    isEmailVerified: true,
                    "emailVerification.consumedAt": new Date(),
                    "emailVerification.attempts": 0,
                },
                $unset: {
                    "emailVerification.otpHash": "",
                    "emailVerification.expiresAt": "",
                },
            },
            { returnDocument: "after" }
        );

        if(!consumed){
            const fresh = await User.findById(user._id);
            if(fresh && isAccountVerified(fresh)){
                return res.status(200).json({
                    success : false ,
                    code : "ALREADY_VERIFIED" ,
                    message : "This email is already verified. Please log in.",
                });
            }
            return res.status(400).json({
                success : false ,
                code : "INVALID_CODE" ,
                message : "This code is no longer valid. Resend a new code to continue.",
            });
        }

        const token = generateToken(consumed._id);
        return res.status(200).json({
            success : true ,
            code : "VERIFIED" ,
            message : "Email verified successfully. Welcome to NextStep!",
            token,
            user : {
                id : consumed._id,
                name : consumed.name,
                email : consumed.email,
            },
        });
    } catch(error){
        console.log(error);
        return res.status(500).json({
            success : false ,
            code : "INTERNAL_ERROR" ,
            message : "Internal server error",
        });
    }
};

// -----------------------------------------------------------------------------
// resendOtp — POST /auth/resend-otp { email }
// HOW: Enforces a per-email cooldown + hourly cap, then invalidates the prior
//   code by issuing a fresh OTP. Failed delivery never claims success.
// WHY: Recovery path for expired/lost codes and for users returning later.
// -----------------------------------------------------------------------------
const resendOtp = async (req, res) => {
    try{
        const { email } = req.body || {};
        if(!email){
            return res.status(400).json({
                success : false ,
                code : "VALIDATION_ERROR" ,
                message : "Email is required.",
            });
        }
        const normalizedEmail = normalizeEmail(email);
        const emailCheck = validateEmail(normalizedEmail);
        if(!emailCheck.valid){
            return res.status(400).json({
                success : false ,
                code : "VALIDATION_ERROR" ,
                errors : { email : emailCheck.message },
            });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if(!user){
            return res.status(404).json({
                success : false ,
                code : "NO_PENDING_VERIFICATION" ,
                message : "No pending verification for this email. Sign up again to receive a code.",
            });
        }
        if(isAccountVerified(user)){
            return res.status(200).json({
                success : false ,
                code : "ALREADY_VERIFIED" ,
                message : "This email is already verified. Please log in.",
            });
        }

        const config = getOtpConfig();
        const verification = user.emailVerification || {};
        const now = new Date();

        if(
            verification.lastSentAt &&
            now.getTime() - verification.lastSentAt.getTime() <
                config.resendCooldownSeconds * 1000
        ){
            const retryAfterSeconds = Math.ceil(
                (config.resendCooldownSeconds * 1000 -
                    (now.getTime() - verification.lastSentAt.getTime())) / 1000
            );
            return res.status(429).json({
                success : false ,
                code : "RESEND_COOLDOWN" ,
                message : `A code was just sent. Please wait ${retryAfterSeconds}s before requesting another.`,
                retryAfterSeconds,
            });
        }

        // Hourly resend budget (sliding window).
        let resendCount = verification.resendCount || 0;
        if(
            !verification.resendWindowStart ||
            now.getTime() - verification.resendWindowStart.getTime() > 60 * 60 * 1000
        ){
            resendCount = 0;
            user.emailVerification.resendWindowStart = now;
        }
        if(resendCount >= config.maxResendsPerHour){
            return res.status(429).json({
                success : false ,
                code : "RESEND_LIMIT_REACHED" ,
                message : "Too many code requests. Please try again later.",
            });
        }

        const { code: otpCode, ttlMinutes } = issueFreshOtp(user);
        user.emailVerification.resendCount = resendCount + 1;
        user.emailVerification.resendWindowStart =
            user.emailVerification.resendWindowStart || now;
        await user.save();

        const delivery = await deliverOtp(normalizedEmail, otpCode, ttlMinutes);
        if(!delivery.mailed){
            const status = delivery.code === "RECIPIENT_NOT_VERIFIED" ? 502 : 502;
            return res.status(status).json({
                success : false ,
                code : delivery.code ,
                message : delivery.message,
                emailSent : false,
            });
        }

        return res.status(200).json({
            success : true ,
            code : "OTP_SENT" ,
            message : "A new verification code was sent to your email.",
            emailSent : true,
            email : user.email,
            expiresInMinutes : ttlMinutes,
        });
    } catch(error){
        console.log(error);
        return res.status(500).json({
            success : false ,
            code : "INTERNAL_ERROR" ,
            message : "Internal server error",
        });
    }
};

const updateProfile = async(req , res) => {
    try {
        const {
            age,
            dateOfBirth,
            gender,
            educationLevel ,
            stream ,
            subjects ,
            percentage ,
            avatar ,
        } = req.body;
        // NOTE: careerInterests / careerPreference / careerType are
        // intentionally NOT read here. Career type belongs to exam discovery,
        // not the user profile, so any such fields sent by older clients are
        // ignored rather than stored.

        if(!req.user.profile) {
            req.user.profile = {};
        }

        if(age!==undefined && age!==null && age!==""){
            // Age is stored and returned but never required for completeness.
            // Legacy path: the form now collects dateOfBirth instead, which
            // takes precedence for eligibility (see getAgeFromProfile).
            const ageCheck = validateAge(age);
            if(!ageCheck.valid){
                return res.status(400).json({
                    success : false ,
                    errors : { age : ageCheck.message },
                });
            }
            req.user.profile.age = Number(age);
        }

        if(dateOfBirth!==undefined && dateOfBirth!==null && dateOfBirth!==""){
            // Date of birth is the source of truth for the user's age.
            const dobCheck = validateDateOfBirth(dateOfBirth);
            if(!dobCheck.valid){
                return res.status(400).json({
                    success : false ,
                    errors : { dateOfBirth : dobCheck.message },
                });
            }
            req.user.profile.dateOfBirth = new Date(dateOfBirth);
        }

        if(gender!==undefined && gender!==null && gender!==""){
            const genderCheck = validateGender(gender);
            if(!genderCheck.valid){
                return res.status(400).json({
                    success : false ,
                    errors : { gender : genderCheck.message },
                });
            }
            req.user.profile.gender = genderCheck.canonical;
        }

        if(stream!==undefined && stream!==null && stream!==""){
            const canonicalStream = normalizeStream(stream);
            if(!canonicalStream){
                return res.status(400).json({
                    success : false ,
                    errors : {
                        stream : `Stream must be one of: ${CANONICAL_STREAMS.join(", ")}.`,
                    },
                });
            }
            req.user.profile.stream = canonicalStream;
        }

        if(educationLevel!==undefined && educationLevel!==null && educationLevel!==""){
            const canonicalLevel = normalizeEducationLevel(educationLevel);
            if(!canonicalLevel){
                return res.status(400).json({
                    success : false ,
                    errors : {
                        educationLevel : `Education level must be one of: ${ALLOWED_EDUCATION_LEVELS.join(", ")}.`,
                    },
                });
            }
            req.user.profile.educationLevel = canonicalLevel;
        }

        if(subjects!==undefined){
            if(!Array.isArray(subjects)){
                return res.status(400).json({
                    success : false ,
                    errors : { subjects : "Subjects must be an array of strings." },
                });
            }
            const invalid = subjects.some(
                (entry) => typeof entry !== "string" || !entry.trim()
            );
            if(invalid){
                return res.status(400).json({
                    success : false ,
                    errors : { subjects : "Subjects must be an array of non-empty strings." },
                });
            }
            req.user.profile.subjects = normalizeUserSubjects(subjects);
        }

        if(percentage!==undefined && percentage!==null && percentage!==""){
            // -----------------------------------------------------------------
            // Percentage validation (server-side)
            // HOW: validatePercentage() blocks negative values (and values > 100).
            // WHY: A negative percentage is impossible in reality; accepting it
            //   would corrupt the profile and skew the exam recommendation query
            //   that compares user percentage against exam minimums.
            // -----------------------------------------------------------------
            const percentageCheck = validatePercentage(Number(percentage));
            if(!percentageCheck.valid){
                return res.status(400).json({
                    success : false ,
                    errors : { percentage : percentageCheck.message },
                });
            }
            req.user.profile.percentage = Number(percentage);
        }

        if(avatar!==undefined && avatar!==null && avatar!==""){
            // -----------------------------------------------------------------
            // Profile photo (avatar) upload.
            // HOW: the frontend downscales the image to a small thumbnail and
            //   sends it as a data URL (or a plain https URL). We accept only
            //   image data URLs / http(s) URLs and cap the length so a huge
            //   payload cannot bloat the user document.
            // WHY: keeps photo upload dependency-free (no file storage/S3)
            //   while preventing abuse via strict format + size checks.
            // -----------------------------------------------------------------
            const isDataUrl = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
            const isUrl = /^https?:\/\/\S{1,2000}$/.test(avatar);
            if(!isDataUrl && !isUrl){
                return res.status(400).json({
                    success : false ,
                    errors : { avatar : "Avatar must be an image data URL or an http(s) URL." },
                });
            }
            if(avatar.length > 700000){
                return res.status(400).json({
                    success : false ,
                    errors : { avatar : "Avatar image is too large. Please use a smaller photo." },
                });
            }
            req.user.avatar = avatar;
        }

        await req.user.save();

        return res.status(200).json({
            success : true ,
            message : "Profile updated successfully" ,
            user : {
                id: req.user._id,
                name: req.user.name,
                email: req.user.email,
                avatar: req.user.avatar,
                isEmailVerified: isAccountVerified(req.user),
                age: req.user.profile.age,
                dateOfBirth: req.user.profile.dateOfBirth,
                gender: req.user.profile.gender,
                educationLevel: req.user.profile.educationLevel,
                percentage: req.user.profile.percentage,
                stream: req.user.profile.stream,
                subjects: req.user.profile.subjects
            }
        })
    } catch(error) {
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server issue"
        });
    }
};

module.exports = {
    signup ,
    login , 
    getMe ,
    updateProfile ,
    getGoogleConfig ,
    googleAuth ,
    verifyOtp ,
    resendOtp ,
    isAccountVerified ,
};


const express = require("express");

const {signup , login , getMe , updateProfile , getGoogleConfig , googleAuth , verifyOtp , resendOtp} = require("../controllers/authController");

// here the signup is written inside {} , becuase authController.js will export multiple functions later.
// like signup , login , logout , forgetPassword , reset Password.
// but rn we are only importing signup function

const router = express.Router();

const {protect} = require("../middleware/authMiddleware")

const {signupLimiter , loginLimiter , verifyLimiter , resendLimiter} = require("../utils/rateLimit");

router.post("/signup" , signupLimiter , signup);

router.post("/login" , loginLimiter , login);

// Email OTP verification (new email/password sign-ups only).
// POST /auth/verify-otp { email, code } -> verifies + issues the normal JWT.
// POST /auth/resend-otp { email }       -> invalidates the prior code, sends a new one.
router.post("/verify-otp" , verifyLimiter , verifyOtp);

router.post("/resend-otp" , resendLimiter , resendOtp);

router.get("/me" , protect , getMe);

router.patch("/profile" , protect , updateProfile);

// Google OAuth ("Continue with Google")
// GET  /auth/google/config -> hands the frontend the OAuth client ID.
// POST /auth/google         -> receives the Google ID token, verifies it, then
//                              registers/logs-in the user and returns our JWT.
router.get("/google/config" , getGoogleConfig);

router.post("/google" , googleAuth);

module.exports = router;


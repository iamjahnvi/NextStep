const mongoose = require("mongoose");
// importing mongoose

const userSchema = new mongoose.Schema({
    name: {
        type : String,
        required : true,
        trim : true,
        minlength : 2,
        maxlength : 50,
    } ,
    email : {
       type: String,
       required: true,
       unique: true,
       lowercase: true,
       trim: true,
    } ,
    password :{
        type : String,
        required : true,
        minlength : 0,
    } ,

    // Email verification (OTP flow for email/password sign-ups only).
    // WHY: a new password account must prove it owns the address before it
    //   receives a session. Legacy documents predate this field — a MISSING
    // value is treated as verified (see authController/protect), so existing
    // users are never locked out. There is deliberately NO default here: a
    // Mongoose default would be applied on READ to legacy documents missing
    // the field, wrongly flipping them to unverified. All creation paths set
    // this explicitly (signup=false, Google=true).
    // Google accounts are provider-verified and always treated as verified
    // regardless of this flag.
    isEmailVerified: {
        type: Boolean,
    },
    // emailVerification holds ONLY the hash of the latest OTP plus control
    // metadata. Plaintext codes are never stored. otpHash is select:false so
    // normal queries never load it into API responses.
    emailVerification: {
        otpHash: { type: String, select: false },
        expiresAt: { type: Date },
        attempts: { type: Number, default: 0 },
        lastSentAt: { type: Date },
        resendCount: { type: Number, default: 0 },
        resendWindowStart: { type: Date },
        consumedAt: { type: Date },
        purpose: { type: String, default: "email-verification" },
    },
    // Google OAuth fields — only set when the user signs in via Google.
    // googleId: Google's unique ID for the account (audience/obfuscated sub).
    // avatar: profile picture URL returned by Google.
    googleId : {
        type : String ,
    },
    avatar : {
        type : String ,
    },

    // point to be noted is that password never stores the plain text password written by us, it stores the value of it , after hashing.
    // name , email and password are authentication information

    profile : {
        age : {
            type : Number ,
        } ,
        // Date of birth is the source of truth for the user's age.
        // The legacy numeric `age` above is kept only so older documents
        // still read; new writes go through `dateOfBirth` and eligibility
        // always derives age from it (see utils/eligibility.js).
        dateOfBirth : {
            type : Date ,
        } ,
        gender : {
            type : String ,
            trim : true ,
        } ,
        educationLevel : {
            type : String ,
        },
        percentage : {
            type : Number ,
        } ,
        stream: {
            type : String
        },
        subjects : [
            {
                type : String
            },
        ],
    },
    // Active profile architecture (Phase 1): age, educationLevel, stream,
    // percentage, subjects. Age is stored but optional for completeness.
    // educationLevel uses canonical strings (see utils/educationLevels.js).
    // careerInterests was removed: career type belongs to exam discovery,
    // not the user profile.
}, {
    timestamps: true
    // this was created so that, timstamps for when any of these
    // (email, password etc) , were being created and updated, that is being saved as :
    // createdAt
    // updatedAt
    
});

// NEVER expose password hashes or OTP hashes through JSON. Controllers also
// project safe fields explicitly; this is defense-in-depth.
const stripSensitive = (doc, ret) => {
    delete ret.password;
    if (ret.emailVerification) delete ret.emailVerification.otpHash;
    return ret;
};
userSchema.set("toJSON", { transform: stripSensitive });
userSchema.set("toObject", { transform: stripSensitive });

const User = mongoose.model('User', userSchema);
// creation of a model

module.exports = User;
// export User

// here model is User , which is generally written with a capslock.























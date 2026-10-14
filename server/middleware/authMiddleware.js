const jwt = require("jsonwebtoken");
// importing jsonwebtoken

const User = require("../models/User");

// creation of middleware function :-

const protect = async (req , res , next) => {
    try {
        const authHeader = req.headers.authorization;

        if(!authHeader || !authHeader.startsWith("Bearer ")){
            return res.status(401).json({
                success : false ,
                message : "Not authorized" ,
            });
        }
        
        const token = authHeader.split(" ")[1];
        // extracting token 

        const decoded = jwt.verify(
            token , 
            process.env.JWT_SECRET
        );
        // verifying token

        // otpHash stays out of the session object (select:false anyway) and
        // the password hash is never attached to req.user.
        const user = await User.findById(decoded.id).select("-password -emailVerification.otpHash");
        // find user , and select everything except password.

        if(!user){
            // Token belongs to a deleted/missing account: fail closed instead
            // of passing a null user down the chain.
            return res.status(401).json({
                success : false ,
                code : "USER_NOT_FOUND" ,
                message : "Not authorized , token failed"
            });
        }

        // Unverified password accounts hold no valid session for protected
        // APIs (they never receive a JWT, but this blocks any forged/legacy
        // token too). Google-linked and legacy (flag missing) accounts pass.
        if(!user.googleId && user.isEmailVerified === false){
            return res.status(403).json({
                success : false ,
                code : "EMAIL_NOT_VERIFIED" ,
                message : "Please verify your email before continuing.",
            });
        }

        req.user = user;
        // attach user to req.user

        next();

    } catch (error){
        console.log(error);

        return res.status(401).json({
            success : false  , 
            message : "Not authorized , token failed"
        });
    }
};


// next is one of the most important concept in middleware , whenever a request is being made, it first passes thru middleware , middleware checks if the person is authenticated , if yes , next , if no, it will return a response for the previous request and never calls next().


module.exports = {protect};

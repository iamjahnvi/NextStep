import axios from "axios";

const api = axios.create({
    // VITE_API_URL in production builds; localhost fallback for local dev.
    // No secrets here — only the public API origin.
    baseURL: import.meta.env?.VITE_API_URL || "http://localhost:5000/api/v1",
});

api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem("token");
        if (token) {
            config.headers = config.headers || {};

            // config.headers ??= {};
            // this is nullish assignment operator , which does the same job as above statement does.
            
            // This is a safety check. It says: "If the headers object doesn't exist yet, create an empty one." This prevents the code from crashing if config.headers is undefined.

            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
    // This passes the error down the line to your own try/catch blocks or .catch() methods in your components(signup or login) so you can handle the failure gracefully.
);

// api : instance of axios
// interceptors : a buit in feauture of axios , that lets you globally handle req or responses.
// .request : specifically targets the ongoing req
// .use : this is a method that accepts two functions :-
// function-1 = success : runs if the req is being prepared successfully
// function-2 = error : runs if something goes wrong even before the req is being sent.

// -----------------------------------------------------------------------------
// CENTRAL 401 HANDLING
// HOW: AuthProvider registers a single onUnauthorized callback (see
//   context/AuthProvider.jsx) that clears the token + user state. Any API call
//   that fails with 401 (expired/invalid JWT) invokes it, so pages never need
//   their own 401 branches. The redirect below only fires off the auth pages
//   themselves — a failed login attempt already lives on /login and shows its
//   own inline error, and must NOT be bounced anywhere.
// WHY: one place owns session expiry; 400 validation responses and all other
//   errors pass through untouched to the calling component.
// -----------------------------------------------------------------------------
let onUnauthorized = null;

export const setOnUnauthorized = (handler) => {
    onUnauthorized = typeof handler === "function" ? handler : null;
};

// Auth-adjacent pages handle their own 401s: login/signup show inline errors,
// and /verify-email uses 401 INVALID_CODE for wrong OTPs (redirecting there
// would destroy the verification flow). Only bounce elsewhere.
const AUTH_PAGES = ["/login", "/signup", "/verify-email"];

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401 && !AUTH_PAGES.includes(window.location.pathname)) {
            if (onUnauthorized) {
                onUnauthorized();
            } else {
                localStorage.removeItem("token");
            }
            window.location.href = "/login";
        }
        return Promise.reject(error);
    }
);

export default api;
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EDUCATION_LEVEL_OPTIONS } from "./profileOptions.js";
import {
    normalizeEducationLevel,
    ALLOWED_EDUCATION_LEVELS,
} from "../../../server/utils/educationLevels.js";

// -----------------------------------------------------------------------------
// Frontend/backend education contract: every profile-selector value must map
// through the REAL backend normalizer to its own canonical level, so the
// value sent to /auth/profile and used by recommend/discover is exactly what
// the student selected. Guards against selector/backend drift (e.g. the
// previously missing Class 11 option).
// -----------------------------------------------------------------------------
describe("profile education options map to canonical backend levels", () => {
    it("covers every selectable student level", () => {
        const values = EDUCATION_LEVEL_OPTIONS.map((o) => o.value);
        for (const required of ["8", "9", "10", "11", "12", "Graduate", "Post-Graduate", "Doctorate"]) {
            assert.ok(values.includes(required), `selector offers ${required}`);
        }
    });

    it("each option value round-trips through the backend normalizer", () => {
        for (const option of EDUCATION_LEVEL_OPTIONS) {
            assert.ok(
                ALLOWED_EDUCATION_LEVELS.includes(option.value),
                `${option.value} is a canonical backend level`
            );
            assert.equal(
                normalizeEducationLevel(option.value),
                option.value,
                `${option.label} maps to canonical ${option.value}`
            );
        }
    });

    it("option values are unique with human-readable labels", () => {
        const values = EDUCATION_LEVEL_OPTIONS.map((o) => o.value);
        assert.equal(new Set(values).size, values.length);
        for (const option of EDUCATION_LEVEL_OPTIONS) {
            assert.ok(option.label && option.label.length > 0);
        }
    });
});

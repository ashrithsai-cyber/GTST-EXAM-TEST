// Small request-input helpers shared by the controllers.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every primary key in the exam database is a uuid. Checking the shape up
// front turns a malformed id into a clean 400/404 instead of a Postgres
// "invalid input syntax for type uuid" error surfacing as a 500.
function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

// Search terms are interpolated into a PostgREST `.or()` filter string,
// where `,` `(` `)` separate/group conditions and `%` `*` `\` are
// pattern characters. Stripping them keeps a search box from being able
// to break (or extend) the filter expression.
function sanitizeSearchTerm(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[,()*%_\\]/g, " ").trim().slice(0, 100);
}

// Student login identifiers (Registration ID, Hall Ticket Number) as typed:
// all whitespace removed (stored values never contain any), then only
// letters, digits, "/" and "-" are accepted. The result is matched with a
// case-insensitive ILIKE, so it must never carry a pattern character —
// `%` `_` `*` `\` all fail this check. Returns null when not acceptable.
const LOGIN_ID_PATTERN = /^[A-Za-z0-9/-]{1,64}$/;
function normalizeLoginId(value) {
    if (typeof value !== "string") return null;
    const compact = value.replace(/\s+/g, "");
    return LOGIN_ID_PATTERN.test(compact) ? compact : null;
}

module.exports = {
    isUuid,
    isNonEmptyString,
    sanitizeSearchTerm,
    normalizeLoginId
};

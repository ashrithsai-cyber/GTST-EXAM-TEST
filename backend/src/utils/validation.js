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
    return value.replace(/[,()*%\\]/g, " ").trim().slice(0, 100);
}

module.exports = {
    isUuid,
    isNonEmptyString,
    sanitizeSearchTerm
};

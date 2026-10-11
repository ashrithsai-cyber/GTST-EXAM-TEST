// In-memory stand-in for the subset of the supabase-js query builder the
// backend uses, so the security test suite exercises the real Express
// routes/controllers end to end WITHOUT touching a real Supabase project.
// Test-only: never imported by application code.
const crypto = require("node:crypto");
const { loginRpc } = require("./loginRpc");
const { monitoringRpc } = require("./monitoringRpc");

// Unique constraints mirrored from backend/sql/*.sql. `where` makes a
// constraint partial (exam_sessions_one_in_progress_per_candidate).
const UNIQUE = {
    exam_candidates: [{ cols: ["registration_id"] }],
    exam_sessions: [
        { cols: ["candidate_id", "exam_id"] },
        { cols: ["candidate_id"], where: (row) => row.status === "IN_PROGRESS" }
    ],
    exam_answers: [{ cols: ["session_id", "question_id"] }],
    exam_preflight: [{ cols: ["candidate_id", "exam_id"] }],
    system_check_screenshots: [{ cols: ["candidate_id", "exam_id"] }],
    student_presence: [{ cols: ["candidate_id"] }],
    student_login_sessions: [{ cols: ["candidate_id"] }, { cols: ["login_session_id"] }],
    admin_users: [{ cols: ["email"] }]
};

// Embedded-resource name -> foreign-key column on the parent row.
const EMBED_FK = {
    questions: "question_id",
    subjects: "subject_id",
    exams: "exam_id",
    exam_candidates: "candidate_id",
    exam_sessions: "session_id",
    admin_users: "admin_id",
    classes: "class_id"
};

function splitTopLevel(spec) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of spec) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function project(db, row, spec) {
    if (!spec || spec.trim() === "*") return { ...row };
    const out = {};
    for (const part of splitTopLevel(spec.replace(/\s+/g, " "))) {
        const embed = part.match(/^([a-z_]+)(?:![a-z_]+)?\((.*)\)$/s);
        if (embed) {
            const [, name, sub] = embed;
            const target = (db.tables[name] || []).find((r) => r.id === row[EMBED_FK[name]]);
            out[name] = target ? project(db, target, sub) : null;
        } else if (part === "*") {
            Object.assign(out, row);
        } else {
            out[part] = row[part] === undefined ? null : row[part];
        }
    }
    return out;
}

function relatedRow(db, table, row) {
    const foreignKey = EMBED_FK[table];
    return foreignKey ? (db.tables[table] || []).find((related) => related.id === row[foreignKey]) : null;
}

function nestedValue(db, baseTable, row, path) {
    const parts = path.split(".");
    let currentTable = baseTable;
    let currentRow = row;
    for (let index = 0; index < parts.length - 1; index++) {
        currentTable = parts[index];
        currentRow = relatedRow(db, currentTable, currentRow);
        if (!currentRow) return undefined;
    }
    return currentRow?.[parts[parts.length - 1]];
}

function relatedPathRow(db, baseTable, row, path) {
    let currentTable = baseTable;
    let currentRow = row;
    for (const relation of path.split(".")) {
        currentTable = relation;
        currentRow = relatedRow(db, currentTable, currentRow);
        if (!currentRow) return null;
    }
    return currentRow;
}

function violatesUnique(db, table, candidate, ignoreRow) {
    for (const constraint of UNIQUE[table] || []) {
        if (constraint.where && !constraint.where(candidate)) continue;
        const clash = (db.tables[table] || []).some((row) =>
            row !== ignoreRow &&
            (!constraint.where || constraint.where(row)) &&
            constraint.cols.every((c) => row[c] === candidate[c])
        );
        if (clash) return true;
    }
    return false;
}

class Query {
    constructor(db, table) {
        this.db = db;
        this.table = table;
        this.filters = [];
        this.op = "select";
        this.selectSpec = "*";
        this.returning = false;
    }

    rows() {
        if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
        return this.db.tables[this.table];
    }

    select(spec = "*", opts = {}) {
        if (this.op === "select") {
            this.selectSpec = spec;
            this.countMode = opts.count;
            this.head = opts.head;
        } else {
            this.returning = true;
            this.selectSpec = spec;
        }
        return this;
    }

    insert(payload) { this.op = "insert"; this.payload = payload; return this; }
    upsert(payload, opts = {}) { this.op = "upsert"; this.payload = payload; this.upsertOpts = opts; return this; }
    update(payload) { this.op = "update"; this.payload = payload; return this; }
    delete() { this.op = "delete"; return this; }

    eq(col, value) { this.filters.push((r) => nestedValue(this.db, this.table, r, col) === value); return this; }
    neq(col, value) { this.filters.push((r) => nestedValue(this.db, this.table, r, col) !== value); return this; }
    in(col, values) { this.filters.push((r) => values.includes(r[col])); return this; }
    is(col, value) { this.filters.push((r) => (r[col] ?? null) === value); return this; }
    gte(col, value) { this.filters.push((r) => { const actual = nestedValue(this.db, this.table, r, col); return actual != null && actual >= value; }); return this; }
    lte(col, value) { this.filters.push((r) => { const actual = nestedValue(this.db, this.table, r, col); return actual != null && actual <= value; }); return this; }
    not(col, operator, value) {
        if (operator === "is") this.filters.push((r) => (r[col] ?? null) !== value);
        return this;
    }
    or(expression, { foreignTable } = {}) {
        const conditions = String(expression).split(",").map((condition) => {
            const match = condition.match(/^([a-z_]+)\.ilike\.(.+)$/i);
            if (!match) throw new Error(`Unsupported test query OR condition: ${condition}`);
            return { column: match[1], pattern: match[2] };
        });
        this.filters.push((row) => {
            const target = foreignTable
                ? relatedPathRow(this.db, this.table, row, foreignTable)
                : row;
            return Boolean(target && conditions.some(({ column, pattern }) => {
                const regex = new RegExp(`^${pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
                return typeof target[column] === "string" && regex.test(target[column]);
            }));
        });
        return this;
    }
    // Postgres ILIKE: case-insensitive, `%` any run, `_` one char, `\` escapes.
    ilike(col, pattern) {
        const source = String(pattern).replace(/\\(.)|([%_])|([^\\%_])/g, (m, escaped, wild, plain) =>
            wild === "%" ? ".*" : wild === "_" ? "." : (escaped ?? plain).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
        const regex = new RegExp(`^${source}$`, "is");
        this.filters.push((r) => typeof r[col] === "string" && regex.test(r[col]));
        return this;
    }
    order(col, { ascending = true } = {}) { this.sort = { col, ascending }; return this; }
    limit(n) { this.limitN = n; return this; }
    range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this; }
    maybeSingle() { this.single_ = "maybe"; return this; }
    single() { this.single_ = "one"; return this; }

    matching() {
        return this.rows().filter((r) => this.filters.every((f) => f(r)));
    }

    execute() {
        const now = new Date().toISOString();
        let result = [];

        if (this.op === "select") {
            result = this.matching();
            if (this.sort) {
                const { col, ascending } = this.sort;
                result = [...result].sort((a, b) => {
                    if (a[col] === b[col]) return 0;
                    if (a[col] == null) return 1;
                    if (b[col] == null) return -1;
                    return (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1);
                });
            }
            const count = result.length;
            if (this.rangeFrom !== undefined) result = result.slice(this.rangeFrom, this.rangeTo + 1);
            if (this.limitN !== undefined) result = result.slice(0, this.limitN);
            if (this.head) return { data: null, error: null, count };
            return this.finish(result.map((r) => project(this.db, r, this.selectSpec)), count);
        }

        if (this.op === "insert") {
            const inserted = [];
            for (const item of [].concat(this.payload)) {
                const row = { id: crypto.randomUUID(), created_at: now,
                    ...(this.table === "questions" && { status: "ACTIVE" }), ...item };
                if (violatesUnique(this.db, this.table, row)) {
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                }
                this.rows().push(row);
                inserted.push(row);
            }
            return this.finish(this.returning ? inserted.map((r) => project(this.db, r, this.selectSpec)) : null);
        }

        if (this.op === "upsert") {
            const conflictCols = (this.upsertOpts.onConflict || "id").split(",").map((c) => c.trim());
            const touched = [];
            for (const item of [].concat(this.payload)) {
                const existing = this.rows().find((r) => conflictCols.every((c) => r[c] === item[c]));
                if (existing) {
                    if (!this.upsertOpts.ignoreDuplicates) Object.assign(existing, item);
                    touched.push(existing);
                } else {
                    const row = { id: crypto.randomUUID(), created_at: now, ...item };
                    this.rows().push(row);
                    touched.push(row);
                }
            }
            return this.finish(this.returning ? touched.map((r) => project(this.db, r, this.selectSpec)) : null);
        }

        if (this.op === "update") {
            const targets = this.matching();
            for (const row of targets) {
                if (violatesUnique(this.db, this.table, { ...row, ...this.payload }, row)) {
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                }
            }
            targets.forEach((row) => Object.assign(row, this.payload));
            return this.finish(this.returning ? targets.map((r) => project(this.db, r, this.selectSpec)) : null);
        }

        if (this.op === "delete") {
            const targets = new Set(this.matching());
            this.db.tables[this.table] = this.rows().filter((r) => !targets.has(r));
            return { data: null, error: null };
        }

        return { data: null, error: { message: `unsupported op ${this.op}` } };
    }

    finish(data, count) {
        if (this.single_ === "maybe") {
            if (data && data.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
            return { data: data?.[0] ?? null, error: null };
        }
        if (this.single_ === "one") {
            if (!data || data.length !== 1) return { data: null, error: { code: "PGRST116", message: "expected one row" } };
            return { data: data[0], error: null };
        }
        return { data, error: null, count };
    }

    then(resolve, reject) {
        try {
            return Promise.resolve(this.execute()).then(resolve, reject);
        } catch (error) {
            return Promise.reject(error).then(resolve, reject);
        }
    }
}

function createMemorySupabase(seed = {}) {
    const db = { tables: JSON.parse(JSON.stringify(seed)), storage: new Map() };
    for (const row of db.tables.questions || []) row.status ??= "ACTIVE";
    return {
        db,
        from: (table) => new Query(db, table),
        rpc: async (name, args = {}) => {
            const monitoringResult = monitoringRpc(db, name, args);
            if (monitoringResult !== undefined) return monitoringResult;
            const eventResult = require('./eventRpc').eventRpc(db, name, args);
            if (eventResult !== undefined) return eventResult;
            const loginResult = loginRpc(db, name, args);
            if (loginResult !== undefined) return loginResult;
            const { attemptRpc } = require("./attemptRpc");
            const attemptResult = await attemptRpc(db, name, args);
            return attemptResult || { data: null, error: { message: `unsupported RPC ${name}` } };
        },
        storage: {
            from: (bucket) => ({
                upload: async (path, buffer, opts) => {
                    db.storage.set(`${bucket}/${path}`, { buffer: Buffer.from(buffer), contentType: opts?.contentType });
                    return { data: { path }, error: null };
                },
                download: async (path) => {
                    const obj = db.storage.get(`${bucket}/${path}`);
                    if (!obj) return { data: null, error: { message: "not found" } };
                    return { data: new Blob([obj.buffer]), error: null };
                },
                remove: async (paths) => {
                    paths.forEach((p) => db.storage.delete(`${bucket}/${p}`));
                    return { data: null, error: null };
                },
                getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.invalid/${bucket}/${path}` } })
            })
        }
    };
}

module.exports = { createMemorySupabase };

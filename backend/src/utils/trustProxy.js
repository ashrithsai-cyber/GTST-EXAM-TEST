// Express "trust proxy" setting for the deployment this process runs in.
//
// Behind a reverse proxy / load balancer (Nginx, Render, Railway, etc.)
// req.ip is the proxy's address unless Express is told how many proxy
// hops to trust — without this every student would share one rate-limit
// bucket, and express-rate-limit rejects the proxy's X-Forwarded-For
// header (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). Trusting exactly the hops
// that exist matters: req.ip is then the address the last trusted proxy
// appended, so client-supplied X-Forwarded-For entries are ignored.
//
// TRUST_PROXY sets the hop count explicitly; on Railway (one edge proxy,
// detected from its injected RAILWAY_* variables) it defaults to 1; with
// no proxy nothing is trusted, so a direct client cannot spoof its IP.
function resolveTrustProxy(env = process.env) {
    const configured = env.TRUST_PROXY?.trim();
    if (configured) {
        if (/^(false|0)$/i.test(configured)) return false;
        const hops = Number(configured);
        return Number.isInteger(hops) && hops > 0 ? hops : configured;
    }
    if (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) return 1;
    return false;
}

module.exports = { resolveTrustProxy };

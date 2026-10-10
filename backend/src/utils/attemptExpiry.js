const supabase = require("../config/examSupabase");

// The database owns the deadline and transaction. A disconnected browser is
// therefore finalized by the server too, including admin presence updates.
function startAttemptExpiryWorker() {
    let running = false;
    const sweep = async () => {
        if (running) return;
        running = true;
        try {
            // At most 20 sequential batches per cycle, no overlapping worker
            // requests. SQL processes <=500 rows with SKIP LOCKED per batch.
            for (let batch = 0; batch < 20; batch += 1) {
                const { data, error } = await supabase.rpc("expire_exam_attempts", { p_session_id: null });
                if (error) throw error;
                if (Number(data) < 500) break;
            }
        } catch (error) {
            console.error("[attemptExpiry] unable to finalize overdue attempts:", error.message || error);
        } finally { running = false; }
    };
    void sweep();
    const timer = setInterval(() => { void sweep(); }, 30000);
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = { startAttemptExpiryWorker };

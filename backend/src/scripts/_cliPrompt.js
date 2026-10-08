const readline = require("readline");

// Shared CLI prompt helpers for the admin bootstrap/reset scripts.
//
// Both prompt() and promptHidden() let a single readline interface own
// stdin's TTY state for the whole call, instead of manually toggling
// process.stdin.setRawMode()/pause()/resume() ourselves alongside it.
// Mixing readline's own internal raw-mode handling with a second,
// independent manual raw-mode toggle on the same stdin stream (as an
// earlier version of createSuperAdmin.js did) is what caused a
// Windows-only crash on exit:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
//
// Two stdin.setRawMode() managers racing to close/reopen the same TTY
// handle left libuv trying to close a handle that was already mid-close.
// Routing every prompt through readline alone avoids that.

function prompt(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

// Same as prompt(), but the typed characters are never echoed. Achieved
// by intercepting the interface's own output writer (how readline
// redraws the input line) rather than reading stdin directly ourselves
// -- readline still owns the TTY handle end to end.
function promptHidden(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const originalWriteToOutput = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (stringToWrite) => {
        if (stringToWrite === query) {
            originalWriteToOutput(stringToWrite);
        }
        // Anything else is the echoed keystroke / line redraw -- swallowed.
    };

    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer);
        });
    });
}

module.exports = { prompt, promptHidden };

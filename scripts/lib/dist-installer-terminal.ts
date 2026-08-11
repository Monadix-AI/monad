export const SHELL_INSTALLER_TERMINAL_GUARD = `MONAD_TERMINAL_STATE=''
MONAD_INPUT_DRAIN_PID=''
MONAD_TERMINAL_DEVICE='/dev/tty'

monad_terminal_lock() {
    monad_is_interactive || return 0
    [ -z "\${MONAD_TERMINAL_STATE:-}" ] || return 0
    MONAD_TERMINAL_STATE=$(stty -g < "$MONAD_TERMINAL_DEVICE" 2>/dev/null) || {
        MONAD_TERMINAL_STATE=''
        return 0
    }
    if ! stty -echo -icanon min 1 time 0 < "$MONAD_TERMINAL_DEVICE" 2>/dev/null; then
        MONAD_TERMINAL_STATE=''
        return 0
    fi
    printf '\\033[?25l' >&2
    cat < "$MONAD_TERMINAL_DEVICE" > /dev/null &
    MONAD_INPUT_DRAIN_PID=$!
}

monad_terminal_unlock() {
    [ -n "\${MONAD_TERMINAL_STATE:-}" ] || return 0
    if [ -n "\${MONAD_INPUT_DRAIN_PID:-}" ]; then
        kill "$MONAD_INPUT_DRAIN_PID" 2>/dev/null || true
        wait "$MONAD_INPUT_DRAIN_PID" 2>/dev/null || true
        MONAD_INPUT_DRAIN_PID=''
    fi
    stty "$MONAD_TERMINAL_STATE" < "$MONAD_TERMINAL_DEVICE" 2>/dev/null || stty echo icanon < "$MONAD_TERMINAL_DEVICE" 2>/dev/null || true
    MONAD_TERMINAL_STATE=''
    printf '\\033[?25h' >&2
}
`;

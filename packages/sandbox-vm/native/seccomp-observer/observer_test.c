#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/poll.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *message) {
    fprintf(stderr, "observer_test: %s\n", message);
    exit(1);
}

static int run_observer(const char *observer, int event_fd, const char *script) {
    pid_t child = fork();
    if (child < 0) fail("fork failed");
    if (child == 0) {
        char fd_text[16];
        snprintf(fd_text, sizeof(fd_text), "%d", event_fd);
        execl(observer, observer, "--event-fd", fd_text, "--", "/bin/sh", "-c", script, NULL);
        _exit(127);
    }
    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) fail("waitpid failed");
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static ssize_t read_events(int fd, char *buffer, size_t capacity) {
    size_t used = 0;
    struct pollfd poll_fd = {.fd = fd, .events = POLLIN};
    while (used + 1 < capacity) {
        int ready = poll(&poll_fd, 1, 100);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) break;
        ssize_t count = read(fd, buffer + used, capacity - used - 1);
        if (count <= 0) break;
        used += (size_t)count;
    }
    buffer[used] = '\0';
    return (ssize_t)used;
}

static void test_signal_passthrough(const char *observer, int event_fd, const char *directory) {
    char ready[512];
    char script[1200];
    char fd_text[16];
    snprintf(ready, sizeof(ready), "%s/signal-ready", directory);
    snprintf(script, sizeof(script), "touch '%s'; exec sleep 30", ready);
    snprintf(fd_text, sizeof(fd_text), "%d", event_fd);
    pid_t child = fork();
    if (child < 0) fail("signal fork failed");
    if (child == 0) {
        execl(observer, observer, "--event-fd", fd_text, "--", "/bin/sh", "-c", script, NULL);
        _exit(127);
    }
    struct stat info;
    int attempts = 0;
    while (stat(ready, &info) < 0 && attempts++ < 500) usleep(10000);
    if (attempts > 500) fail("signal workload did not start");
    if (kill(child, SIGTERM) < 0) fail("signal observer failed");
    int status = 0;
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM) fail("observer did not preserve signal exit");
    unlink(ready);
}

int main(int argc, char **argv) {
    if (argc != 2) fail("expected observer path");

    char directory[] = "/tmp/monad-observer-test-XXXXXX";
    if (!mkdtemp(directory)) fail("mkdtemp failed");
    char write_path[512];
    char read_path[512];
    snprintf(write_path, sizeof(write_path), "%s/write", directory);
    snprintf(read_path, sizeof(read_path), "%s/read", directory);
    int seed = open(read_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (seed < 0 || write(seed, "x", 1) != 1 || close(seed) < 0) fail("seed file failed");

    int events[2];
    if (pipe(events) < 0) fail("pipe failed");
    char script[1200];
    snprintf(script, sizeof(script), "test ! -e /proc/self/fd/%d || exit 42; exec 9>'%s'; printf x >&9; exec 9>&-; cat '%s' >/dev/null", events[1], write_path, read_path);
    if (run_observer(argv[1], events[1], script) != 0) fail("observed command failed");
    close(events[1]);

    char output[8192];
    if (read_events(events[0], output, sizeof(output)) <= 0) fail("missing write observation");
    close(events[0]);
    if (!strstr(output, "\"syscall\":\"openat\"") || !strstr(output, write_path)) fail("write record missing contract fields");
    if (strstr(output, read_path)) fail("read-only open was observed");

    test_signal_passthrough(argv[1], events[1], directory);

    int closed_fd = open("/dev/null", O_RDONLY);
    if (closed_fd < 0) fail("open /dev/null failed");
    close(closed_fd);
    char closed_script[700];
    snprintf(closed_script, sizeof(closed_script), "printf x >'%s/closed'", directory);
    if (run_observer(argv[1], closed_fd, closed_script) != 0) fail("closed event fd blocked workload");

    unlink(write_path);
    unlink(read_path);
    char closed_path[512];
    snprintf(closed_path, sizeof(closed_path), "%s/closed", directory);
    unlink(closed_path);
    rmdir(directory);
    return 0;
}

// stuga-job: runs one of Stuga's launchd scripts with /bin/bash, in its own place.
//
//   stuga-job <script> [arguments...]
//
// macOS names a launchd job in Login Items after the app its AssociatedBundleIdentifiers gives only
// when the job's program is signed by that app's team, which /bin/bash is not: a job run by bash is
// listed as "bash", from an unknown developer. Each job's program is this, signed by Stuga's team,
// and it becomes bash, so the process, its signals and its exit status stay the script's.
// build-runtime.sh compiles it.
#include <stdio.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: stuga-job <script> [arguments...]\n");
        return 64;
    }
    argv[0] = (char *)"/bin/bash";
    execv("/bin/bash", argv);
    perror("stuga-job: /bin/bash");
    return 71;
}

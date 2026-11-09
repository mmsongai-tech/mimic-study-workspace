import os
import resource
import sys


def main() -> None:
    if len(sys.argv) < 6:
        raise SystemExit(64)
    cpu_seconds = int(sys.argv[1])
    memory_mb = int(sys.argv[2])
    output_bytes = int(sys.argv[3])
    command = sys.argv[4:]
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    memory_bytes = memory_mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (ValueError, OSError):
        pass
    os.execv(command[0], command)


if __name__ == "__main__":
    main()


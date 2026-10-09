"""Command-line entry point: ``python -m textstats FILE``."""

import argparse
import sys

from .core import count_sentences, count_words, most_common_words


def format_stats(text):
    """Return a human-readable report of the stats for ``text``."""
    lines = [
        f"Words: {count_words(text)}",
        f"Sentences: {count_sentences(text)}",
        "Most common words:",
    ]
    common = most_common_words(text, 5)
    if common:
        lines.extend(f"  {word}: {count}" for word, count in common)
    else:
        lines.append("  (none)")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m textstats",
        description="Print word, sentence and most-common-word stats for a text file.",
    )
    parser.add_argument("file", help="path to a UTF-8 text file, or - for stdin")
    args = parser.parse_args(argv)

    try:
        if args.file == "-":
            text = sys.stdin.read()
        else:
            with open(args.file, encoding="utf-8") as f:
                text = f.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"textstats: cannot read {args.file}: {exc}", file=sys.stderr)
        return 1

    print(format_stats(text))
    return 0


if __name__ == "__main__":
    sys.exit(main())

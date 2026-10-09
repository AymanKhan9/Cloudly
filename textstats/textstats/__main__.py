"""Command-line entry point: ``python -m textstats FILE``."""

import argparse
import sys

from .core import count_sentences, count_words, most_common_words


DEFAULT_TOP = 5


def positive_int(value):
    """argparse type: an integer >= 1."""
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid integer: {value!r}") from None
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {number}")
    return number


def format_stats(text, top=DEFAULT_TOP):
    """Return a human-readable report of the stats for ``text``."""
    lines = [
        f"Words: {count_words(text)}",
        f"Sentences: {count_sentences(text)}",
        "Most common words:",
    ]
    common = most_common_words(text, top)
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
    parser.add_argument(
        "--top",
        type=positive_int,
        default=DEFAULT_TOP,
        metavar="N",
        help=f"number of most common words to show (default: {DEFAULT_TOP})",
    )
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

    print(format_stats(text, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())

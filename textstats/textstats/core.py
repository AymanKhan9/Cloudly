"""Core text statistics functions."""

import re
from collections import Counter

# A word is a run of letters/digits (no underscores), optionally joined by
# internal apostrophes or hyphens ("don't", "well-known", "rock'n'roll"),
# or by "." / "," between digits so numbers like "3.14" and "1,000" stay whole.
_WORD_RE = re.compile(r"[^\W_]+(?:(?:['’\-]|(?<=\d)[.,](?=\d))[^\W_]+)*")

# A sentence ends at one or more terminators (., !, ?, …) followed by
# whitespace or end of text. Requiring whitespace keeps "3.14" or "e.g" intact.
_SENTENCE_END_RE = re.compile(r"[.!?…]+(?=\s|$)")


def words(text):
    """Return the list of words in ``text`` in order of appearance."""
    return _WORD_RE.findall(text)


def count_words(text):
    """Return the number of words in ``text``."""
    return len(words(text))


def count_sentences(text):
    """Return the number of sentences in ``text``.

    Text after the last terminator still counts as a sentence, so
    "Hello world" is one sentence. Fragments with no words (such as a
    stray "..." or "?!") are not counted.
    """
    return sum(1 for part in _SENTENCE_END_RE.split(text) if _WORD_RE.search(part))


def most_common_words(text, n=5):
    """Return up to ``n`` ``(word, count)`` pairs, most frequent first.

    Matching is case-insensitive and words are returned in lowercase.
    Ties are ordered by first appearance in the text.
    """
    counts = Counter(word.lower() for word in words(text))
    return counts.most_common(n)

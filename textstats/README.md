# textstats

A small, standard-library-only Python package for basic text statistics.

## Usage

Run from this directory (`textstats/`), with Python 3.8+:

```sh
python -m textstats FILE     # read a UTF-8 text file
python -m textstats -        # read from stdin
python -m textstats --top 10 FILE   # show the 10 most common words (default: 5)
```

`--top N` must be a whole number of at least 1. If the text has fewer than N distinct words, all of them are shown.

Example output:

```
Words: 8
Sentences: 3
Most common words:
  the: 2
  cat: 2
  sat: 1
  ran: 1
  did: 1
```

From Python:

```python
from textstats import count_words, count_sentences, most_common_words

count_words("Don't panic. It's fine!")        # 4
count_sentences("Don't panic. It's fine!")    # 2
most_common_words("a b a c a b", n=2)         # [('a', 3), ('b', 2)]
```

How text is counted:

- **Words** are runs of letters or digits. Apostrophes and hyphens inside a word keep it whole (`don't`, `well-known`), and so do `.`/`,` between digits (`3.14`, `1,000`). Underscores separate words.
- **Sentences** end at `.`, `!`, `?` or `…` followed by whitespace or the end of the text. Repeated marks like `?!` or `...` count once, and text without a final mark still counts as a sentence. Abbreviations such as `Dr.` are not detected, so they count as sentence ends.
- **Most common words** ignore case, are returned in lowercase, and ties keep the order in which the words first appear.

Run the tests:

```sh
python -m unittest discover -s tests -t .
```

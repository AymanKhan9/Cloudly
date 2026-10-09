import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from textstats import count_sentences, count_words, most_common_words
from textstats.__main__ import main

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NormalTextTests(unittest.TestCase):
    TEXT = (
        "The cat sat on the mat. The dog sat on the log! "
        "Did the cat see the dog? Yes, the cat did."
    )

    def test_count_words(self):
        self.assertEqual(count_words(self.TEXT), 22)

    def test_count_sentences(self):
        self.assertEqual(count_sentences(self.TEXT), 4)

    def test_most_common_words(self):
        self.assertEqual(
            most_common_words(self.TEXT),
            [("the", 7), ("cat", 3), ("sat", 2), ("on", 2), ("dog", 2)],
        )

    def test_most_common_is_case_insensitive(self):
        self.assertEqual(most_common_words("Apple apple APPLE pear"), [("apple", 3), ("pear", 1)])

    def test_most_common_ties_keep_first_appearance_order(self):
        self.assertEqual(
            most_common_words("f e d c b a"),
            [("f", 1), ("e", 1), ("d", 1), ("c", 1), ("b", 1)],
        )

    def test_most_common_custom_n(self):
        self.assertEqual(most_common_words("a a b", n=1), [("a", 2)])

    def test_multiline_text(self):
        text = "First line here.\nSecond line\nstill second.\n\nThird."
        self.assertEqual(count_words(text), 8)
        self.assertEqual(count_sentences(text), 3)

    def test_unicode_words(self):
        self.assertEqual(count_words("Café naïve façade. Über straße!"), 5)
        self.assertEqual(count_sentences("Café naïve façade. Über straße!"), 2)


class EmptyTextTests(unittest.TestCase):
    def test_empty_string(self):
        self.assertEqual(count_words(""), 0)
        self.assertEqual(count_sentences(""), 0)
        self.assertEqual(most_common_words(""), [])

    def test_whitespace_only(self):
        text = "   \n\t  \n"
        self.assertEqual(count_words(text), 0)
        self.assertEqual(count_sentences(text), 0)
        self.assertEqual(most_common_words(text), [])

    def test_punctuation_only(self):
        text = "... !!! ??? -- , ;"
        self.assertEqual(count_words(text), 0)
        self.assertEqual(count_sentences(text), 0)
        self.assertEqual(most_common_words(text), [])


class PunctuationEdgeCaseTests(unittest.TestCase):
    def test_no_terminal_punctuation_is_one_sentence(self):
        self.assertEqual(count_sentences("hello world"), 1)

    def test_repeated_terminators_count_once(self):
        self.assertEqual(count_sentences("Wait... What?! No!!!"), 3)

    def test_unicode_ellipsis(self):
        self.assertEqual(count_sentences("Well… maybe."), 2)

    def test_decimal_numbers_do_not_split_sentences(self):
        text = "Pi is 3.14 roughly."
        self.assertEqual(count_sentences(text), 1)
        self.assertEqual(count_words(text), 4)
        self.assertEqual(most_common_words("Paid 1,000 then 3.14"), [
            ("paid", 1), ("1,000", 1), ("then", 1), ("3.14", 1),
        ])

    def test_number_followed_by_period_ends_sentence(self):
        self.assertEqual(count_sentences("I have 3. You have 4."), 2)
        self.assertEqual(count_words("I have 3. You have 4."), 6)

    def test_contractions_are_single_words(self):
        self.assertEqual(count_words("Don't stop, it's fine."), 4)
        self.assertEqual(count_words("It’s fine"), 2)

    def test_hyphenated_words_are_single_words(self):
        self.assertEqual(count_words("A well-known state-of-the-art tool."), 4)

    def test_stray_dashes_and_quotes_are_not_words(self):
        self.assertEqual(count_words("one - two -- 'three' \"four\""), 4)
        self.assertEqual(
            most_common_words("'quoted' quoted \"quoted\""), [("quoted", 3)]
        )

    def test_punctuation_attached_to_words(self):
        self.assertEqual(most_common_words("end. end, end! (end)"), [("end", 4)])

    def test_underscores_are_separators(self):
        self.assertEqual(count_words("snake_case"), 2)

    def test_leading_punctuation_fragment_not_counted(self):
        self.assertEqual(count_sentences("?! Hello there."), 1)


class CliTests(unittest.TestCase):
    def _write_temp(self, content):
        fd, path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        self.addCleanup(os.remove, path)
        return path

    def test_main_prints_stats(self):
        path = self._write_temp("Hello world. Hello again!")
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([path])
        self.assertEqual(code, 0)
        self.assertEqual(
            out.getvalue(),
            "Words: 4\nSentences: 2\nMost common words:\n"
            "  hello: 2\n  world: 1\n  again: 1\n",
        )

    def test_main_empty_file(self):
        path = self._write_temp("")
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([path])
        self.assertEqual(code, 0)
        self.assertEqual(
            out.getvalue(), "Words: 0\nSentences: 0\nMost common words:\n  (none)\n"
        )

    def test_main_missing_file(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = main([os.path.join(tempfile.gettempdir(), "no-such-file-textstats.txt")])
        self.assertEqual(code, 1)
        self.assertIn("cannot read", err.getvalue())

    def test_python_dash_m(self):
        path = self._write_temp("One fish. Two fish.")
        result = subprocess.run(
            [sys.executable, "-m", "textstats", path],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("Words: 4", result.stdout)
        self.assertIn("Sentences: 2", result.stdout)
        self.assertIn("fish: 2", result.stdout)


if __name__ == "__main__":
    unittest.main()

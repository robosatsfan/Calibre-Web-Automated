# Calibre-Web Automated – fork of Calibre-Web
# Copyright (C) 2018-2026 Calibre-Web contributors
# Copyright (C) 2024-2026 Calibre-Web Automated contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# See CONTRIBUTORS for full list of authors.

"""Unit tests for the pure Notes helpers (no Flask app context required)."""

import pytest

from cps.notes_utils import (MAX_TAG, clean_note_text, normalize_tags, render_markdown,
                             valid_cfi)


@pytest.mark.unit
class TestNormalizeTags:
    def test_empty(self):
        assert normalize_tags('') == ''
        assert normalize_tags(None) == ''
        assert normalize_tags(' , , ') == ''

    def test_lowercase_dedupe_and_strip(self):
        assert normalize_tags(' a, A , b,, ') == 'a,b'

    def test_order_is_preserved(self):
        assert normalize_tags('zeta,alpha,beta') == 'zeta,alpha,beta'

    def test_long_tag_is_truncated(self):
        result = normalize_tags('x' * (MAX_TAG + 50))
        assert len(result) == MAX_TAG


@pytest.mark.unit
class TestValidCfi:
    def test_accepts_cfi_range(self):
        assert valid_cfi('epubcfi(/6/4!/4/2/2[c01]/1:0)')

    def test_rejects_empty(self):
        assert not valid_cfi('')
        assert not valid_cfi(None)

    def test_rejects_script_like_values(self):
        assert not valid_cfi('javascript:alert(1)')
        assert not valid_cfi('epubcfi(x')

    def test_rejects_overlong(self):
        assert not valid_cfi('epubcfi(' + 'a' * 2049 + ')')


@pytest.mark.unit
class TestCleanNoteText:
    def test_none_becomes_empty(self):
        assert clean_note_text(None, 10) == ''

    def test_truncation(self):
        assert clean_note_text('abcdef', 3) == 'abc'

    def test_control_characters_removed_but_newlines_kept(self):
        assert clean_note_text('a\x00b\x07c\nd\te', 100) == 'abc\nd\te'

    def test_strips_control_range(self):
        assert clean_note_text('\x1b[31mred', 100) == '[31mred'


@pytest.mark.unit
class TestRenderMarkdown:
    def test_bold_becomes_strong(self):
        assert '<strong>bold</strong>' in render_markdown('**bold**')

    def test_lists_survive(self):
        html = render_markdown('- one\n- two')
        assert '<ul>' in html and '<li>one</li>' in html

    def test_script_is_neutralized(self):
        html = render_markdown('<script>alert(1)</script>')
        assert '<script' not in html
        assert 'alert(1)' in html  # shown as text, not executed

    def test_onerror_attribute_is_removed(self):
        # The payload is escaped into inert text by markdown2/bleach, never a real attribute
        html = render_markdown('<img src=x onerror=alert(1)>')
        assert '<img' not in html
        assert '&lt;img' in html

    def test_javascript_link_is_removed(self):
        html = render_markdown('[click](javascript:alert(1))')
        assert 'javascript:' not in html

    def test_quote_refs_become_anchor_links(self):
        html = render_markdown('see [#2] and [#5]', {2, 5})
        assert 'href="#quote-2"' in html and 'href="#quote-5"' in html
        assert '[#2]' in html

    def test_unknown_quote_ref_is_left_alone(self):
        html = render_markdown('see [#3]', {1})
        assert 'href="#quote-3"' not in html
        assert '[#3]' in html

    def test_quote_refs_inside_code_are_not_linked(self):
        html = render_markdown('inline `[#1]` then\n\n```\n[#1]\n```\n\nand [#1]', {1})
        # Only the trailing reference outside code becomes a link
        assert html.count('href="#quote-1"') == 1
        assert '[#1]' in html

    def test_quote_refs_do_not_enable_html_injection(self):
        html = render_markdown('[#1] <script>alert(1)</script>', {1})
        assert 'href="#quote-1"' in html
        assert '<script' not in html

    def test_no_quote_seqs_keeps_plain_text(self):
        html = render_markdown('see [#2]')
        assert 'href="#quote-2"' not in html

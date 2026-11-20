# Calibre-Web Automated – fork of Calibre-Web
# Copyright (C) 2018-2026 Calibre-Web contributors
# Copyright (C) 2024-2026 Calibre-Web Automated contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# See CONTRIBUTORS for full list of authors.

"""Pure helpers for the Notes feature. No Flask imports, so they are easy to test."""

import re
from html import escape

MAX_TITLE = 255
MAX_BODY = 50_000
MAX_QUOTE = 5_000
MAX_COMMENT = 5_000
MAX_CFI = 2_048
MAX_TAG = 64
ALLOWED_FORMATS = ('EPUB', 'KEPUB', 'PDF')

# Strip control characters but keep tab (\t) and newline (\n)
_CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')


def normalize_tags(raw):
    """Split, trim, lowercase, de-duplicate and re-join a comma separated tag string."""
    if not raw:
        return ''
    tags = []
    seen = set()
    for part in str(raw).split(','):
        tag = part.strip().lower()[:MAX_TAG]
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return ','.join(tags)


def valid_cfi(value):
    """Return True for something that looks like a single EPUB CFI range."""
    if not isinstance(value, str):
        return False
    value = value.strip()
    return bool(value) and value.startswith('epubcfi(') and value.endswith(')') \
        and len(value) <= MAX_CFI


def clean_note_text(value, limit):
    """Coerce to str, drop control characters, then truncate to ``limit`` characters."""
    if value is None:
        return ''
    text = _CONTROL_CHARS.sub('', str(value))
    if limit is None or limit < 0:
        return text
    return text[:limit]


def render_markdown(text):
    """Render user Markdown to sanitized HTML."""
    from cps.clean_html import clean_string

    source = text or ''
    try:
        import markdown2
    except ImportError:
        return clean_string(escape(source).replace('\n', '<br>'))

    html = markdown2.markdown(source,
                              safe_mode='escape',
                              extras=['fenced-code-blocks', 'tables', 'strike'])
    return clean_string(html)

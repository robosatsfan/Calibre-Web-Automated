# Calibre-Web Automated – fork of Calibre-Web
# Copyright (C) 2018-2026 Calibre-Web contributors
# Copyright (C) 2024-2026 Calibre-Web Automated contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# See CONTRIBUTORS for full list of authors.

"""Notes feature: per-user Markdown notes with book quotes."""

from datetime import datetime, timezone

from flask import Blueprint, Response, abort, flash, g, jsonify, redirect, request, url_for
from flask_babel import gettext as _
from sqlalchemy import func, or_

from . import calibre_db, logger, ub
from .cw_login import current_user
from .notes_utils import (ALLOWED_FORMATS, MAX_BODY, MAX_COMMENT, MAX_QUOTE, MAX_TITLE,
                          clean_note_text, normalize_tags, render_markdown, valid_cfi)
from .pagination import Pagination
from .render_template import render_title_template
from .usermanagement import user_login_required

log = logger.create()

notes = Blueprint('notes', __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _own_note_or_404(note_id):
    note = ub.session.query(ub.Note).filter(ub.Note.id == note_id,
                                            ub.Note.user_id == current_user.id).first()
    if note is None:
        abort(404)
    return note


def _visible_note_or_404(note_id):
    note = ub.session.query(ub.Note).filter(ub.Note.id == note_id).first()
    if note is None or (note.user_id != current_user.id and not note.is_public):
        abort(404)
    return note


def _touch_note(note):
    note.updated_at = datetime.now(timezone.utc)


def _next_seq(session, note_id):
    """Next stable quote number for ``note_id`` (never reuses a number)."""
    highest = session.query(func.max(ub.NoteCitation.seq)).filter(
        ub.NoteCitation.note_id == note_id).scalar()
    return (highest or 0) + 1


def _book_meta(book_id):
    """Return {'id', 'title', 'authors', 'formats'} for an accessible book, else None (cached per request)."""
    try:
        book_id = int(book_id)
    except (TypeError, ValueError):
        return None
    cache = g.get('cwa_note_books')
    if cache is None:
        cache = {}
        g.cwa_note_books = cache
    if book_id in cache:
        return cache[book_id]

    meta = None
    try:
        book = calibre_db.get_filtered_book(book_id)
    except Exception as ex:
        log.debug("Notes: could not load book %s: %s", book_id, ex)
        book = None
    if book is not None:
        try:
            authors = ', '.join(a.name.replace('|', ',') for a in book.authors)
        except Exception:
            authors = ''
        formats = set()
        for data in getattr(book, 'data', []) or []:
            if data.format:
                formats.add(data.format.upper())
        meta = {'id': book_id, 'title': book.title or '', 'authors': authors, 'formats': formats}
    cache[book_id] = meta
    return meta


def _book_accessible(book_id):
    return _book_meta(book_id) is not None


def _citation_dict(citation):
    meta = _book_meta(citation.book_id)
    return {
        'id': citation.id,
        'note_id': citation.note_id,
        'seq': citation.seq,
        'note_title': citation.note.title if citation.note else '',
        'book_id': citation.book_id,
        'book_title': meta['title'] if meta else _('Unknown book'),
        'book_format': citation.book_format,
        'quote': citation.quote,
        'comment': citation.comment,
        'cfi_range': citation.cfi_range,
        'chapter_label': citation.chapter_label,
        'page': citation.page,
        'paragraph': citation.paragraph,
        'color': citation.color,
        'created_at': citation.created_at.isoformat() if citation.created_at else None,
        'open_url': url_for('notes.citation_open', citation_id=citation.id),
    }


def _citation_views(note, is_owner=True):
    """Citations of ``note`` together with resolved book data.

    Quotes from books the viewer cannot access are marked ``visible=False`` so shared
    notes never expose them.
    """
    views = []
    citations = sorted(note.citations,
                       key=lambda item: (item.seq is None, item.seq or 0, item.id or 0))
    for citation in citations:
        meta = _book_meta(citation.book_id)
        views.append({
            'citation': citation,
            'book_meta': meta,
            'book_title': meta['title'] if meta else None,
            'available': meta is not None and (citation.book_format or '').upper() in meta['formats'],
            'visible': is_owner or _book_accessible(citation.book_id),
        })
    return views


def _own_citation_or_404(citation_id):
    citation = ub.session.query(ub.NoteCitation).filter(
        ub.NoteCitation.id == citation_id,
        ub.NoteCitation.user_id == current_user.id).first()
    if citation is None:
        abort(404)
    return citation


def _json_error(message, status=400):
    return jsonify({"error": message}), status


NOTES_PER_PAGE = 25


def _query_notes(args, force_scope=None):
    """Build the filtered Notes query shared by the list page and the export."""
    query = ub.session.query(ub.Note).outerjoin(ub.NoteCitation).distinct()

    scope = force_scope or (args.get('scope') or 'mine').lower()
    if scope == 'shared':
        query = query.filter(ub.Note.is_public.is_(True),
                             ub.Note.user_id != current_user.id)
    else:
        scope = 'mine'
        query = query.filter(ub.Note.user_id == current_user.id)

    term = (args.get('q') or '').strip()
    if term:
        like = '%{}%'.format(term)
        query = query.filter(or_(ub.Note.title.ilike(like),
                                 ub.Note.body.ilike(like),
                                 ub.Note.tags.ilike(like),
                                 ub.NoteCitation.quote.ilike(like)))

    book_id = args.get('book_id', type=int)
    if book_id:
        query = query.filter(ub.NoteCitation.book_id == book_id)
    else:
        book_id = None

    tag = normalize_tags(args.get('tag') or '')
    if tag:
        query = query.filter(or_(ub.Note.tags == tag,
                                 ub.Note.tags.like(tag + ',%'),
                                 ub.Note.tags.like('%,' + tag),
                                 ub.Note.tags.like('%,' + tag + ',%')))

    note_type = (args.get('type') or '').lower()
    if note_type == 'free':
        query = query.filter(~ub.Note.citations.any())
    elif note_type == 'cited':
        query = query.filter(ub.Note.citations.any())
    else:
        note_type = ''

    return query.order_by(ub.Note.updated_at.desc()), {
        'scope': scope,
        'q': term,
        'tag': tag,
        'type': note_type,
        'book_id': book_id,
    }


def _values_from_form():
    return {
        'title': clean_note_text(request.form.get('title'), MAX_TITLE),
        'body': clean_note_text(request.form.get('body'), MAX_BODY),
        'tags': request.form.get('tags') or '',
        'shared': request.form.get('shared') is not None,
    }


def _apply_note_form(note):
    """Copy submitted values onto ``note``; return an error message or None."""
    values = _values_from_form()
    if not values['title'].strip():
        return _('A title is required')
    note.title = values['title'].strip()
    note.body = values['body']
    note.tags = normalize_tags(values['tags'])
    note.is_public = values['shared']
    return None


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@notes.route("/notes")
@user_login_required
def notes_list():
    page_number = request.args.get('page', 1, type=int)
    if page_number < 1:
        page_number = 1
    query, filters = _query_notes(request.args)
    total = query.count()
    pagination = Pagination(page_number, NOTES_PER_PAGE, total)
    own_notes = query.offset((page_number - 1) * NOTES_PER_PAGE) \
        .limit(NOTES_PER_PAGE).all()

    book_filter_title = None
    if filters['book_id']:
        meta = _book_meta(filters['book_id'])
        book_filter_title = meta['title'] if meta else _('Unknown book')

    return render_title_template('notes_list.html',
                                 notes=own_notes,
                                 pagination=pagination,
                                 filters=filters,
                                 book_filter_title=book_filter_title,
                                 title=_("Notes"),
                                 page="notes")


@notes.route("/notes/new", methods=["GET", "POST"])
@user_login_required
def note_create():
    if request.method == "POST":
        note = ub.Note(user_id=current_user.id)
        error = _apply_note_form(note)
        if error:
            flash(error, category="error")
            return render_title_template('note_edit.html',
                                         note=None,
                                         values=_values_from_form(),
                                         title=_("New note"),
                                         page="notes")
        ub.session.add(note)
        ub.session_commit()
        return redirect(url_for('notes.note_view', note_id=note.id))
    return render_title_template('note_edit.html',
                                 note=None,
                                 values=None,
                                 title=_("New note"),
                                 page="notes")


@notes.route("/notes/<int:note_id>")
@user_login_required
def note_view(note_id):
    note = _visible_note_or_404(note_id)
    is_owner = note.user_id == current_user.id
    views = _citation_views(note, is_owner=is_owner)
    quote_seqs = {item['citation'].seq for item in views
                  if item['citation'].seq is not None}
    quote_comments = []
    for item in views:
        citation = item['citation']
        if not item['visible'] or not (citation.comment or '').strip():
            continue
        quote_comments.append({
            'num': citation.seq if citation.seq is not None else citation.id,
            'color': citation.color,
            'comment': citation.comment,
            'book_title': item['book_title'],
        })
    return render_title_template('note_view.html',
                                 note=note,
                                 citation_views=views,
                                 quote_comments=quote_comments,
                                 rendered_body=render_markdown(note.body, quote_seqs),
                                 is_owner=is_owner,
                                 title=note.title or _("Note"),
                                 page="notes")


@notes.route("/notes/<int:note_id>/edit", methods=["GET", "POST"])
@user_login_required
def note_edit(note_id):
    note = _own_note_or_404(note_id)
    if request.method == "POST":
        error = _apply_note_form(note)
        if error:
            flash(error, category="error")
            return render_title_template('note_edit.html',
                                         note=note,
                                         values=_values_from_form(),
                                         citation_views=_citation_views(note),
                                         title=note.title or _("Note"),
                                         page="notes")
        _touch_note(note)
        ub.session_commit()
        return redirect(url_for('notes.note_view', note_id=note.id))
    return render_title_template('note_edit.html',
                                 note=note,
                                 values=None,
                                 citation_views=_citation_views(note),
                                 title=note.title or _("Note"),
                                 page="notes")


@notes.route("/notes/<int:note_id>/delete", methods=["POST"])
@user_login_required
def note_delete(note_id):
    note = _own_note_or_404(note_id)
    ub.session.delete(note)
    ub.session_commit()
    flash(_("Note deleted"), category="success")
    return redirect(url_for('notes.notes_list'))


# ---------------------------------------------------------------------------
# Markdown preview (write/preview toggle)
# ---------------------------------------------------------------------------

@notes.route("/notes/preview", methods=["POST"])
@user_login_required
def notes_preview():
    payload = request.get_json(silent=True) or {}
    text = payload.get('text')
    if text is None:
        text = request.form.get('body', '')
    quote_seqs = set()
    note_id = payload.get('note_id')
    if note_id not in (None, '', 0, '0'):
        try:
            note = ub.session.query(ub.Note).filter(
                ub.Note.id == int(note_id), ub.Note.user_id == current_user.id).first()
        except (TypeError, ValueError):
            note = None
        if note is not None:
            quote_seqs = {citation.seq for citation in note.citations
                          if citation.seq is not None}
    return jsonify({"html": render_markdown(clean_note_text(text, MAX_BODY), quote_seqs)})


# ---------------------------------------------------------------------------
# Citations: jump route
# ---------------------------------------------------------------------------

@notes.route("/notes/citation/<int:citation_id>/open")
@user_login_required
def citation_open(citation_id):
    citation = ub.session.query(ub.NoteCitation).filter(ub.NoteCitation.id == citation_id).first()
    if citation is None:
        abort(404)
    note = citation.note
    if note is None or (note.user_id != current_user.id and not note.is_public):
        abort(404)
    meta = _book_meta(citation.book_id)
    if meta is None:
        flash(_('That book is no longer available'), category="error")
        return redirect(url_for('notes.note_view', note_id=note.id))
    book_format = (citation.book_format or '').upper()
    if book_format not in meta['formats']:
        flash(_('That book format is no longer available'), category="error")
        return redirect(url_for('notes.note_view', note_id=note.id))

    if book_format in ('EPUB', 'KEPUB'):
        kwargs = {'book_id': citation.book_id, 'book_format': book_format.lower(),
                  'citation': citation.id}
        if citation.cfi_range:
            kwargs['cfi'] = citation.cfi_range
        return redirect(url_for('web.read_book', **kwargs))
    return redirect(url_for('web.read_book', book_id=citation.book_id, book_format='pdf')
                    + '#page=' + str(citation.page or 1))


# ---------------------------------------------------------------------------
# Citations: JSON API
# ---------------------------------------------------------------------------

@notes.route("/ajax/notes/book/<int:book_id>")
@user_login_required
def notes_book_api(book_id):
    citations = ub.session.query(ub.NoteCitation).join(ub.Note) \
        .filter(ub.NoteCitation.user_id == current_user.id,
                ub.NoteCitation.book_id == book_id,
                ub.Note.user_id == current_user.id) \
        .order_by(ub.NoteCitation.created_at.desc()).all()
    return jsonify([_citation_dict(citation) for citation in citations])


@notes.route("/ajax/notes/mine")
@user_login_required
def notes_mine():
    query = ub.session.query(ub.Note).filter(ub.Note.user_id == current_user.id)
    term = (request.args.get('q') or '').strip()
    if term:
        like = '%{}%'.format(term)
        query = query.filter(or_(ub.Note.title.ilike(like),
                                 ub.Note.body.ilike(like),
                                 ub.Note.tags.ilike(like)))
    own_notes = query.order_by(ub.Note.updated_at.desc()).limit(20).all()
    return jsonify([{'id': note.id, 'title': note.title} for note in own_notes])


def _validated_citation_payload(payload):
    """Return (values, error_message). ``values`` is a dict of cleaned citation fields."""
    try:
        book_id = int(payload.get('book_id'))
    except (TypeError, ValueError):
        return None, _('Invalid book')
    if not _book_accessible(book_id):
        return None, _('That book is no longer available')

    book_format = str(payload.get('book_format') or '').upper()
    if book_format not in ALLOWED_FORMATS:
        return None, _('Invalid book format')

    color = payload.get('color') or 'yellow'
    if color not in ub.NoteCitation.COLORS:
        return None, _('Invalid color')

    quote = clean_note_text(payload.get('quote'), MAX_QUOTE).strip()
    comment = clean_note_text(payload.get('comment'), MAX_COMMENT).strip()
    if not quote and not comment:
        return None, _('A quote or a comment is required')

    cfi_range = None
    page = None
    paragraph = None
    if book_format in ('EPUB', 'KEPUB'):
        cfi_range = payload.get('cfi_range')
        if not valid_cfi(cfi_range):
            return None, _('Invalid EPUB location')
    else:
        try:
            page = int(payload.get('page'))
        except (TypeError, ValueError):
            return None, _('A valid page number is required')
        if page < 1:
            return None, _('A valid page number is required')
        if payload.get('paragraph') not in (None, ''):
            try:
                paragraph = int(payload.get('paragraph'))
            except (TypeError, ValueError):
                return None, _('Invalid paragraph number')
            if paragraph < 1:
                return None, _('Invalid paragraph number')

    return {
        'book_id': book_id,
        'book_format': book_format,
        'color': color,
        'quote': quote,
        'comment': comment,
        'cfi_range': cfi_range,
        'page': page,
        'paragraph': paragraph,
        'chapter_label': clean_note_text(payload.get('chapter_label'), MAX_TITLE).strip() or None,
    }, None


@notes.route("/ajax/notes/citation", methods=["POST"])
@user_login_required
def citation_create():
    payload = request.get_json(silent=True) or {}
    values, error = _validated_citation_payload(payload)
    if error:
        log.debug("Notes: rejected citation: %s", error)
        return _json_error(error)

    note_id = payload.get('note_id')
    if note_id not in (None, '', 0, '0'):
        try:
            note = ub.session.query(ub.Note).filter(ub.Note.id == int(note_id),
                                                    ub.Note.user_id == current_user.id).first()
        except (TypeError, ValueError):
            note = None
        if note is None:
            return _json_error(_('Note not found'), 404)
    else:
        title = clean_note_text(payload.get('note_title'), MAX_TITLE).strip()
        if not title:
            book_title = _book_meta(values['book_id'])['title'] or _('Unknown book')
            first_words = values['quote'][:60].strip()
            title = '{} – {}'.format(book_title, first_words) if first_words else book_title
            title = title.strip() or _('Note')
        note = ub.Note(user_id=current_user.id, title=title[:MAX_TITLE], body='', tags='',
                       is_public=False)
        ub.session.add(note)

    if note.id is None:
        ub.session.flush()
    citation = ub.NoteCitation(note=note,
                               user_id=current_user.id,
                               seq=_next_seq(ub.session, note.id),
                               book_id=values['book_id'],
                               book_format=values['book_format'],
                               quote=values['quote'],
                               comment=values['comment'],
                               cfi_range=values['cfi_range'],
                               chapter_label=values['chapter_label'],
                               page=values['page'],
                               paragraph=values['paragraph'],
                               color=values['color'])
    ub.session.add(citation)
    _touch_note(note)
    ub.session_commit()
    return jsonify(_citation_dict(citation)), 201


@notes.route("/ajax/notes/citation/<int:citation_id>/update", methods=["POST"])
@user_login_required
def citation_update(citation_id):
    citation = _own_citation_or_404(citation_id)
    payload = request.get_json(silent=True) or {}
    if 'color' in payload:
        color = payload.get('color')
        if color not in ub.NoteCitation.COLORS:
            return _json_error(_('Invalid color'))
        citation.color = color
    if 'comment' in payload:
        citation.comment = clean_note_text(payload.get('comment'), MAX_COMMENT).strip()
    if citation.note is not None:
        _touch_note(citation.note)
    ub.session_commit()
    return jsonify(_citation_dict(citation))


@notes.route("/ajax/notes/citation/<int:citation_id>/delete", methods=["POST"])
@user_login_required
def citation_delete(citation_id):
    citation = _own_citation_or_404(citation_id)
    note = citation.note
    ub.session.delete(citation)
    if note is not None:
        _touch_note(note)
    ub.session_commit()
    return '', 204


# ---------------------------------------------------------------------------
# Export (own notes only)
# ---------------------------------------------------------------------------

def _markdown_escape_body(text):
    """Indent user text so a stray heading marker cannot break the export structure."""
    lines = []
    for line in (text or '').splitlines():
        if line.lstrip().startswith('#'):
            line = line.replace('#', '\\#', 1)
        lines.append(line)
    return '\n'.join(lines)


def _markdown_quote_block(text):
    lines = []
    for line in (text or '').splitlines():
        lines.append('> ' + line if line.strip() else '>')
    return '\n'.join(lines)


def _citation_location_label(citation):
    if citation.book_format in ('EPUB', 'KEPUB'):
        return citation.chapter_label or ''
    if citation.page:
        label = '{} {}'.format(_('Page'), citation.page)
        if citation.paragraph:
            label += ' · {} {}'.format(_('Paragraph'), citation.paragraph)
        return label
    return ''


def _export_markdown(notes):
    lines = ['# {} — {}'.format(_('Notes export'), datetime.now(timezone.utc).strftime('%Y-%m-%d')),
             '']
    for note in notes:
        lines.append('## {}'.format(note.title or _('Untitled')))
        if note.tags:
            lines.append('')
            lines.append('{}: {}'.format(_('Tags'), ', '.join(note.tags.split(','))))
        lines.append('')
        body = _markdown_escape_body(note.body)
        if body:
            lines.append(body)
            lines.append('')
        for citation in note.citations:
            meta = _book_meta(citation.book_id)
            book_title = meta['title'] if meta else _('Unknown book')
            if citation.quote:
                lines.append(_markdown_quote_block(citation.quote))
            location = _citation_location_label(citation)
            source = '— *{}*'.format(book_title.replace('*', r'\*'))
            if location:
                source += ', {}'.format(location)
            lines.append(source)
            lines.append('')
            if citation.comment:
                lines.append(_markdown_escape_body(citation.comment))
                lines.append('')
        lines.append('---')
        lines.append('')
    return '\n'.join(lines)


def _export_json(notes):
    payload = []
    for note in notes:
        citations = []
        for citation in note.citations:
            meta = _book_meta(citation.book_id)
            citations.append({
                'book_id': citation.book_id,
                'book_title': meta['title'] if meta else _('Unknown book'),
                'book_authors': meta['authors'] if meta else '',
                'book_format': citation.book_format,
                'quote': citation.quote,
                'comment': citation.comment,
                'cfi_range': citation.cfi_range,
                'chapter_label': citation.chapter_label,
                'page': citation.page,
                'paragraph': citation.paragraph,
                'color': citation.color,
                'created_at': citation.created_at.isoformat() if citation.created_at else None,
            })
        payload.append({
            'id': note.id,
            'title': note.title,
            'body': note.body,
            'tags': note.tags,
            'is_public': bool(note.is_public),
            'created_at': note.created_at.isoformat() if note.created_at else None,
            'updated_at': note.updated_at.isoformat() if note.updated_at else None,
            'citations': citations,
        })
    return payload


@notes.route("/notes/export")
@user_login_required
def notes_export():
    fmt = (request.args.get('fmt') or 'md').lower()
    if fmt not in ('md', 'json'):
        return _json_error(_('Unknown export format'))
    query, _filters = _query_notes(request.args, force_scope='mine')
    notes = query.all()
    filename = 'cwa-notes-{}.{}'.format(datetime.now(timezone.utc).strftime('%Y%m%d'), fmt)

    if fmt == 'json':
        response = jsonify(_export_json(notes))
        response.headers['Content-Type'] = 'application/json; charset=utf-8'
    else:
        response = Response(_export_markdown(notes), mimetype='text/markdown')
    response.headers['Content-Disposition'] = 'attachment; filename="{}"'.format(filename)
    return response

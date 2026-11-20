# Calibre-Web Automated – fork of Calibre-Web
# Copyright (C) 2018-2026 Calibre-Web contributors
# Copyright (C) 2024-2026 Calibre-Web Automated contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# See CONTRIBUTORS for full list of authors.

"""Notes feature: per-user Markdown notes with book quotes."""

from datetime import datetime, timezone

from flask import Blueprint, abort, flash, jsonify, redirect, request, url_for
from flask_babel import gettext as _

from . import logger, ub
from .cw_login import current_user
from .notes_utils import MAX_BODY, MAX_TITLE, clean_note_text, normalize_tags, render_markdown
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
    own_notes = ub.session.query(ub.Note).filter(ub.Note.user_id == current_user.id) \
        .order_by(ub.Note.updated_at.desc()).limit(100).all()
    return render_title_template('notes_list.html',
                                 notes=own_notes,
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
    return render_title_template('note_view.html',
                                 note=note,
                                 rendered_body=render_markdown(note.body),
                                 is_owner=(note.user_id == current_user.id),
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
                                         title=note.title or _("Note"),
                                         page="notes")
        _touch_note(note)
        ub.session_commit()
        return redirect(url_for('notes.note_view', note_id=note.id))
    return render_title_template('note_edit.html',
                                 note=note,
                                 values=None,
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
    return jsonify({"html": render_markdown(clean_note_text(text, MAX_BODY))})

# Calibre-Web Automated – fork of Calibre-Web
# Copyright (C) 2018-2026 Calibre-Web contributors
# Copyright (C) 2024-2026 Calibre-Web Automated contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# See CONTRIBUTORS for full list of authors.

"""Unit tests for the Notes feature: models, helpers, ownership, citations and export.

The Flask app here is a minimal one (blueprint + Babel) with the notes module's
collaborators (db session, calibre_db, current_user, template renderer) monkeypatched,
so no Calibre library, app context or Docker is required.
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask
from flask_babel import Babel
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from werkzeug.exceptions import NotFound

import cps.ub as ub
from cps import constants, notes as notes_module
from cps.notes_utils import normalize_tags, render_markdown, valid_cfi

REPO = Path(__file__).resolve().parents[2]
CFI = 'epubcfi(/6/4!/4/2/2[c01]/1:0)'


class FakeBook:
    def __init__(self, book_id, title, formats):
        self.id = book_id
        self.title = title
        self.authors = [SimpleNamespace(name='Ann|Author')]
        self.data = [SimpleNamespace(format=fmt) for fmt in formats]


class CurrentUserStub:
    def __init__(self, state):
        self._state = state

    def __getattr__(self, name):
        return getattr(self._state['user'], name)


def _unwrapped(name):
    view = getattr(notes_module, name)
    assert hasattr(view, '__wrapped__'), 'user_login_required must wrap with functools.wraps'
    return view.__wrapped__


@pytest.fixture
def env(monkeypatch, tmp_path):
    engine = create_engine('sqlite:///{}'.format(tmp_path / 'app.db'))
    ub.Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    user_a = ub.User(name='alice', email='alice@example.com',
                     role=constants.ROLE_ADMIN, password='x')
    user_b = ub.User(name='bob', email='bob@example.com',
                     role=constants.ROLE_USER, password='x')
    session.add_all([user_a, user_b])
    session.commit()

    monkeypatch.setattr(ub, 'session', session)
    books = {
        1: FakeBook(1, 'Accessible Book', ['EPUB', 'PDF']),
        2: FakeBook(2, 'Restricted Book', ['EPUB']),
    }
    monkeypatch.setattr(notes_module.calibre_db, 'get_filtered_book',
                        lambda book_id, *args, **kwargs: books.get(book_id))
    monkeypatch.setattr(notes_module, 'render_title_template',
                        lambda *args, **kwargs: ('template', kwargs))

    state = {'user': user_a}
    monkeypatch.setattr(notes_module, 'current_user', CurrentUserStub(state))

    app = Flask(__name__)
    app.secret_key = 'test-secret'
    Babel(app)
    app.register_blueprint(notes_module.notes)
    app.add_url_rule('/read/<int:book_id>/<book_format>', endpoint='web.read_book',
                     view_func=lambda **kwargs: 'reader')

    return SimpleNamespace(engine=engine, session=session, app=app, books=books,
                           user_a=user_a, user_b=user_b,
                           set_user=lambda user: state.update(user=user))


@pytest.mark.unit
class TestModels:
    def test_tables_and_cascade(self, env):
        tables = inspect(env.engine).get_table_names()
        assert 'note' in tables and 'note_citation' in tables

        note = ub.Note(user_id=env.user_a.id, title='T', body='B', tags='a,b')
        env.session.add(note)
        env.session.commit()
        citation = ub.NoteCitation(note_id=note.id, user_id=env.user_a.id, book_id=1,
                                   book_format='EPUB', quote='q', cfi_range=CFI)
        env.session.add(citation)
        env.session.commit()
        assert env.session.query(ub.NoteCitation).count() == 1

        env.session.delete(note)
        env.session.commit()
        assert env.session.query(ub.NoteCitation).count() == 0


@pytest.mark.unit
class TestHelpers:
    def test_normalize_tags(self):
        assert normalize_tags(' a, A , b,, ') == 'a,b'
        assert normalize_tags(None) == ''

    def test_valid_cfi(self):
        assert valid_cfi(CFI)
        assert not valid_cfi('javascript:alert(1)')
        assert not valid_cfi('epubcfi(x')

    def test_render_markdown_sanitizes(self):
        html = render_markdown('**bold** <script>alert(1)</script>')
        assert '<strong>bold</strong>' in html
        assert '<script' not in html


@pytest.mark.unit
class TestOwnership:
    def _note(self, env, **kwargs):
        note = ub.Note(user_id=env.user_a.id, title='Alice note', body='body', **kwargs)
        env.session.add(note)
        env.session.commit()
        return note

    def test_other_user_cannot_view_private_note(self, env):
        note = self._note(env)
        env.set_user(env.user_b)
        with env.app.test_request_context('/notes/{}'.format(note.id)):
            with pytest.raises(NotFound):
                _unwrapped('note_view')(note.id)

    def test_other_user_can_view_shared_note_read_only(self, env):
        note = self._note(env, is_public=True)
        env.set_user(env.user_b)
        with env.app.test_request_context('/notes/{}'.format(note.id)):
            result = _unwrapped('note_view')(note.id)
        kwargs = result[1]
        assert kwargs['is_owner'] is False
        assert kwargs['note'].id == note.id

    def test_other_user_cannot_edit_or_delete(self, env):
        note = self._note(env, is_public=True)
        env.set_user(env.user_b)
        with env.app.test_request_context('/notes/{}/edit'.format(note.id),
                                          method='POST', data={'title': 'hacked'}):
            with pytest.raises(NotFound):
                _unwrapped('note_edit')(note.id)
        with env.app.test_request_context('/notes/{}/delete'.format(note.id), method='POST'):
            with pytest.raises(NotFound):
                _unwrapped('note_delete')(note.id)
        assert env.session.query(ub.Note).filter(ub.Note.id == note.id).count() == 1

    def test_shared_note_hides_quotes_from_inaccessible_books(self, env, monkeypatch):
        note = self._note(env, is_public=True)
        env.session.add(ub.NoteCitation(note_id=note.id, user_id=env.user_a.id, book_id=2,
                                        book_format='EPUB', quote='hidden secret', cfi_range=CFI))
        env.session.commit()
        monkeypatch.setattr(notes_module, '_book_accessible', lambda book_id: False)

        env.set_user(env.user_b)
        with env.app.test_request_context('/notes/{}'.format(note.id)):
            views = _unwrapped('note_view')(note.id)[1]['citation_views']
        assert views[0]['visible'] is False

        env.set_user(env.user_a)
        with env.app.test_request_context('/notes/{}'.format(note.id)):
            views = _unwrapped('note_view')(note.id)[1]['citation_views']
        assert views[0]['visible'] is True


@pytest.mark.unit
class TestCitations:
    def _post(self, env, payload):
        with env.app.test_request_context('/ajax/notes/citation', method='POST', json=payload):
            response = _unwrapped('citation_create')()
        if isinstance(response, tuple):
            return response
        return response, 200

    def test_create_epub_and_pdf(self, env):
        epub, status = self._post(env, {'book_id': 1, 'book_format': 'EPUB', 'quote': 'hello',
                                        'color': 'green', 'cfi_range': CFI,
                                        'chapter_label': 'Chapter 1'})
        assert status == 201
        data = epub.get_json()
        assert data['color'] == 'green' and data['open_url'].endswith('/open')

        pdf, status = self._post(env, {'book_id': 1, 'book_format': 'PDF', 'quote': 'page text',
                                       'page': 12, 'paragraph': 4})
        assert status == 201
        assert pdf.get_json()['page'] == 12 and pdf.get_json()['paragraph'] == 4

    @pytest.mark.parametrize('payload', [
        {'book_id': 1, 'book_format': 'MOBI', 'quote': 'x'},
        {'book_id': 1, 'book_format': 'EPUB', 'quote': 'x', 'color': 'red'},
        {'book_id': 1, 'book_format': 'EPUB', 'quote': 'x', 'cfi_range': 'javascript:alert(1)'},
        {'book_id': 1, 'book_format': 'PDF', 'quote': 'x', 'page': 0},
        {'book_id': 99, 'book_format': 'EPUB', 'quote': 'x', 'cfi_range': CFI},
        {'book_id': 1, 'book_format': 'PDF', 'quote': '', 'comment': ''},
    ])
    def test_invalid_payloads_rejected(self, env, payload):
        _response, status = self._post(env, payload)
        assert status == 400

    def test_citation_update_and_delete_owner_only(self, env):
        _response, _status = self._post(env, {'book_id': 1, 'book_format': 'EPUB', 'quote': 'q',
                                              'cfi_range': CFI})
        citation = env.session.query(ub.NoteCitation).one()

        env.set_user(env.user_b)
        with env.app.test_request_context('/update', method='POST', json={'color': 'blue'}):
            with pytest.raises(NotFound):
                _unwrapped('citation_update')(citation.id)
        with env.app.test_request_context('/delete', method='POST'):
            with pytest.raises(NotFound):
                _unwrapped('citation_delete')(citation.id)

        env.set_user(env.user_a)
        with env.app.test_request_context('/update', method='POST',
                                          json={'color': 'blue', 'comment': 'nice'}):
            data = _unwrapped('citation_update')(citation.id).get_json()
        assert data['color'] == 'blue' and data['comment'] == 'nice'

        with env.app.test_request_context('/delete', method='POST'):
            body, status = _unwrapped('citation_delete')(citation.id)
        assert status == 204
        assert env.session.query(ub.Note).count() == 1


@pytest.mark.unit
class TestQuoteSequence:
    def _note(self, env, title='Seq note'):
        note = ub.Note(user_id=env.user_a.id, title=title, body='')
        env.session.add(note)
        env.session.commit()
        return note

    def _create(self, env, note, payload_extra=None):
        payload = {'book_id': 1, 'book_format': 'EPUB', 'quote': 'q{}'.format(note.id),
                   'cfi_range': CFI}
        payload.update(payload_extra or {})
        payload['note_id'] = note.id
        with env.app.test_request_context('/ajax/notes/citation', method='POST', json=payload):
            response = _unwrapped('citation_create')()
        if isinstance(response, tuple):
            response = response[0]
        return response.get_json()['seq']

    def test_numbers_are_incremental_per_note(self, env):
        first = self._note(env, 'One')
        second = self._note(env, 'Two')
        assert [self._create(env, first) for _ in range(2)] == [1, 2]
        assert [self._create(env, second) for _ in range(3)] == [1, 2, 3]

    def test_new_note_starts_at_one(self, env):
        with env.app.test_request_context('/ajax/notes/citation', method='POST',
                                          json={'book_id': 1, 'book_format': 'EPUB',
                                                'quote': 'fresh', 'cfi_range': CFI,
                                                'note_title': 'Brand new'}):
            response = _unwrapped('citation_create')()
        if isinstance(response, tuple):
            response = response[0]
        assert response.get_json()['seq'] == 1

    def test_number_is_not_reused_after_delete(self, env):
        note = self._note(env)
        assert [self._create(env, note) for _ in range(3)] == [1, 2, 3]
        middle = env.session.query(ub.NoteCitation).filter(
            ub.NoteCitation.seq == 2).one()
        with env.app.test_request_context('/delete', method='POST'):
            _unwrapped('citation_delete')(middle.id)
        assert self._create(env, note) == 4

    def test_views_are_sorted_by_seq(self, env):
        note = self._note(env)
        note.body = ''
        cit_a = ub.NoteCitation(note_id=note.id, user_id=env.user_a.id, book_id=1,
                                book_format='EPUB', quote='third', cfi_range=CFI, seq=9)
        cit_b = ub.NoteCitation(note_id=note.id, user_id=env.user_a.id, book_id=1,
                                book_format='EPUB', quote='first', cfi_range=CFI, seq=2)
        env.session.add_all([cit_a, cit_b])
        env.session.commit()
        with env.app.test_request_context('/notes/{}'.format(note.id)):
            views = _unwrapped('note_view')(note.id)[1]['citation_views']
        assert [item['citation'].seq for item in views] == [2, 9]
        assert [item['citation'].quote for item in views] == ['first', 'third']

    def test_backfill_numbers_legacy_rows(self, env):
        note = self._note(env)
        with env.engine.begin() as conn:
            conn.execute(text('DROP TABLE note_citation'))
            conn.execute(text(
                "CREATE TABLE note_citation (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, "
                "user_id INTEGER NOT NULL, book_id INTEGER NOT NULL, book_format VARCHAR NOT NULL, "
                "quote VARCHAR NOT NULL, comment VARCHAR NOT NULL, cfi_range VARCHAR, "
                "chapter_label VARCHAR, page INTEGER, paragraph INTEGER, color VARCHAR NOT NULL, "
                "created_at DATETIME)"))
            for offset, created in ((0, '2026-01-01 10:00:00'), (1, '2026-01-01 10:00:05')):
                conn.execute(text(
                    "INSERT INTO note_citation (note_id, user_id, book_id, book_format, quote, "
                    "comment, color, created_at) VALUES ({}, 1, 1, 'EPUB', 'q{}', '', 'yellow', "
                    "'{}')".format(note.id, offset, created)))
        env.session.commit()

        numbered = ub.backfill_note_citation_seq(env.engine, env.session)

        assert numbered == 2
        rows = env.session.execute(text("SELECT quote, seq FROM note_citation ORDER BY seq")).fetchall()
        assert [tuple(row) for row in rows] == [('q0', 1), ('q1', 2)]
        # Idempotent: a second run keeps the numbers stable
        assert ub.backfill_note_citation_seq(env.engine, env.session) == 2
        again = env.session.execute(text("SELECT quote, seq FROM note_citation ORDER BY seq")).fetchall()
        assert [tuple(row) for row in again] == [('q0', 1), ('q1', 2)]


@pytest.mark.unit
class TestExport:
    def _seed(self, env):
        note = ub.Note(user_id=env.user_a.id, title='Trip', body='line one',
                       tags='travel', is_public=False)
        env.session.add(note)
        env.session.commit()
        env.session.add(ub.NoteCitation(note_id=note.id, user_id=env.user_a.id, book_id=1,
                                        book_format='EPUB', quote='quoted line',
                                        comment='my comment', cfi_range=CFI,
                                        chapter_label='Chapter 2'))
        env.session.add(ub.Note(user_id=env.user_b.id, title='Bob secret', body='nope'))
        env.session.commit()
        return note

    def test_markdown_contains_quote_and_book(self, env):
        self._seed(env)
        with env.app.test_request_context('/notes/export?fmt=md'):
            response = _unwrapped('notes_export')()
        text = response.get_data(as_text=True)
        assert '> quoted line' in text
        assert 'Accessible Book' in text
        assert 'Bob secret' not in text
        assert response.headers['Content-Disposition'].startswith('attachment; filename="cwa-notes-')
        assert response.headers['Content-Type'].startswith('text/markdown')

    def test_json_schema_and_own_notes_only(self, env):
        self._seed(env)
        with env.app.test_request_context('/notes/export?fmt=json'):
            response = _unwrapped('notes_export')()
        data = json.loads(response.get_data(as_text=True))
        assert len(data) == 1
        assert set(data[0]) >= {'id', 'title', 'body', 'tags', 'is_public',
                                'created_at', 'updated_at', 'citations'}
        citation = data[0]['citations'][0]
        assert set(citation) >= {'book_id', 'book_title', 'book_authors', 'book_format',
                                 'quote', 'comment', 'cfi_range', 'chapter_label',
                                 'page', 'paragraph', 'color', 'created_at'}
        assert citation['book_title'] == 'Accessible Book'

    def test_unknown_format_rejected(self, env):
        with env.app.test_request_context('/notes/export?fmt=xml'):
            response = _unwrapped('notes_export')()
        assert response[1] == 400


@pytest.mark.unit
class TestSidebarVisibility:
    def test_notes_bit_registered(self):
        assert constants.SIDEBAR_NOTES == 1 << 19
        assert constants.sidebar_settings['sidebar_notes'] == constants.SIDEBAR_NOTES
        assert constants.ADMIN_USER_SIDEBAR & constants.SIDEBAR_NOTES

    def test_admin_bulk_edit_accepts_notes_bit(self):
        admin_source = (REPO / 'cps' / 'admin.py').read_text(encoding='utf-8')
        assert 'value <= constants.SIDEBAR_NOTES' in admin_source

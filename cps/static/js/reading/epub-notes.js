/* global calibre, reader */

/*
 * Notes integration for the EPUB reader: lists the user's quotes for this book
 * in the sidebar "Notes" tab, highlights them in the text and handles the
 * jump-to-CFI target passed by /notes/citation/<id>/open.
 *
 * URL templates from read.html contain the placeholder id "0" as a path
 * segment (e.g. /notes/0, /ajax/notes/citation/0/delete); fillUrl() replaces
 * the last "/0" segment with the real id.
 */
(function () {
    "use strict";

    if (!window.calibre || !calibre.notesEnabled || !window.reader) {
        return;
    }

    var COLOR_HEX = {
        yellow: "#ffeb3b",
        green: "#8bc34a",
        blue: "#64b5f6",
        pink: "#f48fb1"
    };
    var QUOTE_PREVIEW = 200;
    var FLASH_MS = 2000;
    var i18n = calibre.notesI18n || {};

    var state = {
        citations: [],
        jumpTarget: !!calibre.jumpCfi
    };
    window.cwaNotes = { hasJumpTarget: state.jumpTarget };

    var listEl = document.getElementById("cwa-notes-list");

    function fillUrl(tpl, id) {
        var i = tpl.lastIndexOf("/0");
        if (i < 0) {
            return tpl;
        }
        return tpl.slice(0, i) + "/" + encodeURIComponent(id) + tpl.slice(i + 2);
    }

    function isValidCfi(value) {
        return typeof value === "string" && value.indexOf("epubcfi(") === 0 &&
            value.charAt(value.length - 1) === ")";
    }

    function colorOf(c) {
        return COLOR_HEX.hasOwnProperty(c.color) ? c.color : "yellow";
    }

    function isLocal(c) {
        return (c.book_format || "").toUpperCase() === calibre.bookFormat && isValidCfi(c.cfi_range);
    }

    function truncate(text, max) {
        text = text || "";
        return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
    }

    function findCitation(id) {
        for (var i = 0; i < state.citations.length; i++) {
            if (state.citations[i].id === id) {
                return state.citations[i];
            }
        }
        return null;
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text) {
            node.textContent = text;
        }
        return node;
    }

    function renderMessage(text, className) {
        if (!listEl) {
            return;
        }
        listEl.textContent = "";
        listEl.appendChild(el("p", className, text));
    }

    function goTo(c) {
        if (isLocal(c)) {
            reader.rendition.display(c.cfi_range);
        } else if (c.open_url) {
            window.location.href = c.open_url;
        }
    }

    function buildItem(c) {
        var item = el("div", "cwa-note-item");
        item.setAttribute("data-citation-id", String(c.id));

        var head = el("div", "cwa-note-head");
        head.appendChild(el("span", "cwa-dot cwa-dot-" + colorOf(c)));
        if (c.chapter_label) {
            head.appendChild(el("span", "cwa-note-chapter", c.chapter_label));
        }
        item.appendChild(head);

        if (c.quote) {
            item.appendChild(el("blockquote", "cwa-note-quote", truncate(c.quote, QUOTE_PREVIEW)));
        }
        if (c.comment) {
            item.appendChild(el("div", "cwa-note-comment", c.comment));
        }
        if (!isLocal(c)) {
            item.appendChild(el("div", "cwa-note-other",
                (i18n.otherFormat || "") + " (" + (c.book_format || "") + ")"));
        }

        var actions = el("div", "cwa-note-actions");
        var goLink = el("a", "cwa-note-goto", i18n.goTo);
        goLink.href = isLocal(c) ? "#" : (c.open_url || "#");
        goLink.addEventListener("click", function (event) {
            event.preventDefault();
            goTo(c);
        });
        actions.appendChild(goLink);

        var noteLink = el("a", "cwa-note-open", i18n.openNote);
        noteLink.href = fillUrl(calibre.noteViewUrlTpl, c.note_id);
        actions.appendChild(noteLink);
        item.appendChild(actions);
        return item;
    }

    function renderList() {
        if (!listEl) {
            return;
        }
        if (!state.citations.length) {
            renderMessage(i18n.empty, "cwa-notes-empty");
            return;
        }
        listEl.textContent = "";
        state.citations.forEach(function (c) {
            listEl.appendChild(buildItem(c));
        });
    }

    function itemFor(id) {
        if (!listEl) {
            return null;
        }
        return listEl.querySelector('[data-citation-id="' + String(parseInt(id, 10)) + '"]');
    }

    function flashNode(node, className) {
        if (!node) {
            return;
        }
        node.classList.remove(className);
        // Force reflow so the animation restarts on repeated flashes
        void node.getBoundingClientRect();
        node.classList.add(className);
        setTimeout(function () {
            node.classList.remove(className);
        }, FLASH_MS);
    }

    function flashItem(id) {
        var item = itemFor(id);
        if (item) {
            item.scrollIntoView({ block: "center" });
            flashNode(item, "cwa-flash");
        }
    }

    function flashHighlight(id) {
        var marks = document.querySelectorAll('#viewer [ref^="cwa-hl-"]');
        for (var i = 0; i < marks.length; i++) {
            if (marks[i].getAttribute("data-id") === String(id)) {
                flashNode(marks[i], "cwa-hl-flash");
            }
        }
    }

    function openSidebarAt(id) {
        var sidebar = reader.SidebarController;
        if (sidebar) {
            sidebar.show();
            sidebar.changePanelTo("Notes");
        }
        flashItem(id);
    }

    function addHighlight(c) {
        try {
            reader.rendition.annotations.highlight(
                c.cfi_range,
                { id: String(c.id) },
                function () { openSidebarAt(c.id); },
                // epub.js passes this to classList.add(), so it must be a single token
                "cwa-hl-" + colorOf(c),
                { fill: COLOR_HEX[colorOf(c)], "fill-opacity": "0.35", "mix-blend-mode": "multiply" }
            );
        } catch (e) {
            console.warn("cwa-notes: could not highlight citation " + c.id, e);
        }
    }

    function loadCitations() {
        return fetch(calibre.notesBookUrl, {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.json();
        }).then(function (data) {
            state.citations = Array.isArray(data) ? data : [];
            renderList();
            return state.citations;
        });
    }

    var citationsLoaded = loadCitations().catch(function (error) {
        console.warn("cwa-notes: failed to load notes", error);
        renderMessage(i18n.loadError, "cwa-notes-error");
        return [];
    });

    Promise.all([citationsLoaded, reader.book.ready]).then(function (results) {
        results[0].forEach(function (c) {
            if (isLocal(c)) {
                addHighlight(c);
            }
        });
    }).catch(function (error) {
        console.warn("cwa-notes: failed to apply highlights", error);
    });

    if (state.jumpTarget) {
        var jumped = Promise.resolve(reader.displayed).catch(function () {}).then(function () {
            return reader.rendition.display(calibre.jumpCfi);
        });
        Promise.all([jumped, citationsLoaded]).then(function () {
            var id = calibre.jumpCitation;
            if (id && findCitation(id)) {
                flashItem(id);
                // Marks are drawn after the section renders; give them a moment
                setTimeout(function () { flashHighlight(id); }, 400);
            }
        }).catch(function (error) {
            console.warn("cwa-notes: jump to passage failed", error);
        });
    }
})();

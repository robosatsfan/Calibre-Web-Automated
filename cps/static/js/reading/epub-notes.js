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

        var delLink = el("a", "cwa-note-delete", i18n.delete);
        delLink.href = "#";
        delLink.addEventListener("click", function (event) {
            event.preventDefault();
            deleteCitation(c, item);
        });
        actions.appendChild(delLink);
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

    function csrfToken() {
        var input = document.querySelector("input[name='csrf_token']");
        return input ? input.value : "";
    }

    function postJson(url, payload) {
        return fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-CSRFToken": csrfToken()
            },
            body: JSON.stringify(payload || {})
        }).then(function (response) {
            if (response.ok) {
                return response.status === 204 ? null : response.json();
            }
            // Server errors are JSON ({error: ...}); CSRF failures are HTML
            return response.json().catch(function () { return {}; }).then(function (data) {
                var error = new Error((data && data.error) || (i18n.requestError + " (" + response.status + ")"));
                error.serverMessage = true;
                throw error;
            });
        });
    }

    function errorText(error, fallback) {
        return error && error.serverMessage ? error.message : fallback;
    }

    var toastTimer = null;

    function toast(text) {
        var node = document.getElementById("cwa-note-toast");
        if (!node) {
            node = el("div", "cwa-toast");
            node.id = "cwa-note-toast";
            node.setAttribute("role", "status");
            document.body.appendChild(node);
        }
        node.textContent = text;
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { node.hidden = true; }, 2000);
    }

    function removeHighlight(c) {
        try {
            reader.rendition.annotations.remove(c.cfi_range, "highlight");
        } catch (e) {
            console.warn("cwa-notes: could not remove highlight " + c.id, e);
        }
        // Another quote may share the same range; keep its highlight
        state.citations.forEach(function (other) {
            if (other.id !== c.id && isLocal(other) && other.cfi_range === c.cfi_range) {
                addHighlight(other);
            }
        });
    }

    function deleteCitation(c, item) {
        if (!window.confirm(i18n.confirmDelete)) {
            return;
        }
        postJson(fillUrl(calibre.citationDeleteUrlTpl, c.id)).then(function () {
            state.citations = state.citations.filter(function (other) { return other.id !== c.id; });
            if (isLocal(c)) {
                removeHighlight(c);
            }
            renderList();
        }).catch(function (error) {
            var old = item.querySelector(".cwa-notes-error");
            if (old) {
                old.remove();
            }
            item.appendChild(el("div", "cwa-notes-error", errorText(error, i18n.deleteError)));
        });
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

    // ---- Selection popup: save a quote from the EPUB ----

    var POPUP_PREVIEW = 300;
    var MIN_SELECTION = 2;
    var SELECT_DEBOUNCE_MS = 150;

    var popup = null;
    var pending = null;
    var selectTimer = null;
    var mineLoaded = null;
    var saving = false;

    function chapterLabel() {
        var location = reader.rendition.location;
        var href = location && location.start && location.start.href;
        var nav = reader.book.navigation;
        if (!href || !nav || !nav.toc) {
            return "";
        }
        href = href.split("#")[0];
        var found = "";
        (function walk(items) {
            for (var i = 0; i < items.length && !found; i++) {
                var itemHref = (items[i].href || "").split("#")[0];
                if (itemHref && (itemHref === href || href.endsWith("/" + itemHref) ||
                        itemHref.endsWith("/" + href))) {
                    found = (items[i].label || "").trim();
                }
                if (!found && items[i].subitems && items[i].subitems.length) {
                    walk(items[i].subitems);
                }
            }
        })(nav.toc);
        return found;
    }

    function selectionText(cfiRange, contents) {
        var text = "";
        try {
            var selection = contents && contents.window && contents.window.getSelection();
            text = selection ? selection.toString().trim() : "";
        } catch (e) {
            text = "";
        }
        if (text) {
            return Promise.resolve(text);
        }
        try {
            return Promise.resolve(reader.book.getRange(cfiRange)).then(function (range) {
                return range ? range.toString().trim() : "";
            }).catch(function () { return ""; });
        } catch (e) {
            return Promise.resolve("");
        }
    }

    function buildPopup() {
        popup = el("div", "cwa-note-popup");
        popup.id = "cwa-note-popup";
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-label", i18n.addNote);
        popup.hidden = true;

        popup.appendChild(el("div", "cwa-popup-title", i18n.addNote));
        popup.quoteEl = popup.appendChild(el("blockquote", "cwa-popup-quote"));

        var swatches = popup.appendChild(el("div", "cwa-popup-swatches"));
        swatches.setAttribute("role", "radiogroup");
        swatches.setAttribute("aria-label", i18n.color);
        popup.color = "yellow";
        Object.keys(COLOR_HEX).forEach(function (color) {
            var btn = el("button", "cwa-swatch cwa-dot-" + color);
            btn.type = "button";
            btn.setAttribute("role", "radio");
            btn.setAttribute("data-color", color);
            btn.setAttribute("aria-label", (i18n.colors && i18n.colors[color]) || color);
            btn.title = btn.getAttribute("aria-label");
            btn.addEventListener("click", function () { selectColor(color); });
            swatches.appendChild(btn);
        });

        var commentLabel = popup.appendChild(el("label", "cwa-popup-label", i18n.comment));
        popup.commentEl = el("textarea", "cwa-popup-comment");
        popup.commentEl.id = "cwa-popup-comment";
        popup.commentEl.rows = 3;
        commentLabel.htmlFor = popup.commentEl.id;
        popup.appendChild(popup.commentEl);

        var targetLabel = popup.appendChild(el("label", "cwa-popup-label", i18n.addTo));
        popup.targetEl = el("select", "cwa-popup-target");
        popup.targetEl.id = "cwa-popup-target";
        targetLabel.htmlFor = popup.targetEl.id;
        popup.targetEl.appendChild(new Option(i18n.newNote, ""));
        popup.targetEl.addEventListener("change", updateTitleVisibility);
        popup.appendChild(popup.targetEl);

        popup.titleWrap = popup.appendChild(el("div", "cwa-popup-title-wrap"));
        var titleLabel = popup.titleWrap.appendChild(el("label", "cwa-popup-label", i18n.noteTitle));
        popup.titleEl = el("input", "cwa-popup-note-title");
        popup.titleEl.id = "cwa-popup-note-title";
        popup.titleEl.type = "text";
        popup.titleEl.maxLength = 255;
        popup.titleEl.placeholder = i18n.titlePlaceholder || "";
        titleLabel.htmlFor = popup.titleEl.id;
        popup.titleWrap.appendChild(popup.titleEl);

        popup.errorEl = popup.appendChild(el("div", "cwa-notes-error cwa-popup-error"));
        popup.errorEl.setAttribute("role", "alert");
        popup.errorEl.hidden = true;

        var actions = popup.appendChild(el("div", "cwa-popup-actions"));
        var cancelBtn = el("button", "cwa-popup-cancel", i18n.cancel);
        cancelBtn.type = "button";
        cancelBtn.addEventListener("click", function () { hidePopup(); });
        actions.appendChild(cancelBtn);
        popup.saveBtn = el("button", "cwa-popup-save", i18n.save);
        popup.saveBtn.type = "button";
        popup.saveBtn.addEventListener("click", savePending);
        actions.appendChild(popup.saveBtn);

        // Keep typing inside the popup from turning pages or resizing fonts
        popup.addEventListener("keydown", function (event) {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                hidePopup();
            } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                savePending();
            }
        });

        document.body.appendChild(popup);
        selectColor(popup.color);
        updateTitleVisibility();
    }

    function selectColor(color) {
        popup.color = COLOR_HEX.hasOwnProperty(color) ? color : "yellow";
        var buttons = popup.querySelectorAll(".cwa-swatch");
        for (var i = 0; i < buttons.length; i++) {
            var active = buttons[i].getAttribute("data-color") === popup.color;
            buttons[i].classList.toggle("cwa-swatch-active", active);
            buttons[i].setAttribute("aria-checked", active ? "true" : "false");
        }
    }

    function updateTitleVisibility() {
        popup.titleWrap.hidden = popup.targetEl.value !== "";
    }

    function showPopupError(text) {
        popup.errorEl.textContent = text;
        popup.errorEl.hidden = !text;
    }

    function loadMine() {
        if (mineLoaded) {
            return mineLoaded;
        }
        mineLoaded = fetch(calibre.notesMineUrl, {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.json();
        }).then(function (notes) {
            var select = popup.targetEl;
            var current = select.value;
            while (select.options.length > 1) {
                select.remove(1);
            }
            (Array.isArray(notes) ? notes : []).forEach(function (note) {
                select.appendChild(new Option(note.title || ("#" + note.id), String(note.id)));
            });
            // Keep the previous choice if that note is still listed
            select.value = current;
            if (select.value !== current) {
                select.value = "";
            }
            updateTitleVisibility();
        }).catch(function (error) {
            mineLoaded = null;
            console.warn("cwa-notes: failed to load notes list", error);
        });
        return mineLoaded;
    }

    function showPopup(cfiRange, text, contents) {
        if (!popup) {
            buildPopup();
        }
        pending = { cfiRange: cfiRange, text: text, contents: contents };
        popup.quoteEl.textContent = truncate(text, POPUP_PREVIEW);
        showPopupError("");
        if (popup.hidden) {
            popup.commentEl.value = "";
            popup.titleEl.value = "";
            popup.hidden = false;
        }
        loadMine();
    }

    function hidePopup() {
        clearTimeout(selectTimer);
        pending = null;
        if (popup && !popup.hidden) {
            popup.hidden = true;
            showPopupError("");
        }
    }

    function clearSelection(contents) {
        try {
            contents.window.getSelection().removeAllRanges();
        } catch (e) {
            // The section may have been unloaded already
        }
    }

    function savePending() {
        if (!pending || saving) {
            return;
        }
        var request = pending;
        var payload = {
            book_id: calibre.bookId,
            book_format: calibre.bookFormat,
            quote: request.text,
            comment: popup.commentEl.value.trim(),
            color: popup.color,
            cfi_range: request.cfiRange,
            chapter_label: chapterLabel()
        };
        if (popup.targetEl.value) {
            payload.note_id = parseInt(popup.targetEl.value, 10);
        } else if (popup.titleEl.value.trim()) {
            payload.note_title = popup.titleEl.value.trim();
        }

        saving = true;
        popup.saveBtn.disabled = true;
        showPopupError("");
        postJson(calibre.citationCreateUrl, payload).then(function (citation) {
            state.citations.unshift(citation);
            if (isLocal(citation)) {
                addHighlight(citation);
            }
            renderList();
            // A new note was created: refresh the target list on next open
            if (!payload.note_id) {
                mineLoaded = null;
                popup.targetEl.value = "";
            }
            clearSelection(request.contents);
            hidePopup();
            toast(i18n.saved);
        }).catch(function (error) {
            showPopupError(errorText(error, i18n.saveError));
        }).then(function () {
            saving = false;
            popup.saveBtn.disabled = false;
        });
    }

    reader.rendition.on("selected", function (cfiRange, contents) {
        clearTimeout(selectTimer);
        selectTimer = setTimeout(function () {
            if (!isValidCfi(cfiRange)) {
                hidePopup();
                return;
            }
            selectionText(cfiRange, contents).then(function (text) {
                if (!text || text.length < MIN_SELECTION) {
                    hidePopup();
                    return;
                }
                showPopup(cfiRange, text, contents);
            });
        }, SELECT_DEBOUNCE_MS);
    });

    // Clicking in the book without a selection (collapsing it) cancels the popup
    reader.rendition.on("click", function (event) {
        var view = event && event.view;
        var selection = null;
        try {
            selection = view && view.getSelection();
        } catch (e) {
            selection = null;
        }
        if (!selection || selection.isCollapsed) {
            hidePopup();
        }
    });

    reader.rendition.on("keydown", function (event) {
        if (event && event.key === "Escape") {
            hidePopup();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            hidePopup();
        }
    });

    document.addEventListener("mousedown", function (event) {
        if (popup && !popup.hidden && !popup.contains(event.target)) {
            hidePopup();
        }
    });
})();

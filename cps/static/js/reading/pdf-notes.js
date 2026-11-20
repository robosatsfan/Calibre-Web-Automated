/* global PDFViewerApplication */

/*
 * Notes integration for the PDF reader: a floating "Note" button opens a
 * dialog that saves the selected text with page/paragraph to a note, and
 * #page=N from /notes/citation/<id>/open is re-applied after load.
 * No highlights and no in-reader list in v1.
 */
(function () {
    "use strict";

    var cfg = window.calibreNotes;
    if (!cfg || !cfg.enabled) {
        return;
    }
    var i18n = cfg.i18n || {};

    var btn = document.getElementById("cwa-pdf-note-btn");
    var dialog = document.getElementById("cwa-pdf-note-dialog");
    var form = document.getElementById("cwa-pdf-note-form");
    var quoteEl = document.getElementById("cwa-pdf-quote");
    var pageEl = document.getElementById("cwa-pdf-page");
    var paragraphEl = document.getElementById("cwa-pdf-paragraph");
    var commentEl = document.getElementById("cwa-pdf-comment");
    var targetEl = document.getElementById("cwa-pdf-target");
    var titleWrap = document.getElementById("cwa-pdf-title-wrap");
    var titleEl = document.getElementById("cwa-pdf-title");
    var errorEl = document.getElementById("cwa-pdf-error");
    var saveBtn = document.getElementById("cwa-pdf-save");
    var cancelBtn = document.getElementById("cwa-pdf-cancel");
    if (!btn || !dialog || !form) {
        return;
    }

    var lastSelection = "";
    var mineLoaded = null;
    var saving = false;

    function app() {
        return window.PDFViewerApplication;
    }

    function currentSelection() {
        var selection = window.getSelection();
        return selection ? selection.toString().trim() : "";
    }

    // Tapping the button can collapse the selection on touch devices, so keep the last one
    document.addEventListener("selectionchange", function () {
        var text = currentSelection();
        if (text) {
            lastSelection = text;
        }
    });

    function showError(text) {
        errorEl.textContent = text || "";
        errorEl.hidden = !text;
    }

    function updateTitleVisibility() {
        titleWrap.hidden = targetEl.value !== "";
    }

    function loadMine() {
        if (mineLoaded) {
            return mineLoaded;
        }
        mineLoaded = fetch(cfg.mineUrl, {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.json();
        }).then(function (notes) {
            var current = targetEl.value;
            while (targetEl.options.length > 1) {
                targetEl.remove(1);
            }
            (Array.isArray(notes) ? notes : []).forEach(function (note) {
                targetEl.appendChild(new Option(note.title || ("#" + note.id), String(note.id)));
            });
            targetEl.value = current;
            if (targetEl.value !== current) {
                targetEl.value = "";
            }
            updateTitleVisibility();
        }).catch(function (error) {
            mineLoaded = null;
            console.warn("cwa-notes: failed to load notes list", error);
        });
        return mineLoaded;
    }

    function openDialog() {
        var pdf = app();
        quoteEl.value = currentSelection() || lastSelection;
        pageEl.value = pdf && pdf.page ? String(pdf.page) : "1";
        paragraphEl.value = "";
        commentEl.value = "";
        titleEl.value = "";
        showError("");
        updateTitleVisibility();
        btn.hidden = true;
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
        loadMine();
        (quoteEl.value ? commentEl : quoteEl).focus();
    }

    function closeDialog() {
        if (dialog.open) {
            if (typeof dialog.close === "function") {
                dialog.close();
            } else {
                dialog.removeAttribute("open");
            }
        }
        btn.hidden = false;
    }

    var toastTimer = null;

    function toast(text) {
        var node = document.getElementById("cwa-note-toast");
        if (!node) {
            node = document.createElement("div");
            node.id = "cwa-note-toast";
            node.className = "cwa-toast";
            node.setAttribute("role", "status");
            document.body.appendChild(node);
        }
        node.textContent = text;
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { node.hidden = true; }, 2000);
    }

    function positiveInt(value) {
        var n = Number(value);
        return Number.isInteger(n) && n >= 1 ? n : null;
    }

    function save() {
        if (saving) {
            return;
        }
        var quote = quoteEl.value.trim();
        var comment = commentEl.value.trim();
        if (!quote && !comment) {
            showError(i18n.required);
            return;
        }
        var page = positiveInt(pageEl.value);
        if (!page) {
            showError(i18n.invalidPage);
            return;
        }
        var paragraph = null;
        if (paragraphEl.value.trim() !== "") {
            paragraph = positiveInt(paragraphEl.value);
            if (!paragraph) {
                showError(i18n.invalidParagraph);
                return;
            }
        }

        var payload = {
            book_id: cfg.bookId,
            book_format: "PDF",
            quote: quote,
            comment: comment,
            color: "yellow",
            page: page,
            paragraph: paragraph
        };
        if (targetEl.value) {
            payload.note_id = parseInt(targetEl.value, 10);
        } else if (titleEl.value.trim()) {
            payload.note_title = titleEl.value.trim();
        }

        saving = true;
        saveBtn.disabled = true;
        showError("");
        fetch(cfg.createUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-CSRFToken": cfg.csrf
            },
            body: JSON.stringify(payload)
        }).then(function (response) {
            if (response.ok) {
                return response.json();
            }
            // Server errors are JSON ({error: ...}); CSRF failures are HTML
            return response.json().catch(function () { return {}; }).then(function (data) {
                var error = new Error((data && data.error) || (i18n.requestError + " (" + response.status + ")"));
                error.serverMessage = true;
                throw error;
            });
        }).then(function () {
            // A new note was created: refresh the target list on next open
            if (!payload.note_id) {
                mineLoaded = null;
            }
            lastSelection = "";
            closeDialog();
            toast(i18n.saved);
        }).catch(function (error) {
            showError(error && error.serverMessage ? error.message : i18n.saveError);
        }).then(function () {
            saving = false;
            saveBtn.disabled = false;
        });
    }

    // Keep the selection (and focus) when the button is pressed with a mouse
    btn.addEventListener("mousedown", function (event) {
        event.preventDefault();
    });
    btn.addEventListener("click", openDialog);
    cancelBtn.addEventListener("click", closeDialog);
    targetEl.addEventListener("change", updateTitleVisibility);
    form.addEventListener("submit", function (event) {
        event.preventDefault();
        save();
    });
    // Native Escape closes the dialog; restore the button afterwards
    dialog.addEventListener("close", function () {
        btn.hidden = false;
    });
    // Don't let pdf.js keyboard shortcuts react to typing in the dialog
    dialog.addEventListener("keydown", function (event) {
        event.stopPropagation();
    });

    // ---- Jump: re-apply #page=N after load (pdf.js already honours it; safety net) ----

    var hashMatch = /(?:^#|&)page=(\d+)/.exec(window.location.hash || "");
    if (!hashMatch) {
        return;
    }
    var jumpPage = parseInt(hashMatch[1], 10);

    function applyJump() {
        var pdf = app();
        if (!pdf || !pdf.pdfDocument || jumpPage < 1 || jumpPage > pdf.pagesCount) {
            return;
        }
        if (pdf.page !== jumpPage) {
            pdf.page = jumpPage;
        }
    }

    var tries = 0;
    var waitTimer = setInterval(function () {
        var pdf = app();
        tries += 1;
        if (pdf && pdf.initializedPromise) {
            clearInterval(waitTimer);
            pdf.initializedPromise.then(function () {
                var bus = pdf.eventBus;
                if (!bus) {
                    return;
                }
                var done = { documentloaded: false, documentinit: false };
                ["documentinit", "documentloaded"].forEach(function (name) {
                    bus.on(name, function () {
                        if (!done[name]) {
                            done[name] = true;
                            applyJump();
                        }
                    });
                });
            });
        } else if (tries > 200) {
            clearInterval(waitTimer);
        }
    }, 100);
})();

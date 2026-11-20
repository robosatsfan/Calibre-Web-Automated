/* Notes: write/preview toggle for the note editor. */
(function () {
    "use strict";

    function getCsrfToken(form) {
        var input = form.querySelector("input[name='csrf_token']") ||
            document.querySelector("input[name='csrf_token']");
        return input ? input.value : "";
    }

    function setActive(buttons, mode) {
        Array.prototype.forEach.call(buttons, function (button) {
            if (button.getAttribute("data-cwa-mode") === mode) {
                button.classList.add("active");
            } else {
                button.classList.remove("active");
            }
        });
    }

    function showPreview(form, textarea, pane) {
        var url = form.getAttribute("data-preview-url");
        var errorText = form.getAttribute("data-preview-error") || "";
        var emptyText = form.getAttribute("data-preview-empty") || "";

        if (!textarea.value.trim()) {
            pane.textContent = emptyText;
            pane.classList.remove("note-preview-error");
            return;
        }

        fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": getCsrfToken(form)
            },
            body: JSON.stringify({text: textarea.value})
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("preview failed");
            }
            return response.json();
        }).then(function (data) {
            // The HTML is produced server side by render_markdown() (escaped + sanitized).
            pane.innerHTML = data.html || "";
            pane.classList.remove("note-preview-error");
        }).catch(function () {
            pane.textContent = errorText;
            pane.classList.add("note-preview-error");
        });
    }

    function initEditor() {
        var form = document.querySelector("[data-cwa-note-form]");
        if (!form) {
            return;
        }
        var textarea = form.querySelector("textarea[name='body']");
        var pane = form.querySelector("[data-cwa-preview-pane]");
        var buttons = form.querySelectorAll("[data-cwa-mode]");
        if (!textarea || !pane || !buttons.length) {
            return;
        }

        Array.prototype.forEach.call(buttons, function (button) {
            button.addEventListener("click", function () {
                var mode = button.getAttribute("data-cwa-mode");
                setActive(buttons, mode);
                if (mode === "preview") {
                    textarea.hidden = true;
                    pane.hidden = false;
                    showPreview(form, textarea, pane);
                } else {
                    pane.hidden = true;
                    textarea.hidden = false;
                    textarea.focus();
                }
            });
        });
    }

    function initCitations() {
        var container = document.querySelector("[data-cwa-citations]");
        if (!container) {
            return;
        }
        var errorText = container.getAttribute("data-error-text") || "";
        var csrf = getCsrfToken(container);

        function postJson(url, body) {
            return fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": csrf
                },
                body: JSON.stringify(body || {})
            });
        }

        function applyColor(item, color) {
            item.className = item.className.replace(/note-quote-\w+/g, "").trim();
            item.className += " note-quote-" + color;
        }

        Array.prototype.forEach.call(container.querySelectorAll("[data-cwa-citation]"), function (item) {
            var saveButton = item.querySelector("[data-cwa-citation-save]");
            var deleteButton = item.querySelector("[data-cwa-citation-delete]");
            var colorSelect = item.querySelector("[data-cwa-citation-color]");
            var commentField = item.querySelector("[data-cwa-citation-comment]");
            var status = item.querySelector("[data-cwa-citation-status]");

            if (saveButton) {
                saveButton.addEventListener("click", function () {
                    postJson(item.getAttribute("data-update-url"), {
                        color: colorSelect ? colorSelect.value : undefined,
                        comment: commentField ? commentField.value : undefined
                    }).then(function (response) {
                        if (!response.ok) {
                            throw new Error("update failed");
                        }
                        return response.json();
                    }).then(function (data) {
                        if (colorSelect && data.color) {
                            applyColor(item, data.color);
                        }
                        if (status) {
                            status.textContent = "";
                        }
                    }).catch(function () {
                        if (status) {
                            status.textContent = errorText;
                        }
                    });
                });
            }

            if (deleteButton) {
                deleteButton.addEventListener("click", function () {
                    var question = deleteButton.getAttribute("data-confirm") || "";
                    if (question && !window.confirm(question)) {
                        return;
                    }
                    postJson(item.getAttribute("data-delete-url"), {}).then(function (response) {
                        if (response.status !== 204 && !response.ok) {
                            throw new Error("delete failed");
                        }
                        var list = item.parentNode;
                        item.parentNode.removeChild(item);
                        if (list && !list.querySelector("[data-cwa-citation]")) {
                            container.parentNode.removeChild(container);
                        }
                    }).catch(function () {
                        if (status) {
                            status.textContent = errorText;
                        }
                    });
                });
            }
        });
    }

    document.addEventListener("DOMContentLoaded", initEditor);
    document.addEventListener("DOMContentLoaded", initCitations);
})();

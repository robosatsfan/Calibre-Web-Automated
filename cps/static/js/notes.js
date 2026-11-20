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

    document.addEventListener("DOMContentLoaded", initEditor);
})();

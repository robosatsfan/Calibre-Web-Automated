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

    function textOf(element) {
        return element ? element.textContent.replace(/\s+/g, " ").trim() : "";
    }

    function quoteCopyText(scope) {
        var quote = textOf(scope.querySelector(".note-quote-text"));
        var book = textOf(scope.querySelector(".note-quote-meta .note-quote-book"));
        var parts = [];
        if (book) {
            parts.push(book);
        }
        Array.prototype.forEach.call(scope.querySelectorAll(".note-quote-meta .note-quote-loc"),
            function (loc) {
                var text = textOf(loc);
                if (text) {
                    parts.push(text);
                }
            });
        var source = parts.join(", ");
        if (!quote) {
            return source;
        }
        return "\u201e" + quote + "\u201c" + (source ? " \u2014 " + source : "");
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            var area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.top = "-1000px";
            document.body.appendChild(area);
            area.select();
            var ok = false;
            try {
                ok = document.execCommand("copy");
            } catch (e) {
                ok = false;
            }
            document.body.removeChild(area);
            if (ok) {
                resolve();
            } else {
                reject(new Error("copy failed"));
            }
        });
    }

    function flashQuote(details) {
        details.classList.add("note-flash");
        window.setTimeout(function () {
            details.classList.remove("note-flash");
        }, 1500);
    }

    function openQuoteRef(num) {
        var target = document.getElementById("quote-" + num);
        if (!target) {
            return false;
        }
        target.open = true;
        if (typeof target.scrollIntoView === "function") {
            target.scrollIntoView({block: "center", behavior: "smooth"});
        }
        flashQuote(target);
        return true;
    }

    function initQuoteTools() {
        document.addEventListener("click", function (event) {
            var target = event.target;
            if (!target || !target.closest) {
                return;
            }
            var ref = target.closest("[data-cwa-quote-ref]");
            if (ref) {
                if (openQuoteRef(ref.getAttribute("data-cwa-quote-ref"))) {
                    event.preventDefault();
                }
                return;
            }
            var button = target.closest("[data-cwa-copy-quote]");
            if (!button) {
                return;
            }
            var scope = button.closest(".note-quote") || document;
            var label = button.textContent;
            var copiedText = button.getAttribute("data-copied-text") || "OK";
            var failedText = button.getAttribute("data-copy-failed-text") || "";
            copyText(quoteCopyText(scope)).then(function () {
                button.textContent = copiedText;
            }).catch(function () {
                button.textContent = failedText;
            }).then(function () {
                window.setTimeout(function () {
                    button.textContent = label;
                }, 1500);
            });
        });
    }

    document.addEventListener("DOMContentLoaded", initEditor);
    document.addEventListener("DOMContentLoaded", initCitations);
    document.addEventListener("DOMContentLoaded", initQuoteTools);
})();

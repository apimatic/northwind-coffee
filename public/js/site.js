// Progressive enhancement only: every page works without this file.
// Forms marked data-disable-on-submit disable their submit buttons after the first submit,
// so an impatient double click sends one request. (The server also guards against duplicates.)
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-disable-on-submit")) return;
  if (form.dataset.submitting === "true") {
    event.preventDefault();
    return;
  }
  form.dataset.submitting = "true";
  // Defer so the clicked button's name/value is still included in this submission.
  setTimeout(() => {
    for (const button of form.querySelectorAll("button[type=submit]")) button.disabled = true;
  }, 0);
});

// Back/forward cache can restore a disabled form; re-enable it.
window.addEventListener("pageshow", () => {
  for (const form of document.querySelectorAll("form[data-submitting]")) {
    delete form.dataset.submitting;
    for (const button of form.querySelectorAll("button[type=submit]")) button.disabled = false;
  }
});

// Content script: runs on goodreads.com pages to detect the logged-in user's
// profile ID. Prefers links inside the site header (the signed-in user's own
// profile menu) — a whole-page match could pick up someone else's profile
// link when browsing friends' pages — and falls back to the full document
// for older/alternate layouts.
(function () {
	function findID(root) {
		var links = root.querySelectorAll('a[href*="/user/show/"]');
		for (var i = 0; i < links.length; i++) {
			var match = links[i].href.match(/\/user\/show\/(\d+)/);
			if (match) return match[1];
		}
		return null;
	}

	var header =
		document.querySelector(".siteHeader__personal") ||
		document.querySelector("#siteHeader") ||
		document.querySelector("header");
	var id = (header && findID(header)) || findID(document);
	if (id) {
		chrome.storage.local.set({ detectedGoodreadsID: id });
	}
})();

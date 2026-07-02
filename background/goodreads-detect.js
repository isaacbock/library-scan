// Content script: runs on goodreads.com pages to detect logged-in user's profile ID.
// Looks for any link to /user/show/DIGITS in the page (typically in the nav bar).
(function () {
	var links = document.querySelectorAll('a[href*="/user/show/"]');
	for (var i = 0; i < links.length; i++) {
		var match = links[i].href.match(/\/user\/show\/(\d+)/);
		if (match) {
			chrome.storage.local.set({ detectedGoodreadsID: match[1] });
			return;
		}
	}
})();

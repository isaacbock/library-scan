// ExtensionPay setup
importScripts('../ExtPay.js');
importScripts('api_keys.js');
importScripts('../analytics.js');
const extpay = ExtPay('library-scan');
extpay.startBackground();

// Cache paid status the moment ExtPay confirms payment. The background poll
// (ExtPay's poll_user_paid) runs even while the popup is closed during the
// payment flow, so this is the reliable source of truth for Pro status —
// the popup then reacts to the isPro storage change and updates live.
extpay.onPaid.addListener(function () {
	chrome.storage.local.set({ isPro: true });
});

/**
 * @type {number} A scan is considered stale (e.g. the MV3 service worker was
 * terminated mid-scan) after this long, so a stuck currently_scanning flag
 * can't permanently block auto-refresh.
 */
const STALE_SCAN_MS = 10 * 60 * 1000;

/**
 * @type {number} How often the 1-minute alarm re-validates Pro status against
 * the ExtensionPay API. Payments are caught instantly by onPaid, and scans &
 * popup opens do their own live checks — this is just a slow safety net for
 * out-of-band changes (refunds, dashboard edits).
 */
const PRO_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * @type {number} Maximum RSS pages for free users (100 books per page)
 */
const FREE_MAX_RSS_PAGES = 1;

/**
 * @type {number} Maximum RSS pages for Pro users (effectively unlimited)
 */
const PRO_MAX_RSS_PAGES = 100;

/**
 * @type {number} Refresh wait duration in minutes -- defaults to refreshing every 24 hours
 */
// Auto-refresh interval: 24 hours
const refreshWait = 24 * 60;

// Set up recurring alarm for elapsed time checks (replaces setTimeout loop)
chrome.alarms.create("elapsedTime", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "elapsedTime") {
		getElapsedTime();
	}
});

// Open popup when notification is clicked
chrome.notifications.onClicked.addListener(function (notificationId) {
	if (notificationId === "library-scan-new-books") {
		// openPopup() requires an active user gesture in most Chrome versions
		// and rejects otherwise — guard so the click handler never throws.
		try {
			var opened = chrome.action.openPopup();
			if (opened && typeof opened.catch === "function") opened.catch(function () {});
		} catch (e) {}
		chrome.notifications.clear(notificationId);
	}
});

// Re-send notification when user becomes active (in case original fired during idle/sleep)
chrome.idle.setDetectionInterval(60); // 60 seconds of no input = idle
chrome.idle.onStateChanged.addListener(function (newState) {
	if (newState === "active") {
		chrome.storage.local.get(["pendingNotification"], function (result) {
			if (result.pendingNotification) {
				var data = result.pendingNotification;
				chrome.notifications.create("library-scan-new-books", {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon128.png"),
					title: data.title,
					message: data.message
				});
				chrome.storage.local.remove("pendingNotification");
			}
		});
	}
});

// Initial elapsed time check on service worker start
getElapsedTime();

/**
 * @type {*} Refresh loading message timer (active only during scans)
 */
let carousel_message_timer;

/**
 * @type {number} Monotonically increasing scan generation ID.
 * Incrementing this invalidates any in-flight scan.
 */
let currentScanId = 0;

// Install & uninstall pages
chrome.runtime.onInstalled.addListener(function (details) {
	if (details.reason === "install") {
		chrome.tabs.create({
			url: "https://isaacbock.com/library-scan#start",
		});
		chrome.runtime.setUninstallURL(
			"https://isaacbock.com/library-scan-uninstall"
		);
		Analytics.trackInstall();
	} else if (details.reason === "update") {
		Analytics.trackUpdate(chrome.runtime.getManifest().version);
		chrome.runtime.setUninstallURL(
			"https://isaacbock.com/library-scan-uninstall"
		);
	}
});

// In-memory scanning lock (avoids async storage race condition)
let isScanningLocal = false;

// Receive messages from popup.js (front-end) and respond with data
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
	if (request.msg === "goodreads") {
		if (!isScanningLocal) {
			refresh(request.goodreadsID, request.overdriveURLs, request.shelves, "manual");
		}
	} else if (request.msg === "fetchShelves") {
		fetchShelves(request.goodreadsID).then(function (result) {
			sendResponse({ shelves: result.shelves, counts: result.counts });
		}).catch(function () {
			sendResponse({ shelves: null });
		});
		return true; // keep message channel open for async sendResponse
	} else if (request.msg === "elapsedTime") {
		getElapsedTime();
	} else if (request.msg === "cancelScan") {
		currentScanId++;
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
		clearInterval(carousel_message_timer);
		// Restore badge from stored count
		chrome.storage.local.get(["error", "count"], function (result) {
			if (result.error === "None" && result.count) {
				updateBadgeCount(result.count);
			} else if (result.error && result.error !== "None") {
				updateBadgeError();
			} else {
				updateBadgeCount(0);
			}
		});
	} else if (request.msg === "badgeCount") {
		chrome.storage.session.get(["currently_scanning"], function (result) {
			if (!result.currently_scanning) {
				// Don't overwrite error badge with a stale count
				chrome.storage.local.get(["error"], function (errResult) {
					if (!errResult.error || errResult.error === "None") {
						updateBadgeCount(request.count);
					}
				});
			}
		});
	}
});

/**
 * Get time elapsed since last data refresh and send to popup.js (front-end) for display
 */
function getElapsedTime() {
	chrome.storage.local.get(
		["LastRun", "goodreadsID", "overdriveURLs", "error", "count", "selectedShelves"],
		function (result) {
			let lastRunTime = result.LastRun;
			let goodreadsID = result.goodreadsID;
			let overdriveURLs = result.overdriveURLs;
			let error = result.error;
			let count = result.count;
			if (
				typeof lastRunTime !== "undefined" &&
				typeof goodreadsID !== "undefined" &&
				overdriveURLs && overdriveURLs.length > 0
			) {
				// Calculate time (in minutes) since last refresh
				let lastRun = new Date(lastRunTime);
				let currentTime = new Date();
				let elapsedTime = Math.floor((currentTime - lastRun) / 60000);
				console.log("Elapsed Time Since Last Refresh: " + elapsedTime + " min");

				// Auto-refresh only for Pro users
				chrome.storage.session.get(["currently_scanning", "scan_started_at"], async function (scanResult) {
					// A scan flag older than STALE_SCAN_MS means the service
					// worker was likely killed mid-scan — don't let it block
					// auto-refresh forever.
					let scanning = scanResult.currently_scanning;
					if (scanning && (!scanResult.scan_started_at || (Date.now() - scanResult.scan_started_at) > STALE_SCAN_MS)) {
						scanning = false;
						isScanningLocal = false;
						chrome.storage.session.set({ currently_scanning: false });
					}

					// Gate auto-refresh on the cached Pro status; a live getUser()
					// here used to hit the ExtensionPay API on every 1-minute tick.
					const proResult = await new Promise(function (resolve) {
						chrome.storage.local.get(["isPro", "isProCheckedAt"], function (r) { resolve(r); });
					});
					let isPro = !!proResult.isPro;
					if (!proResult.isProCheckedAt || (Date.now() - proResult.isProCheckedAt) > PRO_RECHECK_MS) {
						// Bump the timestamp before fetching so a failing API
						// doesn't get retried every minute.
						chrome.storage.local.set({ isProCheckedAt: Date.now() });
						try {
							const user = await extpay.getUser();
							isPro = !!user.paid;
							chrome.storage.local.set({ isPro: isPro });
						} catch (e) {
							// Network error — keep the cached value
						}
					}

					if (isPro && elapsedTime > refreshWait && !scanning) {
						refresh(goodreadsID, overdriveURLs, result.selectedShelves, "auto");
						elapsedTime = 0;
					}

					// Send elapsed time to popup
					chrome.runtime.sendMessage({ msg: "ElapsedTime", time: formatElapsedTime(elapsedTime) }).catch(() => {});
				});

				// Auto add badge count (in case of extension update or reset)
				if (typeof error !== "undefined" && typeof count !== "undefined") {
					if (error == "None") {
						updateBadgeCount(count);
					} else {
						updateBadgeError();
					}
				}
			}
		}
	);
}

/**
 * Format elapsed time in minutes to a human-readable string.
 *
 * @param {number} minutes  Minutes since last refresh
 * @returns {string}        e.g. "Just now", "5 min ago", "3 hr ago", "2 days ago", "3 weeks ago"
 */
function formatElapsedTime(minutes) {
	if (minutes === 0) return "Just now";
	if (minutes < 60) return minutes + " min ago";
	var hours = Math.floor(minutes / 60);
	if (hours < 24) return hours + " hr ago";
	var days = Math.floor(hours / 24);
	if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
	var weeks = Math.floor(days / 7);
	if (weeks < 5) return weeks + (weeks === 1 ? " week ago" : " weeks ago");
	var months = Math.floor(days / 30);
	if (months < 12) return months + (months === 1 ? " month ago" : " months ago");
	var years = Math.floor(days / 365);
	return years + (years === 1 ? " year ago" : " years ago");
}

/**
 * Fetch the list of shelves for a Goodreads user by scraping their review list page.
 *
 * @param {string} goodreadsID  Numeric Goodreads user ID
 * @returns {Promise<Object>} { shelves: string[], counts: Object<string, number> }
 */
async function fetchShelves(goodreadsID) {
	console.log("Fetching shelves via RSS for user: " + goodreadsID);
	const shelfCounts = {};
	const shelfRegex = /<user_shelves>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/user_shelves>/g;
	let totalScanned = 0;

	for (let page = 1; page <= PRO_MAX_RSS_PAGES; page++) {
		const rssURL =
			"https://www.goodreads.com/review/list_rss/" +
			goodreadsID +
			"?shelf=%23ALL%23&page=" + page;

		const response = await fetchWithTimeout(rssURL, {}, 15000);
		const xml = await response.text();

		// Count items to know when we've reached the last page
		const itemCount = (xml.match(/<item>/g) || []).length;
		if (itemCount === 0) break;

		totalScanned += itemCount;
		// Send progress to popup
		chrome.runtime.sendMessage({ msg: "shelfScanProgress", count: totalScanned }).catch(() => {});

		let match;
		while ((match = shelfRegex.exec(xml)) !== null) {
			const value = match[1].trim();
			if (value) {
				// A book can be on multiple shelves (comma-separated)
				value.split(",").forEach(function (s) {
					var name = s.trim();
					if (name) {
						shelfCounts[name] = (shelfCounts[name] || 0) + 1;
					}
				});
			} else {
				// Empty <user_shelves> means the book is on the default "read" shelf
				shelfCounts["read"] = (shelfCounts["read"] || 0) + 1;
			}
		}

		if (itemCount < 100) break;
	}

	var shelves = Object.keys(shelfCounts);
	console.log("Found shelves: " + shelves.join(", "));
	return { shelves: shelves, counts: shelfCounts };
}

/**
 * Refresh data
 *
 * @param {number} goodreadsID   User ID number of user's Goodreads account
 * @param {string[]} overdriveURLs  URLs of user's OverDrive libraries
 * @param {string[]} [shelves]     Shelves to scan (defaults to ["to-read"])
 * @param {string}   [source]     Scan trigger source ("manual" or "auto")
 */
function refresh(goodreadsID, overdriveURLs, shelves, source) {
	// Single guard point: never start a scan while one is already running.
	// (The manual message handler also checks this, but auto-refresh calls
	// refresh() directly, and the async Goodreads reachability check below
	// leaves a window where the 1-minute alarm could otherwise double-fire.)
	if (isScanningLocal) return;
	isScanningLocal = true;
	chrome.storage.session.set({ currently_scanning: true, scan_started_at: Date.now() });

	// Invalidate any in-flight scan and capture this scan's ID
	const myScanId = ++currentScanId;

	// Show scanning badge immediately so the UI feels responsive
	chrome.action.setBadgeBackgroundColor({ color: [128, 128, 128, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	chrome.action.setBadgeText({ text: "1%" });

	if (navigator.onLine) {
		fetchWithTimeout("https://www.goodreads.com/", {
			method: "GET",
			headers: {
				"Content-Type": "text/xml",
			},
		}, 15000)
			.then((response) => {
				if (myScanId !== currentScanId) return;
				queryGoodreads(goodreadsID, overdriveURLs, shelves, myScanId, source);
			})
			.catch(function (err) {
				console.log("Could not connect to Goodreads. No internet connection.");
				// Release the lock we took above so a later scan can run.
				isScanningLocal = false;
				chrome.storage.session.set({ currently_scanning: false });
			});
	} else {
		console.log("Could not connect to Goodreads. No internet connection.");
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
	}
}

/**
 * Query Goodreads for shelf titles via public RSS feed (up to 500 books per shelf, 100 per page).
 * Iterates through each selected shelf sequentially to avoid rate limiting.
 *
 * @param {number}   goodreadsID   User ID number of user's Goodreads account
 * @param {string[]} overdriveURLs  URLs of user's OverDrive libraries
 * @param {string[]} [shelves]     Shelves to scan (defaults to saved selection or ["to-read"])
 * @param {number}   myScanId     Scan generation ID — bail if it no longer matches currentScanId
 * @param {string}   [source]     Scan trigger source ("manual" or "auto")
 */
async function queryGoodreads(goodreadsID, overdriveURLs, shelves, myScanId, source) {
	isScanningLocal = true;
	chrome.storage.session.set({ currently_scanning: true, scan_started_at: Date.now() });

	// Determine page limit based on Pro status (live check, fallback to cache).
	// Uses the shared top-level extpay instance so an unpaid→paid transition
	// observed here still fires the onPaid listener registered above.
	let isPro = false;
	try {
		const user = await extpay.getUser();
		isPro = !!user.paid;
		chrome.storage.local.set({ isPro: isPro, isProCheckedAt: Date.now() });
	} catch (e) {
		const proResult = await new Promise(function (resolve) {
			chrome.storage.local.get(["isPro"], function (r) { resolve(r); });
		});
		isPro = !!proResult.isPro;
	}
	const MAX_RSS_PAGES = isPro ? PRO_MAX_RSS_PAGES : FREE_MAX_RSS_PAGES;

	// Resolve shelves: use provided list, or fall back to storage, or default to ["to-read"]
	if (!shelves || shelves.length === 0) {
		const stored = await new Promise(function (resolve) {
			chrome.storage.local.get(["selectedShelves"], function (r) {
				resolve(r.selectedShelves);
			});
		});
		shelves = (stored && stored.length > 0) ? stored : ["to-read"];
	}

	// Free tier only scans the default "to-read" shelf, regardless of what was
	// passed or stored. This enforces the gate server-side so the popup no
	// longer has to destructively overwrite the user's saved shelf selection.
	if (!isPro) {
		shelves = ["to-read"];
	}

	Analytics.trackScanStarted(source || "unknown", shelves.length, overdriveURLs.length);

	// Update Loading view carousel messages every 10 seconds
	let carousel_messages = [
		"We'll scan your Goodreads shelves to find titles already available at your local OverDrive libraries.",
		...(isPro ? ["We'll automatically refresh your library every 24 hours so titles are always up-to-date."] : []),
		"Toggle between eBooks and audiobooks to find exactly what you're looking for.",
		"Use the search bar to explore your OverDrive libraries beyond just your Goodreads shelves.",
	];
	let carousel_position = 1;
	carousel_message_timer = setInterval(function () {
		chrome.runtime.sendMessage({
			msg: "CarouselMsg",
			text: carousel_messages[carousel_position % carousel_messages.length],
		}).catch(() => {});
		carousel_position++;
	}, 10000);

	// Set badge to scanning indicator
	chrome.action.setBadgeBackgroundColor({ color: [128, 128, 128, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	chrome.action.setBadgeText({ text: "1%" });

	try {
		let ToRead = [];
		const seenTitles = new Set();

		// Iterate through each shelf sequentially to avoid rate limiting
		for (let s = 0; s < shelves.length && myScanId === currentScanId; s++) {
			const shelfName = shelves[s];
			console.log("Fetching shelf: " + shelfName);

			// Fetch up to MAX_RSS_PAGES pages (100 books per page) from Goodreads RSS feed
			for (let page = 1; page <= MAX_RSS_PAGES && myScanId === currentScanId; page++) {
				const rssURL =
					"https://www.goodreads.com/review/list_rss/" +
					goodreadsID +
					"?shelf=" + encodeURIComponent(shelfName) +
					"&page=" + page;

				const response = await fetchWithTimeout(rssURL);
				const xmlString = await response.text();

				// Parse RSS XML items using regex (DOMParser not available in service workers)
				const itemRegex = /<item>([\s\S]*?)<\/item>/g;
				const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
				const authorRegex = /<author_name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/author_name>/;
				let itemMatch;
				let itemCount = 0;

				while ((itemMatch = itemRegex.exec(xmlString)) !== null) {
					itemCount++;
					const itemXml = itemMatch[1];
					const titleMatch = itemXml.match(titleRegex);
					const authorMatch = itemXml.match(authorRegex);
					const title = titleMatch ? titleMatch[1].trim() : null;
					const author = authorMatch ? authorMatch[1].trim() : null;
					if (title && author) {
						// Deduplicate across shelves by title+author
						const key = title.toLowerCase() + "|||" + author.toLowerCase();
						if (!seenTitles.has(key)) {
							seenTitles.add(key);
							ToRead.push({ title, author });
						}
					}
				}

				// If no items on this page, we've reached the end of this shelf
				if (itemCount === 0) {
					break;
				}

				console.log("Goodreads RSS shelf=" + shelfName + " page " + page + ": " + itemCount + " books");

				// If fewer than 100 items, this was the last page
				if (itemCount < 100) {
					break;
				}
			}
		}

		if (myScanId !== currentScanId) {
			console.log("Scan invalidated during Goodreads fetch.");
			clearInterval(carousel_message_timer);
			return;
		}

		console.log("Goodreads shelves (" + shelves.join(", ") + "): " + ToRead.length + " books total");
		console.log(ToRead);

		Analytics.trackScanCompleted(ToRead.length, overdriveURLs.length, shelves.length);

		if (ToRead.length === 0) {
			throw new Error("No books found on selected shelves");
		}

		// Query OverDrive for these titles
		queryOverdrive(ToRead, overdriveURLs, myScanId, goodreadsID);

		// Send initial progress to popup
		chrome.runtime.sendMessage({
			msg: "In Progress",
			count: 0,
			total: ToRead.length * overdriveURLs.length,
			bookCount: 0,
			bookTotal: ToRead.length,
			libraryCount: overdriveURLs.length,
		}).catch(() => {});

	} catch (err) {
		console.log("Goodreads fetch Error ", err);
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
		clearInterval(carousel_message_timer);
		Analytics.trackScanFailed('goodreads', err.message);
		updateBadgeError();

		chrome.storage.local.set({ error: "Goodreads", count: 0 });

		// Double error timeout upon each repeated error to prevent over-refreshing
		chrome.storage.session.get(["errorTimeout"], function (result) {
			let errorTimeout = result.errorTimeout || 0;
			errorTimeout = errorTimeout > 0 ? errorTimeout * 2 : 1;
			if (errorTimeout > refreshWait * 7) errorTimeout = refreshWait * 7;
			chrome.storage.session.set({ errorTimeout: errorTimeout });

			let last_run_time = new Date();
			last_run_time.setMinutes(
				last_run_time.getMinutes() - refreshWait + errorTimeout
			);
			chrome.storage.local.set({ LastRun: last_run_time.toJSON() });
		});

		chrome.runtime.sendMessage({ msg: "GoodreadsError" }).catch(() => {});
	}
}

/**
 * Query multiple OverDrive libraries for book availability.
 * Scans one library at a time, one book at a time, to avoid rate limiting.
 *
 * @param {Object[]}    ToRead              All books identified on Goodreads shelves
 * @param {string}      ToRead[].title      Book's title
 * @param {string}      ToRead[].author     Book's author
 * @param {string[]}    overdriveURLs       URLs of user's OverDrive libraries
 * @param {number}      myScanId            Scan generation ID — bail if it no longer matches currentScanId
 */
async function queryOverdrive(ToRead, overdriveURLs, myScanId, goodreadsID) {
	console.log("Query OverDrive (" + overdriveURLs.length + " libraries).");

	// Refresh shelf counts in the background while OverDrive scan runs,
	// so the settings page stays up-to-date without a manual "Refresh shelves".
	if (goodreadsID) {
		chrome.storage.session.set({ shelf_refresh_in_progress: true });
		fetchShelves(goodreadsID).then(function (result) {
			if (result && result.shelves && result.shelves.length > 0) {
				chrome.storage.local.set({ availableShelves: result.shelves, shelfCounts: result.counts || {} });
				chrome.runtime.sendMessage({ msg: "shelfScanComplete", shelves: result.shelves, counts: result.counts || {} }).catch(() => {});
			}
		}).catch(function (err) {
			console.log("Background shelf refresh failed (non-fatal):", err);
		}).finally(function () {
			chrome.storage.session.set({ shelf_refresh_in_progress: false });
		});
	}
	chrome.storage.session.set({ currently_scanning: true });
	let available_count = 0;
	let unavailable_count = 0;

	// Set badge to scanning percentage
	chrome.action.setBadgeBackgroundColor({ color: [128, 128, 128, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	chrome.action.setBadgeText({ text: "2%" });

	let BookAvailability = [];
	let totalRequests = ToRead.length * overdriveURLs.length;
	let completedRequests = 0;
	let failedLibraries = [];

	for (let libIdx = 0; libIdx < overdriveURLs.length && myScanId === currentScanId; libIdx++) {
		let overdriveURL = overdriveURLs[libIdx];
		let libraryError = false;
		let libraryMatchCount = 0;
		console.log("Scanning library: " + overdriveURL);

		// Send reset progress at the start of each library
		chrome.runtime.sendMessage({
			msg: "In Progress",
			count: completedRequests,
			total: totalRequests,
			bookCount: 0,
			bookTotal: ToRead.length,
			libraryName: overdriveURL,
			libraryIndex: libIdx + 1,
			libraryCount: overdriveURLs.length,
		}).catch(() => {});

		for (let i = 0; i < ToRead.length && !libraryError && myScanId === currentScanId; i++) {
			try {
				const res = await fetchWithTimeout(
					overdriveURL +
						"/search/title?query=" +
						encodeURIComponent(ToRead[i].title) +
						"&creator=" +
						encodeURIComponent(ToRead[i].author)
				);
				const html = await res.text();

				// Identify book availability data in response
				let overdriveJSONresults = extractOverdriveMediaItems(html);
				if (!overdriveJSONresults) {
					console.log(
						ToRead[i].title + " by " + ToRead[i].author + " not found at " + overdriveURL
					);
					completedRequests++;
					chrome.runtime.sendMessage({
						msg: "In Progress",
						count: completedRequests,
						total: totalRequests,
						bookCount: i + 1,
						bookTotal: ToRead.length,
						libraryName: overdriveURL,
						libraryIndex: libIdx + 1,
						libraryCount: overdriveURLs.length,
					}).catch(() => {});
					var pct = Math.floor(2 + (completedRequests / totalRequests) * 97);
					chrome.action.setBadgeText({ text: pct + "%" });
					continue;
				}
				libraryMatchCount++;
				let JSON_length = Object.keys(overdriveJSONresults).length;

				if (JSON_length === 0) {
					console.log(
						ToRead[i].title + " by " + ToRead[i].author + " not found at " + overdriveURL
					);
				} else {
					for (var result in overdriveJSONresults) {
						try {
							var book = overdriveJSONresults[result];
							let title = book.title;
							let author = book.firstCreatorName;
							let type = (book.type && book.type.name) || "Unknown";
							let cover = (book.covers && book.covers.cover150Wide && book.covers.cover150Wide.href) || "";
							let available = book.isAvailable;
							let estimatedWait = book.estimatedWaitDays;
							let availableCopies = book.availableCopies;
							let duration = book.formats && book.formats.find(function (f) { return f.duration; });
							duration = duration ? duration.duration : undefined;
							let URL = overdriveURL + "/media/" + book.id;
							let library = overdriveURL;
							BookAvailability.push({ title, author, type, cover, available, estimatedWait, availableCopies, duration, URL, library });
							if (available) {
								available_count++;
							} else {
								unavailable_count++;
							}
						} catch (error) {
							console.log(
								ToRead[i].title + " by " + ToRead[i].author + " metadata could not be loaded."
							);
						}
					}
				}

				completedRequests++;

				// Send progress to popup
				chrome.runtime.sendMessage({
					msg: "In Progress",
					count: completedRequests,
					total: totalRequests,
					bookCount: i + 1,
					bookTotal: ToRead.length,
					libraryName: overdriveURL,
					libraryIndex: libIdx + 1,
					libraryCount: overdriveURLs.length,
				}).catch(() => {});

				var pct = Math.floor(2 + (completedRequests / totalRequests) * 97);
				chrome.action.setBadgeText({ text: pct + "%" });
			} catch (err) {
				console.log("OverDrive fetch Error for " + overdriveURL + ": ", err);
				Analytics.trackOverdriveLibraryFailed(overdriveURL, err.message);
				libraryError = true;
				failedLibraries.push(overdriveURL);
				// Skip remaining books for this library
				completedRequests = (libIdx + 1) * ToRead.length;
			}
		}

		// If the OverDrive data regex never matched for any book, the library URL is likely invalid
		if (!libraryError && libraryMatchCount === 0 && ToRead.length > 0) {
			console.log("No OverDrive data found for any book at " + overdriveURL + " — treating as failed library.");
			Analytics.trackOverdriveLibraryFailed(overdriveURL, "No OverDrive data matched");
			failedLibraries.push(overdriveURL);
		}
	}

	// Scan was invalidated (cancelled or superseded) — exit without saving partial results
	if (myScanId !== currentScanId) {
		console.log("Scan invalidated during OverDrive fetch.");
		clearInterval(carousel_message_timer);
		return;
	}

	// All libraries processed
	if (failedLibraries.length === overdriveURLs.length) {
		// ALL libraries failed — treat as error
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
		clearInterval(carousel_message_timer);
		updateBadgeError();

		chrome.storage.local.set({ error: "OverDrive", count: 0 });

		chrome.storage.session.get(["errorTimeout"], function (result) {
			let errorTimeout = result.errorTimeout || 0;
			errorTimeout = errorTimeout > 0 ? errorTimeout * 2 : 1;
			if (errorTimeout > refreshWait * 7) errorTimeout = refreshWait * 7;
			chrome.storage.session.set({ errorTimeout: errorTimeout });

			let last_run_time = new Date();
			last_run_time.setMinutes(
				last_run_time.getMinutes() - refreshWait + errorTimeout
			);
			chrome.storage.local.set({ LastRun: last_run_time.toJSON() });
		});

		var failedDomains = failedLibraries.map(function (u) { try { return new URL(u).hostname; } catch (e) { return u; } });
		Analytics.trackOverdriveAllFailed(failedDomains);
		chrome.runtime.sendMessage({ msg: "OverdriveError", failedLibraries: failedLibraries }).catch(() => {});
	} else {
		// At least one library succeeded
		// Snapshot currently-available URLs before overwriting, then save new results and notify
		chrome.storage.local.get(["BookAvailability", "ebook_toggle", "audiobook_toggle"], function (prev) {
			const prevAvailable = (prev.BookAvailability || [])
				.filter((b) => b.available && b.URL)
				.map((b) => b.URL);

			// Filter based on user's saved toggle preferences
			var ebookOn = prev.ebook_toggle !== false;
			var audiobookOn = prev.audiobook_toggle !== false;
			function matchesToggle(book) {
				if (book.type === "eBook") return ebookOn;
				if (book.type === "Audiobook") return audiobookOn;
				return true;
			}

			// Detect available and newly available books (filtered by toggle)
			var allAvailable = BookAvailability.filter(function (b) { return b.available && matchesToggle(b); });
			var prevSet = new Set(prevAvailable);
			var newBooks = allAvailable.filter(function (b) {
				return b.URL && !prevSet.has(b.URL);
			});

			// Choose label based on toggle preference
			var itemLabel = "book";
			if (ebookOn && !audiobookOn) itemLabel = "ebook";
			else if (!ebookOn && audiobookOn) itemLabel = "audiobook";

			// Show notification if any books are available
			if (allAvailable.length > 0) {
				var description, listBooks;
				if (newBooks.length > 0 && prev.BookAvailability && prev.BookAvailability.length > 0) {
					description = newBooks.length + " new " + itemLabel + (newBooks.length === 1 ? "" : "s") + " available today! (" + allAvailable.length + " total)";
					listBooks = newBooks;
				} else {
					description = allAvailable.length + " " + itemLabel + (allAvailable.length === 1 ? "" : "s") + " available today!";
					listBooks = allAvailable;
				}
				var bookList = listBooks.slice(0, 8).map(function (b) { return b.title; });
				var body = description + "\n" + bookList.join("\n");
				if (listBooks.length > 8) {
					body += "\n...and " + (listBooks.length - 8) + " more";
				}

				var notifData = { title: "Library Scan Pro", message: body };
				chrome.notifications.create("library-scan-new-books", {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon128.png"),
					title: notifData.title,
					message: notifData.message
				}, function (notificationId) {
					if (chrome.runtime.lastError) {
						console.error("Notification error:", chrome.runtime.lastError.message);
					} else {
						console.log("Notification created:", notificationId);
					}
				});
				// Save for re-send if user is currently idle/locked
				chrome.idle.queryState(60, function (state) {
					if (state !== "active") {
						chrome.storage.local.set({ pendingNotification: notifData });
					}
				});
			}

			// Save PreviouslyAvailable first, then overwrite BookAvailability and notify popup
			chrome.storage.local.set({ PreviouslyAvailable: prevAvailable }, function () {
				chrome.storage.local.set({
					BookAvailability: BookAvailability,
					count: available_count,
					LastRun: new Date().toJSON(),
					error: "None",
				});

				console.log("Sending Complete with failedLibraries:", failedLibraries);
				chrome.runtime.sendMessage({
					msg: "Complete",
					BookAvailability: BookAvailability,
					failedLibraries: failedLibraries,
				}).catch(() => {});

				// Re-send completion after 1 second to overwrite any timing delays
				setTimeout(function () {
					chrome.runtime.sendMessage({
						msg: "Complete",
						BookAvailability: BookAvailability,
						failedLibraries: failedLibraries,
					}).catch(() => {});
				}, 1000);
			});
		});

		clearInterval(carousel_message_timer);
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false, errorTimeout: 0 });

		// Filter for accurate badge count based on toggle preferences
		updateBadgeCount(available_count);
		chrome.storage.local.get(
			["ebook_toggle", "audiobook_toggle"],
			function (result) {
				let ebookToggle = result.ebook_toggle;
				let audiobookToggle = result.audiobook_toggle;
				if (
					typeof ebookToggle !== "undefined" &&
					typeof audiobookToggle !== "undefined"
				) {
					let Available = [];
					for (let j = 0; j < BookAvailability.length; j++) {
						if (BookAvailability[j].type === "eBook" && ebookToggle) {
							if (BookAvailability[j].available === true) {
								Available.push(BookAvailability[j]);
							}
						} else if (
							BookAvailability[j].type === "Audiobook" &&
							audiobookToggle
						) {
							if (BookAvailability[j].available === true) {
								Available.push(BookAvailability[j]);
							}
						}
					}
					updateBadgeCount(Available.length);
					chrome.storage.local.set({ count: Available.length });
				}
			}
		);
		var libraryDomains = overdriveURLs.map(function (u) { try { return new URL(u).hostname; } catch (e) { return u; } });
		var failedDomains = failedLibraries.map(function (u) { try { return new URL(u).hostname; } catch (e) { return u; } });
		Analytics.trackOverdriveScanCompleted(available_count, unavailable_count, libraryDomains, failedDomains);
		console.log("OverDrive scan complete.");
	}
}

/**
 * Extract the `window.OverDrive.mediaItems = {...};` JSON object from an
 * OverDrive HTML page by balancing braces (string-aware), instead of a greedy
 * single-line regex that can over- or under-match if the page format shifts.
 *
 * @param {string} html  Raw OverDrive page HTML
 * @returns {Object|null} Parsed mediaItems object, or null if not found/parseable
 */
function extractOverdriveMediaItems(html) {
	const marker = html.match(/window\.OverDrive\.mediaItems\s*=\s*/);
	if (!marker) return null;
	let start = marker.index + marker[0].length;
	if (html[start] !== "{") return null;

	let depth = 0, inStr = false, esc = false;
	for (let i = start; i < html.length; i++) {
		const ch = html[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') {
			inStr = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(html.slice(start, i + 1));
				} catch (e) {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * Fetch data with a maximum allotted time (60 seconds) before fetch failure
 *
 * @param   {string}    uri             Fetch URL
 * @param   {*}         [options={}]    Fetch options
 * @param   {number}    [time=60000]    Fetch maximum allotted time
 * @returns {*}                         Response from data fetch
 */
async function fetchWithTimeout(uri, options = {}, time = 60000) {
	const controller = new AbortController();
	const config = { ...options, signal: controller.signal };
	const timeout = setTimeout(() => {
		controller.abort();
	}, time);
	try {
		const response = await fetch(uri, config);
		clearTimeout(timeout);
		if (!response.ok) {
			throw new Error(`${response.status}: ${response.statusText}`);
		}
		return response;
	} catch (error) {
		clearTimeout(timeout);
		if (error.name === "AbortError") {
			Analytics.trackTimeout(uri);
			throw new Error("Response timed out.");
		}
		Analytics.trackFetchFailure(error.message);
		throw new Error(error.message);
	}
}

/**
 * Update extension badge count to display number of books currently available
 *
 * @param {number} count Number of books currently available
 */
function updateBadgeCount(count) {
	chrome.action.setBadgeBackgroundColor({ color: [0, 123, 255, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	if (count != 0) {
		chrome.action.setBadgeText({ text: count.toString() });
	} else {
		chrome.action.setBadgeText({ text: "" });
	}
}

/**
 * Show a red error badge on the extension icon
 */
function updateBadgeError() {
	chrome.action.setBadgeBackgroundColor({ color: [220, 53, 69, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	chrome.action.setBadgeText({ text: "!" });
}

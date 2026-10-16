// ExtensionPay setup
importScripts('../ExtPay.js');
importScripts('api_keys.js');
importScripts('../analytics.js');
const extpay = ExtPay('library-scan');
extpay.startBackground();

// Catch-all error telemetry — unexpected background errors go to PostHog's
// error tracking (each distinct error at most once a day per device).
self.addEventListener("error", function (e) {
	Analytics.trackError("background", e.error || e.message);
});
self.addEventListener("unhandledrejection", function (e) {
	Analytics.trackError("background", e.reason);
});

// Cache paid status the moment ExtPay confirms payment. The background poll
// (ExtPay's poll_user_paid) runs even while the popup is closed during the
// payment flow, so this is the reliable source of truth for Pro status —
// the popup then reacts to the isPro storage change and updates live.
extpay.onPaid.addListener(async function (user) {
	chrome.storage.local.set({ isPro: true });
	user = await waitForPaidEmail(user);
	// Link the buyer's devices first so the purchase lands on their person
	await Analytics.linkPaidUser(user);
	Analytics.trackPurchase(user);
});

/**
 * @type {number} Give up on an ExtensionPay status check after this long and
 * fall back to the cached Pro status, so a slow or unreachable ExtensionPay
 * server can never hold up a scan.
 */
const EXTPAY_TIMEOUT_MS = 5000;

/**
 * Fetch the ExtensionPay user, rejecting if it takes longer than
 * EXTPAY_TIMEOUT_MS.
 *
 * @returns {Promise<Object>} ExtensionPay user
 */
function getExtPayUser() {
	return Promise.race([
		extpay.getUser(),
		new Promise(function (resolve, reject) {
			setTimeout(function () { reject(new Error("ExtensionPay timed out")); }, EXTPAY_TIMEOUT_MS);
		}),
	]);
}

/**
 * @type {number[]} Waits between re-asking ExtensionPay for a new buyer's
 * email (5s, 15s and 30s after payment). Each gap stays well under the 30s
 * idle limit that would shut down the service worker.
 */
const PAID_EMAIL_RETRY_DELAYS_MS = [5000, 10000, 15000];

/**
 * ExtensionPay can confirm a payment before the buyer's email is attached,
 * and linking the purchase to the buyer needs that email. Ask again a few
 * times until it shows up. Waiting before each ask also matters: by then
 * ExtPay has saved the payment, so asking again doesn't re-fire onPaid.
 *
 * @param {Object} user  ExtensionPay user passed to onPaid
 * @returns {Promise<Object>} The freshest paid user, with an email if one arrived
 */
async function waitForPaidEmail(user) {
	for (const delay of PAID_EMAIL_RETRY_DELAYS_MS) {
		if (user && user.email) break;
		await new Promise(function (resolve) { setTimeout(resolve, delay); });
		try {
			const fresh = await getExtPayUser();
			if (fresh && fresh.paid) user = fresh;
		} catch (e) {
			// Network error or timeout — try again on the next delay
		}
	}
	return user;
}

/**
 * Parse a Goodreads user ID from a profile URL or a bare ID.
 * Must match parseGoodreadsID in popup.js.
 *
 * @param {string} input  e.g. "goodreads.com/user/show/12345678-name"
 * @returns {string|null} Numeric ID
 */
function parseGoodreadsID(input) {
	if (!input) return null;
	input = String(input).trim();
	const urlMatch = input.match(/goodreads\.com\/user\/show\/(\d+)/);
	if (urlMatch) return urlMatch[1];
	const numMatch = input.match(/^(\d+)/);
	if (numMatch) return numMatch[1];
	return null;
}

/**
 * Parse an OverDrive library URL into https://xxx.overdrive.com.
 * Must match parseOverdriveURL in popup.js.
 *
 * @param {string} input  e.g. "https://lapl.overdrive.com/", "lapl"
 * @returns {string|null} Canonical library URL
 */
function parseOverdriveURL(input) {
	if (!input) return null;
	input = String(input).trim().replace(/\/+$/, "");
	const match = input.match(/(?:https?:\/\/)?([\w-]+\.overdrive\.com)/i);
	if (match) return "https://" + match[1];
	const codeMatch = input.match(/^([\w-]+)$/);
	if (codeMatch) return "https://" + codeMatch[1] + ".overdrive.com";
	return null;
}

/**
 * @param {string} url
 * @returns {string} The URL's hostname, or the input if it isn't a URL
 */
function hostOf(url) {
	try { return new URL(url).hostname; } catch (e) { return String(url || ""); }
}

/**
 * Convert settings saved by Library Scan 1.x, which kept a single library
 * as `overdriveURL` (exactly as typed) and the Goodreads ID as typed. 2.0
 * switched to an `overdriveURLs` list without converting them, so 1.x users
 * silently stopped scanning and were sent back to setup. Their old results
 * are cleared too: they're months out of date, and with no results the
 * popup runs a fresh scan the next time it opens. Safe to run on every
 * start — it only acts on unconverted 1.x settings.
 *
 * @returns {Promise<boolean>} Whether 1.x settings were converted
 */
function migrateLegacySettings() {
	return new Promise(function (resolve) {
		chrome.storage.local.get(["overdriveURL", "overdriveURLs", "goodreadsID"], function (result) {
			const hasLibraries = result.overdriveURLs && result.overdriveURLs.length > 0;
			const libraryURL = !hasLibraries && parseOverdriveURL(result.overdriveURL);
			if (!libraryURL) return resolve(false);

			const settings = { overdriveURLs: [libraryURL] };
			const goodreadsID = parseGoodreadsID(result.goodreadsID);
			if (goodreadsID) settings.goodreadsID = goodreadsID;
			chrome.storage.local.remove(
				["overdriveURL", "BookAvailability", "PreviouslyAvailable", "LastRun", "count", "error"],
				function () {
					chrome.storage.local.set(settings, function () { resolve(true); });
				}
			);
		});
	});
}

const legacyMigration = migrateLegacySettings();

/**
 * Snapshot of this install's state, sent with extension_updated.
 *
 * @param {boolean} migratedLegacy  1.x settings were just converted
 * @returns {Promise<Object>}
 */
function installState(migratedLegacy) {
	return new Promise(function (resolve) {
		chrome.storage.local.get(
			["goodreadsID", "overdriveURLs", "selectedShelves", "isPro", "LastRun", "BookAvailability", "error"],
			function (r) {
				const libraries = r.overdriveURLs || [];
				resolve({
					setup_complete: !!(r.goodreadsID && libraries.length > 0),
					is_pro: !!r.isPro,
					library_count: libraries.length,
					shelf_count: (r.selectedShelves || ["to-read"]).length,
					has_results: !!(r.BookAvailability && r.BookAvailability.length > 0),
					days_since_last_scan: r.LastRun ? Math.floor((Date.now() - new Date(r.LastRun)) / 86400000) : null,
					last_scan_error: r.error && r.error !== "None" ? r.error : null,
					migrated_legacy_settings: migratedLegacy,
				});
			}
		);
	});
}

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
 * @type {number} Wait before retrying an OverDrive search that hit a brief
 * server error
 */
const OVERDRIVE_RETRY_DELAY_MS = 2000;

/**
 * @type {number} Books in a row that can fail (even after a retry) before a
 * library counts as down for this scan. Caps a real outage at a handful of
 * requests per library instead of one per book.
 */
const OVERDRIVE_MAX_CONSECUTIVE_FAILURES = 3;

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
		Analytics.trackNotificationClicked();
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
				Analytics.trackNotificationShown(data.newBooks, data.totalBooks, data.scanSource, true);
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
		// Rejects with "No current window" when no browser window is open, e.g.
		// force-installed on a managed Chromebook at sign-in. Skip the guide
		// rather than opening a window, and keep it out of error tracking.
		chrome.tabs.create({
			url: "https://isaacbock.com/library-scan#start",
		}).catch(function () {});
		chrome.runtime.setUninstallURL(
			"https://isaacbock.com/library-scan-uninstall"
		);
		Analytics.trackInstall();
	} else if (details.reason === "update") {
		legacyMigration.then(installState).then(function (state) {
			Analytics.trackUpdate(details.previousVersion, state);
		});
		chrome.runtime.setUninstallURL(
			"https://isaacbock.com/library-scan-uninstall"
		);
	}
});

// In-memory scanning lock (avoids async storage race condition)
let isScanningLocal = false;

/**
 * @type {{id: string, startedAt: number}|null} Analytics metadata for the
 * current scan — the shared scan_id joins scan_started to its outcome events.
 */
let currentScanMeta = null;

// Receive messages from popup.js (front-end) and respond with data
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
	if (request.msg === "goodreads") {
		if (!isScanningLocal) {
			refresh(request.goodreadsID, request.overdriveURLs, request.shelves, "manual", request.sessionId, request.trigger);
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
		if (currentScanMeta) Analytics.trackScanCancelled(currentScanMeta);
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
				chrome.storage.session.get(["currently_scanning", "scan_started_at", "scan_id"], async function (scanResult) {
					// A scan running in this service worker is alive however long
					// it takes (every request times out on its own), so leave it
					// alone. The flag is only stale when Chrome restarted the
					// worker mid-scan, which resets isScanningLocal — then don't
					// let the dead scan block auto-refresh forever. (Clearing it
					// for long live scans restarted them every ~11 minutes.)
					let scanning = scanResult.currently_scanning;
					if (scanning && !isScanningLocal && (!scanResult.scan_started_at || (Date.now() - scanResult.scan_started_at) > STALE_SCAN_MS)) {
						scanning = false;
						chrome.storage.session.set({ currently_scanning: false });
						Analytics.trackScanAbandoned({
							scan_id: scanResult.scan_id,
							running_minutes: scanResult.scan_started_at
								? Math.round((Date.now() - scanResult.scan_started_at) / 60000)
								: undefined,
						});
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
							const user = await getExtPayUser();
							isPro = !!user.paid;
							chrome.storage.local.set({ isPro: isPro });
							Analytics.linkPaidUser(user);
						} catch (e) {
							// Network error or timeout — keep the cached value
						}
					}

					if (isPro && elapsedTime > refreshWait && !scanning) {
						refresh(goodreadsID, overdriveURLs, result.selectedShelves, "auto", undefined, "auto");
						elapsedTime = 0;
					}

					// Send elapsed time to popup
					chrome.runtime.sendMessage({ msg: "ElapsedTime", time: formatElapsedTime(elapsedTime) }).catch(() => {});

					// Auto add badge count (in case of extension update or reset) —
					// but never while scanning, or this would stomp the N% progress
					// badge with the stale count on every 1-minute tick.
					if (!scanning && typeof error !== "undefined" && typeof count !== "undefined") {
						if (error == "None") {
							updateBadgeCount(count);
						} else {
							updateBadgeError();
						}
					}
				});
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
	let prevFirstGuid = null;

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

		// Guard against a feed that ignores &page= and repeats itself
		const firstGuid = (xml.match(/<guid>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/) || [])[1];
		if (firstGuid && firstGuid === prevFirstGuid) break;
		prevFirstGuid = firstGuid;

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
 * @param {string}   [source]     "manual" or "auto"
 * @param {string}   [sessionId]  Popup analytics session that started a manual scan
 * @param {string}   [trigger]    What started it: setup, refresh_button, settings,
 *                                retry, no_results (popup opened with no results) or auto
 */
function refresh(goodreadsID, overdriveURLs, shelves, source, sessionId, trigger) {
	// Single guard point: never start a scan while one is already running.
	// (The manual message handler also checks this, but auto-refresh calls
	// refresh() directly, and the async Goodreads reachability check below
	// leaves a window where the 1-minute alarm could otherwise double-fire.)
	if (isScanningLocal) return;

	// Offline: nothing to scan. Auto-scans try again on the next 1-minute
	// tick; a manual scan tells the popup rather than leaving it loading.
	if (!navigator.onLine) {
		console.log("Could not connect to Goodreads. No internet connection.");
		if (source === "manual") chrome.runtime.sendMessage({ msg: "GoodreadsError" }).catch(() => {});
		return;
	}

	isScanningLocal = true;
	const scanAnalyticsId = "scan_" + Date.now();
	// scan_id lets a restarted service worker report which scan it lost
	chrome.storage.session.set({ currently_scanning: true, scan_started_at: Date.now(), scan_id: scanAnalyticsId });

	// Invalidate any in-flight scan and capture this scan's ID
	const myScanId = ++currentScanId;

	// Analytics metadata: scan_id joins this scan's events; startedAt feeds
	// the duration on completion; sessionId ties a manual scan to the popup
	// session (and recording) that started it. isPro and the book counts
	// are filled in as the scan learns them.
	const scanMeta = {
		id: scanAnalyticsId,
		startedAt: Date.now(),
		sessionId: sessionId,
		source: source || "unknown",
		trigger: trigger || source || "unknown",
	};
	currentScanMeta = scanMeta;

	// Show scanning badge immediately so the UI feels responsive
	chrome.action.setBadgeBackgroundColor({ color: [128, 128, 128, 255] });
	chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
	chrome.action.setBadgeText({ text: "1%" });

	fetchWithTimeout("https://www.goodreads.com/", {
		method: "GET",
		headers: {
			"Content-Type": "text/xml",
		},
	}, 15000)
		.then((response) => {
			if (myScanId !== currentScanId) return;
			queryGoodreads(goodreadsID, overdriveURLs, shelves, myScanId, source, scanMeta);
		})
		.catch(function (err) {
			if (myScanId !== currentScanId) return;
			console.log("Could not connect to Goodreads.", err);
			isScanningLocal = false;
			chrome.storage.session.set({ currently_scanning: false });
			// Back off like any failed scan. This used to retry every minute
			// and leave the badge stuck at "1%".
			recordScanError("Goodreads").then(function (failures) {
				Analytics.trackScanFailed(scanMeta, "goodreads_unreachable", {
					error_message: err.message,
					http_status: err.status,
					timed_out: !!err.timedOut,
					consecutive_failures: failures,
				});
			});
			chrome.runtime.sendMessage({ msg: "GoodreadsError" }).catch(() => {});
		});
}

/**
 * Record a failed scan: error badge, error state for the popup, and an
 * exponential back-off (1 minute, doubling up to 7 days) so a failing scan
 * isn't retried every minute. Kept in local storage so restarting the
 * browser doesn't reset the back-off.
 *
 * @param {string} errorSource  "Goodreads" or "OverDrive"
 * @returns {Promise<number>} Failed scans in a row, including this one
 */
function recordScanError(errorSource) {
	updateBadgeError();
	return new Promise(function (resolve) {
		chrome.storage.local.get(["errorTimeout", "consecutiveScanFailures"], function (result) {
			let errorTimeout = result.errorTimeout || 0;
			errorTimeout = errorTimeout > 0 ? errorTimeout * 2 : 1;
			if (errorTimeout > refreshWait * 7) errorTimeout = refreshWait * 7;

			// Back-date LastRun so the next auto-scan comes errorTimeout minutes from now
			let last_run_time = new Date();
			last_run_time.setMinutes(
				last_run_time.getMinutes() - refreshWait + errorTimeout
			);
			const failures = (result.consecutiveScanFailures || 0) + 1;
			chrome.storage.local.set({
				error: errorSource,
				count: 0,
				errorTimeout: errorTimeout,
				consecutiveScanFailures: failures,
				LastRun: last_run_time.toJSON(),
			}, function () {
				resolve(failures);
			});
		});
	});
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
 * @param {{id: string, startedAt: number}} scanMeta  Analytics scan metadata
 */
async function queryGoodreads(goodreadsID, overdriveURLs, shelves, myScanId, source, scanMeta) {
	isScanningLocal = true;
	chrome.storage.session.set({ currently_scanning: true, scan_started_at: Date.now() });

	// Determine page limit based on Pro status (live check, fallback to cache).
	// Uses the shared top-level extpay instance so an unpaid→paid transition
	// observed here still fires the onPaid listener registered above.
	let isPro = false;
	try {
		const user = await getExtPayUser();
		isPro = !!user.paid;
		chrome.storage.local.set({ isPro: isPro, isProCheckedAt: Date.now() });
		Analytics.linkPaidUser(user);
	} catch (e) {
		const proResult = await new Promise(function (resolve) {
			chrome.storage.local.get(["isPro"], function (r) { resolve(r); });
		});
		isPro = !!proResult.isPro;
	}
	const MAX_RSS_PAGES = isPro ? PRO_MAX_RSS_PAGES : FREE_MAX_RSS_PAGES;
	scanMeta.isPro = isPro;

	// Resolve shelves: use provided list, or fall back to storage, or default to ["to-read"]
	if (!shelves || shelves.length === 0) {
		const stored = await new Promise(function (resolve) {
			chrome.storage.local.get(["selectedShelves"], function (r) {
				resolve(r.selectedShelves);
			});
		});
		shelves = (stored && stored.length > 0) ? stored : ["to-read"];
	}

	// Free tier only scans the default "to-read" shelf and the first saved
	// library, regardless of what was passed or stored. This enforces the gate
	// server-side so the popup never has to destructively overwrite saved
	// settings — a downgraded user's extra shelves/libraries stay saved and
	// re-activate if they upgrade again.
	if (!isPro) {
		shelves = ["to-read"];
		overdriveURLs = overdriveURLs.slice(0, 1);
	}

	Analytics.trackScanStarted(scanMeta, { shelf_count: shelves.length, library_count: overdriveURLs.length });

	// Update Loading view carousel messages every 10 seconds
	let carousel_messages = [
		"We'll scan your Goodreads shelves to find titles already available at your local OverDrive libraries.",
		...(isPro ? ["We'll automatically refresh your library every 24 hours so titles are always up-to-date."] : []),
		"Toggle between eBooks and audiobooks to find exactly what you're looking for.",
		"Use the search bar to explore your OverDrive libraries beyond just your Goodreads shelves.",
	];
	let carousel_position = 1;
	// Kill any timer leaked by a previous (superseded) scan before starting ours
	clearInterval(carousel_message_timer);
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
		// Free scans read one feed page; a full page means more books were left out
		let truncatedByFreeLimit = false;
		// Pages with fewer than 100 books that still had more pages after them
		let shortPagesMidShelf = 0;

		// Iterate through each shelf sequentially to avoid rate limiting
		for (let s = 0; s < shelves.length && myScanId === currentScanId; s++) {
			const shelfName = shelves[s];
			console.log("Fetching shelf: " + shelfName);
			let prevPageShort = false;
			let prevFirstGuid = null;

			// Fetch up to MAX_RSS_PAGES pages (100 books per page) from Goodreads RSS feed
			for (let page = 1; page <= MAX_RSS_PAGES && myScanId === currentScanId; page++) {
				const rssURL =
					"https://www.goodreads.com/review/list_rss/" +
					goodreadsID +
					"?shelf=" + encodeURIComponent(shelfName) +
					"&page=" + page;

				const response = await fetchWithTimeout(rssURL);
				const xmlString = await response.text();

				// A private or missing profile, or a block page, comes back as
				// a web page rather than a feed
				if (xmlString.indexOf("<rss") === -1) {
					const notFeedErr = new Error("Goodreads returned a web page instead of a shelf feed");
					notFeedErr.stage = "goodreads_not_feed";
					throw notFeedErr;
				}

				// Parse RSS XML items using regex (DOMParser not available in service workers)
				const itemRegex = /<item>([\s\S]*?)<\/item>/g;
				const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/;
				const authorRegex = /<author_name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/author_name>/;
				let itemMatch;
				let itemCount = 0;
				let parsedCount = 0;

				while ((itemMatch = itemRegex.exec(xmlString)) !== null) {
					itemCount++;
					const itemXml = itemMatch[1];
					const titleMatch = itemXml.match(titleRegex);
					const authorMatch = itemXml.match(authorRegex);
					const title = titleMatch ? titleMatch[1].trim() : null;
					const author = authorMatch ? authorMatch[1].trim() : null;
					if (title && author) {
						parsedCount++;
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

				// Books listed but none readable: Goodreads changed its feed format
				if (parsedCount === 0) {
					const formatErr = new Error("Goodreads shelf feed items have no readable title/author");
					formatErr.name = "GoodreadsFeedFormatError";
					formatErr.stage = "goodreads_format";
					throw formatErr;
				}

				if (!isPro && page === MAX_RSS_PAGES && itemCount >= 100) {
					truncatedByFreeLimit = true;
				}

				console.log("Goodreads RSS shelf=" + shelfName + " page " + page + ": " + itemCount + " books");

				// Only an empty page marks the end. Goodreads sometimes leaves a
				// book out of a page (99 instead of 100) even when more pages
				// follow; count those so analytics shows how often it happens.
				if (prevPageShort) {
					shortPagesMidShelf++;
				}
				prevPageShort = itemCount < 100;

				// Guard against a feed that ignores &page= and repeats itself
				const firstGuid = (xmlString.match(/<guid>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/) || [])[1];
				if (firstGuid && firstGuid === prevFirstGuid) {
					break;
				}
				prevFirstGuid = firstGuid;
			}
		}

		if (myScanId !== currentScanId) {
			// Superseded — don't touch the carousel timer: it's either already
			// cleared (cancel) or belongs to the newer scan.
			console.log("Scan invalidated during Goodreads fetch.");
			return;
		}

		console.log("Goodreads shelves (" + shelves.join(", ") + "): " + ToRead.length + " books total");
		console.log(ToRead);

		scanMeta.booksChecked = ToRead.length;
		scanMeta.truncatedByFreeLimit = truncatedByFreeLimit;
		scanMeta.shortPagesMidShelf = shortPagesMidShelf;
		scanMeta.shelfCount = shelves.length;

		if (ToRead.length === 0) {
			const emptyErr = new Error("No books found on selected shelves");
			emptyErr.emptyShelves = true;
			throw emptyErr;
		}

		// Query OverDrive for these titles
		queryOverdrive(ToRead, overdriveURLs, myScanId, goodreadsID, scanMeta);

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
		// A superseded scan must not release the lock, clear the timer, or
		// write error state — all of that now belongs to the newer scan.
		if (myScanId !== currentScanId) {
			console.log("Scan invalidated during Goodreads fetch (error path).");
			return;
		}
		console.log("Goodreads fetch Error ", err);
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
		clearInterval(carousel_message_timer);
		// empty_shelves is a setup problem (read fine, nothing on the shelf);
		// the other stages mean the shelves couldn't be read
		const stage = err.stage || (err.emptyShelves ? "empty_shelves" : "goodreads_error");
		recordScanError("Goodreads").then(function (failures) {
			Analytics.trackScanFailed(scanMeta, stage, {
				error_message: err.message,
				http_status: err.status,
				timed_out: !!err.timedOut,
				consecutive_failures: failures,
			});
		});
		// A feed format change would break every scan at once, so it also
		// goes to Error Tracking, which alerts on new or spiking issues
		if (stage === "goodreads_format") {
			Analytics.trackError("scan", err, { handled: true });
		}

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
 * @param {{id: string, startedAt: number}} scanMeta  Analytics scan metadata
 */
async function queryOverdrive(ToRead, overdriveURLs, myScanId, goodreadsID, scanMeta) {
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
	// Books skipped after a brief OverDrive failure, across all libraries
	let skippedBooks = 0;

	for (let libIdx = 0; libIdx < overdriveURLs.length && myScanId === currentScanId; libIdx++) {
		let overdriveURL = overdriveURLs[libIdx];
		let libraryError = false;
		let libraryMatchCount = 0;
		// Books in a row that failed even after a retry; at
		// OVERDRIVE_MAX_CONSECUTIVE_FAILURES the library counts as down
		let consecutiveFailures = 0;
		let librarySkippedBooks = 0;
		// Where the last search page actually came from, to tell a moved or
		// retired library apart from an OverDrive page format change
		let lastPage = null;
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
				const searchURL =
					overdriveURL +
					"/search/title?query=" +
					encodeURIComponent(ToRead[i].title) +
					"&creator=" +
					encodeURIComponent(ToRead[i].author);
				let res;
				try {
					res = await fetchWithTimeout(searchURL);
				} catch (firstErr) {
					// A quick server hiccup (502/503/504 or a dropped connection)
					// often clears on its own: wait briefly and try once more
					if (!isRetryableOverdriveError(firstErr) || myScanId !== currentScanId) throw firstErr;
					await new Promise(function (resolve) { setTimeout(resolve, OVERDRIVE_RETRY_DELAY_MS); });
					if (myScanId !== currentScanId) break;
					res = await fetchWithTimeout(searchURL);
				}
				consecutiveFailures = 0;
				const html = await res.text();
				// Cancelled while this request was in flight: stop before sending
				// progress, which would put the popup back on the loading view
				if (myScanId !== currentScanId) break;

				// Identify book availability data in response
				let overdriveJSONresults = extractOverdriveMediaItems(html);
				if (!overdriveJSONresults) {
					const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
					lastPage = {
						status: res.status,
						finalHost: hostOf(res.url),
						title: titleMatch ? titleMatch[1].trim().substring(0, 100) : "",
					};
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
				if (myScanId !== currentScanId) break;
				console.log("OverDrive fetch Error for " + overdriveURL + ": ", err);
				consecutiveFailures++;

				// A brief failure (server error, dropped connection, timeout):
				// skip this book and carry on, unless several in a row say the
				// library is down. Rate limits (429) and other 4xx responses
				// (e.g. a bad library address) give up on the library at once.
				const brief = isRetryableOverdriveError(err) || !!err.timedOut;
				if (brief && consecutiveFailures < OVERDRIVE_MAX_CONSECUTIVE_FAILURES) {
					librarySkippedBooks++;
					skippedBooks++;
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

				Analytics.trackLibraryScanFailed(scanMeta, {
					library_domain: hostOf(overdriveURL),
					error_type: err.timedOut ? "timeout" : err.status ? "http" : "network",
					error_message: String(err.message || "").substring(0, 200),
					http_status: err.status,
					books_checked: i,
					consecutive_failures: consecutiveFailures,
					books_skipped: librarySkippedBooks,
				});
				libraryError = true;
				failedLibraries.push(overdriveURL);
				// The whole library counts as failed, so its skips aren't
				// reported again as individually skipped books
				skippedBooks -= librarySkippedBooks;
				// Skip remaining books for this library
				completedRequests = (libIdx + 1) * ToRead.length;
			}
		}

		// No search page had OverDrive's book data: either the library's site
		// sent us somewhere else (a bad or retired library address), or it's
		// the right site and OverDrive changed its page format
		// (A cancelled scan stops early with no matches, so skip it.)
		// (Skip it too when every book was skipped: nothing was read.)
		if (!libraryError && libraryMatchCount === 0 && ToRead.length > librarySkippedBooks && myScanId === currentScanId) {
			console.log("No OverDrive data found for any book at " + overdriveURL + " — treating as failed library.");
			const libraryHost = hostOf(overdriveURL);
			const redirected = !!(lastPage && lastPage.finalHost && lastPage.finalHost !== libraryHost);
			const details = {
				library_domain: libraryHost,
				error_type: redirected ? "redirected" : "format",
				http_status: lastPage ? lastPage.status : undefined,
				final_host: lastPage ? lastPage.finalHost : undefined,
				page_title: lastPage ? lastPage.title : undefined,
				books_checked: ToRead.length,
			};
			Analytics.trackLibraryScanFailed(scanMeta, details);
			// Some libraries always fail this way; a jump across many
			// libraries means OverDrive changed its pages. Error Tracking
			// groups these into one issue and alerts when it spikes.
			if (!redirected) {
				const formatErr = new Error("OverDrive search page has no book data");
				formatErr.name = "OverDriveFormatError";
				Analytics.trackError("scan", formatErr, { handled: true, dedupeKey: libraryHost, properties: details });
			}
			failedLibraries.push(overdriveURL);
		}
	}

	// Scan was invalidated (cancelled or superseded) — exit without saving
	// partial results. Leave the carousel timer alone: it's either already
	// cleared (cancel) or belongs to the newer scan.
	if (myScanId !== currentScanId) {
		console.log("Scan invalidated during OverDrive fetch.");
		return;
	}

	// All libraries processed
	if (failedLibraries.length === overdriveURLs.length) {
		// ALL libraries failed — treat as error
		isScanningLocal = false;
		chrome.storage.session.set({ currently_scanning: false });
		clearInterval(carousel_message_timer);

		var failedDomains = failedLibraries.map(hostOf);
		recordScanError("OverDrive").then(function (failures) {
			Analytics.trackScanFailed(scanMeta, "overdrive", {
				books_checked: ToRead.length,
				library_count: overdriveURLs.length,
				failed_domains: failedDomains,
				consecutive_failures: failures,
			});
		});
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

				var notifData = {
					title: "Library Scan",
					message: body,
					newBooks: newBooks.length,
					totalBooks: allAvailable.length,
					scanSource: scanMeta.source,
				};
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
						Analytics.trackNotificationShown(newBooks.length, allAvailable.length, scanMeta.source, false);
					}
				});
				// Save for re-send if user is currently idle/locked
				chrome.idle.queryState(60, function (state) {
					if (state !== "active") {
						chrome.storage.local.set({ pendingNotification: notifData });
					}
				});
			}

			Analytics.trackScanCompleted(scanMeta, {
				outcome: failedLibraries.length > 0 ? "partial" : "success",
				books_checked: ToRead.length,
				shelf_count: scanMeta.shelfCount,
				available_count: available_count,
				hold_count: unavailable_count,
				new_available_count: prev.BookAvailability && prev.BookAvailability.length > 0 ? newBooks.length : 0,
				library_count: overdriveURLs.length,
				failed_library_count: failedLibraries.length,
				library_domains: overdriveURLs.map(hostOf),
				failed_domains: failedLibraries.map(hostOf),
				duration_ms: Date.now() - scanMeta.startedAt,
				truncated_by_free_limit: !!scanMeta.truncatedByFreeLimit,
				goodreads_short_pages: scanMeta.shortPagesMidShelf || 0,
				books_skipped: skippedBooks,
				is_first_scan: !prev.BookAvailability,
			});

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
		chrome.storage.session.set({ currently_scanning: false });
		chrome.storage.local.set({ errorTimeout: 0, consecutiveScanFailures: 0 });

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
 * Whether a failed OverDrive search is worth one retry: a server-side error
 * (502/503/504) or a dropped connection. Timeouts already waited a full
 * minute, and 429 (rate limited) or other 4xx responses won't clear by
 * retrying right away.
 *
 * @param {Error} err  Error thrown by fetchWithTimeout
 * @returns {boolean}
 */
function isRetryableOverdriveError(err) {
	if (!err || err.timedOut) return false;
	if (!err.status) return true; // network error
	return err.status === 502 || err.status === 503 || err.status === 504;
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
			const httpError = new Error(`${response.status}: ${response.statusText}`);
			httpError.status = response.status;
			throw httpError;
		}
		return response;
	} catch (error) {
		clearTimeout(timeout);
		// No per-request analytics here: a single broken scan produces hundreds
		// of failed fetches, drowning reports in noise. Failures are tracked in
		// aggregate by the scan-level events, which carry the status/timeout
		// attached here.
		if (error.name === "AbortError") {
			const timeoutError = new Error("Response timed out.");
			timeoutError.timedOut = true;
			throw timeoutError;
		}
		const wrapped = new Error(error.message);
		if (error.status) wrapped.status = error.status;
		throw wrapped;
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

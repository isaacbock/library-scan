// ExtensionPay
const extpay = ExtPay('library-scan');

// Current filter tab: "all", "eBook", or "Audiobook"
var activeFilter = "all";

// Single source of truth for Pro status within the popup. Updated by
// applyProStatus() so shelf gating and other UI never read a second, racing
// copy from storage.
var currentIsPro = false;

// A currently_scanning flag older than this is stale (service worker was
// likely killed mid-scan). Must match STALE_SCAN_MS in background.js.
var STALE_SCAN_MS = 10 * 60 * 1000;

// Catch-all error telemetry — a spike in extension_error is the "something
// unexpected broke" alarm (throttled inside Analytics).
window.addEventListener("error", function (e) {
	Analytics.trackError("popup", e.message || String(e.error || "unknown"));
});
window.addEventListener("unhandledrejection", function (e) {
	Analytics.trackError("popup", (e.reason && e.reason.message) || String(e.reason || "unknown"));
});

// Real dwell time, reported on close (keepalive lets the request outlive the
// popup) — the one event whose engagement_time_msec is genuine.
var popupOpenedAt = Date.now();
window.addEventListener("pagehide", function () {
	Analytics.trackPopupClosed(Date.now() - popupOpenedAt);
});

// Search state
var searchDebounceTimer = null;
var currentSearchController = null;
var lastSearchQuery = null;
var lastSearchLocal = null;
var lastSearchLive = null;

// Initialize button and toggle actions
document.addEventListener("DOMContentLoaded", function () {
	document
		.getElementById("refresh_button")
		.addEventListener("click", logReload);

	// Cancel scan
	document.getElementById("cancel_scan").addEventListener("click", function () {
		chrome.runtime.sendMessage({ msg: "cancelScan" });
		// Restore previous view from storage
		document.getElementById("home_loading").classList.add("d-none");
		document.getElementById("home_normal").classList.remove("d-none");
		document.getElementById("pills-tab").classList.remove("d-none");
		document.getElementById("header_refresh").classList.remove("d-none");
		document.getElementById("available_count").classList.remove("d-none");
		chrome.storage.local.get(["BookAvailability"], function (result) {
			if (typeof result.BookAvailability !== "undefined") {
				renderBooks(result.BookAvailability);
			}
		});
	});

	// Filter tab clicks
	document.querySelectorAll("#filter-tabs button").forEach(function (btn) {
		btn.addEventListener("click", function () {
			document.querySelectorAll("#filter-tabs button").forEach(function (b) {
				b.classList.remove("active");
			});
			btn.classList.add("active");
			activeFilter = btn.getAttribute("data-filter");
			Analytics.trackFilterChanged(activeFilter);

			// Persist toggle preferences to local storage
			var ebookOn = activeFilter === "all" || activeFilter === "eBook";
			var audiobookOn = activeFilter === "all" || activeFilter === "Audiobook";
			chrome.storage.local.set({
				ebook_toggle: ebookOn,
				audiobook_toggle: audiobookOn,
			});

			// Update badge count to reflect the new filter
			chrome.storage.local.get(["BookAvailability"], function (result) {
				if (typeof result.BookAvailability !== "undefined") {
					var count = result.BookAvailability.filter(function (b) {
						if (!b.available) return false;
						if (activeFilter === "all") return true;
						return b.type === activeFilter;
					}).length;
					chrome.runtime.sendMessage({ msg: "badgeCount", count: count });
					chrome.storage.local.set({ count: count });
				}
			});

			if (lastSearchQuery && lastSearchLocal !== null) {
				// Re-filter cached search results
				renderSearchResults(lastSearchQuery, lastSearchLocal, lastSearchLive);
			} else {
				chrome.storage.local.get(["BookAvailability"], function (result) {
					if (typeof result.BookAvailability !== "undefined") {
						renderBooks(result.BookAvailability);
					}
				});
			}
		});
	});

	// Search bar
	document.getElementById("search_input").addEventListener("input", onSearchInput);

	// Autosave user input and fetch shelves when Goodreads ID changes
	document.getElementById("goodreadsID").addEventListener("blur", function () {
		var parsed = parseGoodreadsID(this.value);
		if (parsed) {
			this.value = goodreadsDisplayURL(parsed);
			this.setAttribute("data-last-valid", this.value);
			chrome.storage.local.set({ goodreadsID: parsed });
			loadShelvesForUser(parsed);
		} else {
			// Restore previous valid value
			var lastValid = this.getAttribute("data-last-valid");
			if (lastValid) this.value = lastValid;
		}
	});

	// Auto-detect Goodreads profile (settings)
	document.getElementById("autodetect_goodreads").addEventListener("click", function () {
		autodetectGoodreads("autodetect_goodreads", "goodreads_hint", "goodreadsID");
	});

	// Refresh shelves button
	document.getElementById("refresh_shelves").addEventListener("click", function () {
		var id = parseGoodreadsID(document.getElementById("goodreadsID").value);
		if (id) loadShelvesForUser(id);
	});

	// Scan now button (settings)
	document.getElementById("scan_now_btn").addEventListener("click", saveUserData);

	// Add library button
	document.getElementById("add_library_btn").addEventListener("click", function () {
		addLibraryRow("");
	});
	document.getElementById("add_library_pro_badge").addEventListener("click", function () {
		var proTab = document.getElementById("settings-pro-tab");
		if (proTab) new bootstrap.Tab(proTab).show();
	});

	// Retry buttons
	document.getElementById("goodreads_retry").addEventListener("click", function () {
		document.getElementById("goodreads_fail").classList.add("d-none");
		reloadData();
	});
	document.getElementById("overdrive_retry").addEventListener("click", function () {
		document.getElementById("overdrive_fail").classList.add("d-none");
		reloadData();
	});

	// Wizard: auto-detect
	document.getElementById("wizard_autodetect").addEventListener("click", function () {
		autodetectGoodreads("wizard_autodetect", "wizard_goodreads_hint", "wizard_goodreadsID");
	});

	// Wizard: input validation
	document.getElementById("wizard_goodreadsID").addEventListener("input", validateWizard);
	document.getElementById("wizard_overdriveURL").addEventListener("input", validateWizard);

	// Wizard: auto-format on blur
	document.getElementById("wizard_goodreadsID").addEventListener("blur", function () {
		var parsed = parseGoodreadsID(this.value);
		if (parsed) {
			this.value = goodreadsDisplayURL(parsed);
		}
		validateWizard();
	});
	document.getElementById("wizard_overdriveURL").addEventListener("blur", function () {
		var parsed = parseOverdriveURL(this.value);
		if (parsed) {
			this.value = overdriveDisplayURL(parsed);
		}
		validateWizard();
	});

	// Wizard: Start Scanning
	document.getElementById("wizard-next").addEventListener("click", wizardComplete);

	// Hide scan footer when Pro settings tab is active
	var settingsScreens = {
		"settings-goodreads-tab": "settings_goodreads",
		"settings-overdrive-tab": "settings_overdrive",
		"settings-pro-tab": "settings_pro",
	};
	document.querySelectorAll("#settings-tabs button").forEach(function (tab) {
		tab.addEventListener("shown.bs.tab", function () {
			var footer = document.getElementById("scan_footer");
			footer.classList.toggle("d-none", tab.id === "settings-pro-tab");
			if (settingsScreens[tab.id]) {
				Analytics.trackScreenView(settingsScreens[tab.id]);
			}
			if (tab.id === "settings-pro-tab") {
				Analytics.trackProTabViewed();
			}
		});
	});

	// Track main tab views for flow analysis
	document.getElementById("pills-home-tab").addEventListener("shown.bs.tab", function () {
		Analytics.trackScreenView("library");
	});
	document.getElementById("pills-settings-tab").addEventListener("shown.bs.tab", function () {
		var active = document.querySelector("#settings-tabs .nav-link.active");
		Analytics.trackScreenView((active && settingsScreens[active.id]) || "settings_goodreads");
	});

	// Seed UI from cached Pro status immediately so the popup opens in the
	// right state; getUser() below refines it once the network responds.
	// popup_opened (the DAU backbone) fires here from cache — never gated on
	// a network call, so quick check-ins still get counted.
	chrome.storage.local.get(["isPro", "overdriveURLs", "selectedShelves", "BookAvailability"], function (result) {
		applyProStatus(!!result.isPro);
		var bookCount = (result.BookAvailability || []).length;
		var booksBucket = bookCount === 0 ? "0" : bookCount <= 50 ? "1-50" : bookCount <= 200 ? "51-200" : "200+";
		Analytics.trackPopupOpened(!!result.isPro, {
			library_count: (result.overdriveURLs || []).length,
			shelf_count: (result.selectedShelves || ["to-read"]).length,
			books_bucket: booksBucket,
		});
	});

	// ExtensionPay: check pro status, cache it, and toggle UI
	extpay.getUser().then(function (user) {
		var isPro = !!user.paid;
		chrome.storage.local.set({ isPro: isPro });
		applyProStatus(isPro);
	}).catch(function () {
		// Network error — fall back to cached status
		chrome.storage.local.get(["isPro"], function (result) {
			applyProStatus(!!result.isPro);
		});
	});

	// ExtensionPay: upgrade button
	document.getElementById("pro_upgrade_btn").addEventListener("click", function () {
		Analytics.trackProUpgradeClicked();
		extpay.openPaymentPage('library-scan');
	});

	// ExtensionPay: manage purchase button
	document.getElementById("pro_manage_btn").addEventListener("click", function () {
		extpay.openPaymentPage();
	});

	// ExtensionPay: restore purchase (login)
	document.getElementById("pro_restore_btn").addEventListener("click", function () {
		Analytics.trackProRestoreClicked();
		extpay.openLoginPage();
	});

	// ExtensionPay: listen for payment completion to update UI immediately
	extpay.onPaid.addListener(function () {
		chrome.storage.local.set({ isPro: true });
		applyProStatus(true);
		refreshShelfPickerFromStorage();
		// Whichever context observes the payment first reports it; the
		// storage guard inside trackPurchase prevents double-counting.
		Analytics.trackPurchase();
	});

	// React live to Pro status captured elsewhere — e.g. a payment that
	// completed while this popup was closed and was then confirmed by the
	// background poll (which writes isPro). Without this, users had to close
	// and reopen the popup before their new features appeared.
	// No currentIsPro guard here: Chrome only fires onChanged on real value
	// changes, and getUser()'s .then may have already updated currentIsPro —
	// a guard would then swallow the shelf-picker re-render, leaving saved
	// shelves visually unchecked (a duplicate render is harmless).
	chrome.storage.onChanged.addListener(function (changes, area) {
		if (area === "local" && changes.isPro) {
			applyProStatus(!!changes.isPro.newValue);
			refreshShelfPickerFromStorage();
		}
	});

	// Initialize user data and view
	loadUserData();
});

// Receive messages from background.js and update DOM accordingly
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
	if (request.msg === "In Progress") {
		loadingScreen(request);
	} else if (request.msg === "CarouselMsg") {
		const carouselEl = document.getElementById("loading_carousel_message");
		if (carouselEl.textContent.trim() !== request.text) {
			// Fade out, swap text, fade in using CSS transition
			carouselEl.style.transition = "opacity 1s";
			carouselEl.style.opacity = "0";
			setTimeout(function () {
				carouselEl.textContent = "";
				var em = document.createElement("em");
				em.textContent = request.text;
				carouselEl.appendChild(em);
				carouselEl.style.opacity = "1";
			}, 1000);
		}
	} else if (request.msg === "shelfScanProgress") {
		var loadingText = document.querySelector("#shelf_loading small");
		if (loadingText) {
			loadingText.textContent = "Scanning books (" + request.count + "+)";
		}
	} else if (request.msg === "shelfScanComplete") {
		document.getElementById("shelf_loading").classList.add("d-none");
		if (request.shelves && request.shelves.length > 0) {
			chrome.storage.local.get(["selectedShelves"], function (result) {
				renderShelfPicker(request.shelves, result.selectedShelves || ["to-read"], request.counts || {});
			});
		}
	} else if (request.msg === "Complete") {
		// Whether the user was watching the scan (loading view visible) —
		// decides below if we yank them over to the Library tab.
		var wasWatchingScan = !document.getElementById("home_loading").classList.contains("d-none");
		// Reset Loading view statistics to default
		document.getElementById("loading_text").textContent = "Downloading Goodreads Books...";
		document.getElementById("loading_carousel_message").innerHTML =
			"<em>We'll scan your selected Goodreads shelves to find titles already available at your local OverDrive library.</em>";
		const loadingBar = document.getElementById("loading_bar");
		loadingBar.setAttribute("aria-valuemax", "200");
		loadingBar.setAttribute("aria-valuenow", "0");
		loadingBar.style.width = "0%";
		document.getElementById("loading_count").textContent = "";
		// "Last refreshed: just now"
		document.getElementById("time_since_refresh").textContent = "Just now";
		// Remove any old failure messages
		document.getElementById("goodreads_fail").classList.add("d-none");
		document.getElementById("overdrive_fail").classList.add("d-none");
		document.getElementById("goodreadsID").closest(".input-group").classList.remove("has-error");
		// Switch to Library tab and display new book data — but only if the
		// user was watching the scan; a background auto-refresh completing
		// shouldn't yank them out of the Settings tab mid-edit.
		if (wasWatchingScan) {
			document.getElementById("pills-home").classList.add("show", "active");
			document.getElementById("pills-settings").classList.remove("show", "active");
			document.getElementById("pills-home-tab").classList.add("active");
			document.getElementById("pills-settings-tab").classList.remove("active");
		}
		updateMainPage(request.BookAvailability);
		if (request.failedLibraries && request.failedLibraries.length > 0) {
			showPartialOverdriveError(request.failedLibraries);
		}
	} else if (request.msg === "ElapsedTime") {
		document.getElementById("time_since_refresh").textContent = request.time;
	} else if (request.msg === "GoodreadsError") {
		goodreadsError();
	} else if (request.msg === "OverdriveError") {
		overdriveError(request.failedLibraries);
	}
	// No return value: this listener never calls sendResponse, and returning
	// true would hold every message channel open until the popup closes.
});

function logReload() {
	Analytics.trackManualRefresh();
	reloadData();
}


/**
 * Hide the skeleton loading placeholder
 */
function hideSkeleton() {
	var skel = document.getElementById("home_skeleton");
	if (skel) skel.classList.add("d-none");
}

/**
 * Parse a Goodreads user ID from any input format.
 * Accepts: "12345678", "12345678-name", "goodreads.com/user/show/12345678-name",
 *          "https://www.goodreads.com/user/show/12345678-name", etc.
 * Returns the numeric ID string, or null if no valid ID is found.
 *
 * @param {string} input  Raw user input
 * @returns {string|null} Numeric Goodreads user ID
 */
function parseGoodreadsID(input) {
	if (!input) return null;
	input = input.trim();
	// Try to extract from a URL like goodreads.com/user/show/12345678-name
	const urlMatch = input.match(/goodreads\.com\/user\/show\/(\d+)/);
	if (urlMatch) return urlMatch[1];
	// Try to extract a leading numeric ID (handles "12345678" or "12345678-name")
	const numMatch = input.match(/^(\d+)/);
	if (numMatch) return numMatch[1];
	return null;
}

/**
 * Build the canonical Goodreads profile URL from a numeric user ID.
 *
 * @param {string} id  Numeric Goodreads user ID
 * @returns {string}   Full profile URL
 */
function goodreadsProfileURL(id) {
	return "https://www.goodreads.com/user/show/" + id;
}

/**
 * Build a display-friendly Goodreads URL (no https://www.)
 */
function goodreadsDisplayURL(id) {
	return "goodreads.com/user/show/" + id;
}

/**
 * Parse an OverDrive URL from various input formats.
 * Accepts: "https://xxx.overdrive.com", "xxx.overdrive.com", "xxx", etc.
 * Returns the full canonical URL (https://xxx.overdrive.com), or null if invalid.
 *
 * @param {string} input  Raw user input
 * @returns {string|null} Full OverDrive URL
 */
function parseOverdriveURL(input) {
	if (!input) return null;
	input = input.trim().replace(/\/+$/, "");
	// Already a full URL — extract the host
	var match = input.match(/(?:https?:\/\/)?([\w-]+\.overdrive\.com)/i);
	if (match) return "https://" + match[1];
	// Bare library code (e.g. "mylib") — assume .overdrive.com
	var codeMatch = input.match(/^([\w-]+)$/);
	if (codeMatch) return "https://" + codeMatch[1] + ".overdrive.com";
	return null;
}

/**
 * Build a display-friendly OverDrive URL (no https://)
 */
function overdriveDisplayURL(fullURL) {
	return fullURL.replace(/^https?:\/\//, "");
}

/**
 * Auto-detect the logged-in Goodreads user via content script on Goodreads.
 * Parameterized to work with both settings and wizard inputs.
 *
 * @param {string} btnId   ID of the auto-detect button
 * @param {string} hintId  ID of the hint text element
 * @param {string} inputId ID of the Goodreads input field
 */
function autodetectGoodreads(btnId, hintId, inputId) {
	const btn = document.getElementById(btnId);
	const hint = document.getElementById(hintId);
	const input = document.getElementById(inputId);

	btn.disabled = true;
	btn.innerHTML = '<i class="fa fa-spinner fa-spin" aria-hidden="true"></i>';
	hint.textContent = "Looking for your Goodreads account...";

	// Check if the content script has already detected the user's profile
	chrome.storage.local.get(["detectedGoodreadsID"], function (result) {
		if (result.detectedGoodreadsID) {
			applyDetectedID(result.detectedGoodreadsID, btn, hint, input);
		} else {
			// Open Goodreads so the content script can run and detect the profile
			chrome.tabs.create(
				{ url: "https://www.goodreads.com", active: false },
				function (tab) {
					// Listen for the content script to save the detected ID
					function onStorageChanged(changes, area) {
						if (area === "local" && changes.detectedGoodreadsID && changes.detectedGoodreadsID.newValue) {
							chrome.storage.onChanged.removeListener(onStorageChanged);
							clearTimeout(timeout);
							chrome.tabs.remove(tab.id).catch(function () {});
							applyDetectedID(changes.detectedGoodreadsID.newValue, btn, hint, input);
						}
					}
					chrome.storage.onChanged.addListener(onStorageChanged);

					// Give up after 20 seconds
					var timeout = setTimeout(function () {
						chrome.storage.onChanged.removeListener(onStorageChanged);
						// One final check — the content script may have saved it just before timeout
						chrome.storage.local.get(["detectedGoodreadsID"], function (r) {
							chrome.tabs.remove(tab.id).catch(function () {});
							if (r.detectedGoodreadsID) {
								applyDetectedID(r.detectedGoodreadsID, btn, hint, input);
							} else {
								Analytics.trackAutodetectUsed(btnId === "wizard_autodetect" ? "wizard" : "settings", false);
								btn.disabled = false;
								btn.innerHTML = '<i class="fa fa-magic" aria-hidden="true"></i>';
								hint.textContent = "Please make sure you're signed in to Goodreads on this browser.";
								hint.style.color = "#dc3545";
								setTimeout(function () {
									hint.innerHTML = 'Paste your profile URL, or click <i class="fa fa-magic"></i> to auto-detect.';
									hint.style.color = "";
								}, 5000);
							}
						});
					}, 20000);
				}
			);
		}
	});
}

/**
 * Apply a detected Goodreads ID to the input field.
 */
function applyDetectedID(id, btn, hint, input) {
	Analytics.trackAutodetectUsed(btn.id === "wizard_autodetect" ? "wizard" : "settings", true);
	btn.disabled = false;
	btn.innerHTML = '<i class="fa fa-magic" aria-hidden="true"></i>';
	input.value = goodreadsDisplayURL(id);
	input.setAttribute("data-last-valid", input.value);
	chrome.storage.local.set({ goodreadsID: id });
	hint.innerHTML = 'Paste your profile URL, or click <i class="fa fa-magic"></i> to auto-detect.';
	hint.style.color = "";
	// Load shelves if this is the settings input
	if (input.id === "goodreadsID") {
		loadShelvesForUser(id);
	}
	// Re-validate wizard if applicable
	validateWizard();
}

/**
 * Retrieve user data from Chrome local storage & configure view based on login status
 */
function loadUserData() {
	// Check for real internet connectivity with a lightweight fetch,
	// then proceed to load data or show the offline empty state.
	checkConnectivity(function (online) {
		if (!online) {
			showOfflineState();
			return;
		}
		loadUserDataOnline();
	});
}

/**
 * Lightweight connectivity check. Fetches a tiny resource to confirm
 * the network is actually reachable (navigator.onLine is unreliable).
 *
 * @param {function(boolean)} callback  Called with true if online, false if offline
 */
function checkConnectivity(callback) {
	fetch("https://www.goodreads.com/favicon.ico", { method: "HEAD", cache: "no-store" })
		.then(function () { callback(true); })
		.catch(function () { callback(false); });
}

/**
 * Show a full-screen offline empty state — hides all other UI.
 */
function showOfflineState() {
	hideSkeleton();
	document.getElementById("home_normal").classList.add("d-none");
	document.getElementById("home_loading").classList.add("d-none");
	document.getElementById("pills-tab").classList.add("d-none");
	document.getElementById("header_refresh").classList.add("d-none");
	document.getElementById("available_count").classList.add("d-none");
	document.getElementById("wizard-screen").classList.add("d-none");
	document.getElementById("pills-tabContent").classList.remove("d-none");
	document.body.classList.add("full-height");
	const emptyDiv = document.createElement("div");
	emptyDiv.className = "d-flex flex-column justify-content-center align-items-center text-center h-100";
	emptyDiv.innerHTML =
		"<h1 class='mb-3'><i class='fa fa-lg fa-frown-o' aria-hidden='true'></i></h1>" +
		"<h2>Sorry...</h2>" +
		"<h3>No internet connection.</h3>";
	document.getElementById("pills-home").appendChild(emptyDiv);
}

/**
 * Main data loading logic — called only after connectivity is confirmed.
 */
function loadUserDataOnline() {
	chrome.storage.local.get(
		["goodreadsID", "overdriveURLs", "BookAvailability", "ebook_toggle", "audiobook_toggle", "error", "availableShelves", "selectedShelves", "shelfCounts"],
		function (result) {
			let goodreadsID = result.goodreadsID;
			let overdriveURLs = result.overdriveURLs;
			let BookAvailability = result.BookAvailability;
			let error = result.error;

			if (
				typeof goodreadsID !== "undefined" &&
				overdriveURLs && overdriveURLs.length > 0
			) {
				// Existing user — use full-height popup.
				// Note: we key off saved settings, NOT `error`. `error` isn't
				// written until the first scan finishes, so requiring it here
				// used to bounce users back into the setup wizard if they closed
				// and reopened the popup during (or after a failed) first scan.
				document.body.classList.add("full-height");

				// Hide wizard, show main UI
				document.getElementById("wizard-screen").classList.add("d-none");
				document.getElementById("pills-tabContent").classList.remove("d-none");

				// Display current user data in Settings
				var grField = document.getElementById("goodreadsID");
				grField.value = goodreadsDisplayURL(goodreadsID);
				grField.setAttribute("data-last-valid", grField.value);

				// Populate library rows
				document.getElementById("library-rows").innerHTML = "";
				for (var i = 0; i < overdriveURLs.length; i++) {
					addLibraryRow(overdriveURLs[i]);
				}

				// Restore shelf picker if shelves were previously fetched
				if (result.availableShelves && result.availableShelves.length > 0) {
					renderShelfPicker(result.availableShelves, result.selectedShelves || ["to-read"], result.shelfCounts || {});
				}

				// If a background shelf refresh is running (from scan pipeline), show loading indicator
				chrome.storage.session.get(["shelf_refresh_in_progress"], function (session) {
					if (session.shelf_refresh_in_progress) {
						document.getElementById("shelf_picker").classList.remove("d-none");
						document.getElementById("shelf_list").innerHTML = "";
						document.getElementById("shelf_loading").classList.remove("d-none");
					}
				});

				// If a scan is actively running (popup opened mid-scan), show the
				// loading view immediately instead of stale results — progress
				// messages take over from there. A stale flag (service worker
				// killed mid-scan) falls through to the normal views.
				chrome.storage.session.get(["currently_scanning", "scan_started_at"], function (session) {
					var scanActive = session.currently_scanning && session.scan_started_at &&
						(Date.now() - session.scan_started_at) < STALE_SCAN_MS;
					if (scanActive) {
						showTab("pills-home-tab");
						loadingScreen();
						return;
					}

					if (error === "Goodreads" || error === "OverDrive") {
						// Show error banner on the relevant settings sub-tab
						if (error === "Goodreads") {
							goodreadsError();
						} else {
							overdriveError();
						}

						// If we have cached books from a previous successful scan,
						// keep them browsable on the Library tab.
						if (typeof BookAvailability !== "undefined") {
							updateMainPage(BookAvailability);
							chrome.runtime.sendMessage({ msg: "elapsedTime" });
						}
					} else {
						// Default to Library view and show bottom nav bar
						showTab("pills-home-tab");
						document.getElementById("pills-tab").classList.remove("d-none");
						document.body.classList.add("full-height");

						// Hide all Library views until book data is loaded
						document.getElementById("home_normal").classList.add("d-none");
						document.getElementById("home_loading").classList.add("d-none");

						if (typeof BookAvailability !== "undefined") {
							updateMainPage(BookAvailability);
							chrome.runtime.sendMessage({ msg: "elapsedTime" });
						} else {
							reloadData(goodreadsID, overdriveURLs);
						}
					}
				});
			} else {
				// New user — show wizard
				Analytics.trackWizardStarted();
				Analytics.trackScreenView("wizard");
				hideSkeleton();
				document.body.classList.remove("full-height");
				document.getElementById("wizard-screen").classList.remove("d-none");
				document.getElementById("pills-tabContent").classList.add("d-none");
				document.getElementById("pills-tab").classList.add("d-none");
				document.getElementById("header_refresh").classList.add("d-none");
				document.getElementById("wizard-steps").classList.remove("d-none");

				// Pre-fill wizard if partial data exists
				if (typeof goodreadsID !== "undefined") {
					document.getElementById("wizard_goodreadsID").value = goodreadsDisplayURL(goodreadsID);
				}
				if (overdriveURLs && overdriveURLs.length > 0) {
					document.getElementById("wizard_overdriveURL").value = overdriveDisplayURL(overdriveURLs[0]);
				}
				validateWizard();
			}
		}
	);
}

/**
 * Validate wizard inputs and enable/disable the Start Scanning button
 */
function validateWizard() {
	var grInput = document.getElementById("wizard_goodreadsID");
	var odInput = document.getElementById("wizard_overdriveURL");
	var btn = document.getElementById("wizard-next");
	if (!grInput || !odInput || !btn) return;

	var grValid = parseGoodreadsID(grInput.value) !== null;
	var odValid = parseOverdriveURL(odInput.value) !== null;
	btn.disabled = !(grValid && odValid);
}

/**
 * Handle wizard completion — save data and start first scan
 */
function wizardComplete() {
	var goodreadsRaw = document.getElementById("wizard_goodreadsID").value;
	var overdriveRaw = document.getElementById("wizard_overdriveURL").value;

	var goodreadsID = parseGoodreadsID(goodreadsRaw);
	var overdriveURL = parseOverdriveURL(overdriveRaw);
	if (!goodreadsID || !overdriveURL) return;

	var overdriveURLs = [overdriveURL];

	chrome.storage.local.set({
		goodreadsID: goodreadsID,
		overdriveURLs: overdriveURLs,
		ebook_toggle: true,
		audiobook_toggle: true,
	});

	// Hide wizard, show main UI
	document.getElementById("wizard-screen").classList.add("d-none");
	document.getElementById("wizard-steps").classList.add("d-none");
	document.getElementById("pills-tabContent").classList.remove("d-none");

	// Populate settings with wizard data
	document.getElementById("goodreadsID").value = goodreadsDisplayURL(goodreadsID);
	document.getElementById("library-rows").innerHTML = "";
	addLibraryRow(overdriveURL);

	// Fetch shelves in background so they're ready in Goodreads settings
	loadShelvesForUser(goodreadsID);

	Analytics.trackWizardCompleted();

	// Start scanning
	document.body.classList.add("full-height");
	showTab("pills-home-tab");
	reloadData(goodreadsID, overdriveURLs);
}

/**
 * Add a library URL row to the OverDrive settings section
 *
 * @param {string} url  Full OverDrive URL (or empty for a blank row)
 */
function addLibraryRow(url) {
	var container = document.getElementById("library-rows");
	var row = document.createElement("div");
	row.className = "input-group mb-2";

	var input = document.createElement("input");
	input.type = "text";
	input.className = "form-control";
	input.placeholder = "xxxx.overdrive.com";
	if (url) {
		input.value = overdriveDisplayURL(url);
		input.setAttribute("data-last-valid", overdriveDisplayURL(url));
	}
	input.addEventListener("blur", function () {
		var parsed = parseOverdriveURL(this.value);
		if (parsed) {
			this.value = overdriveDisplayURL(parsed);
			this.setAttribute("data-last-valid", this.value);
		} else {
			// Restore previous valid value if the field had one
			var lastValid = this.getAttribute("data-last-valid");
			if (lastValid) this.value = lastValid;
		}
		syncLibraryURLs();
	});

	var deleteBtn = document.createElement("button");
	deleteBtn.type = "button";
	deleteBtn.className = "btn btn-outline-secondary library-delete-btn";
	deleteBtn.innerHTML = '<i class="fa fa-trash" aria-hidden="true"></i>';
	deleteBtn.addEventListener("click", function () {
		row.remove();
		syncLibraryURLs();
		updateLibraryDeleteButtons();
	});

	row.appendChild(input);
	row.appendChild(deleteBtn);
	container.appendChild(row);
	updateLibraryDeleteButtons();
}

/**
 * Save all library URLs from the UI to storage
 */
function syncLibraryURLs() {
	var urls = getLibraryURLs();
	chrome.storage.local.set({ overdriveURLs: urls });
	updateLibraryDeleteButtons();
}

/**
 * Show or hide library delete buttons based on how many valid libraries exist.
 * If only one valid library remains, hide its delete button.
 */
function updateLibraryDeleteButtons() {
	var rows = document.querySelectorAll("#library-rows .input-group");
	// Count rows with valid URLs
	var validRows = [];
	rows.forEach(function (row) {
		var input = row.querySelector("input");
		if (input && parseOverdriveURL(input.value)) {
			validRows.push(row);
		}
	});
	// Show/hide delete buttons
	rows.forEach(function (row) {
		var btn = row.querySelector(".library-delete-btn");
		if (!btn) return;
		var input = row.querySelector("input");
		var isValid = input && parseOverdriveURL(input.value);
		if (validRows.length <= 1 && isValid) {
			btn.style.display = "none";
		} else {
			btn.style.display = "";
		}
	});
}

/**
 * Get parsed OverDrive URLs from all library row inputs
 *
 * @returns {string[]} Array of full OverDrive URLs
 */
function getLibraryURLs() {
	var inputs = document.querySelectorAll("#library-rows input");
	var urls = [];
	inputs.forEach(function (input) {
		var parsed = parseOverdriveURL(input.value);
		if (parsed) urls.push(parsed);
	});
	return urls;
}

/**
 * Activate a Bootstrap 5 pill tab programmatically
 *
 * @param {string} tabId  ID of the tab trigger element (e.g. "pills-home-tab")
 */
function showTab(tabId) {
	const tabEl = document.getElementById(tabId);
	if (!tabEl) return;
	const tab = new bootstrap.Tab(tabEl);
	tab.show();
}

/**
 * Display loading screen
 */
function loadingScreen(request) {
	Analytics.trackScreenView("loading");
	hideSkeleton();
	document.body.classList.add("full-height");
	document.getElementById("home_normal").classList.add("d-none");
	document.getElementById("home_loading").classList.remove("d-none");
	document.getElementById("available_count").classList.add("d-none");
	document.getElementById("header_refresh").classList.add("d-none");
	document.getElementById("pills-tab").classList.remove("d-none");

	// Clear search state when loading starts
	resetSearch();

	// Update progress bar with current stats
	if (request) {
		if (request.libraryCount > 1 && request.libraryName) {
			// Extract library name from URL (e.g. "https://mylib.overdrive.com" -> "MYLIB")
			let libLabel = request.libraryName.replace(/^https?:\/\//, "").replace(/\.overdrive\.com\/?$/, "").toUpperCase();
			document.getElementById("loading_text").textContent =
				"Scanning " + libLabel + " (" + request.libraryIndex + "/" + request.libraryCount + ")...";
		} else {
			document.getElementById("loading_text").textContent = "Scanning OverDrive library...";
		}
		const loadingBar = document.getElementById("loading_bar");
		loadingBar.setAttribute("aria-valuemax", request.total);
		loadingBar.setAttribute("aria-valuenow", request.count);
		let progress = (request.count / request.total) * 100;
		loadingBar.style.width = progress + "%";
		// Show per-library book count (e.g. "5 of 100 books"), not cumulative across libraries
		let displayCount = typeof request.bookCount !== "undefined" ? request.bookCount : request.count;
		let displayTotal = typeof request.bookTotal !== "undefined" ? request.bookTotal : request.total;
		document.getElementById("loading_count").textContent =
			displayCount + " of " + displayTotal + " books";
	}
}

/**
 * Create a book card DOM element (safe from XSS — uses textContent for user data)
 *
 * @param {Object}  book            Book data object
 * @param {boolean} isAvailable     Whether book is available for checkout
 * @param {Set}     [newlyAvailable] URLs newly available since last scan
 * @param {string}  [clickSource]   Analytics context ("library" | "search")
 * @returns {HTMLElement}           Book card element
 */
function createBookCard(book, isAvailable, newlyAvailable, clickSource) {
	const card = document.createElement("div");
	card.className = "book-card";

	const top = document.createElement("div");
	top.className = "card-top";

	const img = document.createElement("img");
	img.className = "cover";
	img.alt = book.title;
	// Validate cover URL — only allow https URLs
	if (book.cover && book.cover.startsWith("https://")) {
		img.src = book.cover;
	}
	top.appendChild(img);

	const info = document.createElement("div");
	info.className = "card-info";

	const showRare = isAvailable && book.availableCopies === 1;
	const showNew = isAvailable && newlyAvailable && book.URL && newlyAvailable.has(book.URL);

	if (showRare || showNew) {
		const badgeRow = document.createElement("div");
		badgeRow.className = "badge-row";

		if (showRare) {
			const rareBadge = document.createElement("span");
			rareBadge.className = "rare-badge";
			rareBadge.textContent = "\u{1F48E} Rare";
			badgeRow.appendChild(rareBadge);
		}
		if (showNew) {
			const newBadge = document.createElement("span");
			newBadge.className = "new-badge";
			newBadge.textContent = "New!";
			badgeRow.appendChild(newBadge);
		}

		info.appendChild(badgeRow);
	}

	const titleEl = document.createElement("h6");
	titleEl.textContent = book.title;
	info.appendChild(titleEl);

	const authorEl = document.createElement("p");
	authorEl.className = "card-author";
	authorEl.textContent = book.author;
	info.appendChild(authorEl);

	const metaEl = document.createElement("p");
	metaEl.className = "card-meta";

	if (book.type === "Audiobook") {
		if (book.duration) {
			var parts = book.duration.split(":");
			var h = parseInt(parts[0], 10);
			var m = parseInt(parts[1], 10);
			metaEl.textContent = "\u{1F3A7} " + h + "h " + m + "m";
		} else {
			metaEl.textContent = "\u{1F3A7} Audiobook";
		}
	} else {
		metaEl.textContent = "\u{1F4D8} " + book.type;
	}
	info.appendChild(metaEl);

	if (!isAvailable) {
		const waitEl = document.createElement("p");
		waitEl.className = "card-meta";
		waitEl.textContent = "~" +
			(book.estimatedWait != undefined
				? book.estimatedWait >= 14
					? Math.round(book.estimatedWait / 7) + " wk wait"
					: book.estimatedWait + " day wait"
				: "Unknown wait");
		info.appendChild(waitEl);
	}

	top.appendChild(info);
	card.appendChild(top);

	const btn = document.createElement("a");
	btn.className = isAvailable
		? "card-btn btn btn-primary"
		: "card-btn btn btn-outline-secondary";
	btn.href = book.URL;
	btn.target = "_blank";
	btn.textContent = isAvailable ? "Available Now" : "Place Hold";
	btn.addEventListener('click', function () {
		Analytics.trackBookClicked(isAvailable ? 'checkout' : 'hold', clickSource || 'library', book.type);
	});
	card.appendChild(btn);

	return card;
}

/**
 * Show or hide the filter tabs based on toggle settings, and render books.
 *
 * @param {Object[]} BookAvailability All books identified on OverDrive
 */
function updateMainPage(BookAvailability) {
	// Show filter tabs (both types enabled by default)
	const filterTabs = document.getElementById("filter-tabs");
	filterTabs.classList.remove("d-none");

	// Restore active filter from stored toggle preferences
	chrome.storage.local.get(["ebook_toggle", "audiobook_toggle"], function (result) {
		var ebookOn = result.ebook_toggle !== false;
		var audiobookOn = result.audiobook_toggle !== false;

		if (ebookOn && !audiobookOn) {
			activeFilter = "eBook";
		} else if (!ebookOn && audiobookOn) {
			activeFilter = "Audiobook";
		} else {
			activeFilter = "all";
		}

		// Update the active tab button to match
		document.querySelectorAll("#filter-tabs button").forEach(function (b) {
			b.classList.toggle("active", b.getAttribute("data-filter") === activeFilter);
		});

		renderBooks(BookAvailability);
	});
}

/**
 * Render the book lists based on current active filter tab.
 *
 * @param {Object[]} BookAvailability All books identified on OverDrive
 */
function renderBooks(BookAvailability) {
	Analytics.trackScreenView("library");
	const availableNow = document.getElementById("available_now");
	const availableSoon = document.getElementById("available_soon");
	availableNow.innerHTML = "";
	availableSoon.innerHTML = "";
	availableNow.classList.remove("book-grid");
	availableSoon.classList.remove("book-grid");

	// Separate books by availability status, filtered by active tab
	let Available = [];
	let Holds = [];
	for (let i = 0; i < BookAvailability.length; i++) {
		var book = BookAvailability[i];
		// Filter by active tab
		if (activeFilter !== "all" && book.type !== activeFilter) continue;

		if (book.available === true) {
			Available.push(book);
		} else {
			Holds.push(book);
		}
	}

	// Load previously-available titles to determine "New!" badges
	chrome.storage.local.get(["PreviouslyAvailable"], function (result) {
		const prevSet = new Set(result.PreviouslyAvailable || []);
		// Books that are available now but were NOT available last scan
		const newlyAvailable = new Set();
		if (prevSet.size > 0) {
			for (const book of Available) {
				if (book.URL && !prevSet.has(book.URL)) {
					newlyAvailable.add(book.URL);
				}
			}
		}

		// Sort available books: New first, then Rare, then the rest
		Available.sort(function (a, b) {
			var aNew = a.URL && newlyAvailable.has(a.URL) ? 1 : 0;
			var bNew = b.URL && newlyAvailable.has(b.URL) ? 1 : 0;
			if (aNew !== bNew) return bNew - aNew;
			var aRare = a.availableCopies === 1 ? 1 : 0;
			var bRare = b.availableCopies === 1 ? 1 : 0;
			return bRare - aRare;
		});

		// If no books found
		if (Available.length === 0 && Holds.length === 0) {
			const emptyDiv = document.createElement("div");
			emptyDiv.className = "d-flex flex-column justify-content-center text-center";
			emptyDiv.innerHTML =
				"<h1 class='mt-5 mb-3'><i class='fa fa-lg fa-frown-o' aria-hidden='true'></i></h1><h2>Sorry...</h2><h3>No titles were found.</h3>";
			availableNow.appendChild(emptyDiv);
		} else {
			// Add available books in a grid
			availableNow.classList.add("book-grid");
			for (let i = 0; i < Available.length; i++) {
				availableNow.appendChild(createBookCard(Available[i], true, newlyAvailable, "library"));
			}

			// If books are available, prompt user to leave a review
			if (Available.length > 0) {
				const reviewDiv = document.createElement("div");
				reviewDiv.className = "d-flex align-items-center justify-content-center grid-full-width pb-3";
				reviewDiv.style.paddingTop = "10px";
				const reviewText = document.createElement("h5");
				reviewText.className = "p-2 m-0";
				reviewText.textContent = "Find a good book?";
				reviewDiv.appendChild(reviewText);
				const reviewBtn = document.createElement("a");
				reviewBtn.className = "btn btn-success";
				reviewBtn.href = "https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik/review";
				reviewBtn.target = "_blank";
				reviewBtn.textContent = "Leave a review!";
				reviewDiv.appendChild(reviewBtn);
				availableNow.appendChild(reviewDiv);
			}

			// Sort Hold books by increasing expected waits
			Holds.sort((a, b) =>
				a.estimatedWait == undefined
					? 1
					: a.estimatedWait > b.estimatedWait
					? 1
					: -1
			);

			// Add hold books in a grid
			availableSoon.classList.add("book-grid");
			for (let i = 0; i < Holds.length; i++) {
				availableSoon.appendChild(createBookCard(Holds[i], false, null, "library"));
			}
		}
	});

	// Switch to Library view with bottom nav bar
	hideSkeleton();
	document.getElementById("home_normal").classList.remove("d-none");
	document.getElementById("home_loading").classList.add("d-none");
	document.getElementById("pills-tab").classList.remove("d-none");
	document.body.classList.add("full-height");

	// Show header refresh controls
	document.getElementById("header_refresh").classList.remove("d-none");

	// Update badge count
	const countBadge = document.getElementById("available_count");
	countBadge.classList.remove("d-none");
	countBadge.textContent = Available.length.toString();
	chrome.storage.local.set({ count: Available.length });
	chrome.runtime.sendMessage({
		msg: "badgeCount",
		count: Available.length,
	});
}

/**
 * Send message to background.js to update & reload all books
 *
 * @param {number} goodreadsID      User ID number of user's Goodreads account
 * @param {string[]} overdriveURLs  URLs of user's OverDrive libraries
 * @param {string[]} [shelves]      Shelves to scan
 */
function reloadData(goodreadsID, overdriveURLs, shelves) {
	if (goodreadsID === undefined || overdriveURLs === undefined) {
		chrome.storage.local.get(
			["goodreadsID", "overdriveURLs", "selectedShelves"],
			function (result) {
				chrome.runtime.sendMessage({
					msg: "goodreads",
					goodreadsID: result.goodreadsID,
					overdriveURLs: result.overdriveURLs,
					shelves: result.selectedShelves,
				});
			}
		);
	} else {
		chrome.runtime.sendMessage({
			msg: "goodreads",
			goodreadsID: goodreadsID,
			overdriveURLs: overdriveURLs,
			shelves: shelves,
		});
	}

	// Clear current book DOM elements (storage is overwritten atomically when the scan completes)
	document.getElementById("available_now").innerHTML = "";
	document.getElementById("available_soon").innerHTML = "";

	// Ensure Library tab pane is immediately visible (skip Bootstrap fade)
	var homePane = document.getElementById("pills-home");
	homePane.classList.add("show", "active");
	var settingsPane = document.getElementById("pills-settings");
	settingsPane.classList.remove("show", "active");

	// Switch to Loading view (keep bottom nav visible)
	document.getElementById("pills-tab").classList.remove("d-none");
	document.getElementById("header_refresh").classList.add("d-none");
	document.getElementById("home_normal").classList.add("d-none");
	document.getElementById("home_loading").classList.remove("d-none");
	document.getElementById("available_count").classList.add("d-none");
}

/**
 * Save settings and start a new scan
 */
function saveUserData() {
	let goodreadsRaw = document.getElementById("goodreadsID").value;

	// Parse Goodreads ID from URL or plain number
	let goodreadsID = parseGoodreadsID(goodreadsRaw);
	if (!goodreadsID) {
		document.getElementById("goodreadsID").closest(".input-group").classList.add("has-error");
		return;
	}
	document.getElementById("goodreadsID").value = goodreadsDisplayURL(goodreadsID);

	// Parse OverDrive URLs from library rows
	let overdriveURLs = getLibraryURLs();
	if (overdriveURLs.length === 0) {
		return;
	}

	// Only persist the shelf selection for Pro users. For free users the
	// non-to-read toggles render disabled+unchecked, so saving the DOM state
	// here would wipe a downgraded user's saved multi-shelf selection (the
	// background scan already enforces the free-tier limit).
	var selectedShelves = currentIsPro ? getSelectedShelves() : undefined;

	var settings = {
		goodreadsID: goodreadsID,
		overdriveURLs: overdriveURLs,
	};
	if (selectedShelves) {
		settings.selectedShelves = selectedShelves;
	}
	chrome.storage.local.set(settings);

	// Remove old failure messages
	document.getElementById("goodreads_fail").classList.add("d-none");
	document.getElementById("overdrive_fail").classList.add("d-none");
	document.getElementById("goodreadsID").closest(".input-group").classList.remove("has-error");

	Analytics.trackSettingsUpdated(overdriveURLs.length, selectedShelves ? selectedShelves.length : 1);
	reloadData(goodreadsID, overdriveURLs, selectedShelves);
}

/**
 * Display error message on settings page upon Goodreads error.
 * Preserves cached book data so the user can still browse previous results.
 */
function goodreadsError() {
	Analytics.trackScreenView("settings_goodreads");
	document.getElementById("goodreads_fail").classList.remove("d-none");
	document.getElementById("overdrive_fail").classList.add("d-none");
	document.getElementById("goodreadsID").closest(".input-group").classList.add("has-error");

	// Dismiss loading screen and restore Library tab content
	document.getElementById("home_loading").classList.add("d-none");
	hideSkeleton();
	restoreLibraryView();

	// Keep bottom nav visible so the user can return to Library
	document.getElementById("pills-tab").classList.remove("d-none");
	document.getElementById("header_refresh").classList.remove("d-none");

	// Force Settings pane active (bypass Bootstrap fade which can fail
	// when reloadData() manually set pills-home as show/active)
	document.getElementById("pills-home").classList.remove("show", "active");
	document.getElementById("pills-settings").classList.add("show", "active");
	document.getElementById("pills-home-tab").classList.remove("active");
	document.getElementById("pills-settings-tab").classList.add("active");

	// Force Goodreads sub-tab active
	document.getElementById("settings-overdrive").classList.remove("show", "active");
	document.getElementById("settings-overdrive-tab").classList.remove("active");
	document.getElementById("settings-goodreads").classList.add("show", "active");
	document.getElementById("settings-goodreads-tab").classList.add("active");

	// Show scan footer (hidden when Pro tab is active)
	document.getElementById("scan_footer").classList.remove("d-none");
}

/**
 * Restore the Library tab so it isn't empty when the user navigates back.
 * Renders cached books if available, otherwise shows the empty state.
 */
function restoreLibraryView() {
	document.getElementById("home_normal").classList.remove("d-none");
	chrome.storage.local.get(["BookAvailability"], function (result) {
		if (typeof result.BookAvailability !== "undefined") {
			renderBooks(result.BookAvailability);
		}
	});
}

/**
 * Reset search state and restore normal view
 */
function resetSearch() {
	document.getElementById("search_input").value = "";
	document.getElementById("search_spinner").classList.add("d-none");
	document.getElementById("search-filter-row").classList.remove("search-active");
	lastSearchQuery = null;
	lastSearchLocal = null;
	lastSearchLive = null;
	clearTimeout(searchDebounceTimer);
	if (currentSearchController) {
		currentSearchController.abort();
		currentSearchController = null;
	}
}

/**
 * Handle search input with debounce.
 * Adds/removes search-active class to hide/show the filter toggle.
 */
function onSearchInput() {
	var query = document.getElementById("search_input").value.trim();
	var row = document.getElementById("search-filter-row");

	// Cancel any pending debounce or in-flight search
	clearTimeout(searchDebounceTimer);
	if (currentSearchController) {
		currentSearchController.abort();
		currentSearchController = null;
	}

	if (query.length === 0) {
		// Restore normal view — show filter toggle again
		row.classList.remove("search-active");
		lastSearchQuery = null;
		lastSearchLocal = null;
		lastSearchLive = null;
		document.getElementById("search_spinner").classList.add("d-none");
		chrome.storage.local.get(["BookAvailability"], function (result) {
			if (typeof result.BookAvailability !== "undefined") {
				renderBooks(result.BookAvailability);
			}
		});
		return;
	}

	// Hide filter toggle while searching, show spinner
	row.classList.add("search-active");
	document.getElementById("search_spinner").classList.remove("d-none");

	// Immediately filter local results (smooth diff, no full re-render)
	chrome.storage.local.get(["BookAvailability"], function (result) {
		var allBooks = result.BookAvailability || [];
		renderSearchResults(query, allBooks, null);
	});

	// Debounce the OverDrive live search (500ms to avoid rate limiting).
	// Search analytics fire once per settled query in searchOverdrive, not
	// per keystroke here.
	searchDebounceTimer = setTimeout(function () {
		searchOverdrive(query);
	}, 500);
}

/**
 * Extract the `window.OverDrive.mediaItems = {...};` JSON object from an
 * OverDrive HTML page by balancing braces (string-aware), rather than a greedy
 * single-line regex that can over- or under-match if the page format shifts.
 *
 * @param {string} html  Raw OverDrive page HTML
 * @returns {Object|null} Parsed mediaItems object, or null if not found/parseable
 */
function extractOverdriveMediaItems(html) {
	var marker = html.match(/window\.OverDrive\.mediaItems\s*=\s*/);
	if (!marker) return null;
	var start = marker.index + marker[0].length;
	if (html[start] !== "{") return null;

	var depth = 0, inStr = false, esc = false;
	for (var i = start; i < html.length; i++) {
		var ch = html[i];
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
 * Search OverDrive library for a query and merge results with local matches
 *
 * @param {string} query  The search query
 */
function searchOverdrive(query) {
	chrome.storage.local.get(["overdriveURLs", "BookAvailability"], function (result) {
		var overdriveURLs = result.overdriveURLs;
		var allBooks = result.BookAvailability || [];
		if (!overdriveURLs || overdriveURLs.length === 0) return;

		// Search the first library for live results
		var overdriveURL = overdriveURLs[0];

		currentSearchController = new AbortController();
		var signal = currentSearchController.signal;

		fetch(
			overdriveURL + "/search?query=" + encodeURIComponent(query),
			{ signal: signal }
		)
			.then(function (res) {
				if (signal.aborted) return "";
				return res.text();
			})
			.then(function (html) {
				if (!html || signal.aborted) return;

				var liveBooks = [];
				try {
					var jsonResults = extractOverdriveMediaItems(html);
					if (jsonResults) {
						for (var key in jsonResults) {
							try {
								var book = jsonResults[key];
								liveBooks.push({
									title: book.title,
									author: book.firstCreatorName,
									type: (book.type && book.type.name) || "Unknown",
									cover: (book.covers && book.covers.cover150Wide && book.covers.cover150Wide.href) || "",
									available: book.isAvailable,
									estimatedWait: book.estimatedWaitDays,
									availableCopies: book.availableCopies,
									duration: book.formats && book.formats.find(function (f) { return f.duration; }) ? book.formats.find(function (f) { return f.duration; }).duration : undefined,
									URL: overdriveURL + "/media/" + book.id,
								});
							} catch (e) {
								// Skip books with missing metadata
							}
						}
					}
				} catch (e) {
					// Search page format may differ; ignore
				}

				currentSearchController = null;
				document.getElementById("search_spinner").classList.add("d-none");

				// Track search shape & outcome only — never the query text
				var lowerQuery = query.toLowerCase();
				var localCount = allBooks.filter(function (b) {
					if (activeFilter !== "all" && b.type !== activeFilter) return false;
					return b.title.toLowerCase().indexOf(lowerQuery) !== -1 ||
						b.author.toLowerCase().indexOf(lowerQuery) !== -1;
				}).length;
				Analytics.trackSearchPerformed(query.length, localCount, liveBooks.length);

				renderSearchResults(query, allBooks, liveBooks);
			})
			.catch(function (err) {
				if (err.name !== "AbortError") {
					currentSearchController = null;
					document.getElementById("search_spinner").classList.add("d-none");
					renderSearchResults(query, allBooks, []);
				}
			});
	});
}

/**
 * Sort books: available first, then by ascending wait time (undefined last).
 *
 * @param {Object[]} books  Array of book objects to sort in place
 * @returns {Object[]}      The same array, sorted
 */
function sortBooks(books) {
	books.sort(function (a, b) {
		if (a.available && !b.available) return -1;
		if (!a.available && b.available) return 1;
		if (!a.available && !b.available) {
			if (a.estimatedWait == undefined) return 1;
			if (b.estimatedWait == undefined) return -1;
			return a.estimatedWait - b.estimatedWait;
		}
		// Both available — rare (1 copy) first
		var aRare = a.availableCopies === 1 ? 1 : 0;
		var bRare = b.availableCopies === 1 ? 1 : 0;
		return bRare - aRare;
	});
	return books;
}

/**
 * DOM-diff a list of books into a container element.
 * Reuses existing card nodes (matched by data-url) to avoid layout shift.
 *
 * @param {HTMLElement} container  The DOM element to render cards into
 * @param {Object[]}   books      Sorted array of book objects
 */
function diffCards(container, books) {
	// Index existing cards by URL
	var existingCards = {};
	for (var c = container.children.length - 1; c >= 0; c--) {
		var child = container.children[c];
		var url = child.getAttribute("data-url");
		if (url) {
			existingCards[url] = child;
		} else {
			container.removeChild(child);
		}
	}

	// Remove cards no longer needed
	var desiredSet = {};
	for (var i = 0; i < books.length; i++) {
		desiredSet[books[i].URL] = true;
	}
	for (var key in existingCards) {
		if (!desiredSet[key]) {
			container.removeChild(existingCards[key]);
			delete existingCards[key];
		}
	}

	// Append in order (appendChild moves existing nodes)
	for (var n = 0; n < books.length; n++) {
		var book = books[n];
		var card = existingCards[book.URL];
		if (!card) {
			card = createBookCard(book, book.available, null, "search");
			card.setAttribute("data-url", book.URL);
		}
		container.appendChild(card);
	}
}

/**
 * Render search results in two sections: "Goodreads Shelf" for local matches
 * and "All OverDrive" for live search results (deduplicated).
 * Uses DOM diffing within each section to avoid layout shift.
 *
 * @param {string}        query       Search query
 * @param {Object[]}      allBooks    All locally stored books
 * @param {Object[]|null} liveBooks   Live OverDrive results (null = not yet loaded)
 */
function renderSearchResults(query, allBooks, liveBooks) {
	// Cache search state so filter changes can re-render without re-fetching
	lastSearchQuery = query;
	lastSearchLocal = allBooks;
	if (liveBooks !== null) lastSearchLive = liveBooks;

	var shelfContainer = document.getElementById("available_now");
	var overdriveContainer = document.getElementById("available_soon");
	shelfContainer.classList.add("book-grid");
	overdriveContainer.classList.add("book-grid");

	var lowerQuery = query.toLowerCase();

	// --- Goodreads Shelf section: filter local results by query ---
	var localMatches = [];
	for (var i = 0; i < allBooks.length; i++) {
		var book = allBooks[i];
		if (activeFilter !== "all" && book.type !== activeFilter) continue;
		if (
			book.title.toLowerCase().indexOf(lowerQuery) !== -1 ||
			book.author.toLowerCase().indexOf(lowerQuery) !== -1
		) {
			localMatches.push(book);
		}
	}
	sortBooks(localMatches);

	// Ensure the section header exists
	var shelfHeader = document.getElementById("search_shelf_header");
	if (!shelfHeader) {
		shelfHeader = document.createElement("p");
		shelfHeader.id = "search_shelf_header";
		shelfHeader.className = "search-section-header";
		shelfHeader.textContent = "Goodreads Shelf";
	}
	// Keep header as first child
	if (shelfContainer.firstChild !== shelfHeader) {
		shelfContainer.insertBefore(shelfHeader, shelfContainer.firstChild);
	}

	diffCards(shelfContainer, localMatches);

	// Re-insert header at top (diffCards may have reordered)
	if (shelfContainer.firstChild !== shelfHeader) {
		shelfContainer.insertBefore(shelfHeader, shelfContainer.firstChild);
	}

	// Shelf empty state
	var shelfEmpty = document.getElementById("search_shelf_empty");
	if (localMatches.length === 0) {
		if (!shelfEmpty) {
			shelfEmpty = document.createElement("p");
			shelfEmpty.id = "search_shelf_empty";
			shelfEmpty.className = "text-muted text-center mb-2";
			shelfEmpty.textContent = "No matches on your shelf.";
		}
		shelfContainer.appendChild(shelfEmpty);
	} else if (shelfEmpty && shelfEmpty.parentNode) {
		shelfEmpty.parentNode.removeChild(shelfEmpty);
	}

	// --- All OverDrive section: deduplicated live results ---
	// Build set of local URLs for dedup
	var localURLs = {};
	for (var j = 0; j < allBooks.length; j++) {
		if (allBooks[j].URL) {
			localURLs[allBooks[j].URL] = true;
		}
	}

	var dedupedLive = [];
	if (liveBooks) {
		for (var k = 0; k < liveBooks.length; k++) {
			var lb = liveBooks[k];
			if (activeFilter !== "all" && lb.type !== activeFilter) continue;
			if (lb.URL && localURLs[lb.URL]) continue;
			dedupedLive.push(lb);
		}
	}
	sortBooks(dedupedLive);

	// Ensure the OverDrive section header exists
	var odHeader = document.getElementById("search_overdrive_header");
	if (!odHeader) {
		odHeader = document.createElement("p");
		odHeader.id = "search_overdrive_header";
		odHeader.className = "search-section-header";
		odHeader.textContent = "All OverDrive";
	}
	if (overdriveContainer.firstChild !== odHeader) {
		overdriveContainer.insertBefore(odHeader, overdriveContainer.firstChild);
	}

	diffCards(overdriveContainer, dedupedLive);

	// Re-insert header at top
	if (overdriveContainer.firstChild !== odHeader) {
		overdriveContainer.insertBefore(odHeader, overdriveContainer.firstChild);
	}

	// Show bottom spinner while OverDrive results are still loading
	var existingSpinner = overdriveContainer.querySelector(".search-bottom-spinner");
	if (liveBooks === null) {
		if (!existingSpinner) {
			var bottomSpinner = document.createElement("div");
			bottomSpinner.className = "d-flex justify-content-center py-3 search-bottom-spinner";
			bottomSpinner.innerHTML = '<span class="search-spinner"></span>';
			overdriveContainer.appendChild(bottomSpinner);
		}
	} else if (existingSpinner) {
		overdriveContainer.removeChild(existingSpinner);
	}

	// OverDrive empty state (only shown after results have loaded)
	var odEmpty = document.getElementById("search_overdrive_empty");
	if (liveBooks !== null && dedupedLive.length === 0) {
		if (!odEmpty) {
			odEmpty = document.createElement("p");
			odEmpty.id = "search_overdrive_empty";
			odEmpty.className = "text-muted text-center mb-2";
			odEmpty.textContent = "No additional results.";
		}
		overdriveContainer.appendChild(odEmpty);
	} else if (odEmpty && odEmpty.parentNode) {
		odEmpty.parentNode.removeChild(odEmpty);
	}

	// Keep normal view visible
	document.getElementById("home_normal").classList.remove("d-none");
	document.getElementById("home_loading").classList.add("d-none");
}

/**
 * Fetch shelves for a Goodreads user and render the shelf picker.
 *
 * @param {string} goodreadsID  Numeric Goodreads user ID
 */
function loadShelvesForUser(goodreadsID) {
	var picker = document.getElementById("shelf_picker");
	var loading = document.getElementById("shelf_loading");
	var errorEl = document.getElementById("shelf_error");
	var listEl = document.getElementById("shelf_list");

	picker.classList.remove("d-none");
	loading.classList.remove("d-none");
	loading.querySelector("small").textContent = "Scanning books (0+)";
	errorEl.classList.add("d-none");
	listEl.innerHTML = "";

	var emptyEl = document.getElementById("shelf_empty");

	chrome.runtime.sendMessage(
		{ msg: "fetchShelves", goodreadsID: goodreadsID },
		function (response) {
			loading.classList.add("d-none");
			if (response && response.shelves) {
				if (response.shelves.length > 0) {
					// Goodreads is reachable — clear any previous error (UI and storage)
					document.getElementById("goodreads_fail").classList.add("d-none");
					document.getElementById("goodreadsID").closest(".input-group").classList.remove("has-error");
					chrome.storage.local.get(["error"], function (r) {
						if (r.error === "Goodreads") {
							chrome.storage.local.set({ error: "None" });
						}
					});

					// Save available shelves and counts
					chrome.storage.local.set({ availableShelves: response.shelves, shelfCounts: response.counts || {} });
					// Load previously selected shelves (default to just "to-read")
					chrome.storage.local.get(["selectedShelves"], function (result) {
						var selected = result.selectedShelves || ["to-read"];
						renderShelfPicker(response.shelves, selected, response.counts || {});
					});
					emptyEl.classList.add("d-none");
				} else {
					// Shelves fetched successfully but none found
					emptyEl.classList.remove("d-none");
				}
			} else {
				errorEl.textContent = "Could not load shelves.";
				errorEl.classList.remove("d-none");
				// Also trigger the main Goodreads error banner
				document.getElementById("goodreads_fail").classList.remove("d-none");
				document.getElementById("goodreadsID").closest(".input-group").classList.add("has-error");
			}
		}
	);
}

/**
 * Re-render the shelf picker from already-fetched data in storage, applying
 * the current Pro gating. Used when Pro status changes while the popup is open
 * so shelves unlock/lock live without needing a re-fetch or a popup reopen.
 */
function refreshShelfPickerFromStorage() {
	chrome.storage.local.get(["availableShelves", "selectedShelves", "shelfCounts"], function (result) {
		if (result.availableShelves && result.availableShelves.length > 0) {
			renderShelfPicker(result.availableShelves, result.selectedShelves || ["to-read"], result.shelfCounts || {});
		}
	});
}

/**
 * Render shelf pills in the shelf picker.
 *
 * @param {string[]} shelves   All available shelf names
 * @param {string[]} selected  Currently selected shelf names
 * @param {Object}   [counts]  Map of shelf name to book count
 */
function renderShelfPicker(shelves, selected, counts) {
	counts = counts || {};
	var picker = document.getElementById("shelf_picker");
	var listEl = document.getElementById("shelf_list");
	picker.classList.remove("d-none");
	listEl.innerHTML = "";

	var selectedSet = new Set(selected);

	// Sort so to-read is always first
	shelves = shelves.slice().sort(function (a, b) {
		if (a === "to-read") return -1;
		if (b === "to-read") return 1;
		return a.localeCompare(b);
	});

	for (var i = 0; i < shelves.length; i++) {
		var row = document.createElement("div");
		row.className = "shelf-toggle-item";

		var label = document.createElement("label");
		label.className = "switch";

		var checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = selectedSet.has(shelves[i]);
		checkbox.setAttribute("data-shelf", shelves[i]);
		checkbox.addEventListener("change", onShelfToggleChange);

		var slider = document.createElement("span");
		slider.className = "slider round";

		label.appendChild(checkbox);
		label.appendChild(slider);

		var nameSpan = document.createElement("span");
		var bookCount = counts[shelves[i]];
		nameSpan.textContent = shelves[i] + (bookCount ? " (" + bookCount + " books)" : "");
		nameSpan.style.cursor = "pointer";
		nameSpan.addEventListener("click", (function (cb) {
			return function () {
				if (!cb.disabled) {
					cb.checked = !cb.checked;
					cb.dispatchEvent(new Event("change"));
				}
			};
		})(checkbox));

		row.appendChild(label);
		row.appendChild(nameSpan);
		listEl.appendChild(row);
	}

	// Mark sole-checked state for CSS styling
	listEl.classList.toggle("sole-checked", listEl.querySelectorAll('input:checked').length === 1);

	// Apply Pro gating to newly rendered shelves using the popup's single
	// source of truth (avoids racing a second storage read against getUser()).
	applyShelfProGating(currentIsPro);
}

/**
 * Handle toggling a shelf checkbox.
 * Ensures at least one shelf remains selected.
 */
function onShelfToggleChange() {
	var checkbox = this;

	// Prevent unchecking the last active shelf
	if (!checkbox.checked) {
		var checkedCount = document.querySelectorAll('#shelf_list input[type="checkbox"]:checked').length;
		if (checkedCount < 1) {
			checkbox.checked = true;
			return;
		}
	}

	// Save updated selection
	var selected = getSelectedShelves();
	chrome.storage.local.set({ selectedShelves: selected });

	// Update sole-checked styling
	var listEl = document.getElementById("shelf_list");
	listEl.classList.toggle("sole-checked", listEl.querySelectorAll('input:checked').length === 1);
}

/**
 * Apply pro gating to shelf toggles.
 * Free users: only "to-read" is enabled; others show a lock and link to Pro tab.
 *
 * @param {boolean} isPro  Whether the user has paid for Pro
 */
function applyShelfProGating(isPro) {
	var items = document.querySelectorAll("#shelf_list .shelf-toggle-item");
	items.forEach(function (item) {
		var cb = item.querySelector('input[type="checkbox"]');
		if (!cb) return;
		var shelf = cb.getAttribute("data-shelf");

		// Remove any existing pro badge
		var existing = item.querySelector(".shelf-pro-badge");
		if (existing) existing.remove();

		var nameSpan = item.querySelectorAll("span:not(.slider):not(.shelf-pro-badge)");
		if (!isPro && shelf !== "to-read") {
			cb.disabled = true;
			cb.checked = false;
			nameSpan.forEach(function (s) { s.style.cursor = "not-allowed"; });
			// Add pro badge
			var badge = document.createElement("span");
			badge.className = "shelf-pro-badge";
			badge.innerHTML = '<i class="fa fa-lock"></i> Pro';
			badge.title = "Upgrade to Pro to scan additional shelves";
			badge.addEventListener("click", function () {
				var proTab = document.getElementById("settings-pro-tab");
				if (proTab) new bootstrap.Tab(proTab).show();
			});
			item.appendChild(badge);
		} else if (isPro) {
			// Re-enable if previously disabled
			cb.disabled = false;
			nameSpan.forEach(function (s) { s.style.cursor = "pointer"; });
		}
	});
	// NOTE: We intentionally do NOT overwrite the saved `selectedShelves` here.
	// A transient getUser() failure or a render that runs before Pro status
	// resolves used to wipe a paying user's multi-shelf selection down to
	// ["to-read"]. The free-tier limit is now enforced server-side in the
	// background scan, and the disabled/unchecked toggles already prevent free
	// users from selecting extra shelves — so the saved selection is preserved
	// and restored intact if the user (re)gains Pro.
}

/**
 * Get the list of currently selected shelf names from the toggle UI.
 *
 * @returns {string[]} Selected shelf names
 */
function getSelectedShelves() {
	var checkboxes = document.querySelectorAll('#shelf_list input[type="checkbox"]:checked');
	var selected = [];
	checkboxes.forEach(function (cb) {
		selected.push(cb.getAttribute("data-shelf"));
	});
	return selected.length > 0 ? selected : ["to-read"];
}

/**
 * Display error message on settings page upon OverDrive error.
 * Preserves cached book data so the user can still browse previous results.
 */
function showPartialOverdriveError(failedLibraries) {
	var failEl = document.getElementById("overdrive_fail");
	failEl.classList.remove("d-none");
	var detailEl = document.getElementById("overdrive_fail_detail");
	if (detailEl) detailEl.remove();
	detailEl = document.createElement("div");
	detailEl.id = "overdrive_fail_detail";
	detailEl.className = "error-banner-detail";
	var names = failedLibraries.map(function (url) {
		return url.replace(/^https?:\/\//, "").replace(/\.overdrive\.com\/?$/, "");
	});
	detailEl.textContent = "Could not reach: " + names.join(", ");
	failEl.querySelector(".error-banner-text").appendChild(detailEl);
}

function overdriveError(failedLibraries) {
	Analytics.trackScreenView("settings_overdrive");
	document.getElementById("goodreads_fail").classList.add("d-none");
	var failEl = document.getElementById("overdrive_fail");
	failEl.classList.remove("d-none");
	// Show which libraries failed if available
	var detailEl = document.getElementById("overdrive_fail_detail");
	if (detailEl) detailEl.remove();
	if (failedLibraries && failedLibraries.length > 0) {
		detailEl = document.createElement("div");
		detailEl.id = "overdrive_fail_detail";
		detailEl.className = "error-banner-detail";
		var names = failedLibraries.map(function (url) {
			return url.replace(/^https?:\/\//, "").replace(/\.overdrive\.com\/?$/, "");
		});
		detailEl.textContent = "Unable to reach: " + names.join(", ");
		failEl.querySelector(".error-banner-text").appendChild(detailEl);
	}
	document.getElementById("goodreadsID").closest(".input-group").classList.remove("has-error");

	// Dismiss loading screen and restore Library tab content
	document.getElementById("home_loading").classList.add("d-none");
	hideSkeleton();
	restoreLibraryView();

	// Keep bottom nav visible so the user can return to Library
	document.getElementById("pills-tab").classList.remove("d-none");
	document.getElementById("header_refresh").classList.remove("d-none");

	// Force Settings pane active (bypass Bootstrap fade which can fail
	// when reloadData() manually set pills-home as show/active)
	document.getElementById("pills-home").classList.remove("show", "active");
	document.getElementById("pills-settings").classList.add("show", "active");
	document.getElementById("pills-home-tab").classList.remove("active");
	document.getElementById("pills-settings-tab").classList.add("active");

	// Force OverDrive sub-tab active
	document.getElementById("settings-goodreads").classList.remove("show", "active");
	document.getElementById("settings-goodreads-tab").classList.remove("active");
	document.getElementById("settings-overdrive").classList.add("show", "active");
	document.getElementById("settings-overdrive-tab").classList.add("active");

	// Show scan footer (hidden when Pro tab is active)
	document.getElementById("scan_footer").classList.remove("d-none");
}

/**
 * Apply pro/free status across the entire popup UI.
 *
 * @param {boolean} isPro  Whether the user has paid for Pro
 */
function applyProStatus(isPro) {
	// Record the single source of truth for the rest of the popup.
	currentIsPro = isPro;

	// Header: show/hide Pro badge
	document.getElementById("pro_header_badge").classList.toggle("d-none", !isPro);

	// Pro tab: toggle upsell vs active card
	document.getElementById("pro_upsell").classList.toggle("d-none", isPro);
	document.getElementById("pro_active").classList.toggle("d-none", !isPro);

	// OverDrive: gate "Add Library" button
	var addBtn = document.getElementById("add_library_btn");
	var addBadge = document.getElementById("add_library_pro_badge");
	if (isPro) {
		addBtn.disabled = false;
		addBtn.title = "Add library";
		addBadge.classList.add("d-none");
	} else {
		addBtn.disabled = true;
		addBtn.title = "Upgrade to Pro to add multiple libraries";
		addBadge.classList.remove("d-none");
	}

	// Goodreads shelves: gate non-to-read toggles
	applyShelfProGating(isPro);
}

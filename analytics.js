/**
 * GA4 Measurement Protocol analytics module.
 * Works in both service worker and popup contexts.
 *
 * The Measurement Protocol records only what we explicitly send — GA derives
 * nothing from the request itself — so every payload is enriched with:
 *   - geo: the public IP (fetched once per browser session from api.ipify.org,
 *     which is CORS-open, so no extra host permissions) sent as ip_override —
 *     Google derives city/region/country from it and discards it. If the
 *     lookup fails, we fall back to country derived locally from the IANA
 *     time zone (see analytics-geo.js) sent as user_location. The store
 *     listing already declares Location data collection.
 *   - device: platform/browser/screen info from navigator (the popup caches
 *     screen resolution to storage for the service worker, which can't see it)
 *   - screen_name: the active popup view, so flow analysis works
 *
 * No user content (search queries, book titles, Goodreads IDs) is collected.
 */
var Analytics = (function () {
	var ENDPOINT = 'https://www.google-analytics.com/mp/collect';
	var DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';
	// DEBUG sends to the validation endpoint: payload errors are logged but
	// events are NOT ingested. To watch live events in GA's DebugView while
	// still ingesting them, set DEBUG_VIEW instead.
	var DEBUG = false;
	var DEBUG_VIEW = false;
	var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
	// Throttle repeated error events only — throttling regular events corrupts
	// their counts (a spike of 300 identical errors is still one data point).
	var ERROR_THROTTLE_MS = 5000;

	// In-memory caches
	var _clientId = null;
	var _clientIdPromise = null;
	var _devicePromise = null;
	var _geoPromise = null;
	var _lastErrorSent = 0;
	// Popup views report their active screen; everything from the service
	// worker is simply "background".
	var _screenName = (typeof document === 'undefined') ? 'background' : null;

	/**
	 * Get or create a persistent client ID.
	 * Deduplicates concurrent calls to avoid generating multiple UUIDs.
	 */
	function getClientId() {
		if (_clientId) return Promise.resolve(_clientId);
		if (_clientIdPromise) return _clientIdPromise;
		_clientIdPromise = new Promise(function (resolve) {
			chrome.storage.local.get(['ga_client_id'], function (result) {
				if (result.ga_client_id) {
					_clientId = result.ga_client_id;
				} else {
					_clientId = crypto.randomUUID();
					chrome.storage.local.set({ ga_client_id: _clientId });
				}
				_clientIdPromise = null;
				resolve(_clientId);
			});
		});
		return _clientIdPromise;
	}

	/**
	 * Get or rotate session ID (numeric string, rotates after 30 min inactivity).
	 */
	function getSessionId() {
		return new Promise(function (resolve) {
			chrome.storage.local.get(['ga_session_id', 'ga_session_last_activity'], function (result) {
				var now = Date.now();
				var sessionId = result.ga_session_id;
				var lastActivity = result.ga_session_last_activity || 0;

				if (!sessionId || (now - lastActivity) > SESSION_TIMEOUT_MS) {
					sessionId = now.toString();
				}

				chrome.storage.local.set({
					ga_session_id: sessionId,
					ga_session_last_activity: now
				});
				resolve(sessionId);
			});
		});
	}

	/**
	 * Geo enrichment, resolved once per context and cached per browser session
	 * (chrome.storage.session): the public IP → ip_override, or on failure the
	 * time-zone country → user_location. Always resolves, never rejects.
	 */
	function getGeo() {
		if (_geoPromise) return _geoPromise;
		_geoPromise = new Promise(function (resolve) {
			var fallback = null;
			try {
				var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
				var country = (typeof TZ_COUNTRIES !== 'undefined') && TZ_COUNTRIES[tz];
				if (country) fallback = { user_location: { country_id: country } };
			} catch (e) {}

			chrome.storage.session.get(['ga_public_ip', 'ga_ip_failed'], function (cached) {
				if (cached && cached.ga_public_ip) return resolve({ ip_override: cached.ga_public_ip });
				if (cached && cached.ga_ip_failed) return resolve(fallback);

				var controller = new AbortController();
				var timer = setTimeout(function () { controller.abort(); }, 3000);
				fetch('https://api.ipify.org?format=json', { signal: controller.signal })
					.then(function (res) { return res.json(); })
					.then(function (data) {
						clearTimeout(timer);
						if (data && data.ip) {
							chrome.storage.session.set({ ga_public_ip: data.ip });
							resolve({ ip_override: data.ip });
						} else {
							chrome.storage.session.set({ ga_ip_failed: true });
							resolve(fallback);
						}
					})
					.catch(function () {
						clearTimeout(timer);
						// Don't retry until the next browser session
						chrome.storage.session.set({ ga_ip_failed: true });
						resolve(fallback);
					});
			});
		});
		return _geoPromise;
	}

	/**
	 * Build the GA4 MP device object once per context. The popup caches its
	 * screen resolution to storage so service-worker events can include it.
	 */
	function getDevice() {
		if (_devicePromise) return _devicePromise;
		_devicePromise = new Promise(function (resolve) {
			var device = { category: 'desktop' };
			try {
				if (navigator.language) device.language = navigator.language.toLowerCase();
				var uad = navigator.userAgentData;
				if (uad) {
					if (uad.platform) device.operating_system = uad.platform;
					var brand = (uad.brands || []).find(function (b) {
						return /chrome|chromium|edge|opera|brave/i.test(b.brand);
					});
					if (brand) {
						device.browser = brand.brand;
						device.browser_version = brand.version;
					}
				}
			} catch (e) {}

			if (typeof screen !== 'undefined' && screen.width) {
				device.screen_resolution = screen.width + 'x' + screen.height;
				try { chrome.storage.local.set({ ga_screen_res: device.screen_resolution }); } catch (e) {}
				finishDevice(device, resolve);
			} else {
				chrome.storage.local.get(['ga_screen_res'], function (r) {
					if (r.ga_screen_res) device.screen_resolution = r.ga_screen_res;
					finishDevice(device, resolve);
				});
			}
		});
		return _devicePromise;
	}

	function finishDevice(device, resolve) {
		try {
			if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
				navigator.userAgentData.getHighEntropyValues(['platformVersion']).then(function (v) {
					if (v && v.platformVersion) device.operating_system_version = v.platformVersion;
					resolve(device);
				}).catch(function () { resolve(device); });
				return;
			}
		} catch (e) {}
		resolve(device);
	}

	/**
	 * Record the popup view currently on screen. Attached to every event as
	 * screen_name so flows are analyzable; trackScreenView() also emits a
	 * page_view (deduplicated) so GA's page/path reports work.
	 */
	function setScreen(name) {
		_screenName = name;
	}

	function trackScreenView(name) {
		if (name === _screenName) return; // dedupe repeat renders of one view
		setScreen(name);
		sendEvent('page_view', {
			page_title: name,
			page_location: 'chrome-extension://popup/' + name
		});
	}

	/**
	 * Send an event to GA4 via the Measurement Protocol.
	 * Fire-and-forget — never blocks or throws.
	 *
	 * @param {string} eventName
	 * @param {Object} [params={}]
	 * @param {Object} [userProperties={}]
	 * @param {Object} [opts={}]  { keepalive: true } for events sent on pagehide
	 */
	function sendEvent(eventName, params, userProperties, opts) {
		params = params || {};
		userProperties = userProperties || {};
		opts = opts || {};

		// No-op if credentials are missing
		if (typeof GA_MEASUREMENT_ID === 'undefined' || typeof GA_API_SECRET === 'undefined') return;
		if (!GA_MEASUREMENT_ID || !GA_API_SECRET) return;

		// Throttle only repeated error events (see ERROR_THROTTLE_MS note)
		if (eventName === 'extension_error') {
			var now = Date.now();
			if ((now - _lastErrorSent) < ERROR_THROTTLE_MS) return;
			_lastErrorSent = now;
		}

		Promise.all([getClientId(), getSessionId(), getDevice(), getGeo()]).then(function (ids) {
			var clientId = ids[0];
			var sessionId = ids[1];
			var device = ids[2];
			var geo = ids[3];

			params.session_id = sessionId;
			params.engagement_time_msec = params.engagement_time_msec || 100;
			if (_screenName && typeof params.screen_name === 'undefined') {
				params.screen_name = _screenName;
			}
			if (DEBUG_VIEW) params.debug_mode = 1;

			// Format user properties for Measurement Protocol
			var formattedUserProps = {};
			for (var key in userProperties) {
				if (userProperties.hasOwnProperty(key)) {
					formattedUserProps[key] = { value: userProperties[key] };
				}
			}

			var payload = {
				client_id: clientId,
				events: [{
					name: eventName,
					params: params
				}]
			};

			if (geo && geo.ip_override) payload.ip_override = geo.ip_override;
			else if (geo && geo.user_location) payload.user_location = geo.user_location;
			if (device) payload.device = device;

			if (Object.keys(formattedUserProps).length > 0) {
				payload.user_properties = formattedUserProps;
			}

			var endpoint = DEBUG ? DEBUG_ENDPOINT : ENDPOINT;
			var url = endpoint + '?measurement_id=' + GA_MEASUREMENT_ID + '&api_secret=' + GA_API_SECRET;

			var fetchOpts = {
				method: 'POST',
				body: JSON.stringify(payload)
			};
			if (opts.keepalive) fetchOpts.keepalive = true;

			fetch(url, fetchOpts).then(function (response) {
				if (DEBUG) {
					response.json().then(function (data) {
						console.log('[Analytics DEBUG] ' + eventName + ':', data);
					}).catch(function () {});
				}
			}).catch(function () {});
		}).catch(function () {});
	}

	// ---------------------------------------------------------------------
	// Install & lifecycle
	// ---------------------------------------------------------------------

	function trackInstall() {
		sendEvent('extension_installed', {}, {
			extension_version: chrome.runtime.getManifest().version
		});
	}

	function trackUpdate(version) {
		sendEvent('extension_updated', {
			extension_version: version
		}, {
			extension_version: version
		});
	}

	/**
	 * Popup opened — the DAU backbone. Fire immediately on DOMContentLoaded
	 * with cached values; never gate this on a network call.
	 *
	 * @param {boolean} isPro
	 * @param {Object}  [stats]  { library_count, shelf_count, books_bucket }
	 */
	function trackPopupOpened(isPro, stats) {
		stats = stats || {};
		var userProps = {
			is_pro: String(isPro),
			extension_version: chrome.runtime.getManifest().version
		};
		if (typeof stats.library_count !== 'undefined') userProps.library_count = stats.library_count;
		if (typeof stats.shelf_count !== 'undefined') userProps.shelf_count = stats.shelf_count;
		if (stats.books_bucket) userProps.books_bucket = stats.books_bucket;
		sendEvent('popup_opened', { is_pro: String(isPro) }, userProps);
	}

	/**
	 * Popup closed with real dwell time — the one event carrying true
	 * engagement_time_msec, so GA's engagement metrics mean something.
	 */
	function trackPopupClosed(dwellMs) {
		sendEvent('popup_closed', {
			engagement_time_msec: Math.max(1, Math.min(dwellMs, 30 * 60 * 1000))
		}, {}, { keepalive: true });
	}

	// ---------------------------------------------------------------------
	// Onboarding
	// ---------------------------------------------------------------------

	function trackWizardStarted() {
		sendEvent('wizard_started');
	}

	function trackAutodetectUsed(context, success) {
		sendEvent('autodetect_used', {
			detect_context: context, // "wizard" | "settings"
			detect_success: String(success)
		});
	}

	function trackWizardCompleted() {
		sendEvent('wizard_completed');
	}

	// ---------------------------------------------------------------------
	// Scan lifecycle — all events share a scan_id so starts join to outcomes
	// ---------------------------------------------------------------------

	function trackScanStarted(source, shelfCount, libraryCount, scanId, isPro) {
		sendEvent('scan_started', {
			scan_source: source, // "manual" | "auto"
			shelf_count: shelfCount,
			library_count: libraryCount,
			scan_id: scanId,
			is_pro: String(isPro)
		});
	}

	// Fires when the Goodreads phase finishes (books collected), BEFORE the
	// OverDrive scan. The scan's true end is overdrive_scan_completed.
	function trackGoodreadsFetchCompleted(bookCount, libraryCount, shelfCount, scanId) {
		sendEvent('goodreads_fetch_completed', {
			book_count: bookCount,
			library_count: libraryCount,
			shelf_count: shelfCount,
			scan_id: scanId
		});
	}

	function trackScanFailed(errorType, errorMessage, scanId) {
		sendEvent('scan_failed', {
			error_type: errorType,
			error_message: String(errorMessage).substring(0, 100),
			scan_id: scanId
		});
	}

	function trackScanCancelled(scanId) {
		sendEvent('scan_cancelled', { scan_id: scanId });
	}

	function trackOverdriveScanCompleted(availableCount, unavailableCount, libraryDomains, failedDomains, scanId, durationMs) {
		sendEvent('overdrive_scan_completed', {
			available_count: availableCount,
			unavailable_count: unavailableCount,
			library_count: libraryDomains.length,
			failed_library_count: failedDomains.length,
			library_domains: libraryDomains.join(', ').substring(0, 100),
			failed_domains: failedDomains.join(', ').substring(0, 100),
			scan_id: scanId,
			duration_ms: durationMs
		});
	}

	/**
	 * @param {string} errorType  "parse" (OverDrive page format changed — the
	 *                            canary to alert on) or "network"
	 */
	function trackOverdriveLibraryFailed(libraryUrl, errorMessage, scanId, errorType) {
		var domain = '';
		try { domain = new URL(libraryUrl).hostname; } catch (e) { domain = libraryUrl; }
		sendEvent('overdrive_library_failed', {
			library_domain: domain,
			error_type: errorType || 'network',
			error_message: String(errorMessage || '').substring(0, 100),
			scan_id: scanId
		});
	}

	function trackOverdriveAllFailed(failedDomains, scanId) {
		sendEvent('overdrive_all_failed', {
			failed_library_count: failedDomains.length,
			failed_domains: failedDomains.join(', ').substring(0, 100),
			scan_id: scanId
		});
	}

	// ---------------------------------------------------------------------
	// Engagement
	// ---------------------------------------------------------------------

	function trackBookClicked(action, source, bookType) {
		sendEvent('book_clicked', {
			book_action: action, // "checkout" | "hold"
			click_source: source, // "library" | "search"
			book_type: bookType || 'Unknown'
		});
	}

	// No search terms are collected — only shape and outcome of the search.
	function trackSearchPerformed(queryLength, localResults, liveResults) {
		sendEvent('search_performed', {
			query_length: queryLength,
			local_results: localResults,
			live_results: liveResults
		});
	}

	function trackFilterChanged(filter) {
		sendEvent('filter_changed', {
			filter_type: filter
		});
	}

	function trackManualRefresh() {
		sendEvent('refresh_manual');
	}

	function trackSettingsUpdated(libraryCount, shelfCount) {
		sendEvent('settings_updated', {
			library_count: libraryCount,
			shelf_count: shelfCount
		});
	}

	function trackNotificationShown(newCount, totalCount) {
		sendEvent('notification_shown', {
			new_books: newCount,
			total_books: totalCount
		});
	}

	function trackNotificationClicked() {
		sendEvent('notification_clicked');
	}

	// ---------------------------------------------------------------------
	// Monetization
	// ---------------------------------------------------------------------

	function trackProTabViewed() {
		sendEvent('pro_tab_viewed');
	}

	function trackProUpgradeClicked() {
		sendEvent('pro_upgrade_clicked');
	}

	function trackProRestoreClicked() {
		sendEvent('pro_restore_clicked');
	}

	/**
	 * GA-recommended purchase event, fired from the ExtPay onPaid listeners.
	 * Storage-guarded so the popup and background listeners can both call it
	 * without double-counting. Value must match the ExtensionPay price.
	 */
	function trackPurchase() {
		chrome.storage.local.get(['ga_purchase_tracked'], function (r) {
			if (r.ga_purchase_tracked) return;
			chrome.storage.local.set({ ga_purchase_tracked: true });
			sendEvent('purchase', {
				currency: 'USD',
				value: 4.99,
				transaction_id: 'extpay-' + Date.now()
			});
		});
	}

	// ---------------------------------------------------------------------
	// Errors — catch-all spike detector (wired to global error handlers)
	// ---------------------------------------------------------------------

	function trackError(context, message) {
		sendEvent('extension_error', {
			error_context: context, // "background" | "popup"
			error_message: String(message || 'unknown').substring(0, 100)
		});
	}

	return {
		sendEvent: sendEvent,
		setScreen: setScreen,
		trackScreenView: trackScreenView,
		trackInstall: trackInstall,
		trackUpdate: trackUpdate,
		trackPopupOpened: trackPopupOpened,
		trackPopupClosed: trackPopupClosed,
		trackWizardStarted: trackWizardStarted,
		trackAutodetectUsed: trackAutodetectUsed,
		trackWizardCompleted: trackWizardCompleted,
		trackScanStarted: trackScanStarted,
		trackGoodreadsFetchCompleted: trackGoodreadsFetchCompleted,
		trackScanFailed: trackScanFailed,
		trackScanCancelled: trackScanCancelled,
		trackOverdriveScanCompleted: trackOverdriveScanCompleted,
		trackOverdriveLibraryFailed: trackOverdriveLibraryFailed,
		trackOverdriveAllFailed: trackOverdriveAllFailed,
		trackBookClicked: trackBookClicked,
		trackSearchPerformed: trackSearchPerformed,
		trackFilterChanged: trackFilterChanged,
		trackManualRefresh: trackManualRefresh,
		trackSettingsUpdated: trackSettingsUpdated,
		trackNotificationShown: trackNotificationShown,
		trackNotificationClicked: trackNotificationClicked,
		trackProTabViewed: trackProTabViewed,
		trackProUpgradeClicked: trackProUpgradeClicked,
		trackProRestoreClicked: trackProRestoreClicked,
		trackPurchase: trackPurchase,
		trackError: trackError
	};
})();

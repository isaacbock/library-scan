/**
 * GA4 Measurement Protocol analytics module.
 * Works in both service worker and popup contexts.
 */
var Analytics = (function () {
	var ENDPOINT = 'https://www.google-analytics.com/mp/collect';
	var DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';
	var DEBUG = false;
	var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
	var THROTTLE_MS = 5000; // 5 seconds per event name

	// In-memory caches
	var _clientId = null;
	var _clientIdPromise = null;
	var _lastSent = {};

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
	 * Send an event to GA4 via the Measurement Protocol.
	 * Fire-and-forget — never blocks or throws.
	 *
	 * @param {string} eventName
	 * @param {Object} [params={}]
	 * @param {Object} [userProperties={}]
	 */
	function sendEvent(eventName, params, userProperties) {
		params = params || {};
		userProperties = userProperties || {};

		// No-op if credentials are missing
		if (typeof GA_MEASUREMENT_ID === 'undefined' || typeof GA_API_SECRET === 'undefined') return;
		if (!GA_MEASUREMENT_ID || !GA_API_SECRET) return;

		// Throttle: skip if same event sent within THROTTLE_MS
		var now = Date.now();
		if (_lastSent[eventName] && (now - _lastSent[eventName]) < THROTTLE_MS) return;
		_lastSent[eventName] = now;

		Promise.all([getClientId(), getSessionId()]).then(function (ids) {
			var clientId = ids[0];
			var sessionId = ids[1];

			params.session_id = sessionId;
			params.engagement_time_msec = params.engagement_time_msec || 100;

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

			if (Object.keys(formattedUserProps).length > 0) {
				payload.user_properties = formattedUserProps;
			}

			var endpoint = DEBUG ? DEBUG_ENDPOINT : ENDPOINT;
			var url = endpoint + '?measurement_id=' + GA_MEASUREMENT_ID + '&api_secret=' + GA_API_SECRET;

			fetch(url, {
				method: 'POST',
				body: JSON.stringify(payload)
			}).then(function (response) {
				if (DEBUG) {
					response.json().then(function (data) {
						console.log('[Analytics DEBUG] ' + eventName + ':', data);
					}).catch(function () {});
				}
			}).catch(function () {});
		}).catch(function () {});
	}

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

	function trackScanStarted(source, shelfCount, libraryCount) {
		sendEvent('scan_started', {
			scan_source: source,
			shelf_count: shelfCount,
			library_count: libraryCount
		});
	}

	function trackScanCompleted(bookCount, libraryCount, shelfCount) {
		sendEvent('scan_completed', {
			book_count: bookCount,
			library_count: libraryCount,
			shelf_count: shelfCount
		});
	}

	function trackScanFailed(errorType, errorMessage) {
		sendEvent('scan_failed', {
			error_type: errorType,
			error_message: String(errorMessage).substring(0, 100)
		});
	}

	function trackTimeout(url) {
		// Strip path to avoid leaking user IDs
		var domain = '';
		try { domain = new URL(url).hostname; } catch (e) { domain = url; }
		sendEvent('request_timeout', {
			request_domain: domain
		});
	}

	function trackFetchFailure(errorMessage) {
		sendEvent('fetch_failure', {
			error_message: String(errorMessage).substring(0, 100)
		});
	}

	function trackPopupOpened(isPro) {
		sendEvent('popup_opened', {
			is_pro: String(isPro)
		}, {
			is_pro: String(isPro),
			extension_version: chrome.runtime.getManifest().version
		});
	}

	function trackBookClicked(action) {
		sendEvent('book_clicked', {
			book_action: action
		});
	}

	function trackSettingsUpdated() {
		sendEvent('settings_updated');
	}

	function trackManualRefresh() {
		sendEvent('refresh_manual');
	}

	function trackOverdriveScanCompleted(availableCount, unavailableCount, libraryDomains, failedDomains) {
		sendEvent('overdrive_scan_completed', {
			available_count: availableCount,
			unavailable_count: unavailableCount,
			library_count: libraryDomains.length,
			failed_library_count: failedDomains.length,
			library_domains: libraryDomains.join(', ').substring(0, 100),
			failed_domains: failedDomains.join(', ').substring(0, 100)
		});
	}

	function trackOverdriveLibraryFailed(libraryUrl, errorMessage) {
		var domain = '';
		try { domain = new URL(libraryUrl).hostname; } catch (e) { domain = libraryUrl; }
		sendEvent('overdrive_library_failed', {
			library_domain: domain,
			error_message: String(errorMessage || '').substring(0, 100)
		});
	}

	function trackOverdriveAllFailed(failedDomains) {
		sendEvent('overdrive_all_failed', {
			failed_library_count: failedDomains.length,
			failed_domains: failedDomains.join(', ').substring(0, 100)
		});
	}

	function trackWizardCompleted() {
		sendEvent('wizard_completed');
	}

	function trackProTabViewed() {
		sendEvent('pro_tab_viewed');
	}

	function trackProUpgradeClicked() {
		sendEvent('pro_upgrade_clicked');
	}

	function trackSearchUsed(queryLength) {
		sendEvent('search_used', {
			query_length: queryLength
		});
	}

	function trackFilterChanged(filter) {
		sendEvent('filter_changed', {
			filter_type: filter
		});
	}

	return {
		sendEvent: sendEvent,
		trackInstall: trackInstall,
		trackUpdate: trackUpdate,
		trackScanStarted: trackScanStarted,
		trackScanCompleted: trackScanCompleted,
		trackScanFailed: trackScanFailed,
		trackTimeout: trackTimeout,
		trackFetchFailure: trackFetchFailure,
		trackPopupOpened: trackPopupOpened,
		trackBookClicked: trackBookClicked,
		trackSettingsUpdated: trackSettingsUpdated,
		trackManualRefresh: trackManualRefresh,
		trackOverdriveScanCompleted: trackOverdriveScanCompleted,
		trackOverdriveLibraryFailed: trackOverdriveLibraryFailed,
		trackOverdriveAllFailed: trackOverdriveAllFailed,
		trackWizardCompleted: trackWizardCompleted,
		trackProTabViewed: trackProTabViewed,
		trackProUpgradeClicked: trackProUpgradeClicked,
		trackSearchUsed: trackSearchUsed,
		trackFilterChanged: trackFilterChanged
	};
})();

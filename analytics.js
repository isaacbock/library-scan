/**
 * PostHog analytics module.
 * Works in both the popup and the background service worker, which need
 * different approaches:
 *
 *   - Popup: the full posthog-js SDK (vendored in /posthog, since MV3 forbids
 *     remote code): a $pageview per screen, autocaptured clicks, session
 *     replay and exception capture. Every popup visit is a real person using
 *     the extension, so popup events create a person profile and a session.
 *   - Background: plain HTTP requests to PostHog's capture endpoint. No SDK —
 *     the service worker is restarted by a 1-minute alarm, and the SDK would
 *     request feature flags on every start. Background events are sent with
 *     $process_person_profile: false and no session, so dormant installs that
 *     never open the popup never become "people" or "sessions". Events for
 *     people who have opened the popup still link to them.
 *
 * Identity: one random distinct_id per install, kept in chrome.storage.sync so
 * every device on the same Chrome account counts as one person. Once a paying
 * user's ExtensionPay email is known, the ID switches to a hash of it, which
 * also links their devices on other Chrome accounts/browsers after they
 * restore their purchase there.
 *
 * Unpacked builds (no update_url) are tagged dev_build: true so they can be
 * filtered out in PostHog. Keys live in background/api_keys.js
 * (POSTHOG_TOKEN, POSTHOG_HOST); with no token, every call is a no-op.
 */
var Analytics = (function () {
	var IS_POPUP = typeof document !== 'undefined';
	var MANIFEST = chrome.runtime.getManifest();
	var IS_DEV_BUILD = !('update_url' in MANIFEST);
	var ID_KEY = 'ph_distinct_id';
	var IDENTIFIED_KEY = 'ph_identified';
	// Background errors: each distinct error is reported at most once per day
	// per device, so an error that recurs every minute can't flood PostHog.
	// (Regular events are never throttled — that would corrupt their counts.)
	var ERRORS_SENT_KEY = 'ph_errors_sent';
	// Fallback when ExtensionPay doesn't report the plan price.
	var PRO_PRICE_USD = 4.99;

	var _idPromise = null;
	var _ready = false; // popup: posthog.init has run
	var _queue = []; // popup: calls made before init finished
	var _screenName = IS_POPUP ? null : 'background';

	function enabled() {
		return typeof POSTHOG_TOKEN !== 'undefined' && !!POSTHOG_TOKEN;
	}

	function apiHost() {
		return (typeof POSTHOG_HOST !== 'undefined' && POSTHOG_HOST) || 'https://us.i.posthog.com';
	}

	// ---------------------------------------------------------------------
	// Identity
	// ---------------------------------------------------------------------

	// chrome.storage.sync, falling back to local if sync is unavailable
	function storageGet(keys) {
		return new Promise(function (resolve) {
			function fromLocal() {
				chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
			}
			try {
				chrome.storage.sync.get(keys, function (r) {
					if (chrome.runtime.lastError || !r) fromLocal();
					else resolve(r);
				});
			} catch (e) {
				fromLocal();
			}
		});
	}

	function storageSet(obj) {
		try {
			chrome.storage.sync.set(obj, function () {
				if (chrome.runtime.lastError) chrome.storage.local.set(obj);
			});
		} catch (e) {
			chrome.storage.local.set(obj);
		}
	}

	function getIdentity() {
		if (_idPromise) return _idPromise;
		_idPromise = storageGet([ID_KEY, IDENTIFIED_KEY]).then(function (r) {
			if (r[ID_KEY]) return { id: r[ID_KEY], identified: !!r[IDENTIFIED_KEY] };
			var id = crypto.randomUUID();
			var obj = {};
			obj[ID_KEY] = id;
			storageSet(obj);
			return { id: id, identified: false };
		});
		return _idPromise;
	}

	// Another context (e.g. the background linking a purchase) changed the ID
	try {
		chrome.storage.onChanged.addListener(function (changes) {
			if (changes[ID_KEY]) _idPromise = null;
		});
	} catch (e) {}

	function sha256Hex(text) {
		return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
			return Array.from(new Uint8Array(buf)).map(function (b) {
				return b.toString(16).padStart(2, '0');
			}).join('');
		});
	}

	/**
	 * Link a paying user's devices: switch this install's distinct_id to a
	 * hash of their ExtensionPay email and merge the old anonymous ID into it.
	 * Runs only when the ID actually changes, so identify is never repeated.
	 * The email is also saved on the person so PostHog can join it to the
	 * matching Stripe customer.
	 *
	 * @param {Object} user  ExtensionPay user ({ paid, email, ... })
	 */
	function linkPaidUser(user) {
		if (!enabled() || !user || !user.paid || !user.email) return Promise.resolve();
		// Lowercased to match Stripe's customer emails exactly for the join.
		var email = String(user.email).trim().toLowerCase();
		return Promise.all([
			getIdentity(),
			sha256Hex(email)
		]).then(function (r) {
			var anonId = r[0].id;
			var paidId = 'paid_' + r[1];

			if (anonId !== paidId) {
				var obj = {};
				obj[ID_KEY] = paidId;
				obj[IDENTIFIED_KEY] = true;
				storageSet(obj);
				_idPromise = Promise.resolve({ id: paidId, identified: true });

				if (!IS_POPUP) {
					return send('$identify', { $anon_distinct_id: anonId, $set: { email: email } }, { processPerson: true, distinctId: paidId });
				}
				whenReady(function () { posthog.identify(paidId); });
			}
			// Diffed, so this only sends when the popup hasn't recorded this email yet.
			if (IS_POPUP) setUserProperties({ email: email });
		}).catch(function () {});
	}

	// ---------------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------------

	function baseProps() {
		return {
			extension_version: MANIFEST.version,
			context: IS_POPUP ? 'popup' : 'background',
			dev_build: IS_DEV_BUILD
		};
	}

	function whenReady(fn) {
		if (!IS_POPUP || typeof posthog === 'undefined') return;
		if (_ready) fn();
		else _queue.push(fn);
	}

	/**
	 * Popup only: start posthog-js. Called once on popup load; calls made
	 * before it finishes are queued and replayed.
	 */
	function initPopup() {
		if (!IS_POPUP || !enabled() || typeof posthog === 'undefined') return Promise.resolve();
		return getIdentity().then(function (ident) {
			posthog.init(POSTHOG_TOKEN, {
				api_host: apiHost(),
				bootstrap: { distinctID: ident.id, isIdentifiedID: ident.identified },
				persistence: 'localStorage',
				disable_external_dependency_loading: true, // MV3: no remote code
				person_profiles: 'always', // every popup visitor is a real person
				autocapture: true,
				// The popup's URL never changes on its own, so trackScreenView
				// sends a $pageview per screen instead. $pageleave marks the
				// popup closing and times the last screen.
				capture_pageview: false,
				capture_pageleave: true,
				capture_exceptions: true,
				error_tracking: { captureExtensionExceptions: true },
				capture_performance: false, // web vitals bundle isn't vendored
				disable_surveys: true, // surveys bundle isn't vendored
				// Nothing in the popup is sensitive (payments happen on
				// ExtensionPay's site), so recordings show everything, including
				// typed input. Disclosed in the README and privacy policy.
				session_recording: { maskAllInputs: false }
			});
			var props = baseProps();
			if (_screenName) props.screen_name = _screenName;
			posthog.register(props);
			// Super properties persist between popup visits; don't let the last
			// visit's screen label this one's events before its first screen
			if (!_screenName) posthog.unregister('screen_name');
			_ready = true;
			var queued = _queue;
			_queue = [];
			queued.forEach(function (fn) { fn(); });
		}).catch(function () {});
	}

	/**
	 * Background only: POST one event to PostHog's capture endpoint.
	 *
	 * @param {Object} [opts]  { processPerson: bool, distinctId: string }
	 */
	function send(event, props, opts) {
		opts = opts || {};
		return getIdentity().then(function (ident) {
			var properties = Object.assign(baseProps(), props || {});
			properties.$lib = 'library-scan-background';
			if (!opts.processPerson) properties.$process_person_profile = false;

			return fetch(apiHost() + '/i/v0/e/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					api_key: POSTHOG_TOKEN,
					event: event,
					distinct_id: opts.distinctId || ident.id,
					properties: properties,
					timestamp: new Date().toISOString()
				}),
				keepalive: true
			});
		}).catch(function () {});
	}

	/**
	 * @param {Object} [opts]  { processPerson, distinctId } (background), or
	 *                         { set, setOnce } person properties sent along
	 *                         with a popup event (no separate $set event)
	 */
	function capture(event, props, opts) {
		if (!enabled()) return;
		opts = opts || {};
		if (IS_POPUP) {
			whenReady(function () {
				var options = {};
				if (opts.set) options.$set = opts.set;
				if (opts.setOnce) options.$set_once = opts.setOnce;
				posthog.capture(event, props || {}, options);
			});
		} else {
			send(event, props, opts);
		}
	}

	/**
	 * Popup only: set person properties, sending only values that changed
	 * since they were last sent (avoids a $set on every popup open).
	 */
	function setUserProperties(props) {
		if (!IS_POPUP || !enabled()) return;
		whenReady(function () {
			var last = {};
			try { last = JSON.parse(localStorage.getItem('ph_person_props') || '{}'); } catch (e) {}
			var changed = {};
			Object.keys(props).forEach(function (k) {
				if (props[k] !== undefined && last[k] !== props[k]) changed[k] = props[k];
			});
			if (Object.keys(changed).length === 0) return;
			posthog.setPersonProperties(changed);
			try { localStorage.setItem('ph_person_props', JSON.stringify(Object.assign(last, changed))); } catch (e) {}
		});
	}

	function getSessionId() {
		if (!IS_POPUP || !_ready || typeof posthog === 'undefined') return null;
		try { return posthog.get_session_id(); } catch (e) { return null; }
	}

	function hostOf(url) {
		try { return new URL(url).hostname; } catch (e) { return String(url || ''); }
	}

	// ---------------------------------------------------------------------
	// Screens (popup)
	// ---------------------------------------------------------------------

	// Record the popup view on screen; attached to every event as screen_name.
	function setScreen(name) {
		_screenName = name;
		if (IS_POPUP && _ready) posthog.register({ screen_name: name });
	}

	/**
	 * Each popup screen is a native $pageview. The URL hash names the screen
	 * (popup.html#/settings/pro), so PostHog's page reports and paths, the
	 * replay's URL bar and every other event's $current_url show which screen
	 * someone was on.
	 *
	 * @param {string} name  e.g. "library", "wizard", "settings_pro"
	 */
	function trackScreenView(name) {
		if (name === _screenName) return; // dedupe repeat renders of one view
		setScreen(name);
		if (!IS_POPUP) return;
		var url = location.origin + location.pathname + '#/' + name.replace(/_/g, '/');
		try { history.replaceState(null, '', url); } catch (e) {}
		// Explicit, since a queued $pageview can run after the next screen
		capture('$pageview', { $current_url: url, screen_name: name });
	}

	// ---------------------------------------------------------------------
	// Install & lifecycle
	// ---------------------------------------------------------------------

	function trackInstall() {
		chrome.storage.local.set({ ph_installed_at: Date.now() });
		capture('extension_installed');
	}

	/**
	 * One per install per new version — the count of installs still active
	 * enough to receive updates, with a snapshot of their state.
	 *
	 * @param {string} previousVersion
	 * @param {Object} state  setup_complete, is_pro, library_count, ...
	 */
	function trackUpdate(previousVersion, state) {
		capture('extension_updated', Object.assign({ previous_version: previousVersion }, state || {}));
	}

	/**
	 * Popup opened. Also keeps the person's current state up to date, sent
	 * on this event rather than as a separate $set.
	 *
	 * @param {Object} state  { is_pro, setup_complete, library_count,
	 *                        shelf_count, books_available, books_total,
	 *                        last_scan_at (ms) }
	 */
	function trackPopupOpened(state) {
		if (!enabled()) return;
		chrome.storage.local.get(['ph_popup_opens', 'ph_last_popup_open_at', 'ph_installed_at'], function (r) {
			chrome.storage.session.get(['ph_notification_clicked_at'], function (s) {
				var now = Date.now();
				var opens = (r.ph_popup_opens || 0) + 1;
				var lastOpen = r.ph_last_popup_open_at;
				var fromNotification = !!s.ph_notification_clicked_at && (now - s.ph_notification_clicked_at) < 60000;
				chrome.storage.local.set({ ph_popup_opens: opens, ph_last_popup_open_at: now });
				if (fromNotification) chrome.storage.session.remove('ph_notification_clicked_at');

				capture('popup_opened', {
					is_pro: state.is_pro,
					setup_complete: state.setup_complete,
					entry_point: fromNotification ? 'notification' : 'toolbar',
					books_available: state.books_available,
					// A scan finished since they last looked (e.g. a daily auto-scan)
					has_new_results: !!(lastOpen && state.last_scan_at && state.last_scan_at > lastOpen),
					days_since_last_open: lastOpen ? Math.floor((now - lastOpen) / 86400000) : null,
					open_number: opens // counted from 2.1.0, when tracking started
				}, {
					set: {
						is_pro: state.is_pro,
						setup_complete: state.setup_complete,
						library_count: state.library_count,
						shelf_count: state.shelf_count,
						books_available: state.books_available,
						books_total: state.books_total,
						popup_open_count: opens,
						last_popup_open_at: new Date(now).toISOString()
					},
					setOnce: r.ph_installed_at ? { installed_at: new Date(r.ph_installed_at).toISOString() } : undefined
				});
			});
		});
	}

	// ---------------------------------------------------------------------
	// Onboarding
	// ---------------------------------------------------------------------

	function trackWizardStarted() {
		capture('wizard_started');
	}

	function trackAutodetectUsed(context, success) {
		capture('autodetect_used', { detect_context: context, detect_success: success });
	}

	function trackWizardCompleted() {
		capture('wizard_completed');
	}

	// ---------------------------------------------------------------------
	// Scans (background) — every scan event carries the same scan_id,
	// source ("manual" | "auto"), trigger and Pro status
	// ---------------------------------------------------------------------

	/**
	 * @param {Object} scan  { id, source, trigger, isPro, sessionId }
	 */
	function scanProps(scan, props) {
		return Object.assign({
			scan_id: scan.id,
			scan_source: scan.source,
			// setup | refresh_button | settings | retry | no_results | auto
			scan_trigger: scan.trigger,
			is_pro: scan.isPro,
			// Scans started from the popup belong to that popup session, so
			// they show up in its recording timeline. Auto-scans have none.
			$session_id: scan.sessionId || undefined
		}, props || {});
	}

	/**
	 * @param {Object} scan  { id, source, trigger, isPro, sessionId }
	 * @param {Object} props { shelf_count, library_count }
	 */
	function trackScanStarted(scan, props) {
		// Lifetime scan count, reported on purchase
		chrome.storage.local.get(['ph_scan_count'], function (r) {
			chrome.storage.local.set({ ph_scan_count: (r.ph_scan_count || 0) + 1 });
		});
		capture('scan_started', scanProps(scan, props));
	}

	/**
	 * At least one library was scanned.
	 *
	 * @param {Object} props { outcome: "success" | "partial", books_checked,
	 *                       available_count, hold_count, new_available_count,
	 *                       library_count, failed_library_count, library_domains,
	 *                       failed_domains, duration_ms, truncated_by_free_limit,
	 *                       is_first_scan }
	 */
	function trackScanCompleted(scan, props) {
		capture('scan_completed', scanProps(scan, props));
	}

	/**
	 * The whole scan failed. Stages:
	 *   goodreads_unreachable  goodreads.com didn't respond
	 *   goodreads_error        the shelf feed request failed (http_status / timed_out)
	 *   goodreads_not_feed     got a web page instead of a feed (private profile,
	 *                          bad ID, or a block page)
	 *   goodreads_format       feed items couldn't be read — Goodreads changed its feed
	 *   empty_shelves          read fine, but the selected shelves are empty
	 *   overdrive              every library failed (see library_scan_failed)
	 *
	 * @param {Object} props { error_message, http_status, timed_out,
	 *                       consecutive_failures, ... }
	 */
	function trackScanFailed(scan, stage, props) {
		var p = Object.assign({ stage: stage }, props || {});
		if (p.error_message) p.error_message = String(p.error_message).substring(0, 200);
		capture('scan_failed', scanProps(scan, p));
	}

	/**
	 * One library failed during a scan. error_type: "timeout" | "network" |
	 * "http" (see http_status) | "redirected" (the library's site sent us
	 * elsewhere — usually a bad or retired library address) | "format" (the
	 * page loaded but had no book data — OverDrive changed its pages, if it
	 * happens to many libraries at once).
	 *
	 * @param {Object} props { library_domain, error_type, http_status,
	 *                       final_host, page_title, books_checked }
	 */
	function trackLibraryScanFailed(scan, props) {
		capture('library_scan_failed', scanProps(scan, props));
	}

	function trackScanCancelled(scan) {
		capture('scan_cancelled', scanProps(scan));
	}

	// ---------------------------------------------------------------------
	// Engagement
	// ---------------------------------------------------------------------

	/**
	 * @param {string}  action        "checkout" | "hold"
	 * @param {string}  source        "library" | "search"
	 * @param {boolean} isNew         Shown with the "newly available" badge
	 */
	function trackBookClicked(action, source, bookType, isNew, libraryUrl) {
		capture('book_clicked', {
			book_action: action,
			click_source: source,
			book_type: bookType || 'Unknown',
			is_new: !!isNew,
			library_domain: libraryUrl ? hostOf(libraryUrl) : undefined
		});
	}

	// Once per finished search. The search text itself isn't on the event
	// (it's visible in recordings), only the shape and outcome.
	function trackSearchPerformed(queryLength, localResults, liveResults, liveStatus) {
		capture('search_performed', {
			query_length: queryLength,
			local_results: localResults,
			live_results: liveResults,
			live_status: liveStatus // "ok" | "error" | "unrecognized"
		});
	}

	/**
	 * @param {string} setting  "goodreads_profile" | "libraries" | "shelves"
	 */
	function trackSettingsChanged(setting, libraryCount, shelfCount) {
		capture('settings_changed', {
			setting: setting,
			library_count: libraryCount,
			shelf_count: shelfCount
		});
	}

	function trackNotificationShown(newCount, totalCount, scanSource, resent) {
		capture('notification_shown', {
			new_books: newCount,
			total_books: totalCount,
			scan_source: scanSource,
			resent: !!resent // shown again when the user came back from idle
		});
	}

	function trackNotificationClicked() {
		// Lets the popup's popup_opened say it was opened from the notification
		chrome.storage.session.set({ ph_notification_clicked_at: Date.now() });
		capture('notification_clicked');
	}

	// ---------------------------------------------------------------------
	// Monetization
	// ---------------------------------------------------------------------

	/**
	 * Purchase, fired from the ExtPay onPaid listeners in both contexts.
	 * Storage-guarded so whichever context sees the payment first reports it
	 * once. Uses ExtensionPay's plan price when available.
	 *
	 * @param {Object} [user]  ExtensionPay user from the onPaid callback
	 */
	function trackPurchase(user) {
		if (!enabled()) return;
		chrome.storage.local.get(['ph_purchase_tracked', 'ph_popup_opens', 'ph_scan_count', 'ph_installed_at'], function (r) {
			if (r.ph_purchase_tracked) return;
			chrome.storage.local.set({ ph_purchase_tracked: true });
			var plan = user && user.plan;
			var price = plan && plan.unitAmountCents ? plan.unitAmountCents / 100 : PRO_PRICE_USD;
			capture('purchase', {
				currency: (plan && plan.currency ? plan.currency : 'usd').toUpperCase(),
				value: price,
				plan: plan && plan.nickname ? plan.nickname : undefined,
				// Counted from 2.1.0, when tracking started
				popup_opens_before: r.ph_popup_opens || 0,
				scans_before: r.ph_scan_count || 0,
				days_since_install: r.ph_installed_at ? Math.floor((Date.now() - r.ph_installed_at) / 86400000) : undefined
			}, { processPerson: true });
		});
	}

	// ---------------------------------------------------------------------
	// Errors (background) — the popup's errors are captured automatically
	// by posthog-js and linked to the session recording.
	// ---------------------------------------------------------------------

	/**
	 * Send a background error to PostHog Error Tracking, at most once per day
	 * for each distinct error on this device.
	 *
	 * @param {string}       context  "background" or "scan"
	 * @param {Error|string} error    error.name becomes the issue type
	 * @param {Object}       [opts]   { handled: bool, dedupeKey: string
	 *                                (e.g. a library, to report each once),
	 *                                properties: extra event properties }
	 */
	function trackError(context, error, opts) {
		if (!enabled() || IS_POPUP) return;
		opts = opts || {};
		var isError = error && typeof error === 'object';
		var type = (isError && error.name) || 'Error';
		var message = String((isError ? error.message : error) || 'unknown').substring(0, 500);
		var signature = type + ': ' + message.substring(0, 120) + (opts.dedupeKey ? ' @ ' + opts.dedupeKey : '');
		var today = new Date().toISOString().slice(0, 10);

		chrome.storage.local.get([ERRORS_SENT_KEY], function (r) {
			var sent = r[ERRORS_SENT_KEY] || {};
			if (sent[signature] === today) return;
			// Drop earlier days' entries so the record stays small
			Object.keys(sent).forEach(function (k) { if (sent[k] !== today) delete sent[k]; });
			sent[signature] = today;
			var obj = {};
			obj[ERRORS_SENT_KEY] = sent;
			chrome.storage.local.set(obj);

			var props = Object.assign({
				$exception_list: [{
					type: type,
					value: message,
					mechanism: { handled: !!opts.handled, synthetic: false }
				}],
				$exception_level: 'error',
				error_context: context
			}, opts.properties || {});
			if (isError && error.stack) props.error_stack = String(error.stack).substring(0, 2000);
			send('$exception', props);
		});
	}

	return {
		initPopup: initPopup,
		linkPaidUser: linkPaidUser,
		setUserProperties: setUserProperties,
		getSessionId: getSessionId,
		setScreen: setScreen,
		trackScreenView: trackScreenView,
		trackInstall: trackInstall,
		trackUpdate: trackUpdate,
		trackPopupOpened: trackPopupOpened,
		trackWizardStarted: trackWizardStarted,
		trackAutodetectUsed: trackAutodetectUsed,
		trackWizardCompleted: trackWizardCompleted,
		trackScanStarted: trackScanStarted,
		trackScanCompleted: trackScanCompleted,
		trackScanFailed: trackScanFailed,
		trackLibraryScanFailed: trackLibraryScanFailed,
		trackScanCancelled: trackScanCancelled,
		trackBookClicked: trackBookClicked,
		trackSearchPerformed: trackSearchPerformed,
		trackSettingsChanged: trackSettingsChanged,
		trackNotificationShown: trackNotificationShown,
		trackNotificationClicked: trackNotificationClicked,
		trackPurchase: trackPurchase,
		trackError: trackError
	};
})();

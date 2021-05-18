/**
 * @type {boolean} Tracks if data is currently being fetched from Goodreads or OverDrive to prevent overlapping fetches
 */
let currently_scanning = false;

/**
 * @type {number} Refresh wait duration in minutes -- defaults to refreshing every 24 hours
 */
 let refreshWait = 24*60;

/**
 * @type {number} Initialize errorTimeout to prevent data from continually over-refreshing after any errors
 */
 let errorTimeout = 0;

// Initialize repeated time-since-refresh check
getElapsedTimeLoop();

// Google Analytics
var _AnalyticsCode = 'UA-172825265-2';
var _gaq = _gaq || [];
_gaq.push(['_setAccount', _AnalyticsCode]);
(function() {
  var ga = document.createElement('script');
  ga.type = 'text/javascript';
  ga.async = true;
  ga.src = 'https://ssl.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0];
  s.parentNode.insertBefore(ga, s);
})();

/**
 * @type {*} Refresh loading message every 10 seconds while currently_scanning
 */
let carousel_message_timer;

// Install & uninstall pages, manifest version tracking
chrome.runtime.onInstalled.addListener(function (details) {
    if (details.reason === "install") {
      // Code to be executed on first install
      chrome.tabs.create({
        url: "https://isaacbock.com/library-scan#start"
      });
      chrome.runtime.setUninstallURL('https://isaacbock.com/library-scan-uninstall');
      _gaq.push(['_trackEvent', 'version', 'installed', chrome.app.getDetails().version]);
    } else if (details.reason === "update") {
      // When extension is updated
      _gaq.push(['_trackEvent', 'version', 'updated', chrome.app.getDetails().version]);
      chrome.runtime.setUninstallURL('https://isaacbock.com/library-scan-uninstall');
    } else if (details.reason === "chrome_update") {
      // When browser is updated
    } else if (details.reason === "shared_module_update") {
      // When a shared module is updated
    }
  });

// Receive messages from popup.js (front-end) and respond with data
chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        // Request to refresh book data
        if (request.msg === "goodreads" && !currently_scanning) {
            // Begin by refreshing all titles from Goodreads (which will then progress to identifying these title on OverDrive)
            queryGoodreads(request.goodreadsID, request.overdriveURL);
            // Update Loading view carousel messages every 10 seconds
            let carousel_messages=["We'll scan the most recent 200 books on your Goodreads To-Read shelf to find titles already available at your local OverDrive library.","We'll automatically refresh your library every 24 hours so titles are always up-to-date.","Toggle between eBooks and Audiobooks to find exactly what you're looking for."];
            let carousel_position=1;
            carousel_message_timer = setInterval(function(){ 
                chrome.runtime.sendMessage({
                    msg: "CarouselMsg",
                    text: carousel_messages[carousel_position%carousel_messages.length]
                    });
                carousel_position++;
                console.log("Carousel message.");
            }, 10000);
        }
        // Get time since last refresh
        else if (request.msg === "elapsedTime") {
            getElapsedTime();
        }
        // Update available book badge count as specified
        else if (request.msg === "badgeCount") {
            updateBadgeCount(request.count);
        }
        // Confirm message received
        return true;
    }
);

/**
 * Call getElapsedTime() every 60 seconds to keep popup.js (front-end) timing & data accurate
 *
 */
function getElapsedTimeLoop() {
    chrome.storage.local.get(['LastRun'], function(result) {
        getElapsedTime();
        setTimeout(getElapsedTimeLoop, 60000);
    });
}

/**
 * Get time elapsed since last data refresh and send to popup.js (front-end) for display
 *
 */
function getElapsedTime() {
    // retrieve data from Chrome local storage
    chrome.storage.local.get(['LastRun', 'goodreadsID', 'overdriveURL'], async function(result) {
        let lastRunTime = await result.LastRun;
        let goodreadsID = await result.goodreadsID;
        let overdriveURL = await result.overdriveURL;
        if (lastRunTime!=undefined) {
            // calculate time (in minutes) since last refresh
            let lastRun = new Date(lastRunTime);
            let currentTime = new Date();
            let elapsedTime = Math.floor((currentTime - lastRun) / 60000);
            console.log("Elapsed Time Since Last Refresh: " + elapsedTime + " min");
            // if more than refreshWait minutes have passed, data is outdated; trigger refresh
            if (elapsedTime > refreshWait && !currently_scanning) {
                _gaq.push(['_trackEvent', 'Data', 'refreshed', 'automatically']);
                queryGoodreads(goodreadsID, overdriveURL);
                elapsedTime = 0;
            }
            // if time elapsed is zero minutes, display as "Last Refreshed: just now"
            if (elapsedTime===0) {
                chrome.runtime.sendMessage({
                    msg: "ElapsedTime", 
                    time: "just now"
                });
            }
            // if time elapsed is less than 60 minutes, display as "Last Refreshed: __ min ago"
            else if (elapsedTime<60) {
                chrome.runtime.sendMessage({
                    msg: "ElapsedTime", 
                    time: elapsedTime + " min ago"
                });
            }
            // if time elapsed is greater than 60 minutes, display as "Last Refreshed: __ hr ago"
            else {
                chrome.runtime.sendMessage({
                    msg: "ElapsedTime", 
                    time: Math.floor(elapsedTime/60) + " hr ago"
                });
            }
        }
    });
}

/**
 * Query Goodreads for list of most recent 200 titles from to-read shelf
 *
 * @param {number} goodreadsID   User ID number of user's Goodreads account (ex: 12345678)
 * @param {string} overdriveURL  URL of user's local OverDrive library (ex: https://nypl.overdrive.com)
 */
function queryGoodreads(goodreadsID, overdriveURL) {
    currently_scanning = true;
    updateBadgeCount(0)
    // fetch data using Goodreads API
    fetch('https://www.goodreads.com/review/list?v=2&id='+goodreadsID+'&shelf=to-read&sort=position&order=d&per_page=200&key='+apiKeys.goodreads, {
        method: "GET",
        headers: {
          "Content-Type": "text/xml",
        }
    })
    // convert response from XML to JSON
    .then(response => response.text())
    .then(xmlString => $.parseXML(xmlString))
    .then(data => xmlToJson.parse( data ).GoodreadsResponse.reviews)
    .then(
        function(data) {
            xmlToJson.parse( data );
            let bookArray = [];
            // save to-read titles as bookArray (slightly different JSON location depending on if only 1 or 2+ titles present)
            if (data.end == 1) {
                bookArray.push(data.review);
            }
            else {
                bookArray = data.review;
            }
            // parse individual book data into ToRead array
            let ToRead = [];
            for (let i=0; i<bookArray.length; i++) {
                ToRead.push({"title":bookArray[i].book.title, "author": bookArray[i].book.authors.author.name})
            }
            // log ToRead books to console
            console.log("Goodreads to-read shelf:");
            console.log(ToRead);
            // Google Analytics: track successful Goodreads fetch
            _gaq.push(['_trackEvent', 'Goodreads', 'fetched', 'success', ToRead.length]);
            // query OverDrive for these titles to check for availability
            queryOverdrive(ToRead, overdriveURL);
            // Begin sending OverDrive fetch progress to popup.js (front-end)
            chrome.runtime.sendMessage({
                msg: "In Progress", 
                count: 0,
                total: ToRead.length
            });
        }
    )
    // if fetch fails, display Goodreads error message on front-end
    .catch(function(err) {
        console.log('Goodreads fetch Error ', err);
        currently_scanning = false;
        clearInterval(carousel_message_timer);
        _gaq.push(['_trackEvent', 'Goodreads', 'fetched', 'failed']);
        updateBadgeCount(0, true);

        // Double error timeout upon each repeated error to prevent over-refreshing
        errorTimeout = errorTimeout>0 ? errorTimeout*2 : 1;
        // Adjust last run time to incorporate error timeout & save to Chrome local storage
        let last_run_time = new Date();
        last_run_time.setMinutes( last_run_time.getMinutes() - refreshWait + errorTimeout );
        last_run_time = last_run_time.toJSON();
        chrome.storage.local.set({'LastRun': last_run_time});

        chrome.runtime.sendMessage({
            msg: "GoodreadsError",
        });
    });
}

/**
 *
 *
 * @param {Object[]}    ToRead              All books identified on Goodreads to-read shelf
 * @param {string}      ToRead[].title      Book's title
 * @param {string}      ToRead[].author     Book's author
 * @param {string}      overdriveURL        URL of user's local OverDrive library (ex: https://nypl.overdrive.com)
 */
async function queryOverdrive(ToRead, overdriveURL) { 
    currently_scanning = true;
    let available_count = 0;
    let unavailable_count = 0;
    console.log("Scanning OverDrive for titles:");
    // as books are identified on OverDrive, add to BookAvailability array
    let BookAvailability = [];
    // for each book within ToRead, fetch its title/author pairing on user's local OverDrive website
    for (let i=0; i<ToRead.length && currently_scanning; i++) {
        await fetchWithTimeout(overdriveURL+"/search/title?query="+encodeURIComponent(ToRead[i].title)+"&creator="+encodeURIComponent(ToRead[i].author))
        .then(res => res.text())
        .then(function(html) {
            // identify book availability data in response & prepare for JSON conversion
            let regexSearch = "window.OverDrive.mediaItems = {.*};";
            let overdriveSearchResults = html.match(regexSearch)[0];
            let overdriveSplicedSearchResults = overdriveSearchResults.slice(30, overdriveSearchResults.length-1);
            // convert book availability data to JSON
            let overdriveJSONresults = JSON.parse(overdriveSplicedSearchResults);
            let JSON_length = Object.keys(overdriveJSONresults).length;
            // if data length is zero, no relevant titles were found in OverDrive
            if (JSON_length===0) {
                console.log(ToRead[i].title + " by " + ToRead[i].author + " not found.");
            }
            // if titles found, identify relevant metadata of each book; log to console & add to BookAvailability 
            else {
                for(var result in overdriveJSONresults){
                    try {
                        var book = overdriveJSONresults[result];
                        let title = book.title;
                        let author = book.firstCreatorName;
                        let type = book.type.name;
                        let cover = book.covers.cover150Wide.href;
                        let available = book.isAvailable;
                        let estimatedWait = book.estimatedWaitDays;
                        let URL = overdriveURL+"/media/"+book.id;
                        console.log({title: title, author:author, type:type, cover:cover, available:available, estimatedWait:estimatedWait, URL:URL});
                        BookAvailability.push({title: title, author:author, type:type, cover:cover, available:available, estimatedWait:estimatedWait, URL:URL});
                        if (available) {
                            available_count++;
                        }
                        else {
                            unavailable_count++;
                        }
                    } catch (error) {
                        console.log(ToRead[i].title + " by " + ToRead[i].author + " metadata could not be loaded.")
                    }
                }
            }
            // send OverDrive fetch progress to popup.js (front-end)
            chrome.runtime.sendMessage({
                msg: "In Progress", 
                count: i+1,
                total: ToRead.length
            });
            // if current book was the final title to fetch (OverDrive fetch completed)
            if (i===ToRead.length-1) {
                // save BookAvailability data to Chrome local storage
                chrome.storage.local.set({'BookAvailability': BookAvailability});
                // save current time (used to calculate time elapsed since last refresh) & save to Chrome local storage
                let last_run_time = (new Date()).toJSON();
                chrome.storage.local.set({'LastRun': last_run_time});
                // notify popup.js (front-end) of completed data refresh
                chrome.runtime.sendMessage({
                    msg: "Complete",
                    BookAvailability: BookAvailability
                    });
                // notify popup.js (front-end) of completed data refresh again (1 second later), to overwrite any possible timing delays of previous progress messages
                setTimeout(() => {
                    chrome.runtime.sendMessage({
                        msg: "Complete",
                        BookAvailability: BookAvailability
                        });
                }, 1000);
                // stop cycling through progress carousel messages
                clearInterval(carousel_message_timer);
                // end data refesh
                currently_scanning = false;
                errorTimeout = 0;
                _gaq.push(['_trackEvent', 'OverDrive', 'fetched', 'success', BookAvailability.length]);
                _gaq.push(['_trackEvent', 'OverDrive', 'count', 'available', available_count]);
                _gaq.push(['_trackEvent', 'OverDrive', 'count', 'hold', unavailable_count]);
                updateBadgeCount(available_count);
                console.log("OverDrive scan complete.");
            }
        })
        // if fetch fails, display OverDrive error message on front-end
        .catch((err) => {
            console.log('OverDrive fetch Error ', err);
            currently_scanning = false;
            clearInterval(carousel_message_timer);
            updateBadgeCount(0, true);

            // Double error timeout upon each repeated error to prevent over-refreshing
            errorTimeout = errorTimeout>0 ? errorTimeout*2 : 1;
            // Adjust last run time to incorporate error timeout & save to Chrome local storage
            let last_run_time = new Date();
            last_run_time.setMinutes( last_run_time.getMinutes() - refreshWait + errorTimeout );
            last_run_time = last_run_time.toJSON();
            chrome.storage.local.set({'LastRun': last_run_time});

            chrome.runtime.sendMessage({
                msg: "OverdriveError",
            });
        });
    }
}

/**
 * Fetch data with a maximum allotted time (60 seconds) before fetch failure
 *
 * @param   {string}    uri             Fetch URL
 * @param   {*}         [options={}]    Fetch options
 * @param   {number}    [time=60000]    Fetch maximum allotted time
 * @returns {*}                         Response from data fetch
 */
async function fetchWithTimeout(uri, options = {}, time=60000) {
    const controller = new AbortController()
    const config = { ...options, signal: controller.signal }
    // Set a timeout limit for the request using `setTimeout`.
    const timeout = setTimeout(() => {
      controller.abort()
    }, time)
    try {
        const response = await fetch(uri, config);
        // Check that the response is in the 200 range
        if (!response.ok) {
            throw new Error(`${response.status}: ${response.statusText}`);
        }
        return response;
    }
    catch (error) {
        if (error.name === 'AbortError') {
            _gaq.push(['_trackEvent', 'OverDrive', 'fetched', 'failed (timeout)']);
            throw new Error('Response timed out.');
        }
        _gaq.push(['_trackEvent', 'OverDrive', 'fetched', 'failed ('+error.message+')']);
        throw new Error(error.message);
    }
}

/**
 * Update extension badge count to display number of books currently available
 *
 * @param {number} count Number of books currently available
 * @param {boolean} [error=false] Should notification color be set to red? Defaults to false.
 */
function updateBadgeCount(count, error = false) {
    // default badge to blue background
    if (!error) {
        chrome.browserAction.setBadgeBackgroundColor({ color: [0, 123, 255, 255] });
    }
    // else upon error, badge to red background
    else {
        chrome.browserAction.setBadgeBackgroundColor({ color: [225, 0, 0, 255] });
    }
    // update badge to display count
    if (count!=0) {
        chrome.browserAction.setBadgeText({text: count.toString()});
    }
    // if count equals zero, do not display badge
    else {
        chrome.browserAction.setBadgeText({text: ''});
    }
    // display "!" badge upon error
    if (error) {
        chrome.browserAction.setBadgeText({text: ' ! '});
    }
}
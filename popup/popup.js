// Initialize form, button, and toggle actions
document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('userData').addEventListener('submit', saveUserData);
    document.getElementById('refresh_button').addEventListener('click', logReload);
    document.getElementById('ebook_toggle').addEventListener('click', toggleType);
    document.getElementById('audiobook_toggle').addEventListener('click', toggleType);
    document.getElementById('ebook_toggle_settings').addEventListener('click', toggleType);
    document.getElementById('audiobook_toggle_settings').addEventListener('click', toggleType);
});

// Receive messages from background.js (which fetches new data & coordinates timing) and update DOM accordingly 
chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.msg==="In Progress") {
            // If data refresh in progress, display only Loading view
            $('#home_normal').addClass("d-none");
            $('#home_loading').removeClass("d-none");
            $('#available_count').addClass("d-none");
            $('#pills-tab').addClass("d-none");
            // Hide bottom nav bar
            $('#pills-home').addClass("show active");
            $('#pills-profile').removeClass("show active");
            $('#pills-home-tab').addClass("active");
            $('#pills-profile-tab').removeClass("active");
            $('#pills-home-tab').attr('aria-selected', true);
            $('#pills-profile-tab').attr('aria-selected', false);
            // Update progress bar with current stats
            $('#loading_text').text("Scanning OverDrive library...");
            $('#loading_bar').attr('aria-valuemax', request.total);
            $('#loading_bar').attr('aria-valuenow', request.count);
            let progress = request.count / request.total * 100;
            $('#loading_bar').attr('style', "width: "+progress+"%");
            $('#loading_count').text(request.count + " of " + request.total + " books");
        }
        else if (request.msg==="CarouselMsg") {
            // Swap out current progress message with new message (occurs every 10 seconds during refresh)
            if ( $('#loading_carousel_message').html()!=("<em>"+request.text+"</em>")) {
                $('#loading_carousel_message').animate({'opacity': 0}, 1000, function () {
                    $(this).html("<em>"+request.text+"</em>");
                }).animate({'opacity': 1}, 1000);
            }
        }
        else if (request.msg==="Complete") {
            // When refresh is complete, reset Loading view statistics to default
            $('#loading_text').text("Downloading Goodreads Books...");
            $('#loading_carousel_message').html("<em>We'll scan the most recent 200 books on your Goodreads To-Read shelf to find titles already available at your local OverDrive library.</em>");
            $('#loading_bar').attr('aria-valuemax', 200);
            $('#loading_bar').attr('aria-valuenow', 0);
            $('#loading_bar').attr('style', "width: 0%");
            $('#loading_count').text("");
            // "Last refreshed: just now"
            $('#time_since_refresh').text("just now");
            // Remove any old failure messages upon successful completion
            $('#goodreads_fail').addClass("d-none");
            $('#overdrive_fail').addClass("d-none");
            document.getElementById("goodreadsID").style.borderColor = "";
            document.getElementById("overdriveURL").style.borderColor = "";
            // Display new book data in Library view
            updateMainPage(request.BookAvailability);
        }
        else if (request.msg==="ElapsedTime") {
            // Update "Last refreshed: ____" data
            $('#time_since_refresh').text(request.time);
        }
        else if (request.msg==="GoodreadsError") {
            // Display Goodreads error message
            goodreadsError();
        }
        else if (request.msg==="OverdriveError") {
            // Display OverDrive error message
            overdriveError();
        }
        // Confirm message received
        return true;
    }
);

// Google Analytics
var _AnalyticsCode = 'UA-172825265-2';
var _gaq = _gaq || [];
_gaq.push(['_setAccount', _AnalyticsCode]);
_gaq.push(['_trackPageview']);
/**
 * Google Analytics: send data to Google
 */
(function() {
  var ga = document.createElement('script');
  ga.type = 'text/javascript';
  ga.async = true;
  ga.src = 'https://ssl.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0];
  s.parentNode.insertBefore(ga, s);
})();
/**
 * Google Analytics: track data refreshes initiated by user
 */
function logReload() {
    _gaq.push(['_trackEvent', 'Data', 'refreshed', 'manually']);
    reloadData();
}
/**
 * Google Analytics: track book checkout on OverDrive
 */
function logCheckout() {
    _gaq.push(['_trackEvent', 'Book', 'checkout']);
}
/**
 * Google Analytics: track book hold on OverDrive
 */
function logHold() {
    _gaq.push(['_trackEvent', 'Book', 'hold']);
}

// Initialize user data and view
loadUserData();

/**
 * Retrieve user data from Chrome local storage & configure view based on login status
 *
 */
function loadUserData() {
    // Retrieve user data from Chrome local storage
    chrome.storage.local.get(['goodreadsID', 'overdriveURL', "BookAvailability", "ebook_toggle", "audiobook_toggle"], async function(result) {
        let goodreadsID = await result.goodreadsID;
        let overdriveURL = await result.overdriveURL;
        let BookAvailability = await result.BookAvailability;
        let ebookToggle = await result.ebook_toggle;
        let audiobookToggle = await result.audiobook_toggle;
        // if user is logged in (data retrieved successfully), grant full access
        if (typeof goodreadsID!=='undefined' && typeof overdriveURL!=='undefined' && typeof ebookToggle!=='undefined' && typeof audiobookToggle!=='undefined') {
            // display current user data in Settings
            document.getElementById("goodreadsID").value = goodreadsID;
            document.getElementById("overdriveURL").value = overdriveURL;
            // default to Library view and show bottom nav bar
            $('#pills-home').addClass("show active");
            $('#pills-profile').removeClass("show active");
            $('#pills-home-tab').addClass("active");
            $('#pills-profile-tab').removeClass("active");
            $('#pills-home-tab').attr('aria-selected', true);
            $('#pills-profile-tab').attr('aria-selected', false);
            $('#pills-tab').removeClass("d-none");
            // display updated user toggle (eBook vs. Audiobook) preferences
            document.getElementById('ebook_toggle').checked = ebookToggle;
            document.getElementById('ebook_toggle_settings').checked = ebookToggle;
            document.getElementById('audiobook_toggle').checked = audiobookToggle;
            document.getElementById('audiobook_toggle_settings').checked = audiobookToggle;
            // hide all Library views until book data is loaded
            $('#home_normal').addClass("d-none");
            $('#home_loading').addClass("d-none");
            // if previous user, display old data & time since last update
            if (typeof BookAvailability!=='undefined') {
                    updateMainPage(BookAvailability);
                    chrome.runtime.sendMessage({
                        msg: "elapsedTime"
                    });
            }
            // else, for users without previous data, load new book data
            else {
                reloadData(goodreadsID, overdriveURL);
            }
        }
        // else, user is not logged in
        else {
            // default to only Settings view
            $('#pills-home').removeClass("show active");
            $('#pills-profile').addClass("show active");
            $('#pills-home-tab').removeClass("active");
            $('#pills-profile-tab').addClass("active");
            $('#pills-home-tab').attr('aria-selected', false);
            $('#pills-profile-tab').attr('aria-selected', true);
            // display existing user data in Settings form
            if (typeof goodreadsID!=='undefined') {
                document.getElementById("goodreadsID").value = goodreadsID;
            }
            if (typeof overdriveURL!=='undefined') {
                document.getElementById("overdriveURL").value = overdriveURL;
            }
        }
    });
}

/**
 * Update library tab to show all current books
 *
 * @param {Object[]}    BookAvailability                    All books identified on OverDrive
 * @param {string}      BookAvailability[].title            Book's title
 * @param {string}      BookAvailability[].author           Book's author
 * @param {string}      BookAvailability[].type             'eBook' or 'Audiobook'
 * @param {string}      BookAvailability[].cover            URL of book's cover image
 * @param {boolean}     BookAvailability[].available        True: available for checkout; False: Place a Hold
 * @param {number}      BookAvailability[].estimatedWait    Estimated time before book is available
 * @param {string}      BookAvailability[].URL              URL of book on OverDrive
 */
function updateMainPage(BookAvailability) {
    // clear all current data being displayed in Library view
    document.getElementById("available_now").innerHTML = "";
    document.getElementById("available_soon").innerHTML = "";
    // check current toggle (eBook vs. Audiobook) preferences
    let ebookToggle = document.getElementById("ebook_toggle").checked;
    let audiobookToggle = document.getElementById("audiobook_toggle").checked;
    // separate books by availability status (available for checkout / place a hold) & filter out unwanted (toggled) book types
    let Available = [];
    let Holds = [];
    for (let i=0; i<BookAvailability.length; i++) {
        if (BookAvailability[i].type==="eBook" && ebookToggle){
            if (BookAvailability[i].available===true){
                Available.push(BookAvailability[i]);
            }
            else {
                Holds.push(BookAvailability[i]);
            }
        }
        else if (BookAvailability[i].type==="Audiobook" && audiobookToggle){
            if (BookAvailability[i].available===true){
                Available.push(BookAvailability[i]);
            }
            else {
                Holds.push(BookAvailability[i]);
            }
        }
    }
    // if no books found, display relevant message in Library view
    if (Available.length==0 && Holds.length==0) {
        document.getElementById("available_now").innerHTML += "<div class='d-flex flex-column justify-content-center text-center'><h1 class='mt-5 mb-3'><i class='fa fa-lg fa-frown-o' aria-hidden='true'></i></h1><h2>Sorry...</h2><h3>No titles were found.</h3></div>";
    }
    // else, books exist and are ready for display
    else {
        // add each Available book to Library view
        for (let i=0; i<Available.length; i++) {
            document.getElementById("available_now").innerHTML += "<div class='d-flex border-bottom pb-2 mb-2'><img src='"+Available[i].cover+"' class='cover' alt='"+Available[i].title+"'><div class='d-flex flex-column justify-content-center overflow-hidden w-75 ml-3 mr-3'><h6 class='text-nowrap text-truncate mb-0'>"+Available[i].title+"</h6><p class='text-nowrap text-truncate mb-0'>"+Available[i].author+"</p><p class='text-nowrap text-truncate mb-3'><em>"+Available[i].type+"</em></p><a type='button' class='btn btn-primary available' href='"+Available[i].URL+"' target='_blank'>Checkout</a></div></div>";
        }
        // if books are available, prompt user to leave a review
        if (Available.length > 0) {
            document.getElementById("available_now").innerHTML += "<div class='d-flex align-items-center border-bottom pt-2 pb-3 mb-2'><h5 class='p-2 m-0'>Find a good book?</h5><a type='button' class='btn btn-success' href='https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik/review' target='_blank'>Leave a review!</a></div>";
        }
        // sort Hold books by increasing expected waits (in days)
        Holds.sort((a, b) => (a.estimatedWait == undefined) ? 1 : (a.estimatedWait > b.estimatedWait) ? 1 : -1);
        // add each Hold book to Library view (underneath Available books)
        for (let i=0; i<Holds.length; i++) {
            document.getElementById("available_soon").innerHTML += "<div class='d-flex border-bottom pb-2 mb-2'><img src='"+Holds[i].cover+"' class='cover' alt='"+Holds[i].title+"'><div class='d-flex flex-column justify-content-center overflow-hidden w-75 ml-3 mr-3'><h6 class='text-nowrap text-truncate mb-0'>"+Holds[i].title+"</h6><p class='text-nowrap text-truncate mb-0'>"+Holds[i].author+"</p><p class='text-nowrap text-truncate mb-3'><em>"+Holds[i].type+"<br>~"+((Holds[i].estimatedWait != undefined) ? ((Holds[i].estimatedWait >=14) ? Math.round(Holds[i].estimatedWait/7)+' week wait' : Holds[i].estimatedWait+' day wait') : 'Unknown wait')+"</em></p><a type='button' class='btn btn-outline-secondary hold' href='"+Holds[i].URL+"' target='_blank'>Place Hold</a></div></div>";
        }
        // Google Analytics: track book checkouts and holds
        $('a.available').click(logCheckout);
        $('a.hold').click(logHold);
    }
    // switch back to displaying Library view w/ bottom nav bar
    $('#home_normal').removeClass("d-none");
    $('#home_loading').addClass("d-none");
    $('#pills-tab').removeClass("d-none");
    // update badge count of available books
    $('#available_count').removeClass("d-none");
    document.getElementById("available_count").innerText = Available.length.toString();
    chrome.runtime.sendMessage({
        msg: "badgeCount", 
        count: Available.length
    });
}

/**
 * Send message to background.js to update & reload all books
 *
 * @param {number} goodreadsID  User ID number of user's Goodreads account (ex: 12345678)
 * @param {string} overdriveURL URL of user's local OverDrive library (ex: https://nypl.overdrive.com)
 */
function reloadData(goodreadsID, overdriveURL) {
    // if user data hasn't been specified, retrieve from Chrome local storage
    if (goodreadsID === undefined || overdriveURL === undefined) {
        chrome.storage.local.get(['goodreadsID', 'overdriveURL'], async function(result) {
            goodreadsID = await result.goodreadsID;
            overdriveURL = await result.overdriveURL;
            // request refresh from background.js using retrieved data (starting w/ book listings from Goodreads)
            chrome.runtime.sendMessage({
                msg: "goodreads", 
                goodreadsID: goodreadsID,
                overdriveURL: overdriveURL
            });
        });
    }
    // else, request refresh from background.js using provided user data (starting w/ book listings from Goodreads)
    else {
        chrome.runtime.sendMessage({
            msg: "goodreads", 
            goodreadsID: goodreadsID,
            overdriveURL: overdriveURL
        });
    }
    // clear all current books
    chrome.storage.local.remove('BookAvailability');
    // clear all current data being displayed in Library view
    document.getElementById("available_now").innerHTML = "";
    document.getElementById("available_soon").innerHTML = "";
    // switch to Loading view
    $('#pills-tab').addClass("d-none");
    $('#home_normal').addClass("d-none");
    $('#home_loading').removeClass("d-none");
    $('#available_count').addClass("d-none");
}

/**
 * Save newly submitted data to Chrome local storage and use it to reloadData()
 *
 * @param {event} e onSubmit event of user settings form
 */
function saveUserData(e) {
    // prevent extension from refreshing all views
    e.preventDefault();
    // collect user data from Settings form
    let goodreadsID = document.getElementById("goodreadsID").value;
    let overdriveURL = document.getElementById("overdriveURL").value;
    // modify OverDrive URL to match correct structure: https://LIBRARY-CODE.overdrive.com
    if (overdriveURL.endsWith("/")) {
        overdriveURL = overdriveURL.slice(0,overdriveURL.length-1);
    }
    // save user data to Chrome local storage
    chrome.storage.local.set({'goodreadsID': goodreadsID, 'overdriveURL': overdriveURL, 'ebook_toggle': document.getElementById('ebook_toggle').checked, 'audiobook_toggle': document.getElementById('audiobook_toggle').checked});
    // show bottom nav bar and switch to Library view
    $('#pills-home').addClass("show active");
    $('#pills-profile').removeClass("show active");
    $('#pills-home-tab').addClass("active");
    $('#pills-profile-tab').removeClass("active");
    $('#pills-home-tab').attr('aria-selected', true);
    $('#pills-profile-tab').attr('aria-selected', false);
    // Remove any old failure messages upon successful completion
    $('#goodreads_fail').addClass("d-none");
    $('#overdrive_fail').addClass("d-none");
    document.getElementById("goodreadsID").style.borderColor = "";
    document.getElementById("overdriveURL").style.borderColor = "";
    // use new user data to refresh Library & track refresh via Google Analytics
    _gaq.push(['_trackEvent', 'Data', 'refreshed', 'updated settings']);
    reloadData(goodreadsID, overdriveURL);
}

/**
 * Sync toggle state between Library & Settings views; save toggle states to Chrome local storage; updateMainPage() to correctly show newly filtered books
 *
 * @param {event} e onClick event of book type toggles
 */
function toggleType(e) {
    // Sync toggle state between Library & Settings views
    if (e.target.id=="ebook_toggle") {
        document.getElementById('ebook_toggle_settings').checked = e.target.checked;
    }
    else if (e.target.id=="audiobook_toggle") {
        document.getElementById('audiobook_toggle_settings').checked = e.target.checked;
    }
    else if (e.target.id=="ebook_toggle_settings") {
        document.getElementById('ebook_toggle').checked = e.target.checked;
    }
    else if (e.target.id=="audiobook_toggle_settings") {
        document.getElementById('audiobook_toggle').checked = e.target.checked;
    }
    // save toggle states to Chrome local storage
    chrome.storage.local.set({'ebook_toggle': document.getElementById('ebook_toggle').checked, 'audiobook_toggle': document.getElementById('audiobook_toggle').checked});
    // if books listings are currently available, update their display to match current toggle settings
    chrome.storage.local.get(['BookAvailability'], async function(result) {
        let BookAvailability = await result.BookAvailability;
        if (typeof BookAvailability!=='undefined') {
            updateMainPage(BookAvailability);
        }
    });
}

/**
 * Display error message on settings page upon Goodreads error
 *
 */
function goodreadsError() {
    // clear problematic Goodreads user ID and current books
    chrome.storage.local.remove(["goodreadsID","BookAvailability"]);
    // show Goodreads error message (and hide OverDrive error message)
    $('#goodreads_fail').removeClass("d-none");
    $('#overdrive_fail').addClass("d-none");
    // highlight offending input field in red
    document.getElementById("goodreadsID").style.borderColor = "red";
    document.getElementById("overdriveURL").style.borderColor = "";
    // default to only showing Settings view
    $('#pills-tab').addClass("d-none");
    $('#pills-home').removeClass("show active");
    $('#pills-profile').addClass("show active");
    $('#pills-home-tab').removeClass("active");
    $('#pills-profile-tab').addClass("active");
    $('#pills-home-tab').attr('aria-selected', false);
    $('#pills-profile-tab').attr('aria-selected', true);
}

/**
 * Display error message on settings page upon OverDrive error
 *
 */
function overdriveError() {
    // clear problematic OverDrive URL and current books
    chrome.storage.local.remove(["overdriveURL","BookAvailability"]);
    // show OverDrive error message (and hide Goodreads error message)
    $('#goodreads_fail').addClass("d-none");
    $('#overdrive_fail').removeClass("d-none");
    // highlight offending input field in red
    document.getElementById("goodreadsID").style.borderColor = "";
    document.getElementById("overdriveURL").style.borderColor = "red";
    // default to only showing Settings view
    $('#pills-tab').addClass("d-none");
    $('#pills-home').removeClass("show active");
    $('#pills-profile').addClass("show active");
    $('#pills-home-tab').removeClass("active");
    $('#pills-profile-tab').addClass("active");
    $('#pills-home-tab').attr('aria-selected', false);
    $('#pills-profile-tab').attr('aria-selected', true);
}
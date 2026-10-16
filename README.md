# Library Scan

<p>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://img.shields.io/chrome-web-store/v/mfckggnkebdpaocogfekaaicafooeiik" alt="Chrome Web Store"></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://img.shields.io/chrome-web-store/users/mfckggnkebdpaocogfekaaicafooeiik?color=blue" alt="Users"></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://img.shields.io/badge/books%20scanned-33.4k%2B-blue" alt="Books Scanned"></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://img.shields.io/badge/books%20found-29.0k%2B-blue" alt="Books Found"></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://img.shields.io/chrome-web-store/stars/mfckggnkebdpaocogfekaaicafooeiik" alt="Rating"></a>
  <a href="https://www.goodreads.com"><img src="https://img.shields.io/website?down_color=red&label=Goodreads&url=https%3A%2F%2Fwww.goodreads.com%2Fapi" alt="Goodreads Status"></a>
  <a href="https://www.overdrive.com"><img src="https://img.shields.io/website?down_color=red&label=OverDrive&url=https%3A%2F%2Fwww.overdrive.com%2F" alt="OverDrive Status"></a>
</p>

<p>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://github.com/isaacbock/library-scan/blob/master/media/Screenshot%201.png?raw=true" width="400" /></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://github.com/isaacbock/library-scan/blob/master/media/Screenshot%202.png?raw=true" width="400" /></a>
</p>

Scan your OverDrive (Libby) libraries for available eBooks & audiobooks from your Goodreads shelves.

- Find titles available to borrow right now
- Place holds on upcoming books, sorted by estimated wait
- Search your results and your libraries by title or author
- Filter by eBook or audiobook
- Guided setup with Goodreads profile auto-detection
- **Free:** scan one library against your to-read shelf (up to 100 books) whenever you like
- **Library Scan Pro:** daily auto-scans with desktop notifications, multiple libraries, any Goodreads shelf, and unlimited books per scan

_Not affiliated with Goodreads or OverDrive, Inc. All data accessed and interpreted is available publicly online._

_Library Scan uses PostHog to collect usage analytics, error reports, and recordings of how the extension's popup is used, to understand usage and fix problems. These can include what the popup displays and what you type into it: your Goodreads profile, shelves, book titles, library names, and searches. No passwords or payment details pass through the extension (purchases are handled by ExtensionPay). If you buy Library Scan Pro, your purchase email is linked to this data. Your IP address is used to estimate your approximate location. Full details: [privacy policy](https://isaacbock.com/library-scan-privacy-policy)._

## Installation

<a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik" target="_blank" rel="noopener"><img src="https://github.com/isaacbock/library-scan/blob/master/media/Chrome%20Web%20Store.png?raw=true" height=100 alt="Available in the Chrome Web Store"></a>

## Permissions

Library Scan only reads public Goodreads shelves and OverDrive library pages. Tutorials and support available at isaacbock.com/library-scan.

```
https://www.goodreads.com/*          Read your public shelves & detect your profile
https://*.overdrive.com/*            Search your OverDrive (Libby) libraries
https://isaacbock.com/library-scan   Confirm installation on the setup guide
https://extensionpay.com/*           Confirm Library Scan Pro purchases
storage                              Save your settings & latest results
alarms                               Run daily auto-scans (Pro)
notifications                        Tell you when books become available (Pro)
idle                                 Re-show a notification you missed while away
```

## Changelog

- Version 2.1.2 (10/16/26)
  - Bug fixes & stability improvements
- Version 2.1.1 (10/15/26)
  - Bug fixes & stability improvements
- Version 2.1.0 (10/10/26)
  - Improved scan reliability & performance
  - Smoother Library Scan Pro upgrades
  - Bug fixes & stability improvements
- Version 2.0.0 (04/01/26)
  - Introducing Library Scan Pro! Daily auto-scans with desktop notifications, multiple OverDrive/Libby libraries, multiple Goodreads shelves, and unlimited books per scan
  - Completely redesigned interface with guided setup wizard & profile auto-detection
  - Search your results & OverDrive/Libby libraries by title and author
- Version 1.0.3 (09/12/21)
  - Bug fix: Only refresh while online
- Version 1.0.2 (05/22/21)
  - Improved book matching algorithm
  - Improved setup instructions & resources
  - Enhanced versioning analytics
  - Bug fix: accurate badge counts
  - Bug fix: limit auto refreshing after errors
- Version 1.0.1 (07/26/20)
  - Improved analytics
- Version 1.0.0 (07/25/20)
  - Initial release

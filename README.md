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
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://github.com/isaactbock/library-scan/blob/master/media/Screenshot%201.png?raw=true" width="400" /></a>
  <a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik"><img src="https://github.com/isaactbock/library-scan/blob/master/media/Screenshot%202.png?raw=true" width="400" /></a>
</p>

Scan any OverDrive library for available eBooks & audiobooks from your Goodreads to-read shelf.

- Find titles immediately available for checkout
- Place holds on upcoming books
- Filter by media type & availability
- Automatic daily scans

_Not affiliated with Goodreads or OverDrive, Inc. All data accessed and interpreted is available publicly online._

_Google Analytics 4 (via Measurement Protocol) is used to collect anonymous usage statistics to help improve the extension. No personally identifiable information is collected. Your IP address is used by Google for approximate geographic reporting but is not stored._

## Installation

<a href="https://chrome.google.com/webstore/detail/mfckggnkebdpaocogfekaaicafooeiik" target="_blank" rel="noopener"><img src="https://github.com/isaacbock/library-scan/blob/master/media/Chrome%20Web%20Store.png?raw=true" height=100 alt="Available in the Chrome Web Store"></a>

## Permissions

Library Scan only fetches data from public Goodreads profiles and OverDrive library pages. Tutorials and support available at isaacbock.com/library-scan.

```
https://www.goodreads.com/*
https://*.overdrive.com/*
https://isaacbock.com/library-scan
```

## Changelog

- Version 2.0.0 (04/02/26)
  - Manifest V3 migration (background service worker)
  - Redesigned popup: onboarding wizard, book cover cards, search, & media-type filters
  - Library Scan Pro: multiple OverDrive libraries, any Goodreads shelves, unlimited books per scan, & daily auto-scans with new-book notifications
  - Goodreads profile auto-detection & shelf picker
  - Upgraded to Bootstrap 5, removed jQuery
  - Google Analytics 4 usage analytics (Measurement Protocol)
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

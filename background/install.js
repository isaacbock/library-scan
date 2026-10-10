// Replace download button after install
let downloadButton = document.querySelector("#download");
if (downloadButton) downloadButton.style.display = "none";

// Replace download button after install
let downloadedText = document.querySelector("#already-downloaded");
if (downloadedText) downloadedText.style.display = "flex";

// Show starting instructions after install
let instructions = document.querySelector("#start");
if (instructions) instructions.style.display = "block";
// Show starting instructions after install
let instructions_nav_link = document.querySelector("#start_nav_link");
if (instructions_nav_link) instructions_nav_link.style.display = "inline";
